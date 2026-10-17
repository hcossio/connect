// Signaling server: serves the web app and relays WebRTC offers/answers/ICE
// between the people in a room. Every pair connects directly (a mesh), so
// media never touches this server.
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');
const auth = require('./auth');

const PORT = process.env.PORT || 3000;
// Each person sends their camera to everyone else, so small groups only.
const MAX_PEERS = Number(process.env.MAX_PEERS || 6);

const app = express();
app.set('trust proxy', 1); // Railway terminates HTTPS in front of us
auth.routes(app, express);
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'login.html')));
app.get('/admin', auth.requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'admin.html')));
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/vendor/noise', express.static(path.dirname(require.resolve('@sapphi-red/web-noise-suppressor')), { maxAge: '7d' }));
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

// ---------- Transcript (xAI) ----------
// Each person sends short clips of their own mic here and we pass them to
// xAI's speech-to-text (Grok Voice Transcribe), so the API key never reaches
// the browser. Only people
// currently in a call can use it (they get a token when they join), and each
// is rate limited. Nothing is stored.
const XAI_KEY = process.env.XAI_API_KEY;
const XAI_URL = process.env.XAI_STT_URL || 'https://api.x.ai/v1/stt';
const XAI_MODEL = process.env.XAI_STT_MODEL || 'grok-voice-transcribe-2.0';
const CLIPS_PER_MINUTE = 40;
/** token -> the person's socket, while they are in a call */
const callers = new Map();
app.post('/api/transcribe', express.raw({ type: 'audio/wav', limit: '2mb' }), async (req, res) => {
  const ws = callers.get(req.get('x-token'));
  if (!ws) return res.status(403).json({ error: 'Not in a call' });
  if (!XAI_KEY) return res.status(503).json({ error: 'xAI transcription is not set up on this server' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No audio' });
  const now = Date.now();
  ws.clips = (ws.clips || []).filter((t) => now - t < 60_000);
  if (ws.clips.length >= CLIPS_PER_MINUTE) return res.status(429).json({ error: 'Too many clips' });
  ws.clips.push(now);
  const form = new FormData();
  form.append('model', XAI_MODEL);
  const lang = String(req.query.lang || '');
  if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);
  form.append('file', new Blob([req.body], { type: 'audio/wav' }), 'clip.wav'); // xAI wants the file last
  try {
    const r = await fetch(XAI_URL, { method: 'POST', headers: { Authorization: `Bearer ${XAI_KEY}` }, body: form });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('xai transcribe failed:', r.status, JSON.stringify(out.error || out).slice(0, 300));
      return res.status(502).json({ error: 'xAI could not transcribe this clip' });
    }
    store.addClip(ws.meeting, Math.max(0, req.body.length - 44) / 32_000); // 16 kHz, 16-bit mono WAV
    res.json({ text: String(out.text || '') });
  } catch (err) {
    console.error('xai transcribe failed:', err.message);
    res.status(502).json({ error: 'xAI is unreachable' });
  }
});

// What the admin page shows: meetings open now, recent ones and daily usage.
const XAI_PRICE_PER_HOUR = Number(process.env.XAI_PRICE_PER_HOUR || 0.10);
app.get('/api/admin/stats', auth.requireAdmin, (_req, res) => {
  const open = [...new Set(rooms.values())].map((r) => ({
    room: r.meeting.room,
    startedAt: r.meeting.startedAt,
    by: r.meeting.by,
    host: r.host.displayName,
    people: [...r.peers].map((p) => p.displayName),
    clips: r.meeting.clips || 0,
    audioSec: r.meeting.audioSec || 0,
  }));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ day, ...(store.data.usage[day] || { meetings: 0, minutes: 0, clips: 0, audioSec: 0 }) });
  }
  const today = days[days.length - 1];
  for (const m of open) today.minutes += (Date.now() - Math.max(m.startedAt, Date.parse(today.day))) / 60_000; // still running
  const recent = store.data.meetings.filter((m) => m.endedAt).slice(-50).reverse();
  res.json({ open, days, recent, pricePerHour: XAI_PRICE_PER_HOUR, cloud: !!XAI_KEY });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// Sessions end on their own so nobody leaves one open by accident: after
