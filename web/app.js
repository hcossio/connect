// DevAssist web client: small-group WebRTC call (everyone connects directly
// to everyone else) with cameras, mic, screen share, chat and remote control.
// Control events travel over a WebRTC data channel; the person being helped
// forwards them to DevAssist Helper on 127.0.0.1, which is the only piece
// that can move the mouse and type (browsers can't).
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // add a TURN server for production
const AGENT_URL = 'ws://127.0.0.1:47800';
const CAN_SHARE = !!navigator.mediaDevices?.getDisplayMedia;
const isWide = () => matchMedia('(min-width: 1025px)').matches;

const state = {
  ws: null, myId: null,
  camStream: new MediaStream(), screenStream: null,
  myName: 'Guest',
  focusId: null,            // whose shared screen we want on the stage
  shownId: null,            // whose shared screen is on the stage now
  agent: null,              // WebSocket to DevAssist Helper (helped side)
  controlGrantedTo: null,   // helped side: the person allowed to control us
  controlRequestFrom: null, // helped side: the person whose request we're answering
  controlling: null,        // helper side: the person we are controlling
  controlPending: null,     // helper side: the person we asked, waiting for an answer
  unread: 0,
  pointers: false,          // show mouse pointers on the shared screen
  isHost: false,            // started the session: gets the "still there?" check and runs the transcript
  hostId: null,
  ended: false,
};
/**
 * Everyone else in the call, by the id the server gave them.
 * @type {Map<number, { id: number, name: string, pc: RTCPeerConnection, dc: RTCDataChannel,
 *   polite: boolean, makingOffer: boolean, ignoreOffer: boolean, waitForOffer: boolean, streams: Map<string, MediaStream>,
 *   cam: MediaStream|null, screen: MediaStream|null, screenStreamId: string|null, sharedAt: number,
 *   tile: HTMLElement, pointer?: { on: number, x: number, y: number }|null, pointerEl?: HTMLElement,
 *   pointerSent?: boolean }>}
 */
const peers = new Map();
const TITLE = document.title;

// ---------- Small UI helpers ----------
function setStatus(text, kind = 'waiting') {
  $('status').textContent = text;
  $('statusPill').dataset.state = kind;
}
const nameOf = (id) => peers.get(id)?.name || 'Someone';
function fillName(el, name) {
  for (const b of el.querySelectorAll('.peer-name')) b.textContent = name;
}
function toast(text, ms = 4000) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  const box = $('toasts');
  box.append(el);
  while (box.children.length > 2) box.firstChild.remove(); // keep the stage readable
  setTimeout(() => el.remove(), ms);
}
function updateStatus() {
  if (state.ended) return;
  const list = [...peers.values()];
  const live = list.filter((p) => p.pc.connectionState === 'connected');
  if (!list.length) setStatus('Waiting for others to join');
  else if (live.length === 1 && list.length === 1) setStatus(`Connected with ${live[0].name}`, 'connected');
  else if (live.length) setStatus(`${live.length + 1} people in the call`, 'connected');
  else if (list.every((p) => p.pc.connectionState === 'failed')) setStatus('Connection failed', 'failed');
  else setStatus('Connecting', 'connecting');
}
// The stage shows one shared screen at a time (the newest, or the one you
// picked) with everyone's cameras in a strip; otherwise a grid of cameras.
function updateStage() {
  const sharers = [...peers.values()].filter((p) => p.screen).sort((a, b) => a.sharedAt - b.sharedAt);
  // Keep the wanted screen while its video is still on the way.
  if (!peers.get(state.focusId)?.screenStreamId) state.focusId = sharers.at(-1)?.id ?? null;
  const wanted = peers.get(state.focusId);
  const focus = wanted?.screen ? wanted : sharers.at(-1) || null;
  state.shownId = focus?.id ?? null;
  const screen = $('remoteScreen');
  if (focus) {
    if (screen.srcObject !== focus.screen) screen.srcObject = focus.screen;
    screen.hidden = false;
  } else {
    screen.hidden = true;
    screen.srcObject = null;
  }
  $('stage').dataset.mode = focus ? 'screen' : peers.size ? 'cam' : 'empty';
  $('emptyState').hidden = peers.size > 0;
  $('grid').hidden = peers.size === 0;
  $('grid').dataset.count = peers.size;
  for (const p of peers.values()) {
    p.tile.classList.toggle('focused', p === focus && sharers.length > 1);
    p.tile.querySelector('.share-tag').hidden = !p.screen || sharers.length < 2; // the chip already says whose
    p.tile.title = p.screen && p !== focus ? `Show ${p.name}'s screen` : '';
  }
  $('screenChip').hidden = !focus;
  if (focus) $('screenChip').textContent = sharers.length > 1 ? `${focus.name}'s screen · tap a camera to switch` : `${focus.name}'s screen`;
  // Control follows the screen on the stage.
  if (state.controlling && state.controlling !== state.shownId) {
    sendTo(state.controlling, { t: 'control-revoked' });
    stopControl();
  }
  updateControlBtn();
  layoutGrid();
  placeTiles();
  syncPointers();
}
// Pick the column count that gives the biggest tiles: 16:9 on landscape
// screens, 3:4 on portrait phones.
function layoutGrid() {
  const g = $('grid'), n = peers.size;
  if (!n || $('stage').dataset.mode === 'screen') return;
  const GAP = 8, W = g.clientWidth - 2 * GAP, H = g.clientHeight - 2 * GAP;
  const ratio = W >= H ? 16 / 9 : 3 / 4;
  let best = { cols: 1, w: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const w = Math.min((W - GAP * (cols - 1)) / cols, ((H - GAP * (rows - 1)) / rows) * ratio);
    if (w > best.w) best = { cols, w };
  }
  g.style.setProperty('--cols', best.cols);
  g.style.setProperty('--tile-w', `${Math.floor(best.w)}px`);
  g.style.setProperty('--tile-h', `${Math.floor(best.w / ratio)}px`);
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

// ---------- Mic / camera (shared by lobby and call) ----------
function syncMediaButtons() {
  const a = state.camStream.getAudioTracks()[0];
  const v = state.camStream.getVideoTracks()[0];
  for (const b of $$('.media-mic')) {
    b.disabled = !a;
    b.classList.toggle('off', !a || !a.enabled);
    b.title = !a ? 'No microphone' : a.enabled ? 'Mute microphone' : 'Unmute microphone';
  }
  for (const b of $$('.media-cam')) {
    b.disabled = !v;
    b.classList.toggle('off', !v || !v.enabled);
    b.title = !v ? 'No camera' : v.enabled ? 'Turn camera off' : 'Turn camera on';
  }
  const camOn = !!v && v.enabled;
  $('previewOff').hidden = camOn;
  if (!camOn) $('previewOff').textContent = v ? 'Camera is off' : 'Camera unavailable';
  $('selfAvatar').hidden = camOn;
  $('selfAvatar').textContent = initials(state.myName);
}
function syncNoiseButtons() {
  for (const b of $$('.media-noise')) {
    b.hidden = !noise.node;
    b.classList.toggle('off', !noise.on);
    b.title = noise.on ? 'Noise filter on: only voices come through' : 'Noise filter off';
  }
}
for (const b of $$('.media-mic')) b.onclick = () => {
  const t = state.camStream.getAudioTracks()[0]; if (t) t.enabled = !t.enabled; syncMediaButtons();
};
for (const b of $$('.media-cam')) b.onclick = () => {
  const t = state.camStream.getVideoTracks()[0]; if (t) t.enabled = !t.enabled; syncMediaButtons();
};
for (const b of $$('.media-noise')) b.onclick = () => {
  noise.on = !noise.on;
  try { localStorage.setItem('devassist:noise', noise.on ? 'on' : 'off'); } catch {}
  routeMic();
  syncNoiseButtons();
  toast(noise.on ? 'Noise filter on' : 'Noise filter off', 2000);
};

// ---------- Noise filter ----------
// The mic runs through RNNoise, a small speech model that keeps voices and
// drops keyboards, fans, traffic and background chatter. It runs locally in
// an AudioWorklet. Turning it on or off only reroutes the audio graph, so the
// track sent to the other person never changes and nothing renegotiates.
const NOISE_LIB = '/vendor/noise';
const noise = { on: true, ctx: null, src: null, node: null, dest: null, raw: null };
try { noise.on = localStorage.getItem('devassist:noise') !== 'off'; } catch {}

async function filterMic(raw) {
  const ctx = new AudioContext({ sampleRate: 48000 }); // RNNoise expects 48 kHz
  try {
    const lib = await import(`${NOISE_LIB}/index.js`);
    const [wasmBinary] = await Promise.all([
      lib.loadRnnoise({ url: `${NOISE_LIB}/rnnoise.wasm`, simdUrl: `${NOISE_LIB}/rnnoise_simd.wasm` }),
      ctx.audioWorklet.addModule(`${NOISE_LIB}/rnnoise/workletProcessor.js`),
    ]);
    Object.assign(noise, {
      ctx, raw,
      node: new lib.RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 }),
      src: ctx.createMediaStreamSource(new MediaStream([raw])),
      dest: ctx.createMediaStreamDestination(),
    });
    noise.node.connect(noise.dest);
    routeMic();
    resumeAudio();
    return noise.dest.stream.getAudioTracks()[0];
  } catch (err) {
    console.warn('Noise filter unavailable, sending the mic as is:', err);
    ctx.close();
    return raw;
  }
}
function routeMic() {
  if (!noise.node) return;
  noise.src.disconnect();
  noise.src.connect(noise.on ? noise.node : noise.dest);
}
// Browsers start audio suspended until the person interacts with the page.
function resumeAudio() {
  if (noise.ctx?.state === 'suspended') noise.ctx.resume().catch(() => {});
}
addEventListener('pointerdown', resumeAudio, true);
addEventListener('keydown', resumeAudio, true);
function stopNoise() {
  noise.raw?.stop();
  noise.node?.destroy();
  noise.ctx?.close().catch(() => {});
  noise.node = null;
}

