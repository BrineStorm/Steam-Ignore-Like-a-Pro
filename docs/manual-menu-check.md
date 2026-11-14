# Manual check: the context menu opened at press

On Linux and macOS the browser opens the context menu at mouse-**down**. On Windows it opens at mouse-up. Left alone, a menu opened at press grabs the pointer and a right-button swipe can never finish. So `SwipeGestureDetector.onContextMenu` (`src/manual-ignore/gestures.js`) cancels a menu that arrives while the right button is still down, on a game capsule, with the master switch on and at least one action bound to a gesture. The first such cancel shows a one-time hint card.

The logic is pinned by `tests/manual-ignore/bindings.unit.spec.js`, and the Firefox project drives it with Playwright's synthetic at-press `contextmenu`. Neither shows the **native** menu staying shut, so this is checked by hand before a release that touches the gesture detector.

Windows itself cannot do it. Firefox's `ui.context_menus.after_mouseup` pref exists for GTK and macOS only, and set at startup it hangs Playwright's Firefox launch. Use WSLg on Windows 11, a Linux desktop, a Mac, or a headless Linux server with a virtual screen.

## The check

| Action | Expected |
|---|---|
| Empty page area: press and hold the right button | The menu opens at once, the button still down, so the environment really behaves like Linux. Console: `MENU at press cancelled=false` |
| A game row: press, drag right, release | No menu, a red IGNORED badge, the one-time hint card. Console: `MENU at press cancelled=true`, then `UP` |
| Another row: swipe left | A blue badge, no hint this time |
| A game row: right-click without moving | No menu and nothing happens (the accepted cost of the fix) |
| SETTINGS → Manual Ignore: all three actions on clicks or off, then right-click a row | The menu is back on the capsule |

For exact evidence, paste this into the page's console (Firefox wants `allow pasting` typed after the first paste):

```js
let h=0;addEventListener('mousedown',e=>{if(e.button==2){h=1;console.log('DOWN')}},1);addEventListener('mouseup',e=>{if(e.button==2){h=0;console.log('UP')}},1);addEventListener('contextmenu',e=>setTimeout(()=>console.log('MENU',h?'at press':'at release','cancelled='+e.defaultPrevented)),1)
```

