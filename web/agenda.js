// ---------- Agenda mode ----------
// The meeting runs point by point. Each point has its minutes; a bar on the
// stage shows everyone the point being discussed, its countdown and what comes
// next. The host and signed-in people edit the points (before or during the
// call), start, pause and move on; the server keeps the one true state.
const ag = { a: null, canRun: false, offset: 0, timer: 0, rung: '', focusNew: false };

const agNow = () => Date.now() + ag.offset;
const agTotal = (items) => items.reduce((n, x) => n + x.minutes, 0);
function agSpent(a, it) {
  let ms = a.spent[it.id] || 0;
  if (a.items[a.current]?.id === it.id && a.runningSince) ms += agNow() - a.runningSince;
  return ms;
}
// "4:05", "1:02:00", or "+1:20" once over
function agClock(ms, signed) {
  const neg = ms < 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  if (neg) s = Math.ceil(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const t = h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  return neg ? `+${t}` : signed ? `-${t}` : t;
}
const agMin = (n) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);
const agAt = (ms) => new Date(ms - ag.offset).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const agSend = (action, extra) => signal({ type: 'agenda', action, ...extra });

/** A new state from the server, or just a change in whether we may run it. */
function onAgenda(a, canRun, msg) {
  if (canRun != null) ag.canRun = !!canRun;
  if (a) {
    const before = ag.a;
    ag.offset = a.now - Date.now();
    ag.a = a;
    // Tell people when the meeting moves on, unless they moved it.
    const now = a.items[a.current], was = before?.items[before.current];
    if (msg && msg.byId !== state.myId && a.on && now && now.id !== was?.id && ['next', 'prev', 'goto', 'start'].includes(msg.action)) toast(`Now: ${now.title}`, 3500);
    if (msg && !ag.canRun && a.on && !before?.on) toast('The meeting is following an agenda. Its points show at the top.', 5000);
  }
  renderAgenda();
}

function renderAgenda() {
  const a = ag.a || { on: false, items: [], current: -1, spent: {}, runningSince: null };
  const run = ag.canRun;
  $('agendaPane').classList.toggle('can-run', run);
  $('agendaBar').classList.toggle('can-run', run);
  $('agendaBtn').classList.toggle('active', a.on);
  $('agDot').hidden = !(a.on && a.runningSince);
  const started = a.current >= 0, done = a.current >= a.items.length && a.items.length > 0, running = !!a.runningSince;

  // The words above the list
  const total = agTotal(a.items);
  $('agHead').textContent = !a.items.length ? (run ? 'Plan the meeting point by point.' : 'No agenda for this meeting yet.')
    : `${a.items.length} ${a.items.length === 1 ? 'point' : 'points'} · ${agMin(total)}`;
  $('agNote').textContent = !a.items.length
    ? (run ? 'Add the points to cover and how long each gets, or use the agenda planned from your last meeting. When you start, everyone sees the point being discussed, its countdown and what comes next.' : 'If the host sets one, the point being discussed and its countdown show at the top of the call.')
    : !started ? (run ? 'Edit anything, before or during the call. Start when you\'re ready.' : 'Waiting for the host to start.')
      : done ? `Done. It took ${agMin(Math.round(a.items.reduce((n, x) => n + agSpent(a, x), 0) / 60000))} of the ${agMin(total)} planned.` : '';

  // Runner controls
  $('agStart').querySelector('span').textContent = done ? 'Run it again' : !started ? 'Start' : running ? 'Pause' : 'Resume';
  $('agStart').querySelector('use').setAttribute('href', started && !done && running ? '#i-pause' : '#i-play');
  $('agStart').disabled = !a.items.length;
  $('agPrev').disabled = !started || a.current <= 0 || done;
  $('agNext').disabled = !started || done;
  $('agOn').classList.toggle('off', !a.on);
  $('agOn').setAttribute('aria-checked', String(a.on));
  $('agLoad').hidden = started && !done;
  $('agReset').hidden = !started;

  // The list, keyed by point so typing in one row survives updates to others.
  const list = $('agList');
  const rows = new Map([...list.children].map((li) => [li.dataset.id, li]));
  const keep = new Set();
  a.items.forEach((it, i) => {
    let li = rows.get(it.id);
    if (!li) li = agRow(it);
    keep.add(it.id);
    if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
    const state = !started ? 'todo' : i < a.current ? 'done' : i === a.current ? 'now' : 'todo';
    li.dataset.state = state;
    li.querySelector('.ag-num').textContent = state === 'done' ? '✓' : String(i + 1);
    const title = li.querySelector('.ag-title-in'), m = li.querySelector('.ag-min-in');
    if (document.activeElement !== title) title.value = it.title;
    if (document.activeElement !== m) m.value = String(it.minutes);
    li.querySelector('.ag-title').textContent = it.title;
    li.querySelector('.ag-min').textContent = agMin(it.minutes);
    li.querySelector('.ag-goal').textContent = it.note || '';
    li.querySelector('.ag-goal').hidden = !it.note;
  });
  for (const [id, li] of rows) if (!keep.has(id)) li.remove();
  if (ag.focusNew) { ag.focusNew = false; list.lastElementChild?.querySelector('.ag-title-in')?.select(); }
  tickAgenda();
  clearInterval(ag.timer);
  if (a.on && started && !done) ag.timer = setInterval(tickAgenda, 250);
}

