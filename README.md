# Tizen Homebrew

Install apps on a Samsung TV from your phone.

<img src="icon.png" width="96" align="right">

Developer Mode normally points a TV at a computer that has to stay on the
network. This points it at `127.0.0.1` — the TV becomes its own developer
machine — and puts the interface on your phone. Set it up once; no computer
after that.

- Install from a catalog, a GitHub release, a URL, or a USB stick
- Re-signs every package for your TV, so builds signed by other people install
- A dmesg-style log on the TV screen
- An sdb shell, from the phone

**Discord**: https://discord.gg/WjxVnrsV4A

---

## Install

One command. It carries its own runtime, so nothing has to be installed first.

### Linux/MacOS
```sh
curl -fsSL https://sushydev.github.io/tizen-homebrew/install.sh | sh
```

### Windows
```powershell
irm https://sushydev.github.io/tizen-homebrew/install.ps1 | iex
```

It tells you what to switch on, finds the TV, mints a Samsung certificate
against your own account, installs the app, and tells you what to switch back.
Ten minutes, most of it spent restarting the TV.

Two steps are yours: sdbd runs a command allowlist, so no software can do them.
Both are **Apps** → **12345** (or hold Enter) → **Settings**, and both need a
restart, since that value is only read at startup.

| When | Set **Host PC IP** to |
| --- | --- |
| Before installing | this computer's address — the installer prints it |
| After installing | `127.0.0.1` |

The second makes the rest work: the TV then installs its own apps, and no other
machine can reach its sdb daemon.

**From a checkout**, with Node 20+:

```sh
git clone https://github.com/SushyDev/tizen-homebrew.git
cd tizen-homebrew
npm install
npm run full-bootstrap          # or: -- <tv-ip>, if you know it
```

Same flow, built from source. It mints a **Partner** certificate — yours, your
account, nothing shared — into `~/.tizen-certs`; `--public` mints a public one,
which installs the same but carries no on-boot service. The certificates go to
the TV as well, so from first boot it re-signs whatever it installs, including
packages built by other people.

---

## Screens

<table>
<tr>
<td width="75%" valign="top">

https://github.com/user-attachments/assets/a5960e36-27b7-4ed9-9445-98849855682b
</td>
<td width="25%" valign="top">

https://github.com/user-attachments/assets/c176baef-5690-414c-95a5-7e968464a860
</td>
</tr>
<tr>
<td align="center"><sub>▶ The television — 37s · pairing, an install as it lands, the log console, the credits</sub></td>
<td align="center"><sub>▶ The phone — 33s</sub></td>
</tr>
</table>

### On the TV

<table>
<tr>
<td><img src="media/tv-screen.webp" alt="The television screen: the address to open, the pairing code, and the log"></td>
</tr>
<tr>
<td align="center"><sub>The address, the code, and whatever the service is doing</sub></td>
</tr>
</table>

<table>
<tr>
<td width="33%"><img src="media/tv-installing.webp" alt="The log narrating an install"></td>
<td width="33%"><img src="media/tv-logs.webp" alt="The log console"></td>
<td width="33%"><img src="media/tv-credits.webp" alt="The credits"></td>
</tr>
<tr>
<td align="center"><sub>An install, as it happens</sub></td>
<td align="center"><sub>The log console</sub></td>
<td align="center"><sub>Credits</sub></td>
</tr>
</table>

### On the phone

<table>
<tr>
<td width="33%"><img src="media/phone-pairing.webp" alt="Pairing"></td>
<td width="33%"><img src="media/phone-apps.webp" alt="The catalog"></td>
<td width="33%"><img src="media/phone-updates.webp" alt="Updates found"></td>
</tr>
<tr>
<td align="center"><sub><b>Pairing</b> — the six digits on the TV</sub></td>
<td align="center"><sub><b>Apps</b> — the catalog, and what is already on the TV</sub></td>
<td align="center"><sub><b>check all</b> — what has a newer release</sub></td>
</tr>
<tr>
<td><img src="media/phone-upload.webp" alt="Upload"></td>
<td><img src="media/phone-github.webp" alt="GitHub"></td>
<td><img src="media/phone-usb.webp" alt="USB"></td>
</tr>
<tr>
<td align="center"><sub><b>Upload</b> — a .wgt from the phone</sub></td>
<td align="center"><sub><b>GitHub</b> — owner/repo, newest release</sub></td>
<td align="center"><sub><b>USB</b> — a stick plugged into the TV</sub></td>
</tr>
<tr>
<td><img src="media/phone-shell.webp" alt="Shell"></td>
<td><img src="media/phone-installing.webp" alt="Installing"></td>
<td><img src="media/phone-installed.webp" alt="Installed"></td>
</tr>
<tr>
<td align="center"><sub><b>Shell</b> — sdb commands, off by default</sub></td>
<td align="center"><sub>Five steps, re-signing among them</sub></td>
<td align="center"><sub>On the TV's home row</sub></td>
</tr>
</table>

