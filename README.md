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
| `server/` | Express + `ws`. Serves the web app and relays WebRTC offers, answers and ICE between the people in a room (up to 6; everyone connects directly to everyone else). | Media is peer-to-peer, so the server is tiny and cheap to host. |
| `web/` | Plain HTML/JS, no build step. Camera, mic, screen share (`getDisplayMedia`), chat, and a data channel that carries control events. | Anyone joins with a link, nothing to install for the helper. |
| `helper/` | DevAssist Helper, a small Tauri app the helped person downloads and double-clicks (no installer). Listens only on `127.0.0.1`, accepts only the DevAssist site's origin, shows a window while running and injects input with enigo. | Browsers cannot move the mouse or type into other apps, so a small local app is unavoidable for remote control. |
| `agent/` | Node version of the helper for development. Requires a pairing code. | Handy when hacking on the protocol without rebuilding the app. |

### Remote control flow

1. The person being helped shares their **entire screen**.
2. The helper clicks **Request control**. In a group call this asks the person whose screen is on the stage (when several people share, tap a camera in the strip to switch screens). If DevAssist Helper isn't running, the other person gets a download button for their OS; the page keeps checking and continues as soon as the app is open.
3. The other person sees an Allow / Deny dialog. The helper window turns red while they are being controlled.
4. While allowed, the helper's clicks, scroll and keys on the shared-screen video are sent over the WebRTC data channel, forwarded by the helped browser to the local agent, and injected.
5. Either side can stop: the helper with **Release control**, the helped person with **Revoke control**, stopping the share, or **Stop and quit** in the helper window.

Extras for dev work: chat renders in monospace (paste logs and commands), and
**Ctrl/Cmd+Shift+V** while controlling types the helper's clipboard on the remote machine.

## Session lifetime

Sessions close on their own so nobody leaves one open by accident:

- After 2 hours, whoever started the session gets a "Still in the session?" popup. If they don't press **Continue** within 5 minutes, the session closes for everyone. Pressing Continue starts another 2 hours. If the person who started it leaves, the next person in the call gets the popup instead.
- Leaving, or closing the tab or window, takes you out of the call and stops any remote control involving you. Everyone else stays in, and you can rejoin with the same link. The session closes once the last person leaves.

Tune with `SESSION_MINUTES` (default 120) and `SESSION_GRACE_MINUTES` (default 5) on the server. `MAX_PEERS` (default 6) caps how many people can be in a room.

## Camera tiles

With nobody sharing, everyone else's cameras fill the stage as a grid. Your camera, and the strip of everyone's cameras during a screen share, float over the stage and can be dragged anywhere (mouse or touch). The pop-out button on a camera opens a small always-on-top window with both cameras and a mic button, so you can keep seeing each other while working in another app. It uses Document Picture-in-Picture in Chrome and Edge, and falls back to the browser's video picture-in-picture in Safari.

## Pointers

While someone shares their screen, **Pointers** shows where everyone is pointing. Each person turns it on for themselves and gets their own color (the dot on the button), and their mouse over the shared screen appears, with their name, for everyone else who has it on. The person sharing sees the pointers drawn on their real screen when DevAssist Helper (0.1.2 or later) is open: it shows them in a transparent window that clicks pass through. Pointers are hidden while you are controlling, since the real mouse is moving then.

## Transcript

The person who started the meeting can turn on a transcript from the **Transcript** tab next to Chat and choose how voices are transcribed. Everyone else sees that it's on and reads along, with no settings to deal with. If the meeting starter leaves, the next person in the call gets the controls. Each person's browser transcribes only their own mic and shares the text, so every line carries the right name. Lines appear in the tab and as live captions over the stage, and **Download** saves them as a text file. Nothing is stored on the server.

The meeting starter's engine choice applies to everyone:

