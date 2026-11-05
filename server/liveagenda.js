// Agenda mode: the call runs through a list of points, each with its own
// countdown. The server keeps the state so everyone, including people who
// join late or reload, sees the same point and the same clock. The host and
// signed-in people run it; everyone else sees it.
const crypto = require('crypto');
const store = require('./store');

const MAX_ITEMS = 30;
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const mins = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.round(n * 2) / 2, 0.5), 240) : 5; };

function fresh() {
  return { on: false, items: [], current: -1, spent: {}, runningSince: null, startedAt: null, endedAt: null };
}

/** What everyone gets: the list, where we are, and the server's clock to count from. */
function view(a) {
  return {
    on: a.on,
    items: a.items,
    current: a.current,
    spent: a.spent,
    runningSince: a.runningSince,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    now: Date.now(),
  };
}

// Time on the clock for the point we're leaving goes into its total.
function bank(a) {
  const it = a.items[a.current];
  if (it && a.runningSince) a.spent[it.id] = (a.spent[it.id] || 0) + (Date.now() - a.runningSince);
  a.runningSince = null;
}
function goTo(a, i, run) {
  bank(a);
  a.current = Math.max(0, Math.min(i, a.items.length));
  if (a.current >= a.items.length) { a.endedAt = Date.now(); return; }
  a.endedAt = null;
  if (run) a.runningSince = Date.now();
}

// The agenda Grok planned for the next meeting, from the last meeting in this
// room (or by this person) that has one.
function lastPlanned(room, user) {
  const ms = store.data.meetings;
  const from = (test) => { for (let i = ms.length - 1; i >= 0; i--) if (ms[i] !== room.meeting && ms[i].agenda?.items?.length && test(ms[i])) return ms[i]; return null; };
  const m = from((x) => x.room === room.meeting.room) || (user ? from((x) => x.by === user.username) : null);
  if (!m) return null;
  return {
    title: m.agenda.title || m.summary?.title || m.room,
    items: m.agenda.items.map((x) => ({ title: x.heading, minutes: x.minutes || 5, note: x.goal || '' })),
  };
}

/** Apply one change from someone allowed to run the agenda. Returns an error to show them, or null. */
function apply(room, ws, msg) {
  const a = (room.agenda ||= fresh());
  const running = a.runningSince != null;
  switch (msg.action) {
    case 'on':
      a.on = !!msg.on;
      if (!a.on) bank(a);
      break;
    case 'items': {
      // Edits keep each point's id, so time already spent on it stays with it.
      const cur = a.items[a.current]?.id;
      const seen = new Set();
      a.items = (Array.isArray(msg.items) ? msg.items : []).slice(0, MAX_ITEMS).map((x) => {
        let id = str(x?.id, 20);
        if (!id || seen.has(id)) id = crypto.randomBytes(4).toString('hex');
        seen.add(id);
        return { id, title: str(x?.title, 140) || 'Untitled point', minutes: mins(x?.minutes), note: str(x?.note, 300) };
      });
      for (const k of Object.keys(a.spent)) if (!seen.has(k)) delete a.spent[k];
      if (a.current >= 0) {
        const at = a.items.findIndex((x) => x.id === cur);
        if (at >= 0) a.current = at;
        else { // the point being discussed was deleted: move on to whatever took its place
          a.runningSince = null;
          a.current = Math.min(a.current, a.items.length);
          if (a.current < a.items.length && running) a.runningSince = Date.now();
          if (a.current >= a.items.length) a.endedAt ||= Date.now();
        }
      }
      break;
    }
    case 'load': {
      const plan = lastPlanned(room, ws.user);
      if (!plan) return 'No earlier meeting has a planned agenda yet. Write one from a meeting summary in Meetings, or add the points here.';
      apply(room, ws, { action: 'items', items: plan.items });
      a.on = true;
      a.loadedFrom = plan.title;
      return null;
    }
    case 'start':
      if (!a.items.length) return 'Add a point first.';
      a.on = true;
      if (a.current < 0 || a.current >= a.items.length) { // from the top (again)
        if (a.current >= a.items.length) a.spent = {};
        a.startedAt = Date.now();
        goTo(a, 0, true);
      } else if (!running) a.runningSince = Date.now();
      break;
    case 'pause':
      bank(a);
      break;
    case 'next':
      if (a.current < 0 || a.current >= a.items.length) return null;
      goTo(a, a.current + 1, running);
      break;
    case 'prev':
      if (a.current <= 0) return null;
      goTo(a, a.current - 1, running);
      break;
    case 'goto': {
      const i = a.items.findIndex((x) => x.id === msg.id);
      if (i < 0) return null;
      a.startedAt ||= Date.now();
      goTo(a, i, running || a.current < 0 || a.current >= a.items.length);
      break;
    }
    case 'extend': { // more time for the point being discussed
      const it = a.items[a.current];
      if (it) it.minutes = mins(it.minutes + (Number(msg.minutes) || 1));
      break;
    }
    case 'reset':
      Object.assign(a, { current: -1, spent: {}, runningSince: null, startedAt: null, endedAt: null });
      break;
    default:
      return null;
  }
  return null;
}

/** A plain record of how the meeting went, kept with the meeting for later. */
function record(room) {
  const a = room.agenda;
  if (!a?.items.length || !a.startedAt) return;
  bank(a);
  room.meeting.agendaRun = {
    startedAt: a.startedAt,
    items: a.items.map((x, i) => ({ title: x.title, minutes: x.minutes, spentMin: Math.round((a.spent[x.id] || 0) / 6000) / 10, reached: i <= a.current })),
  };
}

module.exports = { fresh, view, apply, record };
