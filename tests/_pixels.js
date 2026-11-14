// SPDX-License-Identifier: GPL-3.0-or-later
const zlib = require('zlib');

// The colours a page shows at points, read off one screenshot of it. Some of
// what the panel draws is out of getComputedStyle's reach: a range input's
// thumb and track are pseudo-elements, and what an SVG mask leaves of a shape
// is only on screen. A test of those reads the pixels.

// Playwright's screenshot is an 8-bit RGB or RGBA PNG with no interlacing,
// which is all this reads.
function decodePng(buf) {
    let pos = 8, width = 0, height = 0, channels = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            channels = { 2: 3, 6: 4 }[data[9]];
            if (data[8] !== 8 || data[12] !== 0 || !channels) throw new Error('an 8-bit RGB or RGBA PNG with no interlacing only');
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const px = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1);
        const row = y * stride;
        for (let i = 0; i < stride; i++) {
            const a = i >= channels ? px[row + i - channels] : 0;
            const b = y ? px[row - stride + i] : 0;
            const c = y && i >= channels ? px[row - stride + i - channels] : 0;
            let pred = 0;
            if (filter === 1) pred = a;
            else if (filter === 2) pred = b;
            else if (filter === 3) pred = (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            px[row + i] = (src[i] + pred) & 255;
        }
    }
    return { width, channels, px };
}

// [r, g, b] at each [x, y] (CSS px from the viewport's top left). Motion is
// run to its end first (Playwright's `animations: 'disabled'`).
async function colours(page, points) {
    const png = decodePng(await page.screenshot({ animations: 'disabled' }));
    const dpr = await page.evaluate(() => devicePixelRatio);
    return points.map(([x, y]) => {
        const i = (Math.floor(y * dpr) * png.width + Math.floor(x * dpr)) * png.channels;
        return [png.px[i], png.px[i + 1], png.px[i + 2]];
    });
}

// The largest gap between two colours on any channel.
const gap = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

// 'rgb(1, 2, 3)' or 'rgba(1, 2, 3, x)' as [1, 2, 3].
const rgb = (css) => css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);

module.exports = { colours, gap, rgb };
