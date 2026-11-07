// The people in the call: whether each is on a phone or a computer, their
// mic, raised hands and emoji reactions, and the host's mute buttons.
'use strict';

const IS_PHONE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPads say they're Macs
const REACTIONS = ['👍', '👏', '❤️', '😂', '😮', '🎉', '🙏', '👋'];
const me = { hand: false };

const micOn = () => { const a = state.camStream.getAudioTracks()[0]; return !!a && a.enabled; };
const camOn = () => { const v = state.camStream.getVideoTracks()[0]; return !!v && v.enabled; };
function sendMe(id) {
  // away: this page is hidden, e.g. a phone switched to another app, which pauses its camera.
  const msg = { t: 'me', device: IS_PHONE ? 'phone' : 'desktop', mic: micOn(), cam: camOn(), away: document.hidden, hand: me.hand };
  if (id == null) broadcast(msg); else sendTo(id, msg);
  renderSelf();
}
function onMe(p, m) {
  const hadHand = p.hand;
  p.device = m.device === 'phone' ? 'phone' : 'desktop';
  p.mic = m.mic !== false;
  p.hand = !!m.hand;
  p.camOn = m.cam !== false;
  p.away = !!m.away;
  renderPeer(p);
  if (p.hand && !hadHand) { toast(`${p.name} raised their hand`); ding(); }
}

// The name tag: a phone or computer icon, the name, and a crossed-out mic when muted.
function nameTag(tag, name, device, muted) {
  const icon = (id, cls) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', `icon ${cls}`);
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.append(use);
    return svg;
  };
  const parts = [];
  if (device) {
    const d = icon(device === 'phone' ? 'i-phone' : 'i-monitor', 'dev-icon');
    d.setAttribute('aria-label', device === 'phone' ? 'On a phone' : 'On a computer');
    parts.push(d);
  }
  parts.push(Object.assign(document.createElement('span'), { className: 'nt-name', textContent: name }));
  if (muted) parts.push(icon('i-mic-off', 'mic-icon'));
  tag.replaceChildren(...parts);
  tag.title = `${name}${device ? (device === 'phone' ? ', on a phone' : ', on a computer') : ''}${muted ? ', muted' : ''}`;
}
function renderPeer(p) {
  nameTag(p.tile.querySelector('.name-tag'), p.name, p.device, p.mic === false);
  renderCamCover(p);
  const hand = p.tile.querySelector('.hand-tag');
  hand.hidden = !p.hand;
  hand.title = state.isHost ? `Lower ${p.name}'s hand` : `${p.name} raised their hand`;
  hand.disabled = !state.isHost;
  hand.onclick = (e) => {
    e.stopPropagation();
    if (!state.isHost) return;
    sendTo(p.id, { t: 'hand-lower' });
    p.hand = false;
    renderPeer(p);
  };
  const mute = p.tile.querySelector('.mute-btn');
  mute.hidden = !state.isHost || p.mic === false;
  mute.title = `Mute ${p.name}`;
  mute.onclick = (e) => {
    e.stopPropagation();
    sendTo(p.id, { t: 'mute' });
    toast(`You muted ${p.name}`, 2500);
  };
  if (typeof renderFloor === 'function') renderFloor();
}
// Their initials over the tile instead of a black or frozen picture when their
// camera is off, or paused because they switched to another app on a phone.
// Phones don't let a web page use the camera in the background, so the best
// we can do is say why and pick the picture up again when they're back.
function renderCamCover(p) {
  const cover = p.tile.querySelector('.cam-cover');
  const video = p.cam?.getVideoTracks().find((t) => t.readyState === 'live');
  const paused = p.away && p.device === 'phone';
  const show = paused || p.camOn === false || (!!p.cam && (!video || video.muted));
  cover.hidden = !show;
  if (!show) return;
  cover.querySelector('.cc-initials').textContent = initials(p.name);
  cover.querySelector('.cc-note').textContent = paused ? 'In another app. Their camera is paused until they come back.'
    : p.camOn === false ? 'Camera off' : !video ? 'No camera' : ''; // no picture yet, or it stalled
}
// Tell the others when this page goes to the background and comes back.
document.addEventListener('visibilitychange', () => { if (peers.size) sendMe(); });

function renderSelf() {
  nameTag($('selfTile').querySelector('.name-tag'), 'You', IS_PHONE ? 'phone' : 'desktop', !micOn());
  $('selfTile').querySelector('.hand-tag').hidden = !me.hand;
  $('handDot').hidden = !me.hand;
  $('handBtn').classList.toggle('active', me.hand);
  $('handBtn').setAttribute('aria-checked', String(me.hand));
  $('handBtn').querySelector('span').textContent = me.hand ? 'Lower hand' : 'Raise hand';
}
function syncHostUI() {
  $('muteAllBtn').hidden = !state.isHost;
  $('resetAllBtn').hidden = !state.isHost;
  for (const p of peers.values()) if (p.device) renderPeer(p);
  if (typeof syncBoard === 'function') syncBoard();
  if (typeof renderFloor === 'function') renderFloor();
}
function peerGone(p) {
  board.live.delete(p.id);
  if (typeof renderBoard === 'function') renderBoard();
}

