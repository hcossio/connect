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

const SYSTEM = `You read transcripts of tech support and developer calls and turn them into work.
Reply with JSON only, in this shape:
{"title": "a few words naming what the call was about",
 "project": "the product, repository or system the work is on, or \\"\\" if unclear",
 "summary": "3 to 6 sentences: the problem, what was found, what was decided",
 "decisions": ["each decision or agreement, one short sentence"],
 "tasks": [{"title": "imperative, specific, under 12 words",
            "details": "everything needed to do it without the call: files, errors, steps, values, acceptance criteria",
            "owner": "the person's name exactly as in the transcript, or \\"\\" if nobody clearly took it"}]}
Rules: only include tasks someone actually needs to do after the call. Only set an owner when the transcript makes it clear
(they said they'd do it, or were asked and agreed). Keep technical details exact: copy file names, commands, error text and numbers.
Write in the language most of the call was in.`;

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
        { role: 'user', content: `Call "${m.room}" on ${new Date(m.startedAt).toDateString()}. The host is ${m.host}. People: ${m.names.join(', ')}.\n\nTranscript:\n${transcriptText(m).slice(-120_000)}` },
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
  ];
  if (s.decisions.length) lines.push('', '## Decisions already made', ...s.decisions.map((d) => `- ${d}`));
  lines.push('', '## Tasks for you');
  if (mine.length) mine.forEach((t, i) => lines.push(`${i + 1}. **${t.title}**${t.owner ? '' : ' (nobody claimed this on the call)'}`, ...(t.details ? [`   ${t.details}`] : [])));
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
    const s = {
      title: str(raw.title, 120),
      project: str(raw.project, 120),
      summary: str(raw.summary, 4000),
      decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).map((d) => str(d, 500)).filter(Boolean).slice(0, 30),
      tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => ({ title: str(t?.title, 200), details: str(t?.details, 3000), owner: str(t?.owner, 40) }))
        .filter((t) => t.title).slice(0, 50),
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
