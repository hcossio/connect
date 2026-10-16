// Signaling server: serves the web app and relays WebRTC offers/answers/ICE
// between the (max 2) peers in a room. Media never touches this server.
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 2; // support sessions are 1:1 (helper + person being helped)

const app = express();
app.use(express.static(path.join(__dirname, '..', 'web')));
app.get('/health', (_req, res) => res.json({ ok: true }));
// Any /r/<room> path loads the app; the client reads the room from the URL.
app.get('/r/:room', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

// Helper app downloads. Builds are attached to GitHub releases by
// .github/workflows/helper.yml. For a private repo, set GITHUB_TOKEN (read-only,
// contents:read) and the server hands out short-lived signed links instead.
const HELPER_REPO = process.env.HELPER_REPO || 'hcossio/connect';
const HELPER_ASSETS = {
  windows: 'DevAssist-Helper-windows.exe',
  mac: 'DevAssist-Helper-mac.dmg',
  linux: 'DevAssist-Helper-linux.AppImage',
};
app.get('/download/:os', async (req, res) => {
  const name = HELPER_ASSETS[req.params.os];
  if (!name) return res.status(404).send('Unknown platform');
  const override = process.env[`HELPER_URL_${req.params.os.toUpperCase()}`];
  if (override) return res.redirect(override);
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.redirect(`https://github.com/${HELPER_REPO}/releases/latest/download/${name}`);
  try {
    const gh = { Authorization: `Bearer ${token}`, 'User-Agent': 'devassist' };
    const rel = await fetch(`https://api.github.com/repos/${HELPER_REPO}/releases/latest`, { headers: gh });
    if (!rel.ok) throw new Error(`release lookup ${rel.status}`);
    const asset = (await rel.json()).assets.find((a) => a.name === name);
    if (!asset) throw new Error(`asset ${name} missing`);
    // GitHub answers with a redirect to a signed, short-lived download URL.
    const dl = await fetch(asset.url, { headers: { ...gh, Accept: 'application/octet-stream' }, redirect: 'manual' });
    const location = dl.headers.get('location');
    if (!location) throw new Error(`asset download ${dl.status}`);
    res.redirect(location);
  } catch (err) {
    console.error('helper download failed:', err.message);
    res.status(502).send('The helper download is not available yet.');
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Sessions end on their own so nobody leaves one open by accident: after
// SESSION_MINUTES the person who started it is asked to continue, and if they
// don't answer within GRACE_MINUTES the session closes for everyone. A session
// also ends as soon as either person leaves or closes their window.
const SESSION_MS = Number(process.env.SESSION_MINUTES || 120) * 60_000;
const GRACE_MS = Number(process.env.SESSION_GRACE_MINUTES || 5) * 60_000;

/**
 * @typedef {{ peers: Set<import('ws')>, host: import('ws'), checkTimer?: NodeJS.Timeout, graceTimer?: NodeJS.Timeout }} Room
 * @type {Map<string, Room>}
 */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function scheduleCheck(room) {
  clearTimeout(room.checkTimer);
  clearTimeout(room.graceTimer);
  room.checkTimer = setTimeout(() => {
    send(room.host, { type: 'session-check' });
    room.graceTimer = setTimeout(() => endSession(room, 'timeout'), GRACE_MS);
  }, SESSION_MS);
}

function endSession(room, reason, leaver) {
  clearTimeout(room.checkTimer);
  clearTimeout(room.graceTimer);
  for (const [name, r] of rooms) if (r === room) rooms.delete(name);
  for (const p of room.peers) {
    if (p === leaver) continue;
    send(p, { type: 'session-ended', reason, by: leaver?.displayName });
    p.close(4000, 'session ended');
  }
  room.peers.clear();
}

wss.on('connection', (ws) => {
  /** @type {Room | null} */
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.room || '').slice(0, 64);
      if (!name || room) return;
      let r = rooms.get(name);
      if (r && r.peers.size >= MAX_PEERS) return send(ws, { type: 'full' });
      ws.displayName = String(msg.name || 'Guest').slice(0, 40);
      if (!r) {
        r = { peers: new Set(), host: ws };
        rooms.set(name, r);
        scheduleCheck(r);
      }
      room = r;
      r.peers.add(ws);
      // The second peer to arrive is told to make the offer.
      send(ws, { type: 'joined', initiator: r.peers.size === 2, host: r.host === ws });
      for (const p of r.peers) if (p !== ws) send(p, { type: 'peer-joined', name: ws.displayName });
      return;
    }

    if (!room) return;

    if (msg.type === 'session-continue') {
      if (room.host === ws) scheduleCheck(room);
      return;
    }

    // Everything else (offer/answer/ice) is relayed to the other peer.
    for (const p of room.peers) if (p !== ws) send(p, msg);
  });

  // Leaving or closing the window ends the session for both people.
  ws.on('close', () => {
    if (room && room.peers.has(ws)) endSession(room, 'left', ws);
  });
});

// Ping clients so idle proxies keep the socket open and dead ones are noticed.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`DevAssist running on http://localhost:${PORT}`));