- **xAI**: short clips of each person's speech (cut at pauses) go through our server to [xAI](https://x.ai)'s speech-to-text (`grok-voice-transcribe-2.0`). It's fast and accurate, and needs `XAI_API_KEY` set on the server (optional `XAI_STT_MODEL`, `XAI_STT_URL`). The key never reaches the browser, only people currently in a call can use it, and each person is limited to 40 clips a minute. Without a key, everyone transcribes on device.
- **On device**: Whisper runs in each browser with [Transformers.js](https://github.com/huggingface/transformers.js) (`onnx-community/whisper-base`, on WebGPU where available, otherwise WebAssembly). Audio never leaves anyone's computer. Each browser downloads the model from Hugging Face once and caches it; it's slower on older machines and phones.

A language setting (any, English, Español) helps both engines when everyone speaks the same language.

## Hosts and admin

Only a signed-in host can start a meeting. Guests join with the host's link or room code, and anyone who opens a link before the host arrives waits on a "Waiting for the host" screen until the meeting starts. There are no sign-ups. The one account is created from `ADMIN_USERNAME` (default `marcah`), `ADMIN_EMAIL` (default `hc@marcah.com`) and `ADMIN_PASSWORD`. You sign in at `/login` with the username or the email. You can change the password at `/admin`, and setting `ADMIN_PASSWORD` to a new value resets it, which is the way back in if you forget it. Changing the password signs out every other browser.

`/admin` shows the meetings open right now (room, who's in it, how long it's been running, how much was transcribed), daily usage for the last 30 days, and the last 50 meetings. Meetings with a saved transcript have a **View** link that opens it, with a download button. The **Profile** tab has your display name (filled in for you when you start a call), username, email and password. Transcription cost is estimated at `XAI_PRICE_PER_HOUR` (default $0.10 per hour of audio). Accounts, the meeting log and usage live in `store.json` under `DATA_DIR` (default `./data`). On Railway that is a volume mounted at `/data`, so they survive deploys.

## Scheduled meetings and the waiting room

On the admin page, **Scheduled meetings** creates a meeting with a title, time and length, and copies its link. Before the host opens it, guests who follow the link see the title and time, and they join on their own once it starts. Each scheduled meeting can have a waiting room (on by default). Guests then knock, and the host, or anyone signed in, lets them in or turns them away from a card at the top of the call. For calls that aren't scheduled, the waiting room is a setting on the Profile page.

## Chat and files

Chat messages are bubbles with the time and a copy button. The chat starts closed; new messages float over the call, and tapping one opens it. You can attach, drop or paste files up to `MAX_FILE_MB` (default 25 MB). They're stored on the server only while the meeting is open, deleted when it ends, and only people in that meeting can download them. Images show a preview.

## Saved transcripts

The meeting starter can press **Save** in the Transcript tab to keep the transcript with the meeting. Saving again replaces it. Saved transcripts are listed on the admin page. Once it has been saved, the host's browser also saves the latest version when they leave.

## Summary and tasks

After a transcript is saved, Grok (xAI chat completions) writes a summary, the decisions made and a list of tasks. A task gets an owner only when the call makes it clear who took it; the rest are marked General. The admin page shows all of this in the meeting's **Summary and tasks** tab, along with an **agent prompt**: the host's tasks plus the General ones, with the context a coding agent needs, ready to copy and paste. Other people's tasks are listed only as context.

The model is `XAI_CHAT_MODEL` if set; otherwise the server tries `grok-4-fast`, then `grok-4`, then `grok-3-mini`, and keeps the first one that answers. A summary is rewritten at most once a minute.

## Noise filter

Each person's mic runs through [RNNoise](https://jmvalin.ca/demo/rnnoise/) (via [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor), MIT) before it is sent, so keyboards, fans, traffic and background chatter are removed and voices come through. It runs locally in the browser in an AudioWorklet; no audio leaves the call. It's on by default, the waveform button turns it off and on (the choice is remembered), and switching doesn't interrupt the call. The browser's built-in echo cancellation and noise suppression stay on underneath. Browsers that can't run it fall back to the plain mic and hide the button.

## Run locally

```bash
npm install
ADMIN_PASSWORD=pick-one npm start   # http://localhost:3000
npm run agent        # on the computer that will be controlled
```

Open `http://localhost:3000/login`, sign in as `marcah` with that password, start a room, and send the invite link. For use
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
to connect.marcah.com, the Railway URL and localhost:3000).

The builds are unsigned, so Windows SmartScreen and macOS Gatekeeper warn on
first open (Mac: right-click, Open). Code signing removes that for real users.

Dev agent options: `AGENT_PORT`, `AGENT_TOKEN` (fixed pairing code) and
`AGENT_ORIGINS` (comma-separated list of DevAssist URLs allowed to connect,
recommended in production).

OS permissions the agent needs: macOS asks for **Accessibility** (and Screen
Recording for the browser that shares); Windows works out of the box; Linux
needs X11 (Wayland blocks synthetic input).

## Known limits of this MVP

- Small groups only (6 by default). Everyone sends their video to everyone else, which works well up to about 4 to 6 people; bigger calls would need an SFU such as LiveKit or mediasoup.
- Control and the sharer's pointer overlay map onto the primary display; sharing a single window or a second monitor will misplace clicks and pointers.
- Helper builds are unsigned (see above).
- No accounts or recording. Rooms are open to anyone who has the link.

## Roadmap

1. Code-sign the helper for Windows and Mac.
2. TURN server and HTTPS deploy.
3. Multi-monitor selection and window-relative control.
4. Optional: file transfer over the data channel, session recording, auth.

## License

MIT, see [LICENSE](LICENSE).
