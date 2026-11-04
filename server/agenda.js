// Beta: the agenda for the follow-up meeting, written from a meeting's
// summary (the minuta), not from the transcript. It plans the next call
// around what this one left open: reviewing the pending tasks, the
// deliverables people promised to bring (a content calendar, a draft, a
// quote), and the questions nobody could answer yet.
const store = require('./store');
const summary = require('./summary');

const SYSTEM = `You plan the follow-up meeting for a team, from the summary of their last meeting.
The next meeting exists to check on what the last one left pending: review each task and its deliverable, decide on what was left open, and agree on what comes after.
Write like a careful colleague: plain, specific sentences, no filler, nothing invented. Only plan around things the summary says.
Reply with JSON only, in this shape:
{"title": "e.g. \\"Agenda · Revisión del calendario de contenido\\" or \\"Agenda · Checkout bug follow-up\\"",
 "purpose": "one or two sentences: why this meeting happens and what it should leave decided",
 "recap": "one or two sentences recalling what the last meeting agreed, so someone who missed it can follow",
 "suggested_date": "when to hold it if the summary makes that clear (a date like 2026-11-10, or words like \\"after the calendar is drafted\\"), else \\"\\"",
 "duration_minutes": a number, the total of the items,
 "items": [{"heading": "a short agenda item, e.g. \\"Revisar el calendario de publicaciones\\"",
            "minutes": a number,
            "lead": "who presents or leads it, a name from the summary, or \\"\\"",
            "goal": "one sentence: what the group should leave this item with (a decision, an approval, a date)",
            "points": ["specific things to go over, check or decide, with names, dates and numbers from the summary"]}],
 "deliverables": [{"what": "the thing someone must bring or show, e.g. \\"Calendario de contenido de noviembre\\"", "owner": "name or \\"\\"", "check": "what to look at when reviewing it"}],
 "open_questions": ["questions left open last time that this meeting should settle"],
 "prepare": [{"who": "a name, or \\"Todos\\"/\\"Everyone\\"", "what": "what to prepare or send before the meeting"}],
 "labels": {"agenda": "Agenda", "purpose": "Purpose", "recap": "Where we left off", "based_on": "Based on", "when": "When", "length": "Length", "items": "Agenda items",
            "leads": "Leads", "goal": "Goal", "review": "Pending tasks to review", "task": "Task", "owner": "Owner", "due": "Due", "status": "Status at the meeting",
            "unassigned": "Unassigned", "no_date": "No date", "deliverables": "Deliverables to bring", "check": "What to check", "open_questions": "Open questions to settle",
            "prepare": "Before the meeting", "min": "min", "beta": "Beta · written by AI from the last meeting's summary"}}
Rules:
- Start with a short item to review the pending tasks, then one item per deliverable or topic that needs a decision, in order of importance, and end with a short item to agree on next steps and the date after that.
- 3 to 7 items. Keep minutes realistic; the whole meeting usually fits in 30 to 60 minutes.
- When a task produces something to review (a calendar, a design, a list, a report), give it its own item and a deliverable entry.
- Leave deliverables, open_questions or prepare as [] when the summary gives nothing for them.
- Write everything, labels included, in the language the summary is written in. Use the real names from the summary.`;

const LABELS = {
  agenda: 'Agenda', purpose: 'Purpose', recap: 'Where we left off', based_on: 'Based on', when: 'When', length: 'Length', items: 'Agenda items',
  leads: 'Leads', goal: 'Goal', review: 'Pending tasks to review', task: 'Task', owner: 'Owner', due: 'Due', status: 'Status at the meeting',
  unassigned: 'Unassigned', no_date: 'No date', deliverables: 'Deliverables to bring', check: 'What to check', open_questions: 'Open questions to settle',
  prepare: 'Before the meeting', min: 'min', beta: "Beta · written by AI from the last meeting's summary",
};
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };

/** The minuta as plain text, which is all the model sees. */
function minutaText(m) {
  const s = m.summary;
  const out = [
    `Meeting "${s.title || m.room}" on ${new Date(m.startedAt).toISOString().slice(0, 10)}${s.project ? ` about ${s.project}` : ''}. Host: ${m.host || 'unknown'}.`,
    `Attended: ${(s.attended?.length ? s.attended : m.names || []).join(', ')}`,
  ];
  if (s.absent?.length) out.push(`Did not attend: ${s.absent.join(', ')}`);
  out.push('', '## Summary', ...(s.overview?.length ? s.overview : [s.summary]).filter(Boolean));
  for (const x of s.sections || []) out.push('', `## ${x.heading}`, ...(x.intro ? [x.intro] : []), ...x.points.map((p) => `- ${p.lead ? `${p.lead}: ` : ''}${p.text}`));
  if (s.decisions?.length) out.push('', '## Decisions', ...s.decisions.map((d) => `- ${d}`));
  out.push('', '## Next steps', ...(s.nextStepsIntro ? [s.nextStepsIntro] : []));
  for (const t of s.tasks || []) out.push(`- ${t.title} | owner: ${t.owner || 'nobody'} | due: ${t.due || 'no date'}${t.details ? ` | ${t.details}` : ''}`);
  if (!s.tasks?.length) out.push('(no tasks)');
  if (s.followUp?.questions?.length) out.push('', `## ${s.followUp.heading || 'Open questions'}`, ...(s.followUp.intro ? [s.followUp.intro] : []), ...s.followUp.questions.map((q) => `- ${q}`));
  return out.join('\n');
}

const running = new Set();
/** Write (or rewrite) the next meeting's agenda from a meeting's summary. */
async function write(m) {
  if (!summary.enabled || !m.summary?.prompt || running.has(m.id)) return;
  running.add(m.id);
  const fromSummary = m.summary.at || 0;
  m.agenda = { ...(m.agenda || {}), status: 'working', startedAt: Date.now() };
  store.save();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { raw, model } = await summary.ask(SYSTEM, `Today is ${today}. Plan the follow-up to this meeting.\n\n${minutaText(m).slice(0, 60_000)}`);
    const list = (v, n, max) => (Array.isArray(v) ? v : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);
    const L = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
    const items = (Array.isArray(raw.items) ? raw.items : []).map((x) => ({
      heading: str(x?.heading, 160),
      minutes: num(x?.minutes, 240),
      lead: str(x?.lead, 60),
      goal: str(x?.goal, 600),
      points: list(x?.points, 600, 10),
    })).filter((x) => x.heading).slice(0, 10);
    m.agenda = {
      status: 'done',
      at: Date.now(),
      model,
      fromSummary,
      title: str(raw.title, 140),
      purpose: str(raw.purpose, 1200),
      recap: str(raw.recap, 1200),
      suggestedDate: str(raw.suggested_date, 80),
      minutes: items.reduce((a, x) => a + x.minutes, 0) || num(raw.duration_minutes, 480),
      items,
      deliverables: (Array.isArray(raw.deliverables) ? raw.deliverables : []).map((d) => ({ what: str(d?.what, 200), owner: str(d?.owner, 60), check: str(d?.check, 600) }))
        .filter((d) => d.what).slice(0, 12),
      openQuestions: list(raw.open_questions, 500, 15),
      prepare: (Array.isArray(raw.prepare) ? raw.prepare : []).map((p) => ({ who: str(p?.who, 60), what: str(p?.what, 600) })).filter((p) => p.what).slice(0, 12),
      labels: Object.fromEntries(Object.keys(LABELS).map((k) => [k, str(L[k], 80) || LABELS[k]])),
    };
  } catch (err) {
    console.error('agenda failed:', err.message);
    m.agenda = { ...(m.agenda || {}), status: 'error', error: 'xAI could not write the agenda. Try again in a bit.' };
  } finally {
    running.delete(m.id);
    store.save();
  }
}

module.exports = { write, minutaText };