// ---------- Movable camera tiles ----------
// Floating tiles (your camera, and the strip of everyone's cameras during a
// screen share) can be dragged around the stage. Positions are kept as
// fractions of the free space so they stay put when the window or the chat
// panel resizes.
const TILES = [$('selfTile'), $('grid')];
const tilePos = new Map();
const isFloating = (tile) => !tile.hidden && (tile.id === 'selfTile' || $('stage').dataset.mode === 'screen');
function placeTile(tile) {
  const p = tilePos.get(tile);
  if (!p || !isFloating(tile)) {
    tile.style.left = tile.style.top = tile.style.right = tile.style.bottom = '';
    return;
  }
  const maxX = Math.max(0, $('stage').clientWidth - tile.offsetWidth);
  const maxY = Math.max(0, $('stage').clientHeight - tile.offsetHeight);
  Object.assign(tile.style, { left: `${p.x * maxX}px`, top: `${p.y * maxY}px`, right: 'auto', bottom: 'auto' });
}
function placeTiles() { TILES.forEach(placeTile); }
for (const tile of TILES) {
  tile.addEventListener('pointerdown', (e) => {
    if (!isFloating(tile) || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    const stage = $('stage').getBoundingClientRect();
    const start = tile.getBoundingClientRect();
    const grabX = e.clientX - start.left, grabY = e.clientY - start.top;
    const maxX = stage.width - start.width, maxY = stage.height - start.height;
    // A tap (no movement) on a camera in the strip still counts as a click.
    const tapped = e.target.closest('.tile.peer');
    let moved = false;
    tile.setPointerCapture(e.pointerId);
    tile.classList.add('dragging');
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
      moved = true;
      const x = Math.min(Math.max(ev.clientX - stage.left - grabX, 0), maxX);
      const y = Math.min(Math.max(ev.clientY - stage.top - grabY, 0), maxY);
      tilePos.set(tile, { x: maxX > 0 ? x / maxX : 0, y: maxY > 0 ? y / maxY : 0 });
      placeTile(tile);
    };
    const end = (ev) => {
      if (!moved && ev.type === 'pointerup' && tapped) tapped.click();
      tile.classList.remove('dragging');
      tile.removeEventListener('pointermove', move);
      tile.removeEventListener('pointerup', end);
      tile.removeEventListener('pointercancel', end);
    };
    tile.addEventListener('pointermove', move);
    tile.addEventListener('pointerup', end);
    tile.addEventListener('pointercancel', end);
  });
}
new ResizeObserver(() => { layoutGrid(); placeTiles(); syncPointers(); }).observe($('stage'));

// ---------- Pop-out cameras ----------
// Chrome and Edge open a small always-on-top window with everyone's cameras
// and a mic button (Document Picture-in-Picture), so you can keep seeing each other
// while working in another app. Safari falls back to the browser's video
// picture-in-picture for the camera you clicked.
const CAN_DOC_PIP = 'documentPictureInPicture' in window;
const CAN_VIDEO_PIP = !!document.pictureInPictureEnabled;
let pip = null, pipTimer = null;
function setupPopButton(b) {
  b.hidden = !(CAN_DOC_PIP || CAN_VIDEO_PIP);
  b.onclick = (e) => popOut(e.currentTarget.closest('.tile').querySelector('video'));
}
$$('.pop-btn').forEach(setupPopButton);
async function popOut(video) {
  if (pip) return pip.close();
  if (!CAN_DOC_PIP) {
    try { await video.requestPictureInPicture(); } catch { toast('Your browser blocked the pop-out window.'); }
    return;
  }
  try {
    pip = await documentPictureInPicture.requestWindow({ width: 360, height: 225 });
  } catch {
    return toast('Your browser blocked the pop-out window.');
  }
  const d = pip.document;
  d.title = 'DevAssist';
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) d.head.append(link.cloneNode());
  d.body.append($('sprite').cloneNode(true));
  d.body.insertAdjacentHTML('beforeend', `
    <div class="pip">
      <div class="pip-peers"></div>
      <div class="pip-wait">Waiting for others to join</div>
      <span class="name-tag"></span>
      <div class="pip-self"><video autoplay playsinline muted></video><div class="avatar" hidden></div></div>
      <button class="ctrl" type="button"><svg class="icon"><use href="#i-mic"/></svg><svg class="icon slash"><use href="#i-slash"/></svg></button>
    </div>`);
  d.querySelector('.ctrl').onclick = () => { $('micBtn').click(); syncPip(); };
  $('stage').classList.add('popped');
  syncPip();
  pipTimer = setInterval(syncPip, 500); // streams and names change during the call
  pip.addEventListener('pagehide', () => {
    clearInterval(pipTimer);
    pip = null;
    $('stage').classList.remove('popped');
    placeTiles();
  });
}
function syncPip() {
  if (!pip) return;
  const d = pip.document;
  const list = [...peers.values()].filter((p) => p.cam);
  const box = d.querySelector('.pip-peers');
  const key = list.map((p) => p.id).join();
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.style.gridTemplateColumns = `repeat(${list.length > 1 ? 2 : 1}, 1fr)`;
    box.replaceChildren(...list.map((p) => {
      const v = d.createElement('video');
      v.autoplay = v.playsInline = v.muted = true; // muted: the call's audio keeps playing in the tab
      v.dataset.id = p.id;
      return v;
    }));
  }
  for (const v of box.children) {
    const cam = peers.get(Number(v.dataset.id))?.cam || null;
    if (v.srcObject !== cam) v.srcObject = cam;
  }
  const sv = d.querySelector('.pip-self video');
  if (sv.srcObject !== state.camStream) sv.srcObject = state.camStream;
  d.querySelector('.pip-wait').hidden = list.length > 0;
  const tag = d.querySelector('.name-tag');
  tag.hidden = list.length > 1;
  tag.textContent = list.length ? list[0].name : 'You';
  const a = state.camStream.getAudioTracks()[0], v = state.camStream.getVideoTracks()[0];
  const mic = d.querySelector('.ctrl');
  mic.disabled = !a;
  mic.classList.toggle('off', !a || !a.enabled);
  mic.title = !a ? 'No microphone' : a.enabled ? 'Mute microphone' : 'Unmute microphone';
  const avatar = d.querySelector('.pip-self .avatar');
  avatar.hidden = !!v && v.enabled;
  avatar.textContent = initials(state.myName);
}

