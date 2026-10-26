// Signaling server: serves the web app and relays WebRTC offers/answers/ICE
// between the people in a room. Every pair connects directly (a mesh), so
// media never touches this server.
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const store = require('./store');
const auth = require('./auth');
const summary = require('./summary');
const sharedBrowser = require('./browser');
const preview = require('./preview');
const turn = require('./turn');
const connlog = require('./connlog');

const PORT = process.env.PORT || 3000;
// Each person sends their camera to everyone else, so small groups only.
const MAX_PEERS = Number(process.env.MAX_PEERS || 6);

const app = express();
app.set('trust proxy', 1); // Railway terminates HTTPS in front of us
auth.routes(app, express);
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'login.html')));
app.get('/admin', auth.requireAdmin, (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'admin.html')));
// The app page carries link-preview tags: a scheduled meeting's link shows its title, date and time.
const origin = (req) => `${req.protocol}://${req.get('host')}`;
const appPage = (req, res, room) => {
  const s = room ? scheduledFor(room) : null;
  res.type('html').set('Cache-Control', 'no-cache').send(preview.page(s, origin(req), room, origin(req) + req.originalUrl.split('?')[0]));
};
app.get('/', (req, res) => appPage(req, res, null));
app.use(express.static(path.join(__dirname, '..', 'web')));
app.use('/vendor/noise', express.static(path.dirname(require.resolve('@sapphi-red/web-noise-suppressor')), { maxAge: '7d' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
// Any /r/<room> path loads the app; the client reads the room from the URL.
app.get('/r/:room', (req, res) => appPage(req, res, req.params.room));
// The picture in a scheduled meeting's link preview.
app.get('/og/:room.png', async (req, res) => {
  const s = scheduledFor(req.params.room);
  const png = s && (await preview.card(s).catch((e) => { console.error('preview card failed', e.message); return null; }));
  if (!png) return res.redirect('/img/og.png');
  res.type('png').set('Cache-Control', 'public, max-age=3600').send(png);
});

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
    id: r.meeting.id,
    room: r.meeting.room,
    title: r.meeting.title,
    waiting: r.waiting.size,
    transcriptLines: r.meeting.transcript?.lines.length || 0,
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
    days.push({ day, meetings: 0, minutes: 0, clips: 0, audioSec: 0, relaySent: 0, relayRecv: 0, ...store.data.usage[day] });
  }
  const today = days[days.length - 1];
  for (const m of open) today.minutes += (Date.now() - Math.max(m.startedAt, Date.parse(today.day))) / 60_000; // still running
  const recent = store.data.meetings.filter((m) => m.endedAt).slice(-50).reverse()
    .map(({ transcript, summary: s, ...m }) => ({ ...m, transcriptLines: transcript?.lines.length || 0, tasks: s?.tasks?.length ?? null }));
  res.json({ open, days, recent, pricePerHour: XAI_PRICE_PER_HOUR, cloud: !!XAI_KEY, relay: { ...turn.status(), cloudflare: turn.cloudflareUsage() } });
});

// ---------- Temporary files ----------
// Files shared in a meeting's chat are kept on disk only while the meeting is
// open, and only people in that meeting can download them.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 25);
const FILE_DIR = path.join(os.tmpdir(), 'devassist-files');
fs.rmSync(FILE_DIR, { recursive: true, force: true }); // left over from before a restart
fs.mkdirSync(FILE_DIR, { recursive: true });
/** id -> { room, name, type, size, path } */
const files = new Map();
const roomOf = (token) => callers.get(token)?.room;