Signed in, the ignores are **real**. Roll them back (a click on each badge, or the widget's Undo) before leaving.

**Last run:** `1.3.2 · Firefox 157 · Ubuntu 24.04 (WSLg) · pass`, `1.3.2 · Chrome 155 · Ubuntu 24.04 (WSLg) · pass`. Record a new run here as version · browser · OS · result.

## On Windows 11 through WSLg

WSLg shows Linux GUI apps as ordinary Windows windows, with the clipboard shared both ways. The distro is throwaway. Browsers, profiles and the Steam session all leave with it.

```powershell
# 0. local: a distro (once, its first start asks for a Linux user) and the build
wsl --install -d Ubuntu-24.04
node build.js
```

```bash
# 1. in the distro, as root (wsl -d Ubuntu-24.04 -u root): Firefox from Mozilla's APT repo
#    (the four repo lines of step 2 of the server procedure, without sudo), Chrome from Google's .deb
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /root/chrome.deb
apt-get update && apt-get install firefox /root/chrome.deb

# 2. in the distro, as your Linux user: the build into the Linux home (a short path for the file picker), then the browsers
cp -r /mnt/c/<path to the repo>/dist/firefox ~/ilap-firefox
cp -r /mnt/c/<path to the repo>/dist/chromium ~/ilap-chromium
firefox --profile ~/ilap-ff --no-remote &      # mkdir ~/ilap-ff first
google-chrome --user-data-dir=$HOME/ilap-chrome &
```

- Firefox: load `~/ilap-firefox/manifest.json` and grant the host permission as in step 4 of the server procedure. Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → the `~/ilap-chromium` folder.
- The distro's disk grows into `C:`. Keep a few GB free there. On a full `C:` the distro's file system turns read-only mid-install and the distro will not start again until `wsl --shutdown`.
- From PowerShell, `wsl ... bash -c '…'` mangles nested quotes. Run longer commands from a script file or inside the distro's own shell.
- Cleanup: `wsl --unregister Ubuntu-24.04`.

## On a headless Linux server

The browser runs on a virtual screen (Xvfb), a VNC server bound to **loopback only** shows it, and a VNC viewer reaches it through an SSH tunnel. The viewer's mouse arrives as ordinary X11 input, so GTK opens the menu at press exactly as on a desktop. Connection details stay out of the repo. Set them locally, in a shell profile:

```powershell
$env:ILAP_LINUX_HOST = "<user>@<host>"
$env:ILAP_LINUX_KEY  = "<path to the SSH private key>"
```

If the server runs anything else, the procedure leaves it as it found it:

- no `apt-get autoremove`. The package list is snapshotted before the install and only the new packages are purged afterwards
- installs keep local config files (`--force-confold`) and run without `-y`, so the summary is read before anything is upgraded or removed
- everything of the check (browser profile, Steam session, extension copy) lives under a throwaway user and leaves with `userdel -r`
- no firewall change of any kind. The tunnel arrives over SSH and ends on loopback. The VNC server has no password, so it never listens beyond loopback (`-localhost`), and Xvfb never on TCP (`-nolisten tcp`)
- on a small box a temporary swap file (outside `/etc/fstab`), and the browser under `choom -n 1000`, so the OOM killer picks it first

```powershell
# 0. local: build and copy
node build.js
scp -i "$env:ILAP_LINUX_KEY" -r dist/firefox "${env:ILAP_LINUX_HOST}:/tmp/ilap-firefox"
ssh -i "$env:ILAP_LINUX_KEY" $env:ILAP_LINUX_HOST
```

```bash
# 1. server: preflight
dpkg-query -W -f='${Package}\n' | sort > /tmp/ilap-pkgs-before.txt
sudo fallocate -l 2G /swapfile-ilap && sudo chmod 600 /swapfile-ilap && sudo mkswap /swapfile-ilap && sudo swapon /swapfile-ilap   # small RAM only

# 2. server: Firefox from Mozilla's APT repo (Ubuntu's own package is a snap), a screen, VNC
sudo install -d -m 0755 /etc/apt/keyrings
wget -q https://packages.mozilla.org/apt/repo-signing-key.gpg -O- | sudo tee /etc/apt/keyrings/packages.mozilla.org.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" | sudo tee /etc/apt/sources.list.d/mozilla.list > /dev/null
printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' | sudo tee /etc/apt/preferences.d/mozilla > /dev/null
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -o Dpkg::Options::=--force-confold firefox xvfb x11vnc openbox

# 3. server: throwaway user, screen, VNC, browser
sudo useradd -m -s /usr/sbin/nologin ilaptest
sudo cp -r /tmp/ilap-firefox /home/ilaptest/ && sudo chown -R ilaptest: /home/ilaptest/ilap-firefox
sudo runuser -u ilaptest -- Xvfb :99 -screen 0 1440x900x24 -nolisten tcp &
sleep 2
sudo runuser -u ilaptest -- env DISPLAY=:99 openbox &
sudo runuser -u ilaptest -- x11vnc -display :99 -localhost -nopw -forever -shared -bg -o /home/ilaptest/x11vnc.log
sudo runuser -u ilaptest -- env DISPLAY=:99 HOME=/home/ilaptest choom -n 1000 -- firefox --width 1440 --height 900 &
ss -ltnp | grep -E '5900|6099'    # 5900 on 127.0.0.1 only, 6099 (X over TCP) absent
```

```powershell
# 4. local, a separate window kept open, then point a VNC viewer at localhost::5901 (TightVNC) or localhost:5901
ssh -i "$env:ILAP_LINUX_KEY" -N -L 5901:localhost:5900 $env:ILAP_LINUX_HOST
```

In the browser, `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `/home/ilaptest/ilap-firefox/manifest.json`. Then `about:addons` → the extension → **Permissions** → allow `store.steampowered.com` (Firefox MV3 treats content-script matches as opt-in host permissions). Sign in to Steam to see badges (the cancel itself needs no session) and open a search page. Then run [the check](#the-check).

```bash
# 5. server: cleanup
sudo pkill -u ilaptest; sleep 2; sudo pkill -9 -u ilaptest
sudo userdel -r ilaptest
comm -13 /tmp/ilap-pkgs-before.txt <(dpkg-query -W -f='${Package}\n' | sort) > /tmp/ilap-pkgs-new.txt
cat /tmp/ilap-pkgs-new.txt                      # only what step 2 brought in
xargs -r -a /tmp/ilap-pkgs-new.txt sudo apt-get purge -y
sudo rm -f /etc/apt/sources.list.d/mozilla.list /etc/apt/preferences.d/mozilla /etc/apt/keyrings/packages.mozilla.org.asc
sudo apt-get update
sudo swapoff /swapfile-ilap && sudo rm -f /swapfile-ilap
rm -rf /tmp/ilap-firefox /tmp/ilap-pkgs-before.txt /tmp/ilap-pkgs-new.txt
```