// ---------- Lobby ----------
const urlRoom = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : '';
try { $('nameInput').value = localStorage.getItem('devassist:name') || ''; } catch {}
if (urlRoom) {
  $('lobbyTitle').textContent = 'Ready to join?';
  $('lobbySub').textContent = `You're joining room “${urlRoom}”.`;
  $('roomInput').value = urlRoom;
  $('roomField').hidden = true;
  $('joinBtn').textContent = 'Join call';
}
$('roomInput').oninput = () => {
  const code = $('roomInput').value.trim();
  $('joinBtn').textContent = code || !state.user ? 'Join call' : 'Start call';
  if (!urlRoom && !state.user) $('joinBtn').disabled = !code;
};

// Only the host (signed in) starts meetings; everyone else joins with a link or code.
const meReady = fetch('/api/me').then((r) => r.json()).then(({ user }) => {
  state.user = user;
  $('signedIn').hidden = !user;
  $('hostSignIn').hidden = !!user || !!urlRoom;
  if (user) {
    $('signedInName').textContent = user.username;
    if (user.displayName && !$('nameInput').value) $('nameInput').value = user.displayName;
    $('adminLink').hidden = user.role !== 'admin';
  } else if (!urlRoom) {
    $('lobbyTitle').textContent = 'Join a support call';
    $('lobbySub').textContent = 'Enter the room code your host sent you.';
    $('roomOptional').hidden = true;
    $('roomInput').placeholder = 'Room code';
    $('roomInput').oninput();
  }
}).catch(() => {});
$('signOutLink').onclick = async (e) => {
  e.preventDefault();
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
};

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const previewReady = (async function startPreview() {
  let stream = new MediaStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: true });
  } catch {
    // Fall back to whatever is available; joining works with neither.
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO }); } catch {}
  }
  state.camStream = stream;
  $('previewVideo').srcObject = stream;
  syncMediaButtons();
  const raw = stream.getAudioTracks()[0];
  if (raw && window.AudioWorkletNode) {
    const mic = await filterMic(raw);
    state.camStream = new MediaStream([mic, ...stream.getVideoTracks()]);
  }
  syncMediaButtons();
  syncNoiseButtons();
})();
syncNoiseButtons();

$('lobbyForm').onsubmit = async (e) => {
  e.preventDefault();
  resumeAudio();
  $('joinBtn').disabled = true;
  await previewReady; // so the call starts with the filtered mic
  await meReady;
  join();
};

function join() {
  state.myName = $('nameInput').value.trim() || 'Guest';
  try { localStorage.setItem('devassist:name', state.myName); } catch {}
  const room = $('roomInput').value.trim() || Math.random().toString(36).slice(2, 8);
  history.replaceState(null, '', `/r/${encodeURIComponent(room)}`);

  $('previewVideo').srcObject = null;
  $('localCam').srcObject = state.camStream;
  syncMediaButtons();

  $('roomLabel').textContent = room;
  $('inviteLink').textContent = location.href;
  $('shareBtn').hidden = !CAN_SHARE;
  // The chat starts closed; new messages float over the call until you open it.
  $('chat').hidden = true;
  $('chatBtn').classList.remove('active');
  $('lobby').hidden = true;
  $('call').hidden = false;
  updateStatus();
  updateStage();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => signal({ type: 'join', room, name: state.myName });
  state.joinMsg = { type: 'join', room, name: state.myName };
  state.ws.onmessage = (e) => onSignal(JSON.parse(e.data));
  state.ws.onclose = () => { if (!state.ended) endSession('lost'); };
}

function signal(msg) { state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg)); }

// ---------- Peer connections (one per person, perfect negotiation) ----------
// Whoever joins makes the first offer to each person already there; those
// people wait for it instead of offering at the same time. (Two first offers
// crossing would be resolved by the polite/impolite rule below, but Chrome
// can drop the ICE candidates of the offer it rolls back, leaving that pair
// stuck.) Later renegotiation, like starting a screen share, can come from
// either side.
function addPeer(id, name, initiator) {
  if (peers.has(id)) return peers.get(id);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const tile = $('peerTileTpl').content.firstElementChild.cloneNode(true);
  const p = {
    id, name, pc, dc: null, polite: state.myId > id, makingOffer: false, ignoreOffer: false, waitForOffer: !initiator,
    streams: new Map(), cam: null, screen: null, screenStreamId: null, sharedAt: 0, tile,
  };
  peers.set(id, p);
  tile.querySelector('.name-tag').textContent = name;
  setupPopButton(tile.querySelector('.pop-btn'));
  tile.addEventListener('click', (e) => {
    if (e.target.closest('button') || !p.screen) return;
    state.focusId = id;
    updateStage();
  });
  $('grid').append(tile);

  for (const t of state.camStream.getTracks()) pc.addTrack(t, state.camStream);
  if (state.screenStream) for (const t of state.screenStream.getTracks()) pc.addTrack(t, state.screenStream);

  // Pre-negotiated channel so both sides have it without waiting.
  p.dc = pc.createDataChannel('app', { negotiated: true, id: 0 });
  p.dc.onopen = () => {
    if (state.screenStream) sendTo(id, { t: 'screen-on', streamId: state.screenStream.id });
    if (tx.on && state.isHost) sendTo(id, { t: 'transcribe', on: true, engine: tx.engine, lang: tx.lang, already: true });
    updateControlBtn();
  };
  p.dc.onmessage = (e) => onData(p, JSON.parse(e.data));

  pc.onicecandidate = ({ candidate }) => candidate && signal({ type: 'ice', to: id, candidate });
  pc.onnegotiationneeded = async () => {
    if (p.waitForOffer) return; // fires again once their offer has been answered, if still needed
    try {
      p.makingOffer = true;
      await pc.setLocalDescription();
      signal({ type: 'sdp', to: id, description: pc.localDescription });
    } catch (err) {
      console.warn(err);
    } finally { p.makingOffer = false; }
  };
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;
    p.streams.set(stream.id, stream);
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) { p.streams.delete(stream.id); routeStreams(p); }
    };
    routeStreams(p);
  };
  pc.onconnectionstatechange = updateStatus;
  return p;
}

// Each person sends up to two streams: camera+mic, and their screen.
function routeStreams(p) {
  p.screen = (p.screenStreamId && p.streams.get(p.screenStreamId)) || null;
  p.cam = [...p.streams.values()].find((s) => s.id !== p.screenStreamId) || null;
  const v = p.tile.querySelector('video');
  if (v.srcObject !== p.cam) v.srcObject = p.cam;
  updateStage();
}

function removePeer(id) {
  const p = peers.get(id);
  if (!p) return;
  if (state.controlling === id || state.controlPending === id) stopControl();
  if (state.controlGrantedTo === id) revokeControl(false);
  if (state.controlRequestFrom === id) closeControlPrompts();
  dropPointer(p);
  p.pc.close();
  p.tile.remove();
  peers.delete(id);
  updateStage();
  updateStatus();
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'not-started':
      // The room opens when the host joins; keep asking until then.
      $('emptyTitle').textContent = 'Waiting for the host to start this meeting';
      setStatus('Waiting for the host');
      clearTimeout(state.retryJoin);
      state.retryJoin = setTimeout(() => signal(state.joinMsg), 3000);
      break;
    case 'full':
      $('emptyTitle').textContent = 'This room is full';
      setStatus(`Room full (${msg.max} people max)`, 'failed');
      break;
    case 'joined':
      $('emptyTitle').textContent = 'Waiting for others to join';
      state.myId = msg.id;
      state.isHost = !!msg.host;
      state.hostId = msg.hostId;
      $('myColor').style.setProperty('--c', colorOf(msg.id));
      tx.token = msg.token;
      tx.cloud = !!msg.cloud;
      syncTranscriptUI();
      for (const o of msg.peers) addPeer(o.id, o.name, true);
      updateStage();
      updateStatus();
      break;
    case 'peer-joined':
      addPeer(msg.id, msg.name, false);
      toast(`${msg.name} joined`);
      updateStage();
      updateStatus();
      break;
    case 'peer-left':
      removePeer(msg.id);
      toast(`${msg.name} left`);
      break;
    case 'host':
      // Whoever started the session left; the "still there?" check is ours now.
      state.hostId = msg.id;
      state.isHost = msg.id === state.myId;
      syncTranscriptUI();
      break;
    case 'session-check':
      // Sent only to whoever started the session. No countdown on purpose:
      // if nobody answers, the server closes the session a few minutes later.
      document.title = `Still there? · ${TITLE}`;
      $('continueDialog').showModal();
      break;
    case 'session-ended':
      endSession(msg.reason, msg.by);
      break;
    case 'sdp': {
      const p = peers.get(msg.from);
      if (!p) return;
      const d = msg.description;
      const collision = d.type === 'offer' && (p.makingOffer || p.pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await p.pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await p.pc.setLocalDescription();
        signal({ type: 'sdp', to: p.id, description: p.pc.localDescription });
        p.waitForOffer = false;
      }
      break;
    }
    case 'ice': {
      const p = peers.get(msg.from);
      try { await p?.pc.addIceCandidate(msg.candidate); }
      catch (e) { if (!p?.ignoreOffer) console.warn(e); }
      break;
    }
  }
}

