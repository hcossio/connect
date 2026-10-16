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
                                                                         agent/ (injects mouse + keyboard)
```

| Piece | What it does | Why |
|---|---|---|
| `server/` | Express + `ws`. Serves the web app and relays WebRTC offers, answers and ICE between the two peers in a room. | Media is peer-to-peer, so the server is tiny and cheap to host. |
| `web/` | Plain HTML/JS, no build step. Camera, mic, screen share (`getDisplayMedia`), chat, and a data channel that carries control events. | Anyone joins with a link, nothing to install for the helper. |
| `agent/` | Node process on the helped computer. Listens only on `127.0.0.1`, requires a pairing code, injects input with nut.js. | Browsers cannot move the mouse or type into other apps, so a small local helper is unavoidable for remote control. |

### Remote control flow

1. The person being helped shares their **entire screen** and runs the agent (`npm run agent`), then clicks **Connect agent** and pastes the pairing code it prints.
2. The helper clicks **Request control**; the other person sees an Allow / Deny dialog.
3. While allowed, the helper's clicks, scroll and keys on the shared-screen video are sent over the WebRTC data channel, forwarded by the helped browser to the local agent, and injected.
4. Either side can stop: the helper with **Release control**, the helped person with **Revoke control**, stopping the share, or Ctrl+C on the agent.

Extras for dev work: chat renders in monospace (paste logs and commands), and
**Ctrl/Cmd+Shift+V** while controlling types the helper's clipboard on the remote machine.

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

Agent options: `AGENT_PORT`, `AGENT_TOKEN` (fixed pairing code) and
`AGENT_ORIGINS` (comma-separated list of DevAssist URLs allowed to connect,
recommended in production).

OS permissions the agent needs: macOS asks for **Accessibility** (and Screen
Recording for the browser that shares); Windows works out of the box; Linux
needs X11 (Wayland blocks synthetic input).

## Known limits of this MVP

- 1:1 rooms only (two people). Group calls would need an SFU such as LiveKit or mediasoup.
- Control maps onto the primary display; sharing a single window or a second monitor will misplace clicks.
- The agent is a Node script. Packaging it as a one-click Tauri or Electron app is the next step so non-developers can run it.
- No accounts or recording. Rooms are open to anyone who has the link.

## Roadmap

1. Package the agent (Tauri) with a tray icon and an always-visible "being controlled" indicator.
2. TURN server and HTTPS deploy.
3. Multi-monitor selection and window-relative control.
4. Optional: file transfer over the data channel, session recording, auth.
