// Who gets to talk. Two modes the host switches on and off:
//
// Wait in line: raising a hand puts you in line. When nobody has the floor,
// the first in line gets a 30 second countdown on everyone's screen; when it
// runs out they have the floor and everyone else is muted once (they can
// unmute again). The next person's countdown starts when the speaker is done,
// or when the host moves the line on.
//
// Pass the mic: after a 10 second countdown, only the person holding the mic
// can talk; everyone else stays muted until it's passed to them. It goes to
// whoever raised their hand first, then down the line. The holder passes it
// on, and the host can give it to anyone, take it, or switch the mode off.
//
// The server keeps the line and the clocks, so everyone sees the same thing,
// including people who join late or reload.

const LINE_MS = 30_000;
const MIC_START_MS = 10_000;

function fresh() {
  return { mode: 'off', queue: [], speaker: null, since: null, up: null, startsAt: null, turn: 0, timer: null };
}
const floorOf = (room) => (room.floor ||= fresh());
const peerById = (room, id) => [...room.peers].find((p) => p.peerId === id);
const nameOf = (room, id) => peerById(room, id)?.displayName || 'Someone';

/** What everyone gets: the mode, the line, who talks, and the server's clock to count from. */
function view(room) {
  const f = floorOf(room);
  const who = (id) => (id == null ? null : { id, name: nameOf(room, id) });
  return {
    mode: f.mode,
    queue: f.queue.map(who),
    speaker: who(f.speaker),
    since: f.since,
    up: f.up && { ...who(f.up.id), at: f.up.at },
    startsAt: f.startsAt,
    turn: f.turn,
    now: Date.now(),
  };
}

function stopTimer(f) { clearTimeout(f.timer); f.timer = null; }

// Hand the floor (or the mic) to someone, or to nobody.
function grant(f, id) {
  stopTimer(f);
  f.up = null;
  f.speaker = id ?? null;
  f.since = id == null ? null : Date.now();
  f.queue = f.queue.filter((x) => x !== id);
  f.turn++;
}

// Move things along after any change: start the next countdown in line mode,
// or hand a free mic to the first person in line.
function advance(room, notify) {
  const f = floorOf(room);
  if (f.mode === 'line') {
    if (f.speaker != null || f.up || !f.queue.length) return;
    const id = f.queue[0];
    f.up = { id, at: Date.now() + LINE_MS };
    f.timer = setTimeout(() => {
      if (f.up?.id !== id) return;
      grant(f, id);
      notify('grant');
    }, LINE_MS);
  } else if (f.mode === 'mic') {
    if (f.startsAt || f.speaker != null || !f.queue.length) return;
    grant(f, f.queue[0]);
  }
}

function setMode(room, mode, notify) {
  const f = floorOf(room);
  stopTimer(f);
  Object.assign(f, { mode, speaker: null, since: null, up: null, startsAt: null });
  f.turn++;
  if (mode === 'mic') {
    f.startsAt = Date.now() + MIC_START_MS;
    f.timer = setTimeout(() => {
      f.startsAt = null;
      f.timer = null;
      grant(f, f.queue[0]); // the first hand up, or nobody: then the next hand gets it
      notify('open');
    }, MIC_START_MS);
  }
  advance(room, notify);
}

/**
 * Apply one change. `notify(event)` sends the new state to everyone; it's also
 * called later when a countdown runs out. Returns an error to show the sender, or null.
 */
function apply(room, ws, msg, notify) {
  const f = floorOf(room);
  const isHost = room.host === ws;
  const me = ws.peerId;
  switch (msg.action) {
    case 'hand': // anyone: raising a hand gets you in line, lowering it takes you out
      if (msg.up) {
        if (f.speaker === me || f.queue.includes(me)) return null;
        f.queue.push(me);
      } else {
        if (!f.queue.includes(me)) return null;
        f.queue = f.queue.filter((x) => x !== me);
        if (f.up?.id === me) { stopTimer(f); f.up = null; }
      }
      advance(room, notify);
      return 'hand';
    case 'mode':
      if (!isHost) return null;
      setMode(room, ['line', 'mic'].includes(msg.mode) ? msg.mode : 'off', notify);
      return msg.mode === 'off' ? 'off' : 'on';
    case 'done': // the speaker finishes, or hands the mic on (to someone, or the next in line)
    case 'pass': {
      if (f.speaker !== me && !isHost) return null;
      if (f.mode === 'line') { grant(f, null); advance(room, notify); return 'done'; }
      if (f.mode !== 'mic' || f.startsAt) return null;
      const to = Number(msg.to);
      const target = to && to !== f.speaker && peerById(room, to) ? to : f.queue[0];
      grant(f, target);
      return 'pass';
    }
    case 'give': { // host: this person talks now
      if (!isHost || f.mode === 'off') return null;
      const id = Number(msg.to);
      if (!peerById(room, id)) return null;
      if (f.mode === 'mic' && f.startsAt) f.startsAt = null; // skip the rest of the countdown
      grant(f, id);
      return 'grant';
    }
    case 'now': // host, in line mode: skip the rest of the countdown
      if (!isHost || !f.up) return null;
      grant(f, f.up.id);
      return 'grant';
    default:
      return null;
  }
}

/** Someone left the call: take them out of the line, and pass on what they held. */
function left(room, ws, notify) {
  const f = room.floor;
  if (!f) return;
  const id = ws.peerId;
  const had = f.queue.includes(id) || f.speaker === id || f.up?.id === id;
  if (!had) return;
  f.queue = f.queue.filter((x) => x !== id);
  if (f.up?.id === id) { stopTimer(f); f.up = null; }
  if (f.speaker === id) {
    if (f.mode === 'mic') grant(f, f.queue[0]);
    else grant(f, null);
  }
  advance(room, notify);
  notify('left');
}

function close(room) { if (room.floor) stopTimer(room.floor); }

module.exports = { view, apply, left, close, LINE_MS, MIC_START_MS };