// ---------- Data channel messages ----------
function sendTo(id, obj) {
  const dc = peers.get(id)?.dc;
  if (dc?.readyState === 'open') dc.send(JSON.stringify(obj));
}
function broadcast(obj) { for (const id of peers.keys()) sendTo(id, obj); }

function onData(p, m) {
  switch (m.t) {
    case 'chat': addMessage(p.name, m.text, 'theirs', p.id); break;
    case 'file':
      if (typeof m.id === 'string' && typeof m.name === 'string') {
        addMessage(p.name, m.name, 'theirs', p.id, { id: m.id, name: m.name.slice(0, 200), size: Number(m.size) || 0, type: String(m.type || '') });
      }
      break;
    case 'screen-on':
      // The newest screen takes the stage. Its track may arrive before or
      // after this message; routeStreams sorts it out either way.
      p.screenStreamId = m.streamId;
      p.sharedAt = Date.now();
      state.focusId = p.id;
      routeStreams(p);
      break;
    case 'screen-off':
      if (state.controlling === p.id) stopControl();
      if (p.screenStreamId) p.streams.delete(p.screenStreamId);
      p.screenStreamId = null;
      routeStreams(p);
      break;
    case 'control-request': onControlRequest(p); break;
    case 'control-granted': if (state.controlPending === p.id) startControl(p); break;
    case 'control-denied':
      if (state.controlPending !== p.id) break;
      state.controlPending = null;
      updateControlBtn();
      systemMessage(m.busy ? `Someone else is already controlling ${p.name}'s computer.` : `${p.name} didn't allow control.`);
      break;
    case 'control-revoked':
      if (state.controlGrantedTo === p.id) { revokeControl(false); systemMessage(`${p.name} released control.`); }
      if (state.controlling === p.id) { stopControl(); systemMessage(`${p.name} took back control.`); }
      break;
    case 'input': if (state.controlGrantedTo === p.id) agentSend(m.e); break;
    case 'pointer': onPointer(p, m); break;
    case 'transcribe': if (p.id === state.hostId) onTranscribe(p, m); break;
    case 'line': if (typeof m.text === 'string') addLine(p.name, m.text.slice(0, 2000), Number(m.at) || Date.now(), false, p.id); break;
  }
}

// ---------- Screen share ----------
$('shareBtn').onclick = async () => {
  if (state.screenStream) return stopShare();
  try {
    // Share the entire screen if you want to be controlled: clicks map onto it.
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  } catch { return; }
  const [track] = state.screenStream.getVideoTracks();
  track.contentHint = 'detail'; // favour sharp text over smooth motion
  track.onended = stopShare;
  broadcast({ t: 'screen-on', streamId: state.screenStream.id });
  for (const p of peers.values()) p.pc.addTrack(track, state.screenStream);
  $('shareBtn').classList.add('active');
  $('shareBtn').querySelector('.label').textContent = 'Stop';
  toast('You are sharing your screen');
  syncPointers();
};
function stopShare() {
  if (!state.screenStream) return;
  const ids = new Set(state.screenStream.getTracks().map((t) => t.id));
  for (const p of peers.values()) {
    for (const s of p.pc.getSenders()) if (s.track && ids.has(s.track.id)) p.pc.removeTrack(s);
  }
  state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  broadcast({ t: 'screen-off' });
  revokeControl();
  $('shareBtn').classList.remove('active');
  $('shareBtn').querySelector('.label').textContent = 'Share';
  syncPointers();
}

// ---------- Leave / invite ----------
// Leaving keeps the room open for the others; you can rejoin from the next screen.
$('leaveBtn').onclick = () => endSession('self');

// ---------- Session lifetime ----------
$('continueBtn').onclick = () => {
  signal({ type: 'session-continue' });
  $('continueDialog').close();
  document.title = TITLE;
  toast('Session continued');
};
$('endSessionBtn').onclick = () => { $('continueDialog').close(); teardown(); location.href = '/'; };
// Escape shouldn't silently dismiss the check; make them pick.
$('continueDialog').addEventListener('cancel', (e) => e.preventDefault());
$('rejoinBtn').onclick = () => location.reload();
// Closing the tab or window takes you out of the call (the server tells the others).
addEventListener('pagehide', () => { if (!state.ended) teardown(); });

function teardown() {
  if (state.ended) return;
  state.ended = true;
  clearInterval(helperPoll);
  clearInterval(pointerHelperPoll);
  for (const d of $$('dialog[open]')) d.close();
  stopShare();
  revokeControl(false);
  state.agent?.close();
  state.ws?.close();
  for (const id of [...peers.keys()]) removePeer(id);
  state.camStream.getTracks().forEach((t) => t.stop());
  stopCapture();
  stopNoise();
  pip?.close();
  document.title = TITLE;
}

const END_REASONS = {
  self: () => 'The others can stay in the call, and you can rejoin with the same link.',
  timeout: () => 'It closed automatically because nobody chose to continue it.',
  left: (by) => `${by || 'The other person'} left or closed their window.`,
  lost: () => 'The connection to the server was lost.',
};
function endSession(reason, by) {
  teardown();
  $('endedTitle').textContent = reason === 'self' ? 'You left the call' : 'Session ended';
  $('endedReason').textContent = (END_REASONS[reason] || END_REASONS.left)(by);
  $('rejoinBtn').hidden = reason === 'timeout';
  $('call').hidden = true;
  $('ended').hidden = false;
}
async function copyInvite() {
  try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); }
  catch { toast(location.href, 8000); }
}
$('roomChip').onclick = copyInvite;
$('copyInviteBtn').onclick = copyInvite;

// ---------- Chat ----------
function setChatOpen(open) {
  $('chat').hidden = !open;
  $('chatBtn').classList.toggle('active', open);
  if (open) {
    $('chatPops').replaceChildren();
    state.unread = 0;
    $('unread').hidden = true;
    const m = $('messages'); m.scrollTop = m.scrollHeight;
    if (isWide()) $('chatInput').focus();
  }
}
$('chatBtn').onclick = () => setChatOpen($('chat').hidden);
$('closeChatBtn').onclick = () => setChatOpen(false);

$('chatInput').addEventListener('input', autosize);
function autosize() {
  const t = $('chatInput');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
}
$('chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('chatForm').requestSubmit(); }
});
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value;
  if (!text.trim()) return;
  broadcast({ t: 'chat', text });
  addMessage('You', text, 'mine');
  $('chatInput').value = '';
  autosize();
};

// Messages are bubbles: yours on the right, theirs on the left with their
// name in their color, each with the time and a copy button. Multi-line text
// (logs, commands) keeps a monospace font.
function addMessage(who, text, kind, id, file) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  const body = document.createElement('div'); body.className = 'body'; body.textContent = text;
  if (kind === 'system') {
    div.append(body);
  } else {
    const prev = $('messages').lastElementChild;
    const bubble = document.createElement('div'); bubble.className = 'bubble';
    if (/\n/.test(text.trim()) && !file) bubble.classList.add('code');
    // A run of messages from the same person shows the name only once.
    const sameRun = prev?.dataset.from === String(id ?? kind) && Date.now() - prev.sentAt < 120_000;
    if (kind === 'theirs' && !sameRun) {
      const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
      if (id) w.style.color = colorOf(id);
      bubble.append(w);
    }
    if (sameRun) div.classList.add('cont');
    const meta = document.createElement('span'); meta.className = 'meta'; meta.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const copy = document.createElement('button');
    copy.type = 'button'; copy.className = 'copy'; copy.title = 'Copy message'; copy.setAttribute('aria-label', 'Copy message');
    copy.innerHTML = '<svg class="icon sm"><use href="#i-copy"/></svg>';
    copy.onclick = () => copyText(text, copy);
    bubble.append(file ? fileCard(file) : body, meta);
    if (!file) bubble.append(copy);
    div.append(bubble);
    div.dataset.from = String(id ?? kind);
    div.sentAt = Date.now();
  }
  const m = $('messages');
  m.append(div);
  m.scrollTop = m.scrollHeight;
  if (kind === 'theirs' && $('chat').hidden) {
    state.unread += 1;
    $('unread').textContent = state.unread;
    $('unread').hidden = false;
    popMessage(who, file ? `Sent a file: ${file.name}` : text, id);
  }
  return div;
}