// ---------- Raised hands ----------
function setHand(on, byName) {
  if (me.hand === on) return;
  me.hand = on;
  sendMe();
  signal({ type: 'floor', action: 'hand', up: on }); // the server keeps the line, in order
  if (typeof renderFloor === 'function') renderFloor();
  if (!on && byName) toast(`${byName} lowered your hand`);
}
$('handBtn').onclick = () => { setHand(!me.hand); setReactOpen(false); };
$('selfTile').querySelector('.hand-tag').onclick = (e) => { e.stopPropagation(); setHand(false); };
$('selfTile').querySelector('.hand-tag').title = 'Lower your hand';

// ---------- Host: mute people ----------
function mutedByHost(p) {
  const a = state.camStream.getAudioTracks()[0];
  if (!a?.enabled) return;
  a.enabled = false;
  syncMediaButtons();
  sendMe();
  toast(`${p.name} muted you. Unmute when you're ready to talk.`, 6000);
}
$('muteAllBtn').onclick = () => {
  if (!state.isHost) return;
  broadcast({ t: 'mute' });
  setSettingsOpen(false);
  toast('You muted everyone', 2500);
};

// ---------- Reactions ----------
function setReactOpen(open) {
  $('reactMenu').hidden = !open;
  $('reactBtn').classList.toggle('active', open);
  $('reactBtn').setAttribute('aria-expanded', String(open));
}
$('reactBtn').onclick = () => setReactOpen($('reactMenu').hidden);
addEventListener('pointerdown', (e) => {
  if (!$('reactMenu').hidden && !e.target.closest('#reactMenu, #reactBtn')) setReactOpen(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') setReactOpen(false); });
for (const e of REACTIONS) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'emoji', textContent: e, title: `Send ${e}` });
  b.onclick = () => {
    broadcast({ t: 'react', e });
    showReaction('You', e, $('selfTile'));
    setReactOpen(false);
  };
  $('emojiRow').append(b);
}
function onReact(p, m) {
  if (!REACTIONS.includes(m.e)) return;
  const now = Date.now(); // a few a second at most, so nobody floods the screen
  if (now - (p.lastReact || 0) < 250) return;
  p.lastReact = now;
  showReaction(p.name, m.e, p.tile);
}
// The emoji floats up the stage with the name, and pops on their camera.
function showReaction(name, e, tile) {
  const el = document.createElement('div');
  el.className = 'reaction';
  el.style.setProperty('--x', `${Math.round(Math.random() * 60)}px`);
  el.append(Object.assign(document.createElement('span'), { className: 'r-emoji', textContent: e }),
    Object.assign(document.createElement('span'), { className: 'r-name', textContent: name }));
  $('reactions').append(el);
  while ($('reactions').children.length > 12) $('reactions').firstChild.remove();
  setTimeout(() => el.remove(), 3200);
  if (tile && !tile.hidden) {
    const pop = Object.assign(document.createElement('span'), { className: 'tile-react', textContent: e });
    tile.append(pop);
    setTimeout(() => pop.remove(), 2200);
  }
}
renderSelf();


// ---------- Tools menu: draw, pointers and the shared browser ----------
const TOOLS = ['drawBtn', 'pointersBtn', 'controlBtn', 'agendaBtn', 'lineBtn', 'micModeBtn', 'browserBtn'];
function setToolsOpen(open) {
  $('toolsMenu').hidden = !open;
  $('toolsBtn').classList.toggle('open', open);
  $('toolsBtn').setAttribute('aria-expanded', String(open));
}
$('toolsBtn').onclick = () => setToolsOpen($('toolsMenu').hidden);
addEventListener('pointerdown', (e) => {
  if (!$('toolsMenu').hidden && !e.target.closest('#toolsMenu, #toolsBtn')) setToolsOpen(false);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') setToolsOpen(false); });
// Draw and the browser change the whole stage, so the menu gets out of the way.
for (const id of ['drawBtn', 'controlBtn', 'agendaBtn', 'browserBtn']) $(id).addEventListener('click', () => setToolsOpen(false));
// The switches follow each tool's state, and a dot on Tools shows one is on.
function syncTools() {
  let any = false;
  for (const id of TOOLS) {
    const on = $(id).classList.contains('active');
    $(id).setAttribute('aria-checked', String(on));
    if (on && !$(id).hidden) any = true;
  }
  $('toolsDot').hidden = !any;
  $('toolsBtn').classList.toggle('active', any);
}
const toolsWatch = new MutationObserver(syncTools);
for (const id of TOOLS) toolsWatch.observe($(id), { attributes: true, attributeFilter: ['class', 'hidden', 'disabled'] });
syncTools();