// SESSION_MINUTES the person who started it is asked to continue, and if they
// don't answer within GRACE_MINUTES the session closes for everyone. When
// someone leaves or closes their window the others carry on and anyone can
// rejoin with the same link; the room goes away once the last person leaves.
const SESSION_MS = Number(process.env.SESSION_MINUTES || 120) * 60_000;
const GRACE_MS = Number(process.env.SESSION_GRACE_MINUTES || 5) * 60_000;

/**
 * @typedef {{ peers: Set<import('ws')>, host: import('ws'), checking: boolean, checkTimer?: NodeJS.Timeout, graceTimer?: NodeJS.Timeout }} Room
 * @type {Map<string, Room>}
 */
const rooms = new Map();
let nextId = 1;

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function scheduleCheck(room) {
  clearTimeout(room.checkTimer);
  clearTimeout(room.graceTimer);
  room.checking = false;
  room.checkTimer = setTimeout(() => {
    room.checking = true;
    send(room.host, { type: 'session-check' });
    room.graceTimer = setTimeout(() => endSession(room, 'timeout'), GRACE_MS);
  }, SESSION_MS);
}

function endSession(room, reason, leaver) {
  clearTimeout(room.checkTimer);
  clearTimeout(room.graceTimer);
  for (const [name, r] of rooms) if (r === room) rooms.delete(name);
  if (!room.meeting.endedAt) store.endMeeting(room.meeting);
  for (const p of room.peers) {
    if (p === leaver) continue;
    send(p, { type: 'session-ended', reason, by: leaver?.displayName });
    p.close(4000, 'session ended');
  }
  room.peers.clear();
}

wss.on('connection', (ws, req) => {
  ws.user = auth.userFrom(req); // signed in: allowed to start meetings
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
      // Only signed-in people start meetings; guests wait until one is open.
      if (!r && !ws.user) return send(ws, { type: 'not-started' });
      if (r && r.peers.size >= MAX_PEERS) return send(ws, { type: 'full', max: MAX_PEERS });
      ws.displayName = String(msg.name || 'Guest').slice(0, 40);
      ws.peerId = nextId++;
      ws.token = crypto.randomUUID();
      callers.set(ws.token, ws);
      if (!r) {
        r = { peers: new Set(), host: ws, checking: false };
        r.meeting = { room: name, startedAt: Date.now(), by: ws.user.username, host: ws.displayName, names: [], peak: 0, clips: 0, audioSec: 0 };
        store.addMeeting(r.meeting);
        rooms.set(name, r);
        scheduleCheck(r);
      }
      room = r;
      ws.meeting = r.meeting;
      if (!r.meeting.names.includes(ws.displayName) && r.meeting.names.length < 20) r.meeting.names.push(ws.displayName);
      r.meeting.peak = Math.max(r.meeting.peak, r.peers.size + 1);
      const others = [...r.peers].map((p) => ({ id: p.peerId, name: p.displayName }));
      r.peers.add(ws);
      send(ws, { type: 'joined', id: ws.peerId, host: r.host === ws, hostId: r.host.peerId, peers: others, token: ws.token, cloud: !!XAI_KEY });
      for (const p of r.peers) if (p !== ws) send(p, { type: 'peer-joined', id: ws.peerId, name: ws.displayName });
      return;
    }

    if (!room) return;

    if (msg.type === 'session-continue') {
      if (room.host === ws) scheduleCheck(room);
      return;
    }

    // Everything else (offer/answer/ice) goes to the one person it names.
    for (const p of room.peers) if (p.peerId === msg.to) send(p, { ...msg, from: ws.peerId });
  });

  ws.on('close', () => {
    callers.delete(ws.token);
    if (!room || !room.peers.has(ws)) return;
    room.peers.delete(ws);
    if (!room.peers.size) return endSession(room, 'left', ws);
    for (const p of room.peers) send(p, { type: 'peer-left', id: ws.peerId, name: ws.displayName });
    // Someone still has to be asked whether to continue: pass it on.
    if (room.host === ws) {
      room.host = room.peers.values().next().value;
      for (const p of room.peers) send(p, { type: 'host', id: room.host.peerId });
      if (room.checking) send(room.host, { type: 'session-check' });
    }
  });
});

// Ping clients so idle proxies keep the socket open and dead ones are noticed.
const heartbeat = setInterval(() => {
  for (const r of rooms.values()) r.meeting.lastSeen = Date.now(); // so a restart can tell when they ended
  if (rooms.size) store.save();
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`DevAssist running on http://localhost:${PORT}`));