function agRow(it) {
  const li = document.createElement('li');
  li.dataset.id = it.id;
  li.innerHTML = `<button class="ag-num" type="button" title="Go to this point"></button>
    <div class="ag-body">
      <div class="ag-view"><span class="ag-title"></span><span class="ag-min muted"></span></div>
      <input class="ag-title-in ag-edit" maxlength="140" aria-label="Point">
      <p class="ag-goal muted small"></p>
      <div class="ag-meta"><span class="ag-edit"><input class="ag-min-in" type="number" min="0.5" max="240" step="0.5" inputmode="decimal" aria-label="Minutes"><span class="muted small">min</span></span>
        <span class="ag-time small"></span><span class="spacer"></span>
        <button class="icon-btn ag-del ag-edit" type="button" title="Remove this point"><svg class="icon sm"><use href="#i-x"/></svg></button></div>
    </div>`;
  li.querySelector('.ag-num').onclick = () => { if (ag.canRun) agSend('goto', { id: li.dataset.id }); };
  for (const inp of li.querySelectorAll('input')) {
    inp.addEventListener('change', saveItems);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  }
  li.querySelector('.ag-del').onclick = () => { li.remove(); saveItems(); };
  return li;
}

// Send the whole list as the rows show it now.
function saveItems() {
  const items = [...$('agList').children].map((li) => ({
    id: li.dataset.id.startsWith('new') ? '' : li.dataset.id,
    title: li.querySelector('.ag-title-in').value,
    minutes: Number(li.querySelector('.ag-min-in').value) || 5,
    note: ag.a?.items.find((x) => x.id === li.dataset.id)?.note || '',
  }));
  agSend('items', { items });
}