---

## Using it

| Tab | |
| --- | --- |
| **Apps** | The catalog and every added repository, installed with one press; **update all** |
| **Repos** | Add a collection or a catalog; choose automatic updates |
| **Upload** | A `.wgt` from the phone |
| **GitHub** | `owner/repo` — lists the files in the newest release, with their sha256, to pick one |
| **URL** | A direct https link |
| **USB** | A stick plugged into the TV |
| **Shell** | sdb commands, off by default |

The PIN changes every time the app opens, and the TV screen shows the current
one. Your phone keeps the last one that worked until the TV restarts.

**Repositories.** Under **repos**, add either a GitHub `owner/repo` whose newest
release carries the packages — a *collection*, like
`example/tv-packages`, where every `.wgt` and `.tpk` becomes an
app — or an https link to a `catalog.json` in the same shape as this one. Their
apps appear under **apps**, grouped by where they come from.

**Updates.** Every **Apps** row says whether it is installed and at which
version. Whether anything newer was *released* is a GitHub request per app, so
it waits to be asked: **check** on a row, or **check all** under the list, which
also asks each collection what its newest release holds. **update all** installs
everything with an update, one at a time, Tizen Homebrew itself last. Under
**repos**, automatic updates can **check daily** (the default: what is newer is
listed here and on the TV) or **install daily**. The TV's own screen has an
**apps** button for the same, with the remote. Tizen Homebrew is in its own
catalog, so it updates itself the same way. From a working copy, over the LAN:

```sh
npm run package && npm run push -- <tv-ip> <pin>
```

---

## Commands

| | |
| --- | --- |
| `npm run full-bootstrap [-- <ip>]` | Certificate, build, install — the whole setup. Finds the TV itself if you do not name one |
| `npm run mint -- <ip> [pin]` | Certificate only; adds this TV to the pair you have |
| `npm run package` | Build a `.wgt` signed by nobody — what a release carries |
| `npm run package -- --sign` | The same, signed for this machine's TV — what sdb needs |
| `npm run bootstrap -- <ip>` | Install over sdb (needs Host PC IP pointed here) |
| `npm run push -- <ip> <pin>` | Install over the LAN, once the app is running |
| `npm run certs -- <ip> <pin>` | Re-send the TV's certificates (`--forget` removes) |
| `npm run duid -- <ip> [pin]` | Print the device id a certificate binds to |
| `npm run repl -- <ip>` | A prompt inside the running service — developer builds only |
| `npm run doctor` | Check prerequisites when something looks wrong |

`mint` `certs` `duid` `push` all work with the TV pinned to `127.0.0.1`, given
the PIN. `bootstrap` cannot: it needs the sdbd a pinned set stops answering.
Both certificate commands take `--public`.

**Developer builds.** `--dev` fixes the PIN at `000000` and puts a prompt inside
the service, so a build pushed every few minutes stops asking for a code off the
screen:

```sh
npm run package -- --dev && npm run push -- <tv-ip> 000000
npm run repl -- <tv-ip>
```

Every line is evaluated in the running service — `store.get()`, `await
packages.list()`; `.inspect` opens Node's inspector for Chrome DevTools, and
`.names` lists what is in scope. That is arbitrary code execution as the
service, reachable by anything on the network, so an ordinary build carries no
`/dev` routes: the bundler drops the branch, and `--release` refuses a developer
build outright.

**When it goes wrong**

| The message | What to do |
| --- | --- |
| `Check certificate error … Invalid signature` | Your pair does not cover this TV — `npm run mint -- <ip>` |
| `Author certificate not match` | The author certificate changed — `npm run bootstrap -- <ip> --replace` |
| `accepted the connection then dropped it` | Host PC IP is not this machine. Set it, restart the TV. |

**More than one TV.** One pair covers as many as you like: point `mint` at the
next set and it adds that device, keeping the author certificate. That matters —
Tizen refuses to update an app whose author changed, and the way out is an
uninstall over sdb at every TV you already had.

