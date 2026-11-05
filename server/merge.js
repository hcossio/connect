// Joining meetings: when a call gets cut off and carries on in a new one, the
// admin can pick the pieces and join them. The joined meeting is a new entry
// in the meeting log with every transcript line in the order it was said, so
// the summary, its PDF and the next-meeting agenda all work on it as usual.
// The original meetings are left as they were.
const crypto = require('crypto');
const store = require('./store');

const MAX_LINES = 5000;
const MAX_PARTS = 10;

/** Join the meetings with these ids; returns { meeting } or { error }. */
function join(ids) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (ids.length < 2) return { error: 'Pick at least two meetings to join' };
  if (ids.length > MAX_PARTS) return { error: `You can join up to ${MAX_PARTS} meetings at once` };
  const picked = ids.map((id) => store.data.meetings.find((m) => m.id === id));
  if (picked.some((m) => !m)) return { error: 'One of those meetings is gone' };
  if (picked.some((m) => !m.endedAt)) return { error: 'A meeting that is still open can only be joined once it ends' };
  if (picked.some((m) => !m.transcript?.lines.length)) return { error: 'Every meeting you join needs a saved transcript' };

  // A joined meeting can be joined again: use the meetings it came from.
  const parts = picked.flatMap((m) => (m.mergedFrom?.length ? m.mergedFrom.map((p) => store.data.meetings.find((x) => x.id === p.id) || null) : [m]));
  const seenPart = new Set();
  const sources = parts.filter((m) => m && m.transcript?.lines.length && !seenPart.has(m.id) && seenPart.add(m.id))
    .sort((a, b) => a.startedAt - b.startedAt);
  if (sources.length < 2) return { error: 'Those meetings are already joined' };

  const seen = new Set();
  const lines = sources.flatMap((m, part) => m.transcript.lines.map((l) => ({ ...l, part })))
    .filter((l) => { const k = `${l.name}|${l.at}|${l.text}`; return !seen.has(k) && seen.add(k); })
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_LINES);

  const first = sources[0];
  const last = sources.reduce((a, m) => ((m.endedAt || 0) > (a.endedAt || 0) ? m : a), first);
  const names = [...new Set(sources.flatMap((m) => m.names || []))].slice(0, 40);
  const sum = (k) => sources.reduce((n, m) => n + (m[k] || 0), 0);
  const meeting = {
    id: crypto.randomBytes(6).toString('hex'),
    room: first.room,
    title: sources.find((m) => m.title)?.title,
    startedAt: first.startedAt,
    endedAt: last.endedAt,
    by: first.by,
    host: first.host,
    names,
    peak: Math.max(...sources.map((m) => m.peak || 0)),
    clips: sum('clips'),
    audioSec: sum('audioSec'),
    // Each piece: when it ran and what it was called, for the summary and the admin page.
    mergedFrom: sources.map((m) => ({ id: m.id, room: m.room, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, lines: m.transcript.lines.length })),
    mergedAt: Date.now(),
    transcript: { savedAt: Date.now(), by: 'joined', lines },
  };
  // It goes at the end of the log, so it shows first in the admin page's list.
  store.data.meetings.push(meeting);
  for (const m of sources) (m.joinedInto ||= []).includes(meeting.id) || m.joinedInto.push(meeting.id);
  store.save();
  return { meeting };
}

/** Remove a joined meeting; the meetings it came from stay. */
function unjoin(id) {
  const i = store.data.meetings.findIndex((m) => m.id === id);
  const m = store.data.meetings[i];
  if (!m) return { error: 'No such meeting' };
  if (!m.mergedFrom) return { error: 'Only a joined meeting can be removed' };
  store.data.meetings.splice(i, 1);
  for (const x of store.data.meetings) if (x.joinedInto) { x.joinedInto = x.joinedInto.filter((j) => j !== id); if (!x.joinedInto.length) delete x.joinedInto; }
  store.save();
  return { ok: true };
}

module.exports = { join, unjoin };
