// Connection logs: who joined each meeting from what kind of device, and how
// each of their calls connected or failed (the network path the browser
// found, relay or direct, and any errors). Kept as one JSON-lines file per day
// for the last 7 days, so a call that failed for someone far away can be
// looked at afterwards.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const DIR = path.join(store.dir, 'connlogs');
const KEEP_DAYS = 7;
const MAX_DAY_BYTES = 50e6; // a runaway client can't fill the disk
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

function prune() {
  const oldest = day(Date.now() - (KEEP_DAYS - 1) * 86400_000);
  let files = [];
  try { files = fs.readdirSync(DIR); } catch { return; }
  for (const f of files) if (f.endsWith('.jsonl') && f.slice(0, 10) < oldest) fs.rmSync(path.join(DIR, f), { force: true });
}

const sizes = new Map(); // day -> bytes written, so we don't stat every line
function log(meeting, ev, data = {}) {
  if (!meeting?.id) return;
  const line = JSON.stringify({ t: Date.now(), m: meeting.id, room: meeting.room, title: meeting.title, ev, ...data }).slice(0, 8000) + '\n';
  const d = day();
  const file = path.join(DIR, `${d}.jsonl`);
  if (!sizes.has(d)) {
    sizes.clear();
    try { sizes.set(d, fs.statSync(file).size); } catch { sizes.set(d, 0); }
    prune();
  }
  if (sizes.get(d) > MAX_DAY_BYTES) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(file, line);
    sizes.set(d, sizes.get(d) + line.length);
  } catch (err) { console.error('could not write connection log:', err.message); }
}

function* entries() {
  prune();
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return; }
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) { if (l) try { yield JSON.parse(l); } catch {} }
  }
}

// One row per meeting: when, who, from what devices, and how many calls failed.
function meetings() {
  const by = new Map();
  for (const e of entries()) {
    const m = by.get(e.m) || { id: e.m, room: e.room, title: e.title, first: e.t, last: e.t, people: new Map(), failed: 0, relayed: 0, errors: 0 };
    m.last = e.t;
    if (e.title) m.title = e.title;
    if (e.ev === 'join' && e.who) m.people.set(e.who, e.device || m.people.get(e.who));
    if (e.ev === 'conn' && e.state === 'failed') m.failed++;
    if (e.ev === 'conn' && e.state === 'connected' && e.pair?.local === 'relay') m.relayed++;
    if (e.ev === 'conn' && e.errors?.length) m.errors += e.errors.length;
    by.set(e.m, m);
  }
  return [...by.values()].reverse()
    .sort((a, b) => b.first - a.first)
    .map((m) => ({ ...m, people: [...m.people].map(([name, device]) => ({ name, device })) }));
}

function forMeeting(id) {
  const list = [];
  for (const e of entries()) if (e.m === id) list.push(e);
  return list;
}

prune();
setInterval(prune, 6 * 3600_000).unref();

module.exports = { log, meetings, forMeeting, KEEP_DAYS };