---

## How it works

**Re-signing.** A Tizen package names the device it may be installed on, in its
distributor certificate:

    URI:URN:tizen:deviceid=CPCLIM2YRW7DO

From Tizen 7 the TV enforces it, so a `.wgt` installs on its builder's set and
nowhere else. Prebuilt widgets therefore cannot be handed around, and the TV is
given its own pair during setup: a set holding one re-signs everything it
installs, in about 150ms.

**Always on.** `config.xml` declares the service `on-boot` and `auto-restart`, so
it comes up with the television and updates apps on its own. Phones, though, are
let in only while the app is open on the TV, and for 15 minutes after it closes:
open Tizen Homebrew, then use the phone. A phone that loads the address with the
app closed is told to open it, and carries on by itself once it is. Under
**repos → phone access**, **always** lets phones in at any time, as before.

**Stopping when idle.** Automatic updates are **off** until chosen on the phone.
With them off and phones let in only while the app is open, the service has no
work while the app is closed, so it stops and gives its memory back: 90 seconds
after the TV starts if nobody opens the app, or when phone access closes after
the app does. Opening the app starts it again in a second or two. A TV that
starts a stopped service straight back is noticed after two such restarts, and
the service then stays up and waits, as before.

| Setting (configuration file) | Default | Range |
|---|---|---|
| `phoneAccess` | `whileOpen` | `whileOpen`, `always` |
| `phoneAccessMinutes` | 15 | 1–120 |
| `stopWhenIdle` | `true` | `true`, `false` |
| `stopAfterBootSeconds` | 90 | 15–3600 | Confirmed on a QE65S93DATXXN under a
partner certificate; both attributes are documented as partner and platform only,
whether a public pair gets them is untested, and dropping them returns the
service to starting when the app opens.

**Security.** The install endpoint is open to the network while phones are let
in (see above), gated by the 6-digit PIN: minted on first run, kept beside the signing keys, readable only
over loopback so a person has to relay it. Keeping it rather than regenerating
means a reboot neither unpairs every phone nor leaves the code readable only off
the screen the service exists to avoid. Phones store it per TV and drop it when
refused; five wrong guesses locks pairing for five minutes. The sdb relay is off
by default, takes a second opt-in to survive reboots, and refuses commands that
would disable it or uninstall the app.

**The log.** sdbd's allowlist excludes every log tool, so the app carries its
own. Press **show logs** on the TV; up/down a line, left/right a page, RED for
newest. `GET /logs?since=<seq>` returns the same records as JSON.

```
[    0.906] sdb: loopback 127.0.0.1:26101 answered — this TV can install its own apps
[   59.220] pkg: installed Tube 0.1.0 in 7.22s
```

