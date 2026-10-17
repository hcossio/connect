// Admin page. Dashboard: meetings open now, recent meetings (with saved
// transcripts) and daily usage, refreshed every few seconds from
// /api/admin/stats. Profile: name, username, email and password.
const $ = (id) => document.getElementById(id);

const fmtDuration = (ms) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const fmtAudio = (sec) => (sec < 60 ? `${Math.round(sec)} s` : fmtDuration(sec * 1000));
const fmtCost = (usd) => (usd < 0.01 && usd > 0 ? '< $0.01' : `$${usd.toFixed(2)}`);
const fmtWhen = (t) => {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

function row(cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const td = document.createElement('td');
    if (c instanceof Node) td.append(c); else td.textContent = c;
    tr.append(td);
  }
  return tr;
}
function transcriptCell(m) {
  if (!m.transcriptLines) return '–';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link';
  b.textContent = `View (${m.transcriptLines} lines${m.tasks ? `, ${m.tasks} ${m.tasks === 1 ? 'task' : 'tasks'}` : ''})`;
  b.onclick = () => openTranscript(m.id);
  return b;
}
function roomCell(m) {
  if (!m.title) return m.room;
  const d = document.createElement('div');
  d.append(m.title, Object.assign(document.createElement('div'), { className: 'muted small', textContent: m.room }));
  return d;
}
function fill(body, empty, rows) {
  $(body).replaceChildren(...rows.map(row));
  $(empty).hidden = rows.length > 0;
}

