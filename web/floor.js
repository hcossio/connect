// ---------- Who gets to talk: wait in line, and pass the mic ----------
// The host switches either mode on from Tools. Raising your hand puts you in
// line, in the order hands went up.
//
// Wait in line: when nobody has the floor, the first in line gets a 30 second
// countdown on everyone's screen. When it runs out they have the floor and
// everyone else is muted once; they can unmute again if they need to.
//
// Pass the mic: a 10 second countdown, then only the person with the mic can
// talk. Everyone else stays muted until it's passed to them. The holder passes
// it down the line, and the host can give it to anyone, take it, or stop.
//
// The server keeps the line and the clocks (server/floor.js).
const fl = { f: null, offset: 0, timer: 0, popTimer: 0, lastCount: null };

const flNow = () => Date.now() + fl.offset;
const flSend = (action, extra) => signal({ type: 'floor', action, ...extra });
const flOn = () => !!fl.f && fl.f.mode !== 'off';
const flMine = (id) => id != null && id === state.myId;
const flName = (who) => (who ? (flMine(who.id) ? 'You' : nameOf(who.id) === 'Someone' ? who.name : nameOf(who.id)) : '');
const flSecs = (ms) => Math.max(0, Math.ceil(ms / 1000));
function flClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const MODE_NAME = { line: 'Wait in line', mic: 'Pass the mic' };

/** Pass the mic is live and someone else has it: our mic stays off. */
function floorBlocksMic() {
  const f = fl.f;
  return !!f && f.mode === 'mic' && !f.startsAt && !flMine(f.speaker?.id);
}
function setMyMic(on) {
  const a = state.camStream?.getAudioTracks()[0];
  if (!a || a.enabled === on) return false;
  a.enabled = on;
  syncMediaButtons();
  sendMe();
  return true;
}

/** A new state from the server. `msg` is missing when we just joined. */
function onFloor(f, msg) {
  const prev = fl.f;
  fl.offset = f.now - Date.now();
  fl.f = f;
  if (msg && prev) {
    const was = prev.speaker, now = f.speaker;
    if (prev.mode !== f.mode) {
      if (f.mode === 'line') toast('Wait in line is on. Raise your hand to speak next; you\'ll get the floor after a 30 second countdown.', 7000);
      if (f.mode === 'off') toast(`${MODE_NAME[prev.mode]} is off. Everyone can unmute.`, 5000);
      if (f.mode === 'mic') ding();
    }
    if (f.turn !== prev.turn && now && now.id !== was?.id) {
      const mic = f.mode === 'mic';
      if (flMine(now.id)) {
        setMyMic(true);
        if (me.hand) setHand(false);
        pop('🎤', mic ? 'You have the mic' : 'You have the floor', mic ? 'Pass it on when you\'re done' : 'Everyone else is muted');
        ding();
      } else {
        // Wait in line mutes everyone else once; pass the mic keeps them muted.
        const muted = setMyMic(false);
        pop('🎤', `${flName(now)} ${mic ? 'has the mic' : 'has the floor'}`, mic ? '' : muted ? 'You\'re muted. Unmute if you need to.' : '');
      }
      if (was && prev.since) toast(`${flName(was)} talked for ${flClock(flNow() - prev.since)}`, 3500);
    } else if (f.turn !== prev.turn && was && !now && f.mode !== 'off' && prev.mode === f.mode) {
      const took = prev.since ? ` after ${flClock(flNow() - prev.since)}` : '';
      toast(f.mode === 'mic' ? `${flName(was)} put the mic down${took}. Raise your hand to take it.` : `${flName(was)} finished${took}.`, 4000);
    }
    if (msg.event === 'open' && !now) toast('The mic is free. Raise your hand to take it.', 5000);
  }
  if (floorBlocksMic()) setMyMic(false);
  syncMediaButtons();
  renderFloor();
}

// A big moment in the middle of the stage: the countdown, or who has the mic now.
function pop(emoji, title, sub) {
  const el = $('floorPop');
  el.dataset.kind = 'pop';
  $('fpEmoji').textContent = emoji;
  $('fpNum').textContent = '';
  $('fpTitle').textContent = title;
  $('fpSub').textContent = sub || '';
  $('fpHand').hidden = true;
  el.hidden = false;
  el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
  clearTimeout(fl.popTimer);
  fl.popTimer = setTimeout(() => { if (el.dataset.kind === 'pop') el.hidden = true; }, 2200);
}