// ---------- Files ----------
// Files go up to our server and are kept only while the meeting is open;
// the link works only for people in this meeting.
const MAX_FILE_MB = 25;
const fileUrl = (f, download) => `/files/${f.id}/${encodeURIComponent(f.name)}?t=${encodeURIComponent(tx.token)}${download ? '&dl=1' : ''}`;
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function fileCard(f) {
  const card = document.createElement('div');
  card.className = 'file-card';
  if (/^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.id) {
    const a = document.createElement('a'); a.href = fileUrl(f); a.target = '_blank'; a.rel = 'noopener';
    const img = document.createElement('img'); img.src = fileUrl(f); img.alt = f.name; img.loading = 'lazy';
    a.append(img);
    card.append(a);
  }
  const row = document.createElement('div'); row.className = 'file-row';
  row.innerHTML = '<svg class="icon"><use href="#i-file"/></svg>';
  const info = document.createElement('div'); info.className = 'file-info';
  const n = document.createElement('span'); n.className = 'file-name'; n.textContent = f.name;
  const sz = document.createElement('span'); sz.className = 'file-size'; sz.textContent = fmtSize(f.size);
  info.append(n, sz);
  row.append(info);
  if (f.id) {
    const dl = document.createElement('a'); dl.className = 'icon-btn file-dl'; dl.href = fileUrl(f, true); dl.title = 'Download'; dl.setAttribute('aria-label', `Download ${f.name}`);
    dl.innerHTML = '<svg class="icon sm"><use href="#i-download"/></svg>';
    row.append(dl);
  }
  card.append(row);
  return card;
}
function sendFiles(list) {
  for (const file of list) {
    if (file.size > MAX_FILE_MB * 1048576) { systemMessage(`${file.name} is too big. Files can be up to ${MAX_FILE_MB} MB.`); continue; }
    if (!file.size) continue;
    const msg = addMessage('You', file.name, 'mine', null, { name: file.name, size: file.size, type: file.type });
    const sz = msg.querySelector('.file-size');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('X-Token', tx.token);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) sz.textContent = `Uploading ${Math.round((e.loaded / e.total) * 100)}%`; };
    xhr.onload = () => {
      let out = {};
      try { out = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status !== 200) { sz.textContent = out.error || 'Upload failed'; sz.classList.add('failed'); return; }
      const f = { id: out.id, name: out.name, size: out.size, type: out.type };
      msg.querySelector('.file-card').replaceWith(fileCard(f));
      broadcast({ t: 'file', ...f });
    };
    xhr.onerror = () => { sz.textContent = 'Upload failed'; sz.classList.add('failed'); };
    xhr.send(file);
  }
}
$('attachBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { sendFiles([...$('fileInput').files]); $('fileInput').value = ''; };
$('chat').addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); $('chat').classList.add('drop'); } });
$('chat').addEventListener('dragleave', (e) => { if (!$('chat').contains(e.relatedTarget)) $('chat').classList.remove('drop'); });
$('chat').addEventListener('drop', (e) => {
  e.preventDefault();
  $('chat').classList.remove('drop');
  sendFiles([...e.dataTransfer.files]);
});
$('chatInput').addEventListener('paste', (e) => {
  const list = [...e.clipboardData.files];
  if (list.length) { e.preventDefault(); sendFiles(list); }
});
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { return toast('Could not copy'); }
  btn.classList.add('done');
  btn.innerHTML = '<svg class="icon sm"><use href="#i-check"/></svg>';
  setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = '<svg class="icon sm"><use href="#i-copy"/></svg>'; }, 1500);
}
// With the chat closed, new messages float over the call as bubbles; tap one to open the chat.
function popMessage(who, text, id) {
  const box = $('chatPops');
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'chat-pop';
  const w = document.createElement('b'); w.textContent = who;
  if (id) w.style.color = colorOf(id);
  const t = document.createElement('span'); t.textContent = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  el.append(w, t);
  el.onclick = () => setChatOpen(true);
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 8000);
}
function systemMessage(text) {
  addMessage('', text, 'system');
  toast(text);
}

// ---------- Remote control: helped side ----------
// DevAssist Helper (or the dev agent) listens on 127.0.0.1. We try to reach it
// when control is requested; if it isn't running we offer the download and
// keep retrying until it starts.
const OS = /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux';
const OS_LABEL = { windows: 'Windows', mac: 'Mac', linux: 'Linux' }[OS];
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
let connecting = null;
let helperPoll = null;

function connectAgent(token) {
  if (state.agent) return Promise.resolve(true);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(token ? `${AGENT_URL}/?token=${encodeURIComponent(token)}` : AGENT_URL); }
    catch { return resolve(false); }
    ws.onopen = () => {
      state.agent = ws;
      ws.onclose = () => { state.agent = null; revokeControl(); };
      resolve(true);
    };
    ws.onerror = () => resolve(false);
  }).finally(() => { connecting = null; });
  return connecting;
}

function agentSend(obj) {
  if (state.agent?.readyState === 1) state.agent.send(JSON.stringify(obj));
}

async function onControlRequest(p) {
  const deny = (why, busy = false) => {
    sendTo(p.id, { t: 'control-denied', busy });
    if (why) systemMessage(why);
  };
  if (IS_MOBILE) return deny(`${p.name} asked for control, but phones and tablets can't be controlled remotely.`);
  if (!state.screenStream) return deny(`${p.name} asked for control. Share your entire screen first, then they can ask again.`);
  // One person at a time controls this computer.
  if (state.controlGrantedTo || state.controlRequestFrom) return deny(null, true);
  state.controlRequestFrom = p.id;
  closePointerHelper(); // the control prompts cover the helper too
  fillName($('controlDialog'), p.name);
  fillName($('helperDialog'), p.name);
  const ready = await connectAgent();
  if (state.controlRequestFrom !== p.id) return; // they left or gave up meanwhile
  if (ready) return $('controlDialog').showModal();
  $('downloadHelper').href = `/download/${OS}`;
  $('downloadHelper').textContent = `Download DevAssist Helper for ${OS_LABEL}`;
  $('helperDialog').showModal();
  helperPoll = setInterval(async () => {
    if (await connectAgent()) { closeHelperDialog(); $('controlDialog').showModal(); }
  }, 2000);
}

function closeHelperDialog() {
  clearInterval(helperPoll);
  helperPoll = null;
  $('helperDialog').close();
}
// Answer "no" to whoever is waiting on us.
function denyPending() {
  if (state.controlRequestFrom) sendTo(state.controlRequestFrom, { t: 'control-denied' });
  state.controlRequestFrom = null;
}
function closeControlPrompts() {
  closeHelperDialog();
  $('controlDialog').close();
  state.controlRequestFrom = null;
}
$('cancelHelperBtn').onclick = () => { closeHelperDialog(); denyPending(); };
$('helperDialog').addEventListener('cancel', () => { clearInterval(helperPoll); denyPending(); });
$('pairingCodeLink').onclick = async (e) => {
  e.preventDefault();
  const token = prompt('Pairing code shown by the DevAssist dev agent:');
  if (token && await connectAgent(token.trim())) { closeHelperDialog(); $('controlDialog').showModal(); }
};

$('allowBtn').onclick = () => {
  $('controlDialog').close();
  const id = state.controlRequestFrom;
  state.controlRequestFrom = null;
  if (!peers.has(id)) return;
  if (!state.agent) {
    sendTo(id, { t: 'control-denied' });
    return systemMessage('DevAssist Helper closed. Ask them to request control again.');
  }
  state.controlGrantedTo = id;
  agentSend({ type: 'control', on: true });
  sendTo(id, { t: 'control-granted' });
  fillName($('controlledBanner'), nameOf(id));
  $('controlledBanner').hidden = false;
  addMessage('', `${nameOf(id)} is controlling your computer.`, 'system');
};
$('denyBtn').onclick = () => { $('controlDialog').close(); denyPending(); };
$('controlDialog').addEventListener('cancel', denyPending);
$('revokeBtn').onclick = () => { revokeControl(); systemMessage('You took back control.'); };