async function refresh() {
  const r = await fetch('/api/admin/stats');
  if (r.status === 401) return location.replace('/login?next=/admin');
  const s = await r.json();
  const cost = (sec) => (sec / 3600) * s.pricePerHour;

  const people = s.open.reduce((n, m) => n + m.people.length, 0);
  $('kOpen').textContent = s.open.length;
  $('kOpenSub').textContent = s.open.length ? `${people} ${people === 1 ? 'person' : 'people'} in calls` : 'No calls right now';
  const sum = (k) => s.days.reduce((n, d) => n + d[k], 0);
  $('kMeetings').textContent = sum('meetings');
  $('kMinutes').textContent = `${fmtDuration(sum('minutes') * 60_000)} in calls`;
  $('kAudio').textContent = fmtAudio(sum('audioSec'));
  $('kClips').textContent = s.cloud ? `${sum('clips')} clips sent to xAI` : 'xAI is not set up';
  $('kCost').textContent = fmtCost(cost(sum('audioSec')));
  $('kPrice').textContent = `At $${s.pricePerHour.toFixed(2)} per hour of audio`;

  const now = Date.now();
  fill('openRows', 'openEmpty', s.open.map((m) => [roomCell(m), fmtWhen(m.startedAt), fmtDuration(now - m.startedAt), m.people.join(', ') + (m.waiting ? ` (${m.waiting} waiting)` : ''), fmtAudio(m.audioSec), transcriptCell(m)]));
  fill('dayRows', 'dayEmpty', s.days.filter((d) => d.meetings || d.minutes || d.clips).reverse().map((d) => [
    new Date(d.day + 'T12:00:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    d.meetings, fmtDuration(d.minutes * 60_000), fmtAudio(d.audioSec), d.clips, fmtCost(cost(d.audioSec)),
  ]));
  fill('recentRows', 'recentEmpty', s.recent.map((m) => [
    roomCell(m), fmtWhen(m.startedAt), m.interrupted ? 'Unknown (server restarted)' : fmtDuration(m.endedAt - m.startedAt), m.names.join(', '), fmtAudio(m.audioSec || 0), transcriptCell(m),
  ]));
}

// ---------- Transcript viewer ----------
// Two tabs: the AI summary with its tasks and the prompt to paste into a
// coding agent, and the transcript itself.
let shown = null;
let pollTimer = 0;
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

async function openTranscript(id) {
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  shown = await r.json();
  const t = shown.transcript;
  $('txTitle').textContent = shown.summary?.title || `Meeting in ${shown.room}`;
  $('txMeta').textContent = `${shown.room} · ${fmtWhen(shown.startedAt)} · saved by ${t.by} at ${fmtWhen(t.savedAt)} · ${t.lines.length} lines`;
  $('txLines').replaceChildren(...t.lines.map((l) => {
    const p = el('p');
    const head = el('span', 'tx-who');
    head.append(el('b', null, l.name), el('span', 'muted small', new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    p.append(head, el('span', null, l.text));
    return p;
  }));
  renderSummary();
  if (!$('txDialog').open) { showTab('summary'); $('txDialog').showModal(); }
}

function renderSummary() {
  clearTimeout(pollTimer);
  const s = shown.summary;
  const body = $('sumBody');
  $('sumCopy').hidden = s?.status !== 'done' && !s?.prompt;
  $('sumRedo').hidden = !shown.summaryEnabled || s?.status === 'working';
  $('sumRedo').textContent = s ? 'Write it again' : 'Write summary';
  $('sumStatus').textContent = '';
  if (!shown.summaryEnabled && !s) return body.replaceChildren(el('p', 'muted', 'Summaries need xAI, which is not set up on this server (XAI_API_KEY).'));
  if (!s) return body.replaceChildren(el('p', 'muted', 'No summary yet.'));
  if (s.status === 'working') {
    $('sumStatus').textContent = 'Grok is reading the transcript…';
    pollTimer = setTimeout(() => $('txDialog').open && openTranscript(shown.id), 3000);
    if (!s.prompt) return body.replaceChildren();
  }
  if (s.status === 'error') $('sumStatus').textContent = s.error;
  if (!s.prompt) return body.replaceChildren();
  if (s.lines && s.lines < shown.transcript.lines.length) $('sumStatus').textContent = `Written from the first ${s.lines} lines. Write it again to include the rest.`;

  const parts = [el('p', 'sum-text', s.summary)];
  if (s.decisions.length) {
    parts.push(el('h3', null, 'Decisions'));
    const ul = el('ul', 'sum-list');
    for (const d of s.decisions) ul.append(el('li', null, d));
    parts.push(ul);
  }
  parts.push(el('h3', null, `Tasks (${s.tasks.length})`));
  if (!s.tasks.length) parts.push(el('p', 'muted small', 'No tasks came out of this call.'));
  const ol = el('ol', 'sum-tasks');
  for (const t of s.tasks) {
    const li = el('li');
    const head = el('div', 'task-head');
    head.append(el('b', null, t.title), el('span', 'owner' + (t.owner ? '' : ' general'), t.owner || 'General'));
    li.append(head);
    if (t.details) li.append(el('p', 'muted small', t.details));
    ol.append(li);
  }
  parts.push(ol);
  const details = el('details', 'sum-prompt');
  details.append(el('summary', null, 'Agent prompt'), el('pre', null, s.prompt));
  parts.push(details);
  body.replaceChildren(...parts);
}

function showTab(which) {
  $('tabSummary').setAttribute('aria-selected', String(which === 'summary'));
  $('tabLines').setAttribute('aria-selected', String(which !== 'summary'));
  $('sumPane').hidden = which !== 'summary';
  $('txBody').hidden = which === 'summary';
}
$('tabSummary').onclick = () => showTab('summary');
$('tabLines').onclick = () => showTab('lines');
$('txDialog').addEventListener('close', () => clearTimeout(pollTimer));
$('sumCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(shown.summary.prompt); $('sumCopy').textContent = 'Copied'; }
  catch { $('sumCopy').textContent = 'Could not copy'; }
  setTimeout(() => { $('sumCopy').textContent = 'Copy agent prompt'; }, 1500);
};
$('sumRedo').onclick = async () => {
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(shown.id)}/summary`, { method: 'POST' });
  if (!r.ok) { $('sumStatus').textContent = (await r.json().catch(() => ({}))).error || 'Could not start it.'; return; }
  shown.summary = { ...(shown.summary || {}), status: 'working' };
  renderSummary();
};
$('txClose').onclick = () => $('txDialog').close();
$('txDl').onclick = () => {
  const t = shown.transcript;
  const body = `Transcript of ${shown.room}, ${new Date(shown.startedAt).toLocaleString()}\n\n`
    + t.lines.map((l) => `[${new Date(l.at).toLocaleTimeString()}] ${l.name}: ${l.text}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  a.download = `transcript-${shown.room}-${new Date(shown.startedAt).toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Views ----------
function showView() {
  const view = location.hash === '#profile' ? 'profile' : 'dashboard';
  $('dashboard').hidden = view !== 'dashboard';
  $('profile').hidden = view !== 'profile';
  for (const a of document.querySelectorAll('.admin-nav a')) a.classList.toggle('active', a.dataset.view === view);
}
addEventListener('hashchange', showView);
showView();

async function loadProfile() {
  const { user } = await fetch('/api/me').then((r) => r.json());
  if (!user) return;
  $('pfDisplay').value = user.displayName;
  $('pfUsername').value = user.username;
  $('pfEmail').value = user.email;
  $('pfWaiting').checked = user.waitingRoom;
}
loadProfile();
refresh();
loadScheduled();
setInterval(() => { if (!$('dashboard').hidden) refresh(); }, 10_000);

function say(el, ok, text) {
  $(el).hidden = false;
  $(el).className = 'small ' + (ok ? 'form-ok' : 'form-error');
  $(el).textContent = text;
}
$('profileForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: $('pfDisplay').value, username: $('pfUsername').value, email: $('pfEmail').value, waitingRoom: $('pfWaiting').checked }),
  });
  const out = await r.json().catch(() => ({}));
  say('pfMsg', r.ok, r.ok ? 'Profile saved.' : out.error || 'Could not save it.');
};

$('signOut').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login');
};

$('pwForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: $('pwCurrent').value, next: $('pwNext').value }),
  });
  const out = await r.json().catch(() => ({}));
  say('pwMsg', r.ok, r.ok ? 'Password changed. Other browsers were signed out.' : out.error || 'Could not change it.');
  if (r.ok) $('pwForm').reset();
};

// ---------- Scheduled meetings ----------
const linkFor = (s) => `${location.origin}/r/${encodeURIComponent(s.room)}`;
async function loadScheduled() {
  const list = await fetch('/api/admin/scheduled').then((r) => (r.ok ? r.json() : []));
  fill('schedRows', 'schedEmpty', list.map((s) => {
    const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm', textContent: 'Copy link' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(linkFor(s)); copy.textContent = 'Copied'; } catch { prompt('Meeting link', linkFor(s)); }
      setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
    };
    const open = Object.assign(document.createElement('a'), { className: 'btn primary sm', href: linkFor(s), textContent: 'Start' });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Remove' });
    del.onclick = async () => { await fetch(`/api/admin/scheduled/${s.id}`, { method: 'DELETE' }); loadScheduled(); };
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(copy, open);
    const past = s.at + s.minutes * 60_000 < Date.now();
    return [s.title, `${fmtWhen(s.at)}${past ? ' (past)' : ''} · ${s.minutes} min`, s.waitingRoom ? 'On' : 'Off', actions, del];
  }));
}
// Default to the next half hour.
const next = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
$('schedAt').value = new Date(next - next.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
$('schedForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/admin/scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('schedTitle').value, at: new Date($('schedAt').value).getTime(), minutes: Number($('schedMinutes').value), waitingRoom: $('schedWaiting').checked }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return say('schedMsg', false, out.error || 'Could not schedule it.');
  try { await navigator.clipboard.writeText(linkFor(out)); say('schedMsg', true, `Scheduled. The link is copied: ${linkFor(out)}`); }
  catch { say('schedMsg', true, `Scheduled. Send this link: ${linkFor(out)}`); }
  $('schedTitle').value = '';
  loadScheduled();
};
