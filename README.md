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
**Clipboard while controlling** (DevAssist Helper 0.1.3 or later): **Ctrl/Cmd+V** puts your clipboard on their computer and pastes it, and anything they or you copy on their computer lands on your clipboard (if your browser window doesn't have focus at that moment, it shows up in the chat to copy). **Ctrl/Cmd+Shift+V** types your clipboard instead, for fields that block pasting. The clipboard is only shared while you are in control. With an older helper, Ctrl/Cmd+V pastes their own clipboard.

## Session lifetime

Sessions close on their own so nobody leaves one open by accident:

- After 2 hours, whoever started the session gets a "Still in the session?" popup. If they don't press **Continue** within 5 minutes, the session closes for everyone. Pressing Continue starts another 2 hours. If the person who started it leaves, the next person in the call gets the popup instead.
- Leaving, or closing the tab or window, takes you out of the call and stops any remote control involving you. Everyone else stays in, and you can rejoin with the same link. The session closes once the last person leaves.

Tune with `SESSION_MINUTES` (default 120) and `SESSION_GRACE_MINUTES` (default 5) on the server. How many people can be in a call is set on the admin page under **Settings**: a limit (6 by default, or `MAX_PEERS` the first time the server starts) that can be changed or turned off without a redeploy.

## Camera tiles

With nobody sharing, everyone else's cameras fill the stage as a grid. Your camera, and the strip of everyone's cameras during a screen share, float over the stage and can be dragged anywhere (mouse or touch). Drag a card's bottom-left corner to make it bigger or smaller (double-click the corner to reset), and drop a moved card on the highlighted band at the right edge to dock it back in place. When several people share their screens at once, the screens show side by side; click one to see only that screen. **Invite on WhatsApp** (next to Copy link, and in the settings menu) opens WhatsApp with the call link ready to send. The pop-out button on a camera opens a small always-on-top window with both cameras and a mic button, so you can keep seeing each other while working in another app. It uses Document Picture-in-Picture in Chrome and Edge, and falls back to the browser's video picture-in-picture in Safari. Switching to another app or tab pops the call out on its own where the browser allows it (Safari, and Chrome versions with automatic picture-in-picture). Phones may still pause your own camera while you're in another app; when you come back, a camera or mic the phone stopped is started again. **Reset layout** in the settings menu puts the camera cards back where and how big they started.

## Pointers

**Pointers**, **Draw**, **Control** and **Browser** are switches in the **Tools** menu (the shapes button in the dock); a dot on it shows one is on.

While someone shares their screen, **Pointers** shows where everyone is pointing. Each person turns it on for themselves and gets their own color (the dot next to it in the menu), and their mouse over the shared screen appears, with their name, for everyone else who has it on. The person sharing sees the pointers drawn on their real screen when DevAssist Helper (0.1.2 or later) is open: it shows them in a transparent window that clicks pass through. Pointers are hidden while you are controlling, since the real mouse is moving then.

## Shared browser

**Browser** opens a web browser that runs on the server, so everyone in the call sees the same page without anyone sharing their screen. One person is in control at a time: whoever opened it starts in control, and anyone can press **Take over** (or type an address) to drive. Everyone's mouse over the page shows up for the others with their name. On a phone, tap to click, drag to scroll, and use the keyboard button to type. It needs Chromium on the server (`railpack.json` installs it on Railway; set `CHROMIUM_PATH` elsewhere). The browser can't open localhost or private network addresses (`BROWSER_ALLOW_PRIVATE=1` allows them for local testing), and at most `BROWSER_MAX` (default 4) calls can have one open at once. It presents itself as an everyday Chrome on Windows and searches with DuckDuckGo, but some sites still refuse visitors from cloud server addresses.

## Drawing and the whiteboard

**Draw** puts a toolbar over the screen on the stage: a marker, squares, circles and arrows (hold Shift for a perfect square or circle), seven colors and three widths. A shape you just drew shows corner handles to resize it, and the move tool picks up any of your drawings to move or resize it (Delete removes it, Ctrl+Z undoes). Everyone sees the drawings in place on their own device, phones included, because positions are kept as fractions of the screen. Whoever is sharing can press **See my screen** to watch their own screen with the drawings on it. Drawings on a screen go away when that person stops sharing.

The host's toolbar also has the **whiteboard**, which takes the stage for everyone; anyone can draw on it and put images on it (the image button, or drop or paste an image). The host can **hide everyone else's drawings**, which also stops others drawing until it's turned back on, and **erase everyone's drawings** on the current screen or board. Someone who joins later gets the whiteboard and the drawings from the host. The code is in `web/board.js`.

## People in the call

Each name tag shows whether the person is on a phone or a computer, and a crossed-out mic when they're muted. **React** sends an emoji that floats up the stage and over your camera, and has **Raise hand**: a hand shows on your camera for everyone, and the host can lower it by clicking it. The host can mute anyone from the button on their camera, or everyone from the settings menu; only the person can unmute themselves. The code is in `web/people.js`.

## Transcript

The person who started the meeting can turn on a transcript from the **Transcript** tab next to Chat and choose how voices are transcribed. Everyone else sees that it's on and reads along, with no settings to deal with. If the meeting starter leaves, the next person in the call gets the controls. Each person's browser transcribes only their own mic and shares the text, so every line carries the right name. Lines appear in the tab and as live captions over the stage, and **Download** saves them as a text file. Nothing is stored on the server.

The meeting starter's engine choice applies to everyone:

- **xAI**: short clips of each person's speech (cut at pauses) go through our server to [xAI](https://x.ai)'s speech-to-text (`grok-voice-transcribe-2.0`). It's fast and accurate, and needs `XAI_API_KEY` set on the server (optional `XAI_STT_MODEL`, `XAI_STT_URL`). The key never reaches the browser, only people currently in a call can use it, and each person is limited to 40 clips a minute. Without a key, everyone transcribes on device.
- **On device**: Whisper runs in each browser with [Transformers.js](https://github.com/huggingface/transformers.js) (`onnx-community/whisper-base`, on WebGPU where available, otherwise WebAssembly). Audio never leaves anyone's computer. Each browser downloads the model from Hugging Face once and caches it; it's slower on older machines and phones.

A language setting (any, English, Español) helps both engines when everyone speaks the same language.

## Hosts and admin

Only a signed-in host can start a meeting. Guests join with the host's link or room code, and anyone who opens a link before the host arrives waits on a "Waiting for the host" screen until the meeting starts. There are no sign-ups. The one account is created from `ADMIN_USERNAME` (default `marcah`), `ADMIN_EMAIL` (default `hc@marcah.com`) and `ADMIN_PASSWORD`. You sign in at `/login` with the username or the email. You can change the password at `/admin`, and setting `ADMIN_PASSWORD` to a new value resets it, which is the way back in if you forget it. Changing the password signs out every other browser.

`/admin` opens on a **Dashboard**: totals for the last 30 days, the meetings open right now and the next scheduled ones (five of each, with a link to all). Its tabs hold the rest, ten rows a page: **Meetings** (open, scheduled and finished), **Usage** (by day), **Recordings**, **Connections** (the connection logs) and **Settings** (the call size limit). Meetings with a saved transcript have a **View** link that opens it, with a download button. The **Profile** tab has your display name (filled in for you when you start a call), username, email and password. Transcription cost is estimated at `XAI_PRICE_PER_HOUR` (default $0.10 per hour of audio). Accounts, the meeting log and usage live in `store.json` under `DATA_DIR` (default `./data`). On Railway that is a volume mounted at `/data`, so they survive deploys.

## Remote control recordings

When you control someone's computer while signed in, your browser records what you see of their screen, with both voices, and uploads it to the server every few seconds. The other person sees a **Recorded** badge on their "is controlling your computer" bar and a note in the chat. Recordings appear on the admin page, where you can play, download or delete them. They are stored on the data volume (`DATA_DIR/recordings`). One recording stops at `RECORDING_MAX_MB` (default 1000), and the oldest are deleted once all of them pass `RECORDING_TOTAL_MB` (default 2000). You can turn recording off on the Profile page.

## Scheduled meetings and the waiting room

On the admin page, **Scheduled meetings** creates a meeting with a title, time and length, and copies its link. Before the host opens it, guests who follow the link see the title and time, and they join on their own once it starts. Each scheduled meeting can have a waiting room (on by default). Guests then knock, and the host, or anyone signed in, lets them in or turns them away from a card at the top of the call. Someone who was already let in and drops out (a reload, a lost connection, closing the tab) comes straight back in from the same browser while that meeting is still running, without knocking again. For calls that aren't scheduled, the waiting room is a setting on the Profile page.

When a meeting link is pasted into WhatsApp, iMessage, Slack and other apps, its preview shows the meeting's title, date, time, length and time zone, with a picture card drawn by the server's Chromium (`/og/<room>.png`). The time is shown in the time zone of the browser that scheduled the meeting (meetings scheduled before this existed use `DEFAULT_TZ`, America/New_York unless set). The **WhatsApp** button next to each scheduled meeting, and **Invite on WhatsApp** in the call, write the title and time into the message too. Links to calls that aren't scheduled show a general "Join my call" card.

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
secure origin) and set up a relay (below) or calls behind strict NATs will fail.

### Relay (TURN) for networks that block direct calls

Calls connect browser to browser. Many mobile carriers, and laptops on a phone's hotspot, sit behind a shared carrier address (carrier-grade NAT) that blocks that, and the call shows **Connection failed** unless a relay forwards the media. The server hands each browser the relay's details when it joins; set one of:

- `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_TOKEN`: a TURN key from Cloudflare (dashboard, Realtime, TURN Server, Create). The server asks Cloudflare for credentials that last a day and renews them. The first 1,000 GB a month are free.
- `TURN_URLS` (comma-separated `turn:` / `turns:` URLs) with `TURN_USERNAME` and `TURN_CREDENTIAL`, or with `TURN_SECRET` for coturn's `use-auth-secret`.

The admin page shows how much went through the relay this month next to the 1,000 GB free allowance. Each browser counts what it received through the relay and reports it every 30 seconds; with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (a token with Account Analytics read) set too, the card shows Cloudflare's own count instead, which is what it bills.

Without one, only STUN is used and those calls fail. Calls that can connect directly still do; only the ones that can't use the relay. A call whose path breaks (say, a phone moving from wifi to mobile data) looks for a new one on its own.

### Connection logs

Each meeting's joins and leaves (phone or computer, browser), and how every call in it connected (direct or through the relay, round-trip time) or why it failed (the network paths each side found, network errors), are kept for 7 days in `DATA_DIR/connlogs/`, one file per day. The admin page lists them under **Connection logs**, with each meeting's events and a download.

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
2. Multi-monitor selection and window-relative control.
3. Optional: file transfer over the data channel, session recording, auth.

## License

MIT, see [LICENSE](LICENSE).