// The countdowns: the bar on the stage and the rows' times.
function tickAgenda() {
  const a = ag.a;
  const bar = $('agendaBar');
  const started = a && a.current >= 0, done = a && a.current >= a.items.length;
  const it = a?.items[a.current];
  bar.hidden = !a?.on || !a.items.length || (!started && !ag.canRun) || (done && !ag.canRun);
  if (!a) return;
  for (const li of $('agList').children) {
    const x = a.items.find((y) => y.id === li.dataset.id);
    if (!x) continue;
    const spent = agSpent(a, x), st = li.dataset.state;
    const t = li.querySelector('.ag-time');
    t.textContent = st === 'now' ? `${agClock(x.minutes * 60000 - spent)} ${x.minutes * 60000 - spent < 0 ? 'over' : 'left'}` : st === 'done' ? `took ${agClock(spent)}` : '';
    li.classList.toggle('over', st === 'now' && spent > x.minutes * 60000);
  }
  if (bar.hidden) return;
  if (!started || done) {
    bar.dataset.state = 'idle';
    $('abCount').textContent = done ? 'Done' : `${a.items.length} points`;
    $('abNow').textContent = done ? 'Agenda finished' : 'Agenda ready';
    $('abNext').textContent = done ? `Planned ${agMin(agTotal(a.items))}` : `${agMin(agTotal(a.items))} · first: ${a.items[0].title}`;
    $('abClock').textContent = '';
    $('abPlay').querySelector('use').setAttribute('href', done ? '#i-x' : '#i-play');
    $('abPlay').title = done ? 'Hide the agenda' : 'Start';
    $('abMore').hidden = $('abNextBtn').hidden = true;
    return;
  }
  const left = it.minutes * 60000 - agSpent(a, it);
  const next = a.items[a.current + 1];
  // When will it end at this pace: what's left of this point, plus the rest as planned.
  const rest = a.items.slice(a.current + 1).reduce((n, x) => n + Math.max(x.minutes * 60000 - agSpent(a, x), 0), 0);
  const end = agNow() + Math.max(left, 0) + rest;
  bar.dataset.state = left < 0 ? 'over' : left <= 60000 ? 'warn' : a.runningSince ? 'run' : 'paused';
  $('abCount').textContent = `${a.current + 1}/${a.items.length}`;
  $('abNow').textContent = it.title;
  $('abNext').textContent = next ? `Next: ${next.title} · ends ~${agAt(end)}` : `Last point · ends ~${agAt(end)}`;
  $('abClock').textContent = a.runningSince ? agClock(left) : `${agClock(left)} ⏸`;
  $('abPlay').querySelector('use').setAttribute('href', a.runningSince ? '#i-pause' : '#i-play');
  $('abPlay').title = a.runningSince ? 'Pause' : 'Resume';
  $('abMore').hidden = $('abNextBtn').hidden = false;
  $('abNextBtn').title = next ? `Next: ${next.title}` : 'Finish the agenda';
  // A soft ding for whoever runs it, once, when a point's time is up.
  if (ag.canRun && a.runningSince && left <= 0 && ag.rung !== it.id) { ag.rung = it.id; ding(); }
}

// ---------- Controls ----------
function openAgendaPane() {
  setChatOpen(true);
  showTab('agenda');
}
$('agendaTab').onclick = () => showTab('agenda');
$('agendaBtn').onclick = () => {
  // The switch turns it on for everyone; anyone can open the list.
  if (ag.canRun && !ag.a?.on && ag.a?.items.length) agSend('on', { on: true });
  openAgendaPane();
};
$('abText').onclick = openAgendaPane;
$('agOn').onclick = () => agSend('on', { on: !ag.a?.on });
$('agStart').onclick = () => {
  const a = ag.a;
  if (a && a.current >= 0 && a.current < a.items.length) agSend(a.runningSince ? 'pause' : 'start');
  else agSend('start');
};
$('agPrev').onclick = () => agSend('prev');
$('agNext').onclick = () => agSend('next');
$('agReset').onclick = () => agSend('reset');
$('agLoad').onclick = () => agSend('load');
$('agAdd').onclick = () => {
  const li = agRow({ id: `new${Date.now()}` });
  li.querySelector('.ag-title-in').value = 'New point';
  li.querySelector('.ag-min-in').value = '5';
  $('agList').append(li);
  ag.focusNew = true;
  saveItems();
};
$('abPlay').onclick = () => {
  const a = ag.a;
  if (!a) return;
  if (a.current >= a.items.length) agSend('on', { on: false });
  else if (a.current < 0) agSend('start');
  else agSend(a.runningSince ? 'pause' : 'start');
};
$('abNextBtn').onclick = () => agSend('next');
$('abMore').onclick = () => agSend('extend', { minutes: 2 });
renderAgenda();
