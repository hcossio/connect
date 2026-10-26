// A small JSON file holding the accounts, a meeting log and transcription
// usage. On Railway it lives on a volume (DATA_DIR) so it survives deploys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DIR, 'store.json');
const KEEP_MEETINGS = 500;

/** @type {{ secret: string, users: any[], meetings: any[], usage: Record<string, { meetings: number, minutes: number, clips: number, audioSec: number }> }} */
let data;
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch { data = {}; }
data.secret ||= crypto.randomBytes(32).toString('hex');
data.users ||= [];
data.meetings ||= [];
data.usage ||= {};
data.scheduled ||= [];
data.recordings ||= [];
for (const r of data.recordings) if (!r.endedAt) r.endedAt = r.lastChunkAt || r.startedAt;
// Meetings that were open when the server last stopped ended then.
for (const m of data.meetings) {
  if (!m.endedAt) { m.endedAt = m.lastSeen || m.startedAt; m.interrupted = true; }
  if (m.summary?.status === 'working') Object.assign(m.summary, { status: 'error', error: 'The server restarted while writing it. Try again.' });
}

let timer = null;
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
      fs.renameSync(FILE + '.tmp', FILE); // never leave a half-written file
    } catch (err) { console.error('could not save store:', err.message); }
  }, 500);
}
save();

const today = () => new Date().toISOString().slice(0, 10);
function usage() { return (data.usage[today()] ||= { meetings: 0, minutes: 0, clips: 0, audioSec: 0 }); }

function addMeeting(m) {
  m.id = crypto.randomBytes(6).toString('hex');
  data.meetings.push(m);
  if (data.meetings.length > KEEP_MEETINGS) data.meetings.splice(0, data.meetings.length - KEEP_MEETINGS);
  usage().meetings++;
  save();
}
function endMeeting(m) {
  m.endedAt = Date.now();
  usage().minutes += (m.endedAt - m.startedAt) / 60_000;
  save();
}
// Bytes this server's browsers sent and received through the TURN relay.
function addRelay(sent, received) {
  const u = usage();
  u.relaySent = (u.relaySent || 0) + sent;
  u.relayRecv = (u.relayRecv || 0) + received;
  save();
}
function addClip(m, audioSec) {
  if (m) { m.clips = (m.clips || 0) + 1; m.audioSec = (m.audioSec || 0) + audioSec; }
  const u = usage();
  u.clips++;
  u.audioSec += audioSec;
  save();
}

module.exports = { dir: DIR, data, save, addMeeting, endMeeting, addClip, addRelay };