app.post('/api/files', express.raw({ type: () => true, limit: `${MAX_FILE_MB}mb` }), (req, res) => {
  const ws = callers.get(req.get('x-token'));
  if (!ws?.room) return res.status(403).json({ error: 'Not in a call' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty file' });
  const id = crypto.randomUUID();
  const name = String(req.query.name || 'file').replace(/[\\/\0-\x1f]/g, '_').slice(0, 200) || 'file';
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.get('content-type') || '') ? req.get('content-type') : 'application/octet-stream';
  const file = { room: ws.room, name, type, size: req.body.length, path: path.join(FILE_DIR, id) };
  fs.writeFileSync(file.path, req.body);
  files.set(id, file);
  ws.room.files.add(id);
  res.json({ id, name, type, size: file.size });
});
app.use('/api/files', (err, _req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Files can be up to ${MAX_FILE_MB} MB` });
  next(err);
});
app.get('/files/:id/:name', (req, res) => {
  const file = files.get(req.params.id);
  if (!file || roomOf(String(req.query.t || '')) !== file.room) return res.status(404).send('This file is gone. Files are only kept while the meeting is open.');
  res.setHeader('Content-Type', file.type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  // Images open inline (for previews); everything else downloads.
  const inline = /^image\/(png|jpeg|gif|webp)$/.test(file.type) && req.query.dl !== '1';
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  fs.createReadStream(file.path).pipe(res);
});
function dropFiles(room) {
  for (const id of room.files) {
    const f = files.get(id);
    if (f) fs.rm(f.path, { force: true }, () => {});
    files.delete(id);
  }
  room.files.clear();
}

// ---------- Saved transcripts ----------
// The meeting's host can save the transcript to the meeting; the admin page shows it.
const summaryTimers = new Map();
/** Store the host's transcript on the meeting; returns an error message or the line count. */
function saveTranscript(ws, raw) {
  if (ws.room.host !== ws) return { error: 'Only the meeting host can save the transcript' };
  const lines = (Array.isArray(raw) ? raw : []).slice(0, 5000).map((l) => ({
    name: String(l?.name || '').slice(0, 40), text: String(l?.text || '').slice(0, 2000), at: Number(l?.at) || 0,
  })).filter((l) => l.text);
  if (!lines.length) return { error: 'The transcript is empty' };
  const m = ws.room.meeting;
  m.transcript = { savedAt: Date.now(), by: ws.displayName, lines };
  store.save();
  // Saving again later in the call rewrites the summary, but not more than once a minute.
  clearTimeout(summaryTimers.get(m.id));
  const wait = Math.max(0, 60_000 - (Date.now() - (m.summary?.startedAt || 0)));
  summaryTimers.set(m.id, setTimeout(() => { summaryTimers.delete(m.id); summary.summarize(m); }, wait));
  return { lines: lines.length };
}
app.post('/api/transcript', express.json({ limit: '2mb' }), (req, res) => {
  const ws = callers.get(req.get('x-token'));
  if (!ws?.room) return res.status(403).json({ error: 'Not in a call' });
  const out = saveTranscript(ws, req.body?.lines);
  if (out.error) return res.status(out.error.startsWith('Only') ? 403 : 400).json(out);
  res.json({ ok: true, lines: out.lines, summary: summary.enabled });
});
app.get('/api/admin/meetings/:id', auth.requireAdmin, (req, res) => {
  const m = store.data.meetings.find((x) => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No such meeting' });
  res.json({ ...m, summaryEnabled: summary.enabled });
});
app.post('/api/admin/meetings/:id/summary', auth.requireAdmin, (req, res) => {
  const m = store.data.meetings.find((x) => x.id === req.params.id);
  if (!m?.transcript) return res.status(404).json({ error: 'That meeting has no saved transcript' });
  if (!summary.enabled) return res.status(503).json({ error: 'xAI is not set up on this server' });
  summary.summarize(m);
  res.json({ ok: true });
});

// ---------- Remote control recordings ----------
// While a signed-in host controls someone's computer, their browser records
// what they see and uploads it here in pieces. Each recording has its own key,
// so the last pieces still arrive after the host has left the call. Old
// recordings are deleted once they take more than RECORDING_TOTAL_MB.
const REC_DIR = path.join(store.dir, 'recordings');
fs.mkdirSync(REC_DIR, { recursive: true });
const REC_MAX = Number(process.env.RECORDING_MAX_MB || 1000) * 1024 * 1024;
const REC_TOTAL = Number(process.env.RECORDING_TOTAL_MB || 2000) * 1024 * 1024;
const recFile = (r) => path.join(REC_DIR, `${r.id}.${r.mime.includes('mp4') ? 'mp4' : 'webm'}`);
const publicRec = ({ key, ...r }) => r;
function pruneRecordings() {
  let total = store.data.recordings.reduce((n, r) => n + r.bytes, 0);
  while (total > REC_TOTAL && store.data.recordings.length > 1) {
    const old = store.data.recordings.shift();
    fs.rmSync(recFile(old), { force: true });
    total -= old.bytes;
  }
  store.save();
}
app.post('/api/recordings', express.json({ limit: '10kb' }), (req, res) => {
  const ws = callers.get(req.get('x-token'));
  if (!ws?.room) return res.status(403).json({ error: 'Not in a call' });
  if (!ws.user) return res.status(403).json({ error: 'Only signed-in hosts record' });
  const mime = String(req.body?.mime || 'video/webm');
  if (!/^video\/(webm|mp4)/.test(mime)) return res.status(400).json({ error: 'Unsupported format' });
  const r = {
    id: crypto.randomBytes(8).toString('hex'), key: crypto.randomBytes(16).toString('hex'),
    meetingId: ws.meeting.id, room: ws.meeting.room, title: ws.meeting.title, by: ws.displayName, of: String(req.body?.of || '').slice(0, 40),
    mime: mime.split(';')[0], startedAt: Date.now(), bytes: 0,
  };
  store.data.recordings.push(r);
  store.save();
  res.json({ id: r.id, key: r.key });
});
const recFor = (req) => {
  const r = store.data.recordings.find((x) => x.id === req.params.id);
  return r && req.get('x-key') && r.key === req.get('x-key') && !r.endedAt ? r : null;
};
app.post('/api/recordings/:id/chunk', express.raw({ type: () => true, limit: '50mb' }), (req, res) => {
  const r = recFor(req);
  if (!r) return res.status(404).json({ error: 'No such recording' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.json({ ok: true });
  if (r.bytes + req.body.length > REC_MAX) { r.capped = true; r.endedAt = Date.now(); store.save(); return res.status(413).json({ error: 'The recording is too long' }); }
  fs.appendFileSync(recFile(r), req.body);
  r.bytes += req.body.length;
  r.lastChunkAt = Date.now();
  store.save();
  res.json({ ok: true });
});
app.post('/api/recordings/:id/end', (req, res) => {
  const r = recFor(req);
  if (!r) return res.status(404).json({ error: 'No such recording' });
  r.endedAt = Date.now();
  pruneRecordings();
  res.json({ ok: true });
});
// Connection logs for the last 7 days, one row per meeting, and each meeting's events.
app.get('/api/admin/connlogs', auth.requireAdmin, (_req, res) => res.json({ days: connlog.KEEP_DAYS, turn: turn.status(), meetings: connlog.meetings() }));
app.get('/api/admin/connlogs/:id', auth.requireAdmin, (req, res) => res.json(connlog.forMeeting(req.params.id)));
app.get('/api/admin/recordings', auth.requireAdmin, (_req, res) => {
  res.json(store.data.recordings.filter((r) => r.bytes).slice().reverse().map(publicRec));
});
app.get('/api/admin/recordings/:id/file', auth.requireAdmin, (req, res) => {
  const r = store.data.recordings.find((x) => x.id === req.params.id);
  if (!r || !fs.existsSync(recFile(r))) return res.status(404).json({ error: 'No such recording' });
  if (req.query.download) res.attachment(`control-${r.room}-${new Date(r.startedAt).toISOString().slice(0, 16).replace(':', '')}.${path.extname(recFile(r)).slice(1)}`);
  res.sendFile(recFile(r), { headers: { 'Content-Type': r.mime } });
});
app.delete('/api/admin/recordings/:id', auth.requireAdmin, (req, res) => {
  const i = store.data.recordings.findIndex((x) => x.id === req.params.id);
  if (i >= 0) { fs.rmSync(recFile(store.data.recordings[i]), { force: true }); store.data.recordings.splice(i, 1); store.save(); }
  res.json({ ok: true });
});

// ---------- Scheduled meetings ----------
// The host schedules a meeting and sends its link. Before it starts, guests
// see its title and time; it opens when the host joins.
const json = express.json({ limit: '10kb' });
const scheduledFor = (room) => store.data.scheduled.find((s) => s.room === room);
app.get('/api/admin/scheduled', auth.requireAdmin, (_req, res) => {
  const cutoff = Date.now() - 86_400_000; // keep yesterday's around in case one runs late
  res.json(store.data.scheduled.filter((s) => s.at > cutoff).sort((a, b) => a.at - b.at));
});
app.post('/api/admin/scheduled', auth.requireAdmin, json, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const at = Number(req.body?.at);
  if (!title) return res.status(400).json({ error: 'Give the meeting a title.' });
  if (!Number.isFinite(at)) return res.status(400).json({ error: 'Pick a date and time.' });
  const slug = title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'meeting';
  const s = {
    id: crypto.randomBytes(6).toString('hex'),
    room: `${slug}-${crypto.randomBytes(3).toString('hex')}`,
    title, at,
    minutes: Math.min(600, Math.max(5, Number(req.body?.minutes) || 30)),
    waitingRoom: req.body?.waitingRoom !== false,
    tz: preview.validTz(req.body?.tz) ? String(req.body.tz) : undefined, // the host's time zone, for link previews
    createdAt: Date.now(),
  };
  store.data.scheduled.push(s);
  store.data.scheduled = store.data.scheduled.filter((x) => x.at > Date.now() - 30 * 86_400_000);
  store.save();
  preview.card(s).catch(() => {}); // draw the preview picture now, so the first link paste doesn't wait for it
  res.json(s);
});
app.delete('/api/admin/scheduled/:id', auth.requireAdmin, (req, res) => {
  store.data.scheduled = store.data.scheduled.filter((s) => s.id !== req.params.id);
  store.save();
  res.json({ ok: true });
});
// What the lobby shows for a room link.
app.get('/api/rooms/:room', (req, res) => {
  const s = scheduledFor(req.params.room);
  res.json({ open: rooms.has(req.params.room), scheduled: s ? { title: s.title, at: s.at, minutes: s.minutes } : null });
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

const publicSchedule = (room) => { const s = scheduledFor(room); return s ? { title: s.title, at: s.at } : null; };
// People who can let guests in from the waiting room: the host and anyone signed in.
const admitters = (r) => [...r.peers].filter((p) => p === r.host || p.user);
function knock(r, w) { for (const p of admitters(r)) send(p, { type: 'knock', id: w.peerId, name: w.displayName }); }

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
  dropFiles(room);
  sharedBrowser.close(room);
  for (const w of room.waiting) { w.waitingFor = null; send(w, { type: 'not-started', scheduled: publicSchedule(room.meeting.room) }); }
  room.waiting.clear();
  for (const p of room.peers) {
    if (p === leaver) continue;
    send(p, { type: 'session-ended', reason, by: leaver?.displayName });
    p.close(4000, 'session ended');
  }
  room.peers.clear();
}

wss.on('connection', (ws, req) => {
  ws.user = auth.userFrom(req); // signed in: allowed to start meetings
  ws.ua = String(req.headers['user-agent'] || '').slice(0, 300);
  ws.device = /Android|iPhone|iPad|iPod|Mobile/i.test(ws.ua) ? 'phone' : 'desktop';
  ws.logged = 0; // connection reports from this browser, capped below
  /** @type {Room | null} */
  let room = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Join the room for real: get a token and meet everyone in it.
  function enter(r) {
    ws.token = crypto.randomUUID();
    ws.joinedAt = Date.now();
    callers.set(ws.token, ws);
    room = r;
    ws.meeting = r.meeting;
    ws.room = r;
    if (!r.meeting.names.includes(ws.displayName) && r.meeting.names.length < 20) r.meeting.names.push(ws.displayName);
    r.meeting.peak = Math.max(r.meeting.peak, r.peers.size + 1);
    const others = [...r.peers].map((p) => ({ id: p.peerId, name: p.displayName }));
    // A pass to come back in without knocking again, for as long as this meeting runs.
    const pass = crypto.randomBytes(16).toString('hex');
    r.passes.add(pass);
    r.peers.add(ws);
    send(ws, { type: 'joined', id: ws.peerId, host: r.host === ws, hostId: r.host.peerId, peers: others, token: ws.token, cloud: !!XAI_KEY, title: r.meeting.title, waitingRoom: r.waitingRoom, browser: sharedBrowser.available(), ice: turn.iceServers(), pass });
    connlog.log(r.meeting, 'join', { who: ws.displayName, id: ws.peerId, device: ws.device, ua: ws.ua, signedIn: !!ws.user, relay: turn.hasRelay(), people: r.peers.size });
    sharedBrowser.joined(r, ws);
    for (const p of r.peers) if (p !== ws) send(p, { type: 'peer-joined', id: ws.peerId, name: ws.displayName });
    // Someone who can admit people just arrived: show them who's waiting.
    if (r.host === ws || ws.user) for (const w of r.waiting) send(ws, { type: 'knock', id: w.peerId, name: w.displayName });
  }
  ws.enter = enter; // whoever admits a waiting guest calls this

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.room || '').slice(0, 64);
      if (!name || room || ws.waitingFor) return;
      let r = rooms.get(name);
      // Only signed-in people start meetings; guests wait until one is open.
      if (!r && !ws.user) return send(ws, { type: 'not-started', scheduled: publicSchedule(name) });
      if (r && r.peers.size >= MAX_PEERS) {
        connlog.log(r.meeting, 'full', { who: String(msg.name || 'Guest').slice(0, 40), device: ws.device, ua: ws.ua });
        return send(ws, { type: 'full', max: MAX_PEERS });
      }
      ws.displayName = String(msg.name || 'Guest').slice(0, 40);
      ws.peerId ||= nextId++;
      if (!r) {
        const sched = scheduledFor(name);
        r = { peers: new Set(), host: ws, checking: false, files: new Set(), waiting: new Set(), passes: new Set(), waitingRoom: sched ? sched.waitingRoom : !!ws.user.waitingRoom };
        r.meeting = { room: name, title: sched?.title, startedAt: Date.now(), by: ws.user.username, host: ws.displayName, names: [], peak: 0, clips: 0, audioSec: 0 };
        store.addMeeting(r.meeting);
        rooms.set(name, r);
        scheduleCheck(r);
      }
      // Guests knock first when the meeting has a waiting room, unless they
      // were already let in to this meeting and are coming back.
      const back = typeof msg.pass === 'string' && r.passes.has(msg.pass);
      if (r.waitingRoom && !ws.user && r.peers.size && !back) {
        ws.waitingFor = r;
        r.waiting.add(ws);
        send(ws, { type: 'waiting', scheduled: publicSchedule(name) });
        knock(r, ws);
        return;
      }
      enter(r);
      return;
    }

    if (msg.type === 'admit' && room) {
      if (!admitters(room).includes(ws)) return;
      const w = [...room.waiting].find((x) => x.peerId === msg.id);
      if (!w) return;
      room.waiting.delete(w);
      w.waitingFor = null;
      for (const p of admitters(room)) if (p !== ws) send(p, { type: 'knock-gone', id: w.peerId });
      if (msg.allow) w.enter(room);
      else { send(w, { type: 'denied' }); w.close(4001, 'denied'); }
      return;
    }

    if (!room) return;

    // The host's browser sends its transcript as it leaves, if they saved it before.
    if (msg.type === 'save-transcript') {
      saveTranscript(ws, msg.lines);
      return;
    }

    // A browser's report of what its video is doing, for debugging calls we can't watch.
    if (msg.type === 'diag') {
      console.log('diag', room.meeting.room, ws.displayName || '-', JSON.stringify(msg.data).slice(0, 6000));
      if (ws.logged++ < 300) connlog.log(room.meeting, 'video', { who: ws.displayName, id: ws.peerId, data: msg.data });
      return;
    }

    // Bytes this browser sent and received through the relay since its last report.
    if (msg.type === 'relay-bytes') {
      const n = (v) => Math.min(Math.max(Math.round(Number(v) || 0), 0), 5e9);
      if (n(msg.sent) || n(msg.received)) store.addRelay(n(msg.sent), n(msg.received));
      return;
    }

    // How one of this browser's calls is connecting, or why it isn't.
    if (msg.type === 'conn') {
      const d = msg.data && typeof msg.data === 'object' ? msg.data : {};
      if (ws.logged++ < 300) connlog.log(room.meeting, 'conn', { who: ws.displayName, id: ws.peerId, device: ws.device, ...d });
      if (d.state === 'failed') console.log('call failed', room.meeting.room, ws.displayName, '->', d.about, JSON.stringify(d).slice(0, 2000));
      return;
    }

    if (sharedBrowser.handle(room, ws, msg)) return;

    if (msg.type === 'session-continue') {
      if (room.host === ws) scheduleCheck(room);
      return;
    }

    // Everything else (offer/answer/ice) goes to the one person it names.
    for (const p of room.peers) if (p.peerId === msg.to) send(p, { ...msg, from: ws.peerId });
  });

  ws.on('close', () => {
    callers.delete(ws.token);
    if (ws.waitingFor) {
      const r = ws.waitingFor;
      r.waiting.delete(ws);
      for (const p of admitters(r)) send(p, { type: 'knock-gone', id: ws.peerId });
      return;
    }
    if (!room || !room.peers.has(ws)) return;
    room.peers.delete(ws);
    connlog.log(room.meeting, 'leave', { who: ws.displayName, id: ws.peerId, after: Math.round((Date.now() - ws.joinedAt) / 1000) });
    if (!room.peers.size) return endSession(room, 'left', ws);
    sharedBrowser.left(room, ws);
    for (const p of room.peers) send(p, { type: 'peer-left', id: ws.peerId, name: ws.displayName });
    // Someone still has to be asked whether to continue: pass it on.
    if (room.host === ws) {
      room.host = room.peers.values().next().value;
      for (const p of room.peers) send(p, { type: 'host', id: room.host.peerId });
      if (room.checking) send(room.host, { type: 'session-check' });
      if (!room.host.user) for (const w of room.waiting) send(room.host, { type: 'knock', id: w.peerId, name: w.displayName });
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
