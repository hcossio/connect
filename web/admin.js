// Admin page. Dashboard: meetings open now, recent meetings (with saved
// transcripts) and daily usage, refreshed every few seconds from
// /api/admin/stats. Profile: name, username, email and password.
const $ = (id) => document.getElementById(id);

const fmtDuration = (ms) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const fmtAudio = (sec) => (sec < 60 ? `${Math.round(sec)} s` : fmtDuration(sec * 1000));
const fmtGB = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e11 ? 0 : 1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? '< 1 MB' : '0 GB');
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
  const note = m.mergedFrom?.length ? `Joined from ${m.mergedFrom.length} meetings` : m.joinedInto?.length ? 'Part of a joined meeting' : '';
  if (!m.title && !note) return m.room;
  const d = document.createElement('div');
  d.append(m.title || m.room);
  if (m.title) d.append(Object.assign(document.createElement('div'), { className: 'muted small', textContent: m.room }));
  if (note) d.append(Object.assign(document.createElement('div'), { className: 'muted small joined-note', textContent: note }));
  return d;
}
// ---------- Joining meetings ----------
// A call that got cut off and carried on in a new one: tick its parts in the
// Finished table and join them. The server makes a new meeting with both
// transcripts in order and writes one summary (and PDF) from it.
const picked = new Set();
function pickCell(m) {
  if (!m.transcriptLines) return '';
  const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: picked.has(m.id), title: 'Pick to join with another meeting' });
  box.setAttribute('aria-label', `Pick ${m.title || m.room} to join`);
  box.onchange = () => { if (box.checked) picked.add(m.id); else picked.delete(m.id); joinBar(); };
  return box;
}
function joinBar() {
  const n = picked.size;
  $('mergeBtn').hidden = n < 2;
  $('mergeBtn').textContent = `Join ${n} meetings`;
  $('mergeClear').hidden = n === 0;
  $('mergeHint').textContent = n === 0 ? 'Was one meeting cut off? Tick its parts to join their transcripts into one summary.'
    : n === 1 ? 'Pick at least one more meeting to join.'
    : 'Their transcripts are put together in the order things were said, and a new summary is written. The originals stay as they are.';
}
$('mergeClear').onclick = () => { picked.clear(); joinBar(); refresh(); };
$('mergeBtn').onclick = async () => {
  $('mergeBtn').disabled = true;
  try {
    const r = await fetch('/api/admin/meetings/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [...picked] }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { $('mergeHint').textContent = out.error || 'Could not join those meetings.'; return; }
    picked.clear();
    joinBar();
    pages.set('recentRows', 0); // the joined meeting is first in the list
    await refresh();
    openTranscript(out.id);
  } finally { $('mergeBtn').disabled = false; }
};
// Open meetings get a green dot: they're live.
function liveCell(c) {
  const d = document.createElement('div');
  d.className = 'room-cell';
  const dot = document.createElement('span');
  dot.className = 'live-dot';
  d.append(dot, c);
  return d;
}
// Fill a table. `limit` shows only the first few (with a "See all" link);
// `page` splits the rows into pages of that size with Previous and Next.
const pages = new Map(); // table body id -> page shown
function fill(body, empty, rows, { limit, page, more } = {}) {
  let shown = rows;
  if (limit) {
    shown = rows.slice(0, limit);
    if (more) { $(more).hidden = rows.length <= limit; $(more).textContent = "See all"; }
  }
  if (page) {
    const count = Math.max(1, Math.ceil(rows.length / page));
    const at = Math.min(pages.get(body) || 0, count - 1);
    pages.set(body, at);
    shown = rows.slice(at * page, at * page + page);
    pager(body, empty, rows, page, at, count);
  }
  $(body).replaceChildren(...shown.map(row));
  $(empty).hidden = rows.length > 0;
}
function pager(body, empty, rows, page, at, count) {
  const wrap = $(body).closest('.table-wrap');
  let nav = wrap.nextElementSibling?.classList.contains('pager') ? wrap.nextElementSibling : null;
  if (!nav) { nav = document.createElement('nav'); nav.className = 'pager'; wrap.after(nav); }
  nav.hidden = count < 2;
  const go = (to) => { pages.set(body, to); fill(body, empty, rows, { page }); };
  const btn = (text, to, off) => Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm', textContent: text, disabled: off, onclick: () => go(to) });
  nav.replaceChildren(btn('Previous', at - 1, at === 0),
    Object.assign(document.createElement('span'), { className: 'muted small', textContent: `${at * page + 1}–${Math.min(rows.length, at * page + page)} of ${rows.length}` }),
    btn('Next', at + 1, at >= count - 1));
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

  // Relay traffic: Cloudflare's own count of what it sent out (what it bills)
  // when we can read it, otherwise what our browsers received through it.
  const month = new Date().toISOString().slice(0, 7);
  const ours = s.days.filter((d) => d.day.startsWith(month)).reduce((n, d) => n + (d.relayRecv || 0), 0);
  const cf = s.relay.cloudflare;
  const exact = cf && cf.egress != null;
  $('kRelay').textContent = fmtGB(exact ? cf.egress : ours);
  $('kRelaySub').textContent = !s.relay.configured ? 'No relay set up'
    : `of 1,000 GB free · ${exact ? 'from Cloudflare' : cf?.error ? `counted by Connect (Cloudflare: ${cf.error})` : 'counted by Connect'}`;

  const now = Date.now();
  const openRow = (m) => [liveCell(roomCell(m)), fmtWhen(m.startedAt), fmtDuration(now - m.startedAt), m.people.join(', ') + (m.waiting ? ` (${m.waiting} waiting)` : ''), fmtAudio(m.audioSec), transcriptCell(m)];
  fill('openRows', 'openEmpty', s.open.map(openRow), { limit: 5, more: 'openMore' });
  fill('openAllRows', 'openAllEmpty', s.open.map(openRow), { page: 10 });
  fill('dayRows', 'dayEmpty', s.days.filter((d) => d.meetings || d.minutes || d.clips || d.relayRecv).reverse().map((d) => [
    new Date(d.day + 'T12:00:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    d.meetings, fmtDuration(d.minutes * 60_000), fmtAudio(d.audioSec), d.clips, fmtCost(cost(d.audioSec)), d.relayRecv ? fmtGB(d.relayRecv) : '–',
  ]), { page: 10 });
  // Forget picks of meetings that are gone (a removed joined meeting).
  for (const id of picked) if (!s.recent.some((m) => m.id === id && m.transcriptLines)) picked.delete(id);
  joinBar();
  fill('recentRows', 'recentEmpty', s.recent.map((m) => [
    pickCell(m), roomCell(m), fmtWhen(m.startedAt), m.interrupted ? 'Unknown (server restarted)' : fmtDuration(m.endedAt - m.startedAt), m.names.join(', '), fmtAudio(m.audioSec || 0), transcriptCell(m),
  ]), { page: 10 });
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
  $('txTitle').textContent = shown.summary?.title || shown.title || `Meeting in ${shown.room}`;
  $('txMeta').textContent = shown.mergedFrom?.length
    ? `Joined from ${shown.mergedFrom.length} meetings: ${shown.mergedFrom.map((p) => `${p.title || p.room} (${fmtWhen(p.startedAt)})`).join(', ')} · ${t.lines.length} lines`
    : `${shown.room} · ${fmtWhen(shown.startedAt)} · saved by ${t.by} at ${fmtWhen(t.savedAt)} · ${t.lines.length} lines`;
  $('sumUnjoin').hidden = !shown.mergedFrom;
  let part = -1;
  $('txLines').replaceChildren(...t.lines.flatMap((l) => {
    const out = [];
    // In a joined meeting, a divider marks where each call starts.
    if (shown.mergedFrom && l.part != null && l.part !== part) {
      part = l.part;
      const src = shown.mergedFrom[part];
      out.push(el('div', 'tx-part', `Meeting ${part + 1} of ${shown.mergedFrom.length}${src ? ` · ${src.title || src.room} · ${fmtWhen(src.startedAt)}` : ''}`));
    }
    const p = el('p');
    out.push(p);
    const head = el('span', 'tx-who');
    head.append(el('b', null, l.name), el('span', 'muted small', new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
    p.append(head, el('span', null, l.text));
    return out;
  }));
  renderSummary();
  renderAgenda();
  if (!$('txDialog').open) { showTab('summary'); $('txDialog').showModal(); }
}

function renderSummary() {
  clearTimeout(pollTimer);
  const s = shown.summary;
  const body = $('sumBody');
  $('sumCopy').hidden = s?.status !== 'done' && !s?.prompt;
  $('sumPdf').hidden = !s?.prompt;
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

  // The summary is the same document the PDF is printed from.
  const parts = [docFrame('Meeting summary', `/api/admin/meetings/${encodeURIComponent(shown.id)}/summary.html?v=${s.at || 0}`)];
  const details = el('details', 'sum-prompt');
  details.append(el('summary', null, 'Agent prompt'), el('pre', null, s.prompt));
  parts.push(details);
  body.replaceChildren(...parts);
}

function docFrame(title, src) {
  const doc = el('iframe', 'sum-doc');
  doc.title = title;
  doc.src = src;
  const fit = () => { try { doc.style.height = `${doc.contentDocument.documentElement.scrollHeight}px`; } catch {} };
  doc.onload = () => { fit(); doc.contentDocument?.fonts?.ready.then(fit); setTimeout(fit, 600); };
  return doc;
}

// Beta: the agenda for the follow-up meeting, written from the summary.
let agendaTimer = 0;
function renderAgenda() {
  clearTimeout(agendaTimer);
  const s = shown.summary;
  const a = shown.agenda;
  const body = $('agBody');
  $('agPdf').hidden = !a?.items;
  $('agRedo').hidden = !shown.summaryEnabled || !s?.prompt || a?.status === 'working';
  $('agRedo').textContent = a?.items ? 'Write it again' : 'Write the agenda';
  $('agStatus').textContent = '';
  const intro = el('p', 'muted', 'Plans the follow-up meeting from this summary: the pending tasks to review, what people should bring, and the questions left open.');
  if (!s?.prompt) return body.replaceChildren(el('p', 'muted', 'The agenda is written from the summary. Write the summary first.'));
  if (!shown.summaryEnabled && !a?.items) return body.replaceChildren(el('p', 'muted', 'The agenda needs xAI, which is not set up on this server (XAI_API_KEY).'));
  if (a?.status === 'working') {
    $('agStatus').textContent = 'Grok is planning the next meeting…';
    // Only the agenda refreshes, so the summary above doesn't reload while it waits.
    const id = shown.id;
    agendaTimer = setTimeout(async () => {
      if (!$('txDialog').open || shown.id !== id) return;
      const r = await fetch(`/api/admin/meetings/${encodeURIComponent(id)}`).catch(() => null);
      if (r?.ok && shown.id === id) { const m = await r.json(); shown.agenda = m.agenda; shown.summary = m.summary; renderAgenda(); }
      else renderAgenda();
    }, 3000);
    if (!a.items) return body.replaceChildren(intro);
  }
  if (a?.status === 'error') $('agStatus').textContent = a.error;
  if (!a?.items) return body.replaceChildren(intro);
  if (a.status === 'done' && a.fromSummary && s.at && a.fromSummary < s.at) $('agStatus').textContent = 'The summary changed since this was written. Write it again to catch up.';
  body.replaceChildren(docFrame('Next meeting agenda', `/api/admin/meetings/${encodeURIComponent(shown.id)}/agenda.html?v=${a.at || 0}`));
}
$('agRedo').onclick = async () => {
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(shown.id)}/agenda`, { method: 'POST' });
  if (!r.ok) { $('agStatus').textContent = (await r.json().catch(() => ({}))).error || 'Could not start it.'; return; }
  shown.agenda = { ...(shown.agenda || {}), status: 'working' };
  renderAgenda();
};
$('agPdf').onclick = () => downloadPdf($('agPdf'), 'Download agenda PDF', 'agenda.pdf', $('agStatus'));

function showTab(which) {
  for (const [tab, pane, name] of [['tabSummary', 'sumPane', 'summary'], ['tabAgenda', 'agPane', 'agenda'], ['tabLines', 'txBody', 'lines']]) {
    $(tab).setAttribute('aria-selected', String(which === name));
    $(pane).hidden = which !== name;
  }
}
$('tabSummary').onclick = () => showTab('summary');
$('tabAgenda').onclick = () => showTab('agenda');
$('tabLines').onclick = () => showTab('lines');
$('txDialog').addEventListener('close', () => { clearTimeout(pollTimer); clearTimeout(agendaTimer); });
$('sumCopy').onclick = async () => {
  try { await navigator.clipboard.writeText(shown.summary.prompt); $('sumCopy').textContent = 'Copied'; }
  catch { $('sumCopy').textContent = 'Could not copy'; }
  setTimeout(() => { $('sumCopy').textContent = 'Copy agent prompt'; }, 1500);
};
async function downloadPdf(btn, label, file, status) {
  btn.disabled = true;
  btn.textContent = 'Making the PDF…';
  try {
    const r = await fetch(`/api/admin/meetings/${encodeURIComponent(shown.id)}/${file}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not make the PDF');
    const name = decodeURIComponent((r.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || file);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob());
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (err) { status.textContent = err.message; }
  btn.disabled = false;
  btn.textContent = label;
}
$('sumPdf').onclick = () => downloadPdf($('sumPdf'), 'Download PDF', 'summary.pdf', $('sumStatus'));
$('sumRedo').onclick = async () => {
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(shown.id)}/summary`, { method: 'POST' });
  if (!r.ok) { $('sumStatus').textContent = (await r.json().catch(() => ({}))).error || 'Could not start it.'; return; }
  shown.summary = { ...(shown.summary || {}), status: 'working' };
  renderSummary();
};
$('sumUnjoin').onclick = async () => {
  if (!confirm('Remove this joined meeting, with its summary and agenda? The meetings it was made from stay as they are.')) return;
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(shown.id)}`, { method: 'DELETE' });
  if (!r.ok) { $('sumStatus').textContent = (await r.json().catch(() => ({}))).error || 'Could not remove it.'; return; }
  $('txDialog').close();
  refresh();
};
$('txClose').onclick = () => $('txDialog').close();
$('txDl').onclick = () => {
  const t = shown.transcript;
  const body = `Transcript of ${shown.room}, ${new Date(shown.startedAt).toLocaleString()}\n\n`
    + t.lines.map((l, i) => {
      const src = shown.mergedFrom && l.part != null && l.part !== t.lines[i - 1]?.part ? shown.mergedFrom[l.part] : null;
      return `${src ? `${i ? '\n' : ''}--- Meeting ${l.part + 1} of ${shown.mergedFrom.length}: ${src.title || src.room}, ${new Date(src.startedAt).toLocaleString()} ---\n` : ''}[${new Date(l.at).toLocaleTimeString()}] ${l.name}: ${l.text}`;
    }).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  a.download = `transcript-${shown.room}-${new Date(shown.startedAt).toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// ---------- Views ----------
const VIEWS = ['dashboard', 'meetings', 'usage', 'recordings', 'connections', 'settings', 'profile'];
let view = 'dashboard';
function showView() {
  view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard';
  for (const v of VIEWS) $(v).hidden = v !== view;
  for (const a of document.querySelectorAll('.admin-nav a')) a.classList.toggle('active', a.dataset.view === view);
  if (view === 'recordings') loadRecordings();
  if (view === 'connections') loadConnLogs();
  if (view === 'settings') loadSettings();
  scrollTo(0, 0);
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
  $('pfRecord').checked = user.recordControl;
}
loadProfile();
refresh();
loadScheduled();
// Keep what's on screen fresh; forms and settings aren't redrawn under the cursor.
setInterval(() => {
  if (view === 'dashboard' || view === 'meetings' || view === 'usage') { refresh(); loadScheduled(); }
  if (view === 'recordings') loadRecordings();
  if (view === 'connections') loadConnLogs();
}, 10_000);

// ---------- Settings ----------
async function loadSettings() {
  const s = await fetch('/api/admin/settings').then((r) => (r.ok ? r.json() : null));
  if (!s) return;
  $('limitOn').checked = s.limitOn;
  $('limitMax').value = s.maxPeers;
  $('limitMax').disabled = !s.limitOn;
}
$('limitOn').onchange = () => { $('limitMax').disabled = !$('limitOn').checked; };
$('limitForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/admin/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limitOn: $('limitOn').checked, maxPeers: Number($('limitMax').value) }),
  });
  const out = await r.json().catch(() => ({}));
  say('limitMsg', r.ok, r.ok ? (out.limitOn ? `Saved. Calls now take up to ${out.maxPeers} people.` : 'Saved. Calls have no limit now.') : out.error || 'Could not save it.');
};

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
    body: JSON.stringify({ displayName: $('pfDisplay').value, username: $('pfUsername').value, email: $('pfEmail').value, waitingRoom: $('pfWaiting').checked, recordControl: $('pfRecord').checked }),
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
// The message WhatsApp opens with; the link under it shows the meeting's preview card.
const inviteText = (s) => `${s.title}\n${new Date(s.at).toLocaleString([], { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}${zoneLabel()}\n\nJoin on Connect: ${linkFor(s)}`;
// " (Mexico City time)", so people elsewhere know which clock the time is on.
const zoneLabel = () => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; return tz.includes('/') ? ` (${tz.split('/').pop().replace(/_/g, ' ')} time)` : ''; };
const waFor = (s) => `https://wa.me/?text=${encodeURIComponent(inviteText(s))}`;
async function loadScheduled() {
  const list = await fetch('/api/admin/scheduled').then((r) => (r.ok ? r.json() : []));
  const schedRow = (s) => {
    const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm', textContent: 'Copy link' });
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(linkFor(s)); copy.textContent = 'Copied'; } catch { prompt('Meeting link', linkFor(s)); }
      setTimeout(() => { copy.textContent = 'Copy link'; }, 1500);
    };
    const wa = Object.assign(document.createElement('a'), { className: 'btn sm', href: waFor(s), target: '_blank', rel: 'noopener', textContent: 'WhatsApp' });
    const open = Object.assign(document.createElement('a'), { className: 'btn primary sm', href: linkFor(s), textContent: 'Start' });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Remove' });
    del.onclick = async () => { await fetch(`/api/admin/scheduled/${s.id}`, { method: 'DELETE' }); loadScheduled(); };
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(copy, wa, open);
    const past = s.at + s.minutes * 60_000 < Date.now();
    return [s.title, `${fmtWhen(s.at)}${past ? ' (past)' : ''} · ${s.minutes} min`, s.waitingRoom ? 'On' : 'Off', actions, del];
  };
  // The dashboard shows what's coming up next; Meetings has all of them.
  const upcoming = list.filter((s) => s.at + s.minutes * 60_000 >= Date.now()).sort((a, b) => a.at - b.at);
  fill('schedRows', 'schedEmpty', upcoming.map(schedRow), { limit: 5, more: 'schedMore' });
  fill('schedAllRows', 'schedAllEmpty', list.map(schedRow), { page: 10 });
}
// Default to the next half hour.
const next = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000);
$('schedAt').value = new Date(next - next.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
$('schedForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch('/api/admin/scheduled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: $('schedTitle').value, at: new Date($('schedAt').value).getTime(), minutes: Number($('schedMinutes').value), waitingRoom: $('schedWaiting').checked, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return say('schedMsg', false, out.error || 'Could not schedule it.');
  try { await navigator.clipboard.writeText(linkFor(out)); say('schedMsg', true, `Scheduled. The link is copied: ${linkFor(out)}`); }
  catch { say('schedMsg', true, `Scheduled. Send this link: ${linkFor(out)}`); }
  $('schedTitle').value = '';
  loadScheduled();
};

// ---------- Recordings ----------
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
async function loadRecordings() {
  const list = await fetch('/api/admin/recordings').then((r) => (r.ok ? r.json() : []));
  fill('recRows', 'recEmpty', list.map((r) => {
    const play = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm', textContent: 'Play' });
    play.onclick = () => {
      $('recTitle').textContent = `${r.by} controlling ${r.of || 'a computer'}`;
      $('recMeta').textContent = `${r.title || r.room} · ${fmtWhen(r.startedAt)} · ${fmtDuration(r.endedAt - r.startedAt)}${r.capped ? ' · stopped at the size limit' : ''}`;
      $('recVideo').src = `/api/admin/recordings/${r.id}/file`;
      $('recDl').href = `/api/admin/recordings/${r.id}/file?download=1`;
      $('recDialog').showModal();
    };
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Delete' });
    del.onclick = async () => {
      if (!confirm('Delete this recording?')) return;
      await fetch(`/api/admin/recordings/${r.id}`, { method: 'DELETE' });
      loadRecordings();
    };
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.append(play, del);
    return [roomCell(r), fmtWhen(r.startedAt), r.endedAt ? fmtDuration(r.endedAt - r.startedAt) : 'Recording…', r.of, fmtSize(r.bytes), actions];
  }), { page: 10 });
}
$('recClose').onclick = () => $('recDialog').close();
$('recDialog').addEventListener('close', () => { $('recVideo').pause(); $('recVideo').removeAttribute('src'); $('recVideo').load(); });

// ---------- Connection logs ----------
// How each call in a meeting connected, or why it didn't: kept for 7 days.
const browserOf = (ua = '') => {
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const b = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [b, os].filter(Boolean).join(' on ');
};
const PATHS = { host: 'direct on the same network', srflx: 'direct over the internet', prflx: 'direct over the internet', relay: 'through the relay' };
const counts = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
function describe(e) {
  const dev = e.device === 'phone' ? 'a phone' : 'a computer';
  switch (e.ev) {
    case 'join': return `${e.who} joined from ${dev}${e.ua ? ` (${browserOf(e.ua)})` : ''}${e.relay ? '' : ', no relay available'}`;
    case 'leave': return `${e.who} left after ${fmtDuration((e.after || 0) * 1000)}`;
    case 'full': return `${e.who} couldn't join: the room was full`;
    case 'video': return `${e.who}'s video report about ${e.data?.about || 'someone'}`;
    case 'conn': {
      const to = `${e.who} → ${e.about}`;
      const net = e.net?.type ? ` on ${e.net.type === 'cellular' ? 'mobile data' : e.net.type}` : ''; // only Android says which
      if (e.state === 'connected') {
        const how = PATHS[e.pair?.local] || 'connected';
        return `${to}: connected ${how}${e.pair?.protocol ? ` (${e.pair.protocol})` : ''}${e.pair?.rtt != null ? `, ${Math.round(e.pair.rtt * 1000)} ms` : ''}${net}${e.restarts ? ` after ${e.restarts} retr${e.restarts === 1 ? 'y' : 'ies'}` : ''}`;
      }
      const what = e.state === 'failed' ? 'failed' : e.state === 'slow' ? 'still connecting' : 'disconnected';
      return `${to}: ${what} after ${e.secs} s${net}. Paths found here: ${counts(e.cands)}; from them: ${counts(e.remoteCands)}${e.relayOffered ? '' : '; no relay offered'}${e.errors ? `; ${e.errors.length} network error${e.errors.length === 1 ? '' : 's'}` : ''}`;
    }
    default: return `${e.who || ''} ${e.ev}`;
  }
}
const isBad = (e) => e.ev === 'full' || (e.ev === 'conn' && e.state !== 'connected');

async function loadConnLogs() {
  const r = await fetch('/api/admin/connlogs').then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return;
  $('turnNote').textContent = r.turn.relay
    ? 'The relay is on: calls that can\'t connect directly go through it.'
    : r.turn.configured
      ? `The relay is set up but not working${r.turn.error ? ` (${r.turn.error})` : ''}. Calls on networks that block direct connections will fail.`
      : 'No relay is set up, so calls on networks that block direct connections (many mobile carriers) will fail.';
  fill('connRows', 'connEmpty', r.meetings.map((m) => {
    const people = m.people.map((p) => `${p.name}${p.device === 'phone' ? ' (phone)' : ''}`).join(', ') || '–';
    const calls = document.createElement('span');
    calls.textContent = m.failed ? `${m.failed} failed` : 'All connected';
    if (m.failed) calls.className = 'conn-bad';
    if (m.relayed) calls.textContent += `, ${m.relayed} relayed`;
    const view = Object.assign(document.createElement('button'), { type: 'button', className: 'btn sm', textContent: 'View' });
    view.onclick = () => openConnLog(m);
    return [roomCell(m), fmtWhen(m.first), people, calls, view];
  }), { page: 10 });
}
let connShown = null;
async function openConnLog(m) {
  const list = await fetch(`/api/admin/connlogs/${encodeURIComponent(m.id)}`).then((x) => (x.ok ? x.json() : []));
  connShown = { m, list };
  $('connTitle').textContent = m.title || m.room;
  $('connMeta').textContent = `${fmtWhen(m.first)} · ${list.length} events`;
  $('connLines').replaceChildren(...list.map((e) => {
    const d = document.createElement('details');
    d.className = `conn-line${isBad(e) ? ' bad' : ''}`;
    const sum = document.createElement('summary');
    sum.append(Object.assign(document.createElement('span'), { className: 'muted small', textContent: new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }) }), describe(e));
    const pre = document.createElement('pre');
    const { t, m: _m, room, title, ...rest } = e;
    pre.textContent = JSON.stringify(rest, null, 2);
    d.append(sum, pre);
    return d;
  }));
  if (!$('connDialog').open) $('connDialog').showModal();
}
$('connClose').onclick = () => $('connDialog').close();
$('connDl').onclick = () => {
  if (!connShown) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([connShown.list.map((e) => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' }));
  a.download = `connections-${connShown.m.room}-${new Date(connShown.m.first).toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
