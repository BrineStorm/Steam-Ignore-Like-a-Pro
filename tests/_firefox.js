// Firefox extension loading for Playwright.
//
// Playwright's Firefox has no --load-extension equivalent. The only way to
// load an unpacked WebExtension is the Firefox Remote Debugging Protocol:
// launch with `-start-debugger-server <port>`, connect over TCP, and ask the
// addons actor to `installTemporaryAddon` (the same mechanism web-ext uses).
//
// The extension's internal moz-extension:// UUID is normally random per
// install; we pre-pin it via the `extensions.webextensions.uuids` pref
// (written into the profile's user.js BEFORE launch, together with the
// debugger-server prefs — Playwright's firefoxUserPrefs option applies prefs
// over the juggler protocol AFTER startup, too late for the command-line
// `-start-debugger-server` handler). The fixed UUID gives getExtensionId() a
// deterministic value; storage itself is reached through a content-script
// bridge (see tests/_extension.js), since Firefox blocks navigating a tab to
// a moz-extension:// page.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { firefox } = require('@playwright/test');

const EXT_DIR = path.join(__dirname, '..', 'dist', 'firefox-test');

// Arbitrary fixed UUID for the test install. Stable across runs so helpers
// can build moz-extension:// URLs deterministically.
const EXT_UUID = '9f105afd-321e-4d0a-8d5a-1f68c04594e8';

function geckoId() {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')
    );
    return manifest.browser_specific_settings.gecko.id;
}

function writePrefs(profileDir) {
    const prefs = {
        'devtools.debugger.remote-enabled': true,
        'devtools.debugger.prompt-connection': false,
        'extensions.webextensions.uuids': JSON.stringify({ [geckoId()]: EXT_UUID }),
        // Firefox MV3 treats content-script match patterns as opt-in host
        // permissions; grant by default so the scripts inject without a
        // manual about:addons toggle.
        'extensions.originControls.grantByDefault': true,
    };
    const lines = Object.entries(prefs).map(
        ([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`
    );
    fs.writeFileSync(path.join(profileDir, 'user.js'), lines.join('\n') + '\n');
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
    });
}

// Minimal RDP client. Wire format: `<byteLength>:<json>` packets. We only ever
// have one request in flight, so replies are matched by their `from` actor;
// unsolicited `*ListChanged` events are dropped.
class RdpClient {
    constructor(socket) {
        this.socket = socket;
        this.buf = Buffer.alloc(0);
        this.waiter = null; // { from, resolve, reject }
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', (err) => this._fail(err));
        socket.on('close', () => this._fail(new Error('RDP connection closed')));
    }

    static async connect(port, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        let lastErr;
        // The debugger server comes up a moment after the process starts.
        while (Date.now() < deadline) {
            try {
                const socket = await new Promise((resolve, reject) => {
                    const s = net.connect({ port, host: '127.0.0.1' }, () => resolve(s));
                    s.once('error', reject);
                });
                const client = new RdpClient(socket);
                // The server greets with an unsolicited packet from root.
                await client._wait('root', timeoutMs);
                return client;
            } catch (err) {
                lastErr = err;
                await new Promise((r) => setTimeout(r, 200));
            }
        }
        throw new Error(`Could not reach Firefox debugger server on :${port} — ${lastErr}`);
    }

    _fail(err) {
        if (this.waiter) {
            this.waiter.reject(err);
            this.waiter = null;
        }
    }

    _onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const sep = this.buf.indexOf(0x3a); // ':'
            if (sep < 0) return;
            const len = parseInt(this.buf.slice(0, sep).toString('ascii'), 10);
            if (!Number.isFinite(len)) {
                this._fail(new Error('Malformed RDP packet header'));
                return;
            }
            if (this.buf.length < sep + 1 + len) return;
            const json = this.buf.slice(sep + 1, sep + 1 + len).toString('utf8');
            this.buf = this.buf.slice(sep + 1 + len);
            this._dispatch(JSON.parse(json));
        }
    }

    _dispatch(msg) {
        // Ignore broadcast events (tabListChanged, addonListChanged, ...).
        if (msg.type && /ListChanged$/.test(msg.type)) return;
        if (this.waiter && this.waiter.from === msg.from) {
            const { resolve } = this.waiter;
            this.waiter = null;
            resolve(msg);
        }
    }

    _wait(from, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => this._fail(new Error(`RDP reply from "${from}" timed out`)),
                timeoutMs
            );
            this.waiter = {
                from,
                resolve: (msg) => { clearTimeout(timer); resolve(msg); },
                reject: (err) => { clearTimeout(timer); reject(err); },
            };
        });
    }

    async request(packet, timeoutMs) {
        const reply = this._wait(packet.to, timeoutMs);
        const json = JSON.stringify(packet);
        this.socket.write(`${Buffer.byteLength(json)}:${json}`);
        const msg = await reply;
        if (msg.error) {
            throw new Error(`RDP ${packet.type} failed: ${msg.error} — ${msg.message || ''}`);
        }
        return msg;
    }

    close() {
        this.socket.removeAllListeners('close');
        this.socket.destroy();
    }
}

async function installTemporaryAddon(rdpPort, addonPath) {
    const client = await RdpClient.connect(rdpPort);
    try {
        const root = await client.request({ to: 'root', type: 'getRoot' });
        // The reply lands only once the addon has started up.
        await client.request({
            to: root.addonsActor,
            type: 'installTemporaryAddon',
            addonPath,
        });
    } finally {
        client.close();
    }
}

// Launch a persistent Firefox context from `userDataDir` with the test-flavor
// extension installed. Mirrors the chromium launcher in _fixtures.js; the
// returned context carries `_ilapFirefoxUuid` so _extension.js helpers can
// tell the platforms apart and build moz-extension:// URLs.
async function launchFirefoxExtensionContext(userDataDir, options) {
    const rdpPort = await freePort();
    writePrefs(userDataDir);
    const context = await firefox.launchPersistentContext(userDataDir, {
        ...options,
        args: ['-start-debugger-server', String(rdpPort)],
    });
    try {
        await installTemporaryAddon(rdpPort, EXT_DIR);
    } catch (err) {
        await context.close();
        throw err;
    }
    context._ilapFirefoxUuid = EXT_UUID;
    return context;
}

module.exports = { launchFirefoxExtensionContext, EXT_UUID };
