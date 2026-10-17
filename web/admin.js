// Admin page: meetings open now, recent meetings and daily usage, refreshed
// every few seconds from /api/admin/stats.
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
    td.textContent = c;
    tr.append(td);
  }
  return tr;
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
  fill('openRows', 'openEmpty', s.open.map((m) => [m.room, fmtWhen(m.startedAt), fmtDuration(now - m.startedAt), m.people.join(', '), fmtAudio(m.audioSec)]));
  fill('dayRows', 'dayEmpty', s.days.filter((d) => d.meetings || d.minutes || d.clips).reverse().map((d) => [
    new Date(d.day + 'T12:00:00Z').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }),
    d.meetings, fmtDuration(d.minutes * 60_000), fmtAudio(d.audioSec), d.clips, fmtCost(cost(d.audioSec)),
  ]));
  fill('recentRows', 'recentEmpty', s.recent.map((m) => [
    m.room, fmtWhen(m.startedAt), m.interrupted ? 'Unknown (server restarted)' : fmtDuration(m.endedAt - m.startedAt), m.names.join(', '), fmtAudio(m.audioSec || 0),
  ]));
}

fetch('/api/me').then((r) => r.json()).then(({ user }) => {
  if (user) $('account').textContent = `Signed in as ${user.username} (${user.email}). New accounts can't be created yet.`;
});
refresh();
setInterval(refresh, 10_000);

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
  $('pwMsg').hidden = false;
  $('pwMsg').className = 'small ' + (r.ok ? 'form-ok' : 'form-error');
  $('pwMsg').textContent = r.ok ? 'Password changed. Other browsers were signed out.' : out.error || 'Could not change it.';
  if (r.ok) $('pwForm').reset();
};