// notifyPeer=false when the other side already ended control itself.
function revokeControl(notifyPeer = true) {
  const id = state.controlGrantedTo;
  if (!id) return;
  state.controlGrantedTo = null;
  agentSend({ type: 'control', on: false });
  if (notifyPeer) sendTo(id, { t: 'control-revoked' });
  $('controlledBanner').hidden = true;
}

// ---------- Remote control: helper side ----------
const screenEl = $('remoteScreen');

function updateControlBtn() {
  const btn = $('controlBtn');
  const label = btn.querySelector('.label');
  const target = peers.get(state.shownId);
  btn.classList.toggle('active', !!state.controlling);
  btn.disabled = !state.controlling && ![...peers.values()].some((p) => p.dc?.readyState === 'open');
  if (state.controlling) {
    label.textContent = 'Release';
    btn.title = `Stop controlling ${nameOf(state.controlling)}'s computer`;
  } else if (state.controlPending) {
    label.textContent = 'Asking…';
    btn.title = `Waiting for ${nameOf(state.controlPending)} to allow control`;
  } else {
    label.textContent = 'Control';
    btn.title = target ? `Ask to control ${target.name}'s computer` : 'Ask to control the computer whose screen is shared';
  }
}

$('controlBtn').onclick = () => {
  if (state.controlling) {
    sendTo(state.controlling, { t: 'control-revoked' });
    stopControl();
    return;
  }
  if (state.controlPending) return;
  const target = peers.get(state.shownId);
  if (!target) {
    const only = peers.size === 1 ? [...peers.values()][0].name : 'someone';
    return toast(`Ask ${only} to share their screen first`);
  }
  state.controlPending = target.id;
  updateControlBtn();
  sendTo(target.id, { t: 'control-request' });
  toast(`Asking ${target.name} for control…`);
};

function startControl(p) {
  state.controlling = p.id;
  state.controlPending = null;
  $('toasts').replaceChildren();
  screenEl.classList.add('controlling');
  screenEl.focus({ preventScroll: true });
  fillName($('controllingBanner'), p.name);
  $('controllingBanner').hidden = false;
  updateControlBtn();
}
function stopControl() {
  state.controlling = null;
  state.controlPending = null;
  screenEl.classList.remove('controlling');
  $('controllingBanner').hidden = true;
  updateControlBtn();
}