function renderFloor() {
  const f = fl.f || { mode: 'off', queue: [], speaker: null, up: null, startsAt: null };
  const on = f.mode !== 'off';
  const host = state.isHost;
  for (const [id, mode] of [['lineBtn', 'line'], ['micModeBtn', 'mic']]) {
    $(id).hidden = !host;
    $(id).classList.toggle('active', f.mode === mode);
  }
  $('handBtn').querySelector('span').textContent = me.hand
    ? (f.mode === 'mic' ? 'Leave the line' : 'Lower hand')
    : f.mode === 'mic' ? 'Ask for the mic' : 'Raise hand';

  // Tiles: a glow and a mic on whoever talks, your place in line on your hand,
  // and the host's "give the mic" button.
  const pos = new Map(f.queue.map((x, i) => [x.id, i + 1]));
  const mark = (tile, id) => {
    tile.classList.toggle('has-floor', on && f.speaker?.id === id);
    tile.classList.toggle('is-up', on && f.up?.id === id);
    const h = tile.querySelector('.hand-tag');
    if (on && pos.has(id)) h.dataset.pos = pos.get(id); else delete h.dataset.pos;
  };
  mark($('selfTile'), state.myId);
  for (const p of peers.values()) {
    mark(p.tile, p.id);
    const g = p.tile.querySelector('.give-btn');
    g.hidden = !host || !on || f.speaker?.id === p.id;
    g.title = f.mode === 'mic' ? `Give ${p.name} the mic` : `Give ${p.name} the floor now`;
    g.onclick = (e) => { e.stopPropagation(); flSend('give', { to: p.id }); };
  }

  $('floorBar').hidden = !on;
  clearInterval(fl.timer);
  if (on) fl.timer = setInterval(tickFloor, 250);
  tickFloor();
}

