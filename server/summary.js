// After a meeting's transcript is saved, xAI (Grok) writes a short summary
// and a task list from it, with who owns each task when the call makes that
// clear. From the tasks we build a prompt the host can paste into the coding
// agent working on that project.
const store = require('./store');

const KEY = process.env.XAI_API_KEY;
const URL_ = process.env.XAI_CHAT_URL || 'https://api.x.ai/v1/chat/completions';
// Model names change; try the configured one first, then a few known ones.
const MODELS = [...new Set([process.env.XAI_CHAT_MODEL, 'grok-4-fast', 'grok-4', 'grok-3-mini'].filter(Boolean))];
let workingModel = null;

const SYSTEM = `You read transcripts of work calls (or notes someone wrote about one) and write the meeting summary the team keeps.
Write it like a careful colleague who was in the room: plain, specific sentences, no filler, no hype, nothing invented.
Reply with JSON only, in this shape:
{"title": "Meeting type and topic, e.g. \\"Resumen de reunión · Campaña Feel the Culture\\" or \\"Meeting summary · Checkout bug\\"",
 "project": "the product, client, repository or system the work is on, or \\"\\" if unclear",
 "overview": ["1 or 2 short paragraphs. The first says what was discussed, what was decided and what happens first, with names. The second (optional) gives the context the call built on."],
 "attended": ["names of the people on the call"],
 "absent": ["people the call mentions as missing or who still need to hear about it; [] if none"],
 "sections": [{"heading": "a short descriptive heading for one topic of the call",
               "intro": "one or two sentences that frame the topic, naming who raised it",
               "style": "bullets" or "numbered" (numbered for a list of ideas or options that were weighed),
               "points": [{"lead": "2 to 6 words, the gist of this point", "text": "one or two sentences with the specifics: who said it, why, numbers, names, dates"}]}],
 "next_steps_intro": "one or two sentences: what is most urgent and why, plus any capacity or timing facts said on the call",
 "tasks": [{"title": "imperative, specific, under 14 words",
            "details": "everything needed to do it without the call: files, errors, steps, values, acceptance criteria",
            "owner": "the person's name exactly as in the transcript, or \\"\\" if nobody clearly took it",
            "due": "when it is due, as said on the call (a date like 2026-10-30, a range like 2026-10-30/2026-10-31, or words like \\"before Edrian starts\\"), or \\"\\""}],
 "follow_up": {"heading": "e.g. \\"Para hablar con Andrés y Angie\\" or \\"Questions for the client\\"", "intro": "one or two sentences on why this follow-up matters", "questions": ["open questions to take to that conversation"]} or null,
 "decisions": ["each decision or agreement, one short sentence"],
 "labels": {"summary": "Summary", "participants": "Participants", "attended": "Attended", "absent": "Did not attend", "next_steps": "Next steps",
            "task": "Task", "owner": "Owner", "due": "Due", "status": "Status", "pending": "Pending", "unassigned": "Unassigned", "no_date": "No date"}}
Rules:
- Use 2 to 5 sections, grouped by topic, in the order the call covered them. Put loose remarks in a last section such as "Other points".
- Only include tasks someone actually needs to do after the call. Only set an owner when the transcript makes it clear (they said they'd do it, or were asked and agreed).
- Only add follow_up when the call says some people still need to be consulted or questions remain open.
- Keep exact details: names, numbers, dates, quotes, file names, commands and error text.
- Write everything, labels included, in the language most of the call was in. Use the real names from the call.`;

function transcriptText(m) {
  return m.transcript.lines.map((l) => `[${new Date(l.at).toISOString().slice(11, 16)}] ${l.name}: ${l.text}`).join('\n');
}