// Map a pointer event to 0..1 coordinates of the shared screen, accounting
// for the letterboxing that object-fit: contain adds.
function normalized(ev) {
  const r = screenEl.getBoundingClientRect();
  const vw = screenEl.videoWidth, vh = screenEl.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  const x = (ev.clientX - r.left - (r.width - w) / 2) / w;
  const y = (ev.clientY - r.top - (r.height - h) / 2) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function input(e) { if (state.controlling) sendTo(state.controlling, { t: 'input', e }); }

// Pointer events cover mouse, pen and touch: a tap is a click, a drag is a drag.
let lastMove = 0;
screenEl.addEventListener('pointermove', (ev) => {
  const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; // ~60 Hz
  const p = normalized(ev); if (p) input({ type: 'move', ...p });
});
screenEl.addEventListener('pointerdown', (ev) => {
  if (!state.controlling) return;
  ev.preventDefault();
  screenEl.focus({ preventScroll: true });
  screenEl.setPointerCapture(ev.pointerId);
  const p = normalized(ev); if (p) input({ type: 'down', button: Math.max(ev.button, 0), ...p });
});
screenEl.addEventListener('pointerup', (ev) => {
  if (!state.controlling) return;
  const p = normalized(ev); if (p) input({ type: 'up', button: Math.max(ev.button, 0), ...p });
});
screenEl.addEventListener('contextmenu', (ev) => state.controlling && ev.preventDefault());
screenEl.addEventListener('wheel', (ev) => {
  if (!state.controlling) return; ev.preventDefault();
  input({ type: 'wheel', dx: Math.sign(ev.deltaX), dy: Math.sign(ev.deltaY) });
}, { passive: false });
screenEl.addEventListener('keydown', (ev) => {
  if (!state.controlling) return; ev.preventDefault();
  input({ type: 'keydown', key: ev.key, code: ev.code, ctrl: ev.ctrlKey, alt: ev.altKey, shift: ev.shiftKey, meta: ev.metaKey });
});
screenEl.addEventListener('keyup', (ev) => {
  if (!state.controlling) return; ev.preventDefault();
  input({ type: 'keyup', key: ev.key, code: ev.code });
});
// Ctrl/Cmd+Shift+V types the helper's clipboard on the remote machine,
// handy for pasting commands. (Plain Ctrl+V pastes the remote clipboard.)
screenEl.addEventListener('keydown', async (ev) => {
  if (!state.controlling || !ev.shiftKey || !(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'v') return;
  ev.stopImmediatePropagation();
  const text = await navigator.clipboard.readText().catch(() => '');
  if (text) input({ type: 'text', text });
}, { capture: true });

// "Type text" sends a whole string, which also works from a phone keyboard.
$('typeTextBtn').onclick = () => { $('typeInput').value = ''; $('typeDialog').showModal(); $('typeInput').focus(); };
$('typeCancelBtn').onclick = () => $('typeDialog').close();
$('typeForm').addEventListener('submit', (e) => {
  const text = $('typeInput').value;
  if (text) input({ type: 'text', text });
  if (e.submitter?.value === 'enter') input({ type: 'keydown', key: 'Enter', code: 'Enter' });
  screenEl.focus({ preventScroll: true });
});

// ---------- Shared pointers ----------
// With Pointers on, your mouse over the shared screen shows up, in your own
// color, for everyone else who has Pointers on. Whoever is sharing always sees
// them drawn on their real screen by DevAssist Helper, when it's running.
const POINTER_COLORS = ['#f97316', '#22c55e', '#ec4899', '#eab308', '#06b6d4', '#a855f7', '#ef4444', '#84cc16'];
const colorOf = (id) => POINTER_COLORS[(id - 1) % POINTER_COLORS.length];
let pointerOn = null; // whose screen our pointer is on, as we last told everyone
let lastPointer = 0, lastHelperTry = 0;
let pointerHinted = false, helperHinted = false;

$('pointersBtn').onclick = () => {
  state.pointers = !state.pointers;
  $('pointersBtn').classList.toggle('active', state.pointers);
  if (!state.pointers) sendPointer(null);
  else if (state.screenStream) connectAgent().then((ok) => ok && syncPointers()); // so pointers on our screen show right away
  syncPointers();
};

function sendPointer(pos) {
  const on = pos && state.pointers && !state.controlling ? state.shownId : null;
  if (on === null && pointerOn === null) return;
  pointerOn = on;
  broadcast(on === null ? { t: 'pointer', on: null } : { t: 'pointer', on, x: pos.x, y: pos.y });
}
screenEl.addEventListener('pointermove', (ev) => {
  if (!state.pointers) return;
  const now = performance.now(); if (now - lastPointer < 33) return; lastPointer = now; // ~30 Hz
  sendPointer(normalized(ev));
});
screenEl.addEventListener('pointerleave', () => sendPointer(null));
screenEl.addEventListener('resize', syncPointers); // the shared screen changed size

function onPointer(p, m) {
  p.pointer = m.on == null ? null : { on: m.on, x: m.x, y: m.y };
  if (p.pointer && !state.pointers && !pointerHinted && m.on === state.shownId) {
    pointerHinted = true;
    toast(`${p.name} is pointing at the screen. Turn on Pointers to see it.`);
  }
  drawPointer(p);
}

// Where the video actually is inside the stage (object-fit: contain letterboxes it).
function screenBox() {
  const vw = screenEl.videoWidth, vh = screenEl.videoHeight;
  if (screenEl.hidden || !vw || !vh) return null;
  const W = screenEl.clientWidth, H = screenEl.clientHeight;
  const s = Math.min(W / vw, H / vh);
  return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s };
}

function drawPointer(p) {
  const pt = state.pointers ? p.pointer : null;
  // On the screen we're watching.
  const box = pt && pt.on === state.shownId ? screenBox() : null;
  let el = p.pointerEl;
  if (box) {
    if (!el) {
      el = p.pointerEl = document.createElement('div');
      el.className = 'pointer';
      el.hidden = true;
      el.style.setProperty('--c', colorOf(p.id));
      el.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-cursors"/></svg><span></span>';
      $('pointers').append(el);
    }
    el.querySelector('span').textContent = p.name;
    el.style.transform = `translate(${box.x + pt.x * box.w - 4}px, ${box.y + pt.y * box.h - 4}px)`;
    if (el.hidden) { el.hidden = false; el.style.transition = 'none'; el.offsetWidth; el.style.transition = ''; } // appear in place, don't glide in
    el.classList.remove('idle');
    clearTimeout(el.idle);
    el.idle = setTimeout(() => el.classList.add('idle'), 4000);
  } else if (el) el.hidden = true;
  // On our own screen: DevAssist Helper draws it over everything else. The
  // presenter sees these without turning Pointers on, since they aren't
  // looking at the app while they share.
  const mine = p.pointer;
  if (mine && mine.on === state.myId && state.screenStream) {
    if (state.agent) {
      agentSend({ type: 'pointer', id: p.id, name: p.name, color: colorOf(p.id), x: mine.x, y: mine.y });
      p.pointerSent = true;
    } else tryHelper(p);
  } else if (p.pointerSent) {
    agentSend({ type: 'pointeroff', id: p.id });
    p.pointerSent = false;
  }
}

async function tryHelper(p) {
  if (Date.now() - lastHelperTry < 5000) return;
  lastHelperTry = Date.now();
  if (await connectAgent()) return syncPointers();
  if (helperHinted) return;
  helperHinted = true;
  // Offer the download once; a control request's dialog takes precedence.
  if (!state.screenStream || $$('dialog[open]').length) {
    return systemMessage('Others are pointing at your screen. Open DevAssist Helper to see their pointers on it.');
  }
  fillName($('pointerHelperDialog'), p.name);
  $('pointerHelperDownload').href = `/download/${OS}`;
  $('pointerHelperDownload').textContent = `Download DevAssist Helper for ${OS_LABEL}`;
  $('pointerHelperDialog').showModal();
  pointerHelperPoll = setInterval(async () => {
    if (!state.screenStream) return closePointerHelper();
    if (await connectAgent()) { closePointerHelper(); syncPointers(); }
  }, 2000);
}
let pointerHelperPoll = null;
function closePointerHelper() {
  clearInterval(pointerHelperPoll);
  pointerHelperPoll = null;
  $('pointerHelperDialog').close();
}
$('pointerHelperLater').onclick = closePointerHelper;
$('pointerHelperDialog').addEventListener('close', () => clearInterval(pointerHelperPoll));

function dropPointer(p) {
  p.pointer = null;
  drawPointer(p);
  p.pointerEl?.remove();
}

function syncPointers() {
  $('pointersBtn').hidden = !state.shownId && !state.screenStream;
  if (pointerOn !== null && pointerOn !== state.shownId) sendPointer(null);
  for (const p of peers.values()) drawPointer(p);
}

// ---------- Transcript ----------
// The person who started the meeting turns the transcript on and picks how
// voices are transcribed; everyone else just sees it. Each person's browser
// then transcribes only their own mic and shares the text, so every line
// carries the right name. Engines: xAI's Grok Voice Transcribe (fast and
// accurate; clips go to xAI through our server) or Whisper on each person's device
// (private; the model downloads once). Nothing is stored on the server.
const SPEECH = {
  threshold: 0.008, // RMS level that counts as speech (the noise filter has already removed most noise)
  preRoll: 3,       // frames (100 ms each) kept from before speech starts
  hangMs: 700,      // this much quiet ends a clip
  maxMs: 20000,     // and clips never run longer than this
  minMs: 400,       // clips with less speech than this are ignored
};
// Whisper's well-known inventions on silence or noise.
const HALLUCINATIONS = /^(\[.*\]|\(.*\)|thanks for watching!?|thank you for watching\.?|subt[ií]tulos (realizados )?por .*|amara\.org.*)$/i;
const tx = {
  on: false, cloud: false, token: null,
  engine: 'cloud', lang: '',
  ctx: null, src: null, node: null,
  pre: [], clip: null,
  queue: Promise.resolve(), pending: 0,
  worker: null, jobs: new Map(), nextJob: 1,
  lines: [], // { name, text, at, mine }
};
// The meeting starter's own choices, remembered for their next meeting.
try {
  tx.engine = localStorage.getItem('devassist:engine') === 'device' ? 'device' : 'cloud';
  tx.lang = localStorage.getItem('devassist:lang') || '';
} catch {}
$('txLang').value = tx.lang;
const engineNow = () => (tx.engine === 'cloud' && !tx.cloud ? 'device' : tx.engine);

function showTab(which) {
  const transcript = which === 'transcript';
  $('chat').classList.toggle('show-transcript', transcript);
  $('transcriptPane').hidden = !transcript;
  $('chatTab').classList.toggle('active', !transcript);
  $('transcriptTab').classList.toggle('active', transcript);
  $('chatTab').setAttribute('aria-selected', String(!transcript));
  $('transcriptTab').setAttribute('aria-selected', String(transcript));
}
$('chatTab').onclick = () => showTab('chat');
$('transcriptTab').onclick = () => showTab('transcript');

function syncTranscriptUI() {
  const engine = engineNow();
  $('transcriptPane').classList.toggle('is-host', state.isHost);
  $('txState').textContent = state.isHost ? '' : tx.on ? 'The transcript is on' : 'The transcript is off';
  $('txLang').value = tx.lang;
  $('txToggle').textContent = tx.on ? 'Stop transcript' : 'Start transcript';
  $('txToggle').classList.toggle('primary', !tx.on);
  $('txDot').hidden = !tx.on;
  $('ccBtn').hidden = !tx.on;
  $('ccBtn').classList.toggle('active', state.captions);
  $('txDownload').disabled = !tx.lines.length;
  $('txSave').disabled = !tx.lines.length || tx.saving;
  for (const b of $$('.seg button')) b.setAttribute('aria-checked', String(b.dataset.engine === engine));
  $('engCloud').disabled = !tx.cloud;
  $('engCloud').title = tx.cloud ? '' : 'xAI isn\'t set up on this server (XAI_API_KEY)';
  $('txNote').textContent = engine === 'cloud'
    ? 'Everyone\'s voice is sent to xAI (Grok) to be transcribed. Fast and accurate.'
    : 'Voices stay on each person\'s computer. Each browser downloads the speech model once (about 80 to 200 MB), and it\'s slower on older machines.';
}
// The meeting starter's settings apply to everyone.
function shareTranscriptSettings() {
  if (tx.on) broadcast({ t: 'transcribe', on: true, engine: tx.engine, lang: tx.lang });
}
for (const b of $$('.seg button')) b.onclick = () => {
  if (b.disabled || !state.isHost) return;
  tx.engine = b.dataset.engine;
  try { localStorage.setItem('devassist:engine', tx.engine); } catch {}
  txStatus('');
  syncTranscriptUI();
  shareTranscriptSettings();
};
$('txLang').onchange = () => {
  if (!state.isHost) return;
  tx.lang = $('txLang').value;
  try { localStorage.setItem('devassist:lang', tx.lang); } catch {}
  shareTranscriptSettings();
};
function txStatus(text) {
  $('txStatus').hidden = !text;
  $('txStatus').textContent = text;
}

$('txToggle').onclick = () => {
  if (!state.isHost) return;
  const on = !tx.on;
  broadcast({ t: 'transcribe', on, engine: tx.engine, lang: tx.lang });
  setTranscribing(on, null);
};
function onTranscribe(p, m) {
  if (m.engine === 'cloud' || m.engine === 'device') tx.engine = m.engine;
  tx.lang = /^[a-z]{2}$/.test(m.lang) ? m.lang : '';
  if (!!m.on === tx.on) return syncTranscriptUI(); // only the settings changed
  setTranscribing(!!m.on, p, m.already);
}
// by: the person who switched it (null for us); already: it was on before we joined.
function setTranscribing(on, by, already = false) {
  if (tx.on === on) return;
  tx.on = on;
  const who = by ? by.name : 'You';
  systemMessage(already ? 'This call is being transcribed.' : on ? `${who} started a transcript of the call.` : `${who} stopped the transcript.`);
  if (on) startCapture(); else stopCapture();
  syncTranscriptUI();
}

async function startCapture() {
  const track = state.camStream.getAudioTracks()[0];
  if (!track) return txStatus('No microphone here, so only the others are transcribed.');
  try {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/capture-worklet.js');
    if (!tx.on) return ctx.close(); // stopped while loading
    tx.ctx = ctx;
    tx.src = ctx.createMediaStreamSource(new MediaStream([track]));
    tx.node = new AudioWorkletNode(ctx, 'capture');
    tx.node.port.onmessage = (e) => onSpeechFrame(e.data);
    // Silent route to the speakers so the browser keeps pulling audio through.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    tx.src.connect(tx.node).connect(mute).connect(ctx.destination);
    ctx.resume().catch(() => {});
    txStatus('');
  } catch (err) {
    console.warn(err);
    txStatus('Your mic can\'t be transcribed in this browser.');
  }
}
function stopCapture() {
  tx.ctx?.close().catch(() => {});
  Object.assign(tx, { ctx: null, src: null, node: null, pre: [], clip: null });
}
addEventListener('pointerdown', () => tx.ctx?.state === 'suspended' && tx.ctx.resume().catch(() => {}), true);

// Cut the mic into clips at pauses, so each one is a sentence or so.
function onSpeechFrame(frame) {
  let sum = 0;
  for (const v of frame) sum += v * v;
  const loud = Math.sqrt(sum / frame.length) > SPEECH.threshold;
  const c = tx.clip;
  if (!c) {
    tx.pre.push(frame);
    if (tx.pre.length > SPEECH.preRoll) tx.pre.shift();
    if (loud) {
      tx.clip = { frames: tx.pre, at: Date.now() - tx.pre.length * 100, voiced: 1, quiet: 0 };
      tx.pre = [];
    }
    return;
  }
  c.frames.push(frame);
  if (loud) { c.voiced++; c.quiet = 0; } else c.quiet++;
  if (c.quiet * 100 < SPEECH.hangMs && c.frames.length * 100 < SPEECH.maxMs) return;
  tx.clip = null;
  if (c.voiced * 100 < SPEECH.minMs) return;
  const frames = c.frames.slice(0, c.frames.length - Math.max(0, c.quiet - 2)); // keep a little trailing quiet
  const audio = new Float32Array(frames.length * 1600);
  frames.forEach((f, i) => audio.set(f, i * 1600));
  transcribeClip(audio, c.at);
}

function transcribeClip(audio, at) {
  const engine = engineNow();
  if (tx.pending > 4) return; // falling behind: drop rather than lag further and further
  tx.pending++;
  tx.queue = tx.queue.then(async () => {
    try {
      const raw = engine === 'cloud' ? await viaCloud(audio) : await viaDevice(audio);
      const text = raw.trim().replace(/\s+/g, ' ');
      if (!tx.on || !/\p{L}/u.test(text) || HALLUCINATIONS.test(text)) return;
      addLine(state.myName, text, at, true, state.myId);
      broadcast({ t: 'line', text, at });
    } catch (err) {
      txStatus(err.message);
    } finally { tx.pending--; }
  });
}

async function viaCloud(audio) {
  const r = await fetch(`/api/transcribe${tx.lang ? `?lang=${tx.lang}` : ''}`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Token': tx.token || '' }, body: wav(audio),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${out.error || 'Transcription failed'}. Switch to "This device" if it keeps happening.`);
  if ($('txStatus').textContent) txStatus('');
  return out.text || '';
}
// 16 kHz mono 16-bit PCM WAV.
function wav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return buf;
}

function viaDevice(audio) {
  if (!tx.worker) {
    tx.worker = new Worker('/whisper-worker.js', { type: 'module' });
    tx.worker.onmessage = ({ data: m }) => {
      if (m.type === 'progress') txStatus(`Downloading the speech model… ${m.pct}%`);
      else if (m.type === 'ready') txStatus('');
      else {
        const job = tx.jobs.get(m.id);
        tx.jobs.delete(m.id);
        if (m.type === 'text') {
          if (/^(Loading|Downloading)/.test($('txStatus').textContent)) txStatus('');
          job?.resolve(m.text);
        }
        else job?.reject(new Error(`On-device transcription failed (${m.message}).`));
      }
    };
    tx.worker.onerror = (e) => {
      for (const job of tx.jobs.values()) job.reject(new Error('The on-device speech model couldn\'t load. Try xAI, or check this browser can reach the internet.'));
      tx.jobs.clear();
      tx.worker = null;
      e.preventDefault();
    };
    txStatus('Loading the speech model…');
  }
  return new Promise((resolve, reject) => {
    const id = tx.nextJob++;
    tx.jobs.set(id, { resolve, reject });
    tx.worker.postMessage({ id, audio, language: tx.lang || null }, [audio.buffer]);
  });
}

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function addLine(name, text, at, mine, id) {
  const line = { name, text, at, mine };
  // People's clips finish at different speeds; keep the transcript in speaking order.
  let i = tx.lines.length;
  while (i > 0 && tx.lines[i - 1].at > at) i--;
  tx.lines.splice(i, 0, line);
  const el = document.createElement('div');
  el.className = 'line';
  const who = document.createElement('div');
  who.className = 'who';
  const b = document.createElement('b');
  b.textContent = mine ? `${name} (you)` : name;
  who.append(b, timeOf(at));
  const t = document.createElement('div');
  t.className = 'text';
  t.textContent = text;
  el.append(who, t);
  const box = $('transcriptLines');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.insertBefore(el, box.querySelectorAll('.line')[i] || null);
  if (stick) box.scrollTop = box.scrollHeight;
  $('txSave').textContent = 'Save';
  showCaption(id, mine ? 'You' : name, text);
  syncTranscriptUI();
}

// Captions look like a video's closed captions: white text on a dark band at
// the bottom of the stage, at most two lines, the speaker's name in their
// color. A speaker's next phrase continues their line; a new speaker takes
// over. CC in the control bar hides them for you only.
const cc = { id: null, el: null, timer: 0 };
function showCaption(id, name, text) {
  if (!state.captions) return;
  const box = $('captions');
  if (cc.id !== id || !cc.el?.isConnected) {
    box.replaceChildren();
    cc.el = document.createElement('p');
    cc.el.className = 'cc-line';
    const b = document.createElement('b');
    b.textContent = name;
    if (id) b.style.color = colorOf(id);
    cc.text = document.createElement('span');
    cc.el.append(b, cc.text);
    box.append(cc.el);
    cc.id = id;
  }
  cc.text.textContent = `${cc.text.textContent} ${text}`.trim();
  // Keep only what fits in two lines, dropping whole words from the start.
  const words = cc.text.textContent.split(' ');
  while (words.length > 1 && cc.el.getClientRects().length && cc.el.offsetHeight > 2.2 * parseFloat(getComputedStyle(cc.el).lineHeight)) {
    words.shift();
    cc.text.textContent = words.join(' ');
  }
  clearTimeout(cc.timer);
  cc.timer = setTimeout(() => { box.replaceChildren(); cc.id = null; }, 6000);
}
state.captions = true;
$('ccBtn').onclick = () => {
  state.captions = !state.captions;
  $('ccBtn').classList.toggle('active', state.captions);
  if (!state.captions) { $('captions').replaceChildren(); cc.id = null; }
};

$('txSave').onclick = async () => {
  tx.saving = true;
  syncTranscriptUI();
  try {
    const r = await fetch('/api/transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': tx.token },
      body: JSON.stringify({ lines: tx.lines.map(({ name, text, at }) => ({ name, text, at })) }),
    });
    const out = await r.json().catch(() => ({}));
    toast(r.ok ? `Saved ${out.lines} lines with this meeting` : out.error || 'Could not save the transcript');
    if (r.ok) $('txSave').textContent = 'Saved';
  } catch { toast('Could not save the transcript'); }
  tx.saving = false;
  syncTranscriptUI();
};

$('txDownload').onclick = () => {
  const room = $('roomLabel').textContent;
  const day = new Date(tx.lines[0]?.at || Date.now());
  const body = `Transcript of ${room}, ${day.toLocaleDateString()}\n\n`
    + tx.lines.map((l) => `[${timeOf(l.at)}] ${l.name}: ${l.text}`).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
  a.download = `transcript-${room}-${day.toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

