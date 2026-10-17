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
  b.textContent = `View (${m.transcriptLines} lines)`;
  b.onclick = () => openTranscript(m.id);
  return b;
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
  fill('openRows', 'openEmpty', s.open.map((m) => [m.room, fmtWhen(m.startedAt), fmtDuration(now - m.startedAt), m.people.join(', '), fmtAudio(m.audioSec), transcriptCell(m)]));
  fill('dayRows', 'dayEmpty', s.days.filter((d) => d.meetings || d.minutes || d.clips).reverse().map((d) => [
    new Date(d.day + 'T12:00:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    d.meetings, fmtDuration(d.minutes * 60_000), fmtAudio(d.audioSec), d.clips, fmtCost(cost(d.audioSec)),
  ]));
  fill('recentRows', 'recentEmpty', s.recent.map((m) => [
    m.room, fmtWhen(m.startedAt), m.interrupted ? 'Unknown (server restarted)' : fmtDuration(m.endedAt - m.startedAt), m.names.join(', '), fmtAudio(m.audioSec || 0), transcriptCell(m),
  ]));
}

// ---------- Transcript viewer ----------
let shown = null;
async function openTranscript(id) {
  const r = await fetch(`/api/admin/meetings/${encodeURIComponent(id)}`);
  if (!r.ok) return;
  shown = await r.json();
  const t = shown.transcript;
  $('txTitle').textContent = `Transcript of ${shown.room}`;
  $('txMeta').textContent = `${fmtWhen(shown.startedAt)} · saved by ${t.by} at ${fmtWhen(t.savedAt)} · ${t.lines.length} lines`;
  $('txBody').replaceChildren(...t.lines.map((l) => {
    const p = document.createElement('p');
    const who = document.createElement('b'); who.textContent = l.name;
    const at = document.createElement('span'); at.className = 'muted small'; at.textContent = new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const head = document.createElement('span'); head.className = 'tx-who'; head.append(who, at);
    const text = document.createElement('span'); text.textContent = l.text;
    p.append(head, text);
    return p;
  }));
  $('txDialog').showModal();
}
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
}
loadProfile();
refresh();
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
    body: JSON.stringify({ displayName: $('pfDisplay').value, username: $('pfUsername').value, email: $('pfEmail').value }),
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