// The bar and the clocks. Runs four times a second while a mode is on.
function tickFloor() {
  const f = fl.f, bar = $('floorBar'), popEl = $('floorPop');
  if (!f || f.mode === 'off') {
    if (popEl.dataset.kind === 'count') popEl.hidden = true;
    return;
  }
  const host = state.isHost, mic = f.mode === 'mic';
  const mine = flMine(f.speaker?.id), upMine = flMine(f.up?.id);
  const inLine = f.queue.findIndex((x) => flMine(x.id));
  const rest = f.queue.filter((x) => x.id !== f.up?.id);
  const lineText = (list) => (list.length ? `Next: ${list.slice(0, 3).map(flName).join(', ')}${list.length > 3 ? ` +${list.length - 3}` : ''}` : '');
  let state_ = 'idle', icon = mic ? '🎤' : '✋', main = '', sub = '', clock = '';

  if (mic && f.startsAt) {
    const left = f.startsAt - flNow();
    state_ = 'count';
    main = 'Pass the mic is starting';
    sub = inLine >= 0 ? `You're #${inLine + 1} in line` : 'Raise your hand now to be first in line';
    clock = `0:${String(flSecs(left)).padStart(2, '0')}`;
    // The big countdown in the middle, for everyone.
    popEl.dataset.kind = 'count';
    popEl.hidden = false;
    $('fpEmoji').textContent = '🎤';
    const n = String(flSecs(left));
    if ($('fpNum').textContent !== n) {
      $('fpNum').textContent = n;
      popEl.classList.remove('tick'); void popEl.offsetWidth; popEl.classList.add('tick');
    }
    $('fpTitle').textContent = 'Pass the mic starts in';
    $('fpSub').textContent = inLine >= 0 ? `You're #${inLine + 1} in line` : 'Only the person with the mic can talk. Raise your hand to get in line.';
    $('fpHand').hidden = inLine >= 0;
  } else {
    if (popEl.dataset.kind === 'count') popEl.hidden = true;
    if (f.up) {
      const left = f.up.at - flNow();
      state_ = left <= 10000 ? 'warn' : 'count';
      icon = upMine ? '⏳' : '✋';
      main = upMine ? 'You\'re up next' : `${flName(f.up)} is up next`;
      sub = upMine ? 'You get the floor when the countdown ends' : `Everyone else gets muted when it ends${rest.length ? ` · ${lineText(rest)}` : ''}`;
      clock = flClock(left + 999);
    } else if (f.speaker) {
      state_ = mine ? 'mine' : 'live';
      icon = '🎤';
      main = mine ? (mic ? 'You have the mic' : 'You have the floor') : `${flName(f.speaker)} ${mic ? 'has the mic' : 'has the floor'}`;
      sub = lineText(f.queue) || (mine ? 'Nobody is waiting yet' : mic ? 'Raise your hand to be next' : 'Raise your hand to speak next');
      if (inLine >= 0 && !mine) sub = `You're #${inLine + 1} in line${inLine ? '' : ' · you\'re next'}`;
      clock = flClock(flNow() - f.since);
    } else {
      main = mic ? 'The mic is free' : 'Wait in line is on';
      sub = inLine >= 0 ? `You're #${inLine + 1} in line` : mic ? 'Raise your hand to take it' : 'Raise your hand to speak';
    }
  }
  bar.dataset.state = state_;
  bar.dataset.mode = f.mode;
  $('fbIcon').textContent = inLine >= 0 && !mine && !upMine ? `#${inLine + 1}` : icon;
  $('fbMain').textContent = main;
  $('fbSub').textContent = sub;
  $('fbClock').textContent = clock;
  $('fbClock').title = f.speaker && !f.up ? 'How long they\'ve been talking' : '';

  // Buttons: your hand, the speaker's "done / pass", and the host's overrides.
  const hand = $('fbHand');
  hand.hidden = mine || upMine || (host && mic && !me.hand); // the host has Take instead
  hand.classList.toggle('active', me.hand);
  hand.querySelector('span').textContent = me.hand ? 'Leave line' : mic ? 'Ask for mic' : 'Raise hand';
  const done = $('fbDone');
  // The host moves the line on; in pass the mic only when someone's waiting (Take covers the rest).
  done.hidden = !(mine || (host && f.speaker && (!mic || f.queue.length)));
  done.querySelector('span').textContent = mic
    ? (mine ? (f.queue.length ? `Pass to ${flName(f.queue[0])}` : 'Put the mic down') : `Pass to ${flName(f.queue[0])}`)
    : mine ? 'I\'m done' : 'Next';
  done.title = mic ? (f.queue.length ? `Pass the mic to ${flName(f.queue[0])}` : 'Nobody is in line; the next hand up gets it') : 'End this turn and move the line on';
  $('fbNow').hidden = !(host && (f.up || (mic && f.startsAt)));
  $('fbNow').title = f.up ? `Give ${flName(f.up)} the floor now` : 'Start now';
  $('fbTake').hidden = !(host && mic && !f.startsAt && !mine);
  $('fbOff').hidden = !host;
  $('fbOff').title = `Turn off ${MODE_NAME[f.mode]}`;
}

// ---------- Controls ----------
function setFloorMode(mode) {
  if (!state.isHost) return;
  flSend('mode', { mode: fl.f?.mode === mode ? 'off' : mode });
  setToolsOpen(false);
}
$('lineBtn').onclick = () => setFloorMode('line');
$('micModeBtn').onclick = () => setFloorMode('mic');
$('fbHand').onclick = () => setHand(!me.hand);
$('fpHand').onclick = () => setHand(true);
$('fbDone').onclick = () => {
  const f = fl.f;
  if (f) flSend(flMine(f.speaker?.id) ? 'done' : 'pass');
};
$('fbNow').onclick = () => {
  const f = fl.f;
  if (f?.up) flSend('now');
  else if (f?.mode === 'mic' && f.startsAt) flSend('give', { to: f.queue[0]?.id ?? state.myId });
};
$('fbTake').onclick = () => flSend('give', { to: state.myId });
$('fbOff').onclick = () => flSend('mode', { mode: 'off' });
$('floorPop').onclick = (e) => { if (e.target === $('floorPop') && $('floorPop').dataset.kind === 'pop') $('floorPop').hidden = true; };
renderFloor();
