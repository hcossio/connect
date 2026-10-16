# DevAssist

A deliberately small Google Meet replacement for technical and developer support:
one helper, one person being helped, with video/audio, screen sharing, chat and
remote control of the helped person's computer.

## How it works

```
 Helper's browser  <──── WebRTC (video, audio, screen, data channel) ────>  Helped person's browser
        │                                                                          │
        └────────── signaling (WebSocket) ── server/ ── signaling ─────────────────┘
                                                                                   │ ws://127.0.0.1:47800
                                                                                   ▼
                                                              DevAssist Helper app (helper/) injects mouse + keyboard
```

| Piece | What it does | Why |
|---|---|---|
| `server/` | Express + `ws`. Serves the web app and relays WebRTC offers, answers and ICE between the two peers in a room. | Media is peer-to-peer, so the server is tiny and cheap to host. |
| `web/` | Plain HTML/JS, no build step. Camera, mic, screen share (`getDisplayMedia`), chat, and a data channel that carries control events. | Anyone joins with a link, nothing to install for the helper. |
| `helper/` | DevAssist Helper, a small Tauri app the helped person downloads and double-clicks (no installer). Listens only on `127.0.0.1`, accepts only the DevAssist site's origin, shows a window while running and injects input with enigo. | Browsers cannot move the mouse or type into other apps, so a small local app is unavoidable for remote control. |
| `agent/` | Node version of the helper for development. Requires a pairing code. | Handy when hacking on the protocol without rebuilding the app. |

### Remote control flow

1. The person being helped shares their **entire screen**.
2. The helper clicks **Request control**. If DevAssist Helper isn't running, the other person gets a download button for their OS; the page keeps checking and continues as soon as the app is open.
3. The other person sees an Allow / Deny dialog. The helper window turns red while they are being controlled.
4. While allowed, the helper's clicks, scroll and keys on the shared-screen video are sent over the WebRTC data channel, forwarded by the helped browser to the local agent, and injected.
5. Either side can stop: the helper with **Release control**, the helped person with **Revoke control**, stopping the share, or **Stop and quit** in the helper window.

Extras for dev work: chat renders in monospace (paste logs and commands), and
**Ctrl/Cmd+Shift+V** while controlling types the helper's clipboard on the remote machine.

## Session lifetime

Sessions close on their own so nobody leaves one open by accident:

- After 2 hours, whoever started the session gets a "Still in the session?" popup. If they don't press **Continue** within 5 minutes, the session closes for both people. Pressing Continue starts another 2 hours.
- Leaving, or closing the tab or window, ends the session for both people (remote control stops with it).

Tune with `SESSION_MINUTES` (default 120) and `SESSION_GRACE_MINUTES` (default 5) on the server.

## Noise filter

Each person's mic runs through [RNNoise](https://jmvalin.ca/demo/rnnoise/) (via [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor), MIT) before it is sent, so keyboards, fans, traffic and background chatter are removed and voices come through. It runs locally in the browser in an AudioWorklet; no audio leaves the call. It's on by default, the waveform button turns it off and on (the choice is remembered), and switching doesn't interrupt the call. The browser's built-in echo cancellation and noise suppression stay on underneath. Browsers that can't run it fall back to the plain mic and hide the button.

## Run locally

```bash
npm install
npm start            # http://localhost:3000
npm run agent        # on the computer that will be controlled
```

Open `http://localhost:3000`, join a room, and send the invite link. For use
across the internet, serve it over HTTPS (camera and screen APIs require a
secure origin) and add a TURN server to `ICE_SERVERS` in `web/app.js`
(coturn, or a hosted one) or calls behind strict NATs will fail.

### Helper app

```bash
cd helper && npm ci && npx tauri dev     # run locally
```

Builds for Windows (portable .exe), Mac (universal .dmg) and Linux (AppImage)
come from `.github/workflows/helper.yml`. Merging a change under `helper/` into main (or running the
"Helper app" workflow manually) publishes them as the GitHub release
`helper-v<version>`; bump `version` in `helper/package.json` and
`helper/src-tauri/tauri.conf.json` for a new release. the server's `/download/<os>` route points
there. While the repo is private, set `GITHUB_TOKEN` on the server (a
fine-grained token with read access to this repo's contents) so downloads work.
Allowed web origins are baked in at build time (`DEVASSIST_ORIGINS`, defaults
to the Railway URL and localhost:3000).

The builds are unsigned, so Windows SmartScreen and macOS Gatekeeper warn on
first open (Mac: right-click, Open). Code signing removes that for real users.

Dev agent options: `AGENT_PORT`, `AGENT_TOKEN` (fixed pairing code) and
`AGENT_ORIGINS` (comma-separated list of DevAssist URLs allowed to connect,
recommended in production).

OS permissions the agent needs: macOS asks for **Accessibility** (and Screen
Recording for the browser that shares); Windows works out of the box; Linux
needs X11 (Wayland blocks synthetic input).

## Known limits of this MVP

- 1:1 rooms only (two people). Group calls would need an SFU such as LiveKit or mediasoup.
- Control maps onto the primary display; sharing a single window or a second monitor will misplace clicks.
- Helper builds are unsigned (see above).
- No accounts or recording. Rooms are open to anyone who has the link.

## Roadmap

1. Code-sign the helper for Windows and Mac.
2. TURN server and HTTPS deploy.
3. Multi-monitor selection and window-relative control.
4. Optional: file transfer over the data channel, session recording, auth.

## License

MIT, see [LICENSE](LICENSE).