**The catalog.** The app list is [`catalog/`](catalog/), published to GitHub
Pages. Adding an app is a commit there — no rebuild, nothing to reinstall.
`source.type` is `github` (newest release's first `.wgt`) or `url`. A `github`
app's logo is `logo.png` in its repository root, guessed rather than declared;
`icon` overrides it with an https URL, and an app with neither gets a monogram.

```json
{
  "id": "tube",
  "name": "YouTube",
  "description": "YouTube without the advertisements",
  "packageId": "tUb3Xq7Lm9",
  "source": { "type": "github", "ref": "owner/repo" }
}
```

**Updates.** `packageId` is the id an app installs under, and how a row knows it
is already on the TV: the platform answers that for every app at once, locally,
so the list never waits. Released versions are one GitHub request each — too much
for a two-hundred-app catalog on the way to a screen — so that half is a button:
three at a time, cached six hours, stopping early if GitHub starts refusing. Only
strictly newer by semver lights **update**; anything else gets a blocked button
and a line saying whether it is current or unchecked.

A collection entry has no package id until it is installed, so the pipeline
remembers which entry installed which package, and the sha256 of the file it
came from (`installedFrom` in the configuration). A version is read from the file
name where it has one (`Alpha-1.0.46.wgt`); where it has none (`Bravo.wgt`), a
file whose sha256 differs from the installed one is the update. A different file
at the *same* version is a **rebuild**: offered, never installed unasked.

**Your own name and icon.** The pencil beside an installed app sets a name and
a picture for it on the TV's home row (fitted to 512×512 on the phone). They are
kept by package id and written into the package before it is re-signed, so every
install and update of that app keeps them, wherever it comes from. **save &
reinstall** applies them now; **reset** goes back to the app's own.

**Checksums.** GitHub publishes a sha256 for every release asset, and a catalog
entry may state `sha256` itself. A download that does not match is refused before
anything opens it.

**Reading packages.** `.wgt` files are zips, and many are written with data
descriptors — sizes after the data rather than in the local header (Alpha,
Charlie and Bravo all are). `service/src/install/zip.js` reads the central
directory, walks local headers only when it has just the front of a file, and
bounds every inflate, since the TV's runtime (Node 12.16) predates
`maxOutputLength`.

**What a package says it is.** The phone shows the application rather than the
file it arrived in — name, version, install id and icon, read out of the archive
— covering a stick plugged into the TV and anything mid-install, the moment the
bytes are in hand. A `.wgt` chosen for upload is opened on the phone itself
(`ui/src/core/package.js`), so you can see what it is before sending it.

---

## Working on it

Nothing needs installing on your computer but Docker: `tools/docker.sh` runs
any of the commands below in a throwaway Node container, as you, with no extra
privileges (`tools/docker.sh npm ci`, then `tools/docker.sh npm test`). On Linux,
`DOCKER_NETWORK=host` lets it reach a TV by its address. `.npmrc` stops
dependencies running install scripts.

```sh
npm run dev          # both screens in a browser, no hardware needed
npm run dev:service  # the service off-TV, on :8091
npm test             # lint, protocol, PIN gate, install pipeline, re-signing
```

`npm run dev` serves the TV at `/tv.html`, the phone at `/index.html`, both at
`/preview.html`. With no TV around `ui/dev/service.js` answers, real protocol
over a real WebSocket; `HOMEBREW_TV=<tv-ip> npm run dev` points it at hardware.

The installer is a separate program in [`installer/`](installer/): Bun and
OpenTUI, compiled to one binary per platform. It calls `tools/` and `service/`
directly rather than reimplementing them, so the sdb client and the re-signer
have one implementation each.

```sh
cd installer && bun install && npm run natives   # every platform's renderer
bun run start                                    # or: --wgt <path>, --public
bun test
```

| Path | |
| --- | --- |
| `ui/src/views/television.js` | The TV screen: readouts, log console, credits |
| `ui/src/views/screens.js` | The phone UI |
| `ui/src/app.css` | The design system, one file |
| `ui/src/core/remote.js` | D-pad focus, so the TV page works by remote |
| `service/src/main.js` | Routes, and what the service is |
| `service/src/install/pipeline.js` | Install, six named steps |
| `service/src/install/resign.js` | Re-signing for this television |
| `service/src/install/updates.js` | What is installed, and what has been released since |
| `service/src/install/versions.js` | Semver, to the extent a release tag has one |
| `service/src/tv/sdb.js` | Loopback sdb with real timeouts |
| `service/src/obs/log.js` | The log everything else writes to |
| `installer/src/work.ts` | The installer's steps, calling the above |

Every one of those, and every tool in [`tools/`](tools/), opens with why it is
the way it is. The build enforces two platform floors that are easy to trip:
pages against Chromium 63, which drops CSS it cannot parse *silently*, and the
service bundle against Node 12.

**Releasing.** Pushing a tag builds the widget and the five installer binaries
and opens a draft release with them attached. Tag and version have to agree:

```sh
npm run version:set 1.2.0    # and commit
git tag v1.2.0 && git push origin v1.2.0
```

Publishing the draft is the last step and the one that offers the update: drafts
are invisible to `releases/latest`, which every TV and install script asks. The
widget is **unsigned** — a signature names one television, and every Tizen
Homebrew re-signs what it installs anyway, including itself. No secrets needed;
`HOMEBREW_CATALOG_URL` as a repository variable overrides the catalog origin.

---

## The look

Both screens are the Wii's Homebrew Channel, rebuilt: an ocean falling from a
lit surface to true black, god rays, bubbles, Frutiger Aero glass over the
water. Nothing was eyeballed — every color is sampled from the channel's own
artwork, `ui/src/scene/bubbles.js` ports `bubbles.c` constant for constant, and
the theme is its banner music cut to loop sample-exactly. Credits are on the TV.

---

Licensed GPL-3.0-only. Built on the work in the credits screen — the Homebrew
Channel, TizenBrew, TizenTube, and the people who worked out what a Samsung TV
will and will not allow.