async function callModel(model, m) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Call "${m.room}" on ${new Date(m.startedAt).toISOString().slice(0, 10)} (${new Date(m.startedAt).toDateString()}). The host is ${m.host}. People: ${m.names.join(', ')}.\n\nTranscript:\n${transcriptText(m).slice(-120_000)}` },
      ],
    }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`xAI ${r.status}: ${JSON.stringify(out.error || out).slice(0, 200)}`);
    err.badModel = r.status === 404 || /model/i.test(JSON.stringify(out.error || ''));
    throw err;
  }
  const text = out.choices?.[0]?.message?.content || '';
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

const LABELS = { summary: 'Summary', participants: 'Participants', attended: 'Attended', absent: 'Did not attend', next_steps: 'Next steps', task: 'Task', owner: 'Owner', due: 'Due', status: 'Status', pending: 'Pending', unassigned: 'Unassigned', no_date: 'No date' };
const str = (v, n) => String(v ?? '').trim().slice(0, n);

/** The prompt to hand to a coding agent: the host's tasks and unowned ones to do, others' for context. */
function agentPrompt(m, s) {
  const host = (m.host || '').toLowerCase();
  const mine = s.tasks.filter((t) => !t.owner || t.owner.toLowerCase() === host || host.startsWith(t.owner.toLowerCase()));
  const others = s.tasks.filter((t) => !mine.includes(t));
  const when = new Date(m.startedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const lines = [
    `These tasks come from a call on ${when}${s.project ? ` about ${s.project}` : ''} with ${m.names.join(', ')}.`,
    '',
    '## What the call covered',
    s.summary,
    ...s.sections.flatMap((x) => ['', `### ${x.heading}`, ...(x.intro ? [x.intro] : []), ...x.points.map((p) => `- ${p.lead ? `${p.lead}: ` : ''}${p.text}`)]),
  ];
  if (s.decisions.length) lines.push('', '## Decisions already made', ...s.decisions.map((d) => `- ${d}`));
  lines.push('', '## Tasks for you');
  if (mine.length) mine.forEach((t, i) => lines.push(`${i + 1}. **${t.title}**${t.owner ? '' : ' (nobody claimed this on the call)'}`, ...(t.details ? [`   ${t.details}`] : []), ...(t.due ? [`   Due: ${t.due}`] : [])));
  else lines.push('None.');
  if (others.length) {
    lines.push('', '## Other people\'s tasks (context only, don\'t do these)');
    for (const t of others) lines.push(`- ${t.title} (${t.owner})`);
  }
  lines.push('', 'Work through the tasks for you in order. Look at the code before changing it, and if a task is unclear or conflicts with what you find, say so instead of guessing. When you finish, list what you did for each task and anything left open.');
  return lines.join('\n');
}

const running = new Set();
/** Write (or rewrite) the summary for a meeting with a saved transcript. */
async function summarize(m) {
  if (!KEY || !m.transcript?.lines.length || running.has(m.id)) return;
  running.add(m.id);
  m.summary = { ...(m.summary || {}), status: 'working', startedAt: Date.now() };
  store.save();
  try {
    let raw, lastErr;
    for (const model of workingModel ? [workingModel] : MODELS) {
      try { raw = await callModel(model, m); workingModel = model; break; } catch (err) {
        lastErr = err;
        if (!err.badModel) break;
      }
    }
    if (!raw) throw lastErr || new Error('No model answered');
    const list = (v, n, max = 30) => (Array.isArray(v) ? v : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);
    const overview = Array.isArray(raw.overview) ? list(raw.overview, 3000, 3) : list([raw.overview ?? raw.summary], 4000, 1);
    const fu = raw.follow_up && typeof raw.follow_up === 'object' ? raw.follow_up : null;
    const L = raw.labels && typeof raw.labels === 'object' ? raw.labels : {};
    const s = {
      title: str(raw.title, 120),
      project: str(raw.project, 120),
      overview,
      summary: overview.join('\n\n'),
      attended: list(raw.attended, 60, 40),
      absent: list(raw.absent, 60, 40),
      sections: (Array.isArray(raw.sections) ? raw.sections : []).map((x) => ({
        heading: str(x?.heading, 120),
        intro: str(x?.intro, 1500),
        style: x?.style === 'numbered' ? 'numbered' : 'bullets',
        points: (Array.isArray(x?.points) ? x.points : []).map((p) => (typeof p === 'string' ? { lead: '', text: str(p, 1500) } : { lead: str(p?.lead, 120), text: str(p?.text, 1500) }))
          .filter((p) => p.lead || p.text).slice(0, 20),
      })).filter((x) => x.heading && (x.intro || x.points.length)).slice(0, 8),
      nextStepsIntro: str(raw.next_steps_intro, 1500),
      followUp: fu && list(fu.questions, 500, 15).length ? { heading: str(fu.heading, 120), intro: str(fu.intro, 1500), questions: list(fu.questions, 500, 15) } : null,
      decisions: list(raw.decisions, 500),
      tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => ({ title: str(t?.title, 200), details: str(t?.details, 3000), owner: str(t?.owner, 40), due: str(t?.due, 80) }))
        .filter((t) => t.title).slice(0, 50),
      labels: Object.fromEntries(Object.keys(LABELS).map((k) => [k, str(L[k], 40) || LABELS[k]])),
    };
    m.summary = { status: 'done', at: Date.now(), model: workingModel, lines: m.transcript.lines.length, ...s, prompt: agentPrompt(m, s) };
  } catch (err) {
    console.error('summary failed:', err.message);
    m.summary = { ...(m.summary || {}), status: 'error', error: 'xAI could not write the summary. Try again in a bit.' };
  } finally {
    running.delete(m.id);
    store.save();
  }
}

module.exports = { summarize, enabled: !!KEY };
