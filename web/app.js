// DevAssist web client: 1:1 WebRTC call with camera, mic, screen share, chat
// and remote control. Control events travel over a WebRTC data channel; the
// person being helped forwards them to DevAssist Helper on 127.0.0.1, which
// is the only piece that can move the mouse and type (browsers can't).
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // add a TURN server for production
const AGENT_URL = 'ws://127.0.0.1:47800';
const CAN_SHARE = !!navigator.mediaDevices?.getDisplayMedia;
const isWide = () => matchMedia('(min-width: 1025px)').matches;

const state = {
  ws: null, pc: null, dc: null,
  polite: false, makingOffer: false, ignoreOffer: false,
  camStream: new MediaStream(), screenStream: null,
  remoteScreenStreamId: null,
  peerName: 'Guest', myName: 'Guest', peerPresent: false,
  agent: null,             // WebSocket to DevAssist Helper (helped side)
  controlGranted: false,   // helped side: we allow the peer to control us
  controlling: false,      // helper side: we are controlling the peer
  controlPending: false,   // helper side: waiting for an answer
  unread: 0,
};

// ---------- Small UI helpers ----------
function setStatus(text, kind = 'waiting') {
  $('status').textContent = text;
  $('statusPill').dataset.state = kind;
}
function setPeerName(name) {
  state.peerName = name || 'Guest';
  $('peerTag').textContent = state.peerName;
  for (const el of $$('.peer-name')) el.textContent = state.peerName;
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
function updateStage() {
  const screen = !$('remoteScreen').hidden;
  $('stage').dataset.mode = screen ? 'screen' : state.peerPresent ? 'cam' : 'empty';
  $('emptyState').hidden = state.peerPresent;
  $('remoteTile').hidden = !state.peerPresent;
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
for (const b of $$('.media-mic')) b.onclick = () => {
  const t = state.camStream.getAudioTracks()[0]; if (t) t.enabled = !t.enabled; syncMediaButtons();
};
for (const b of $$('.media-cam')) b.onclick = () => {
  const t = state.camStream.getVideoTracks()[0]; if (t) t.enabled = !t.enabled; syncMediaButtons();
};

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
  $('joinBtn').textContent = $('roomInput').value.trim() ? 'Join call' : 'Start call';
};

(async function startPreview() {
  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    // Fall back to whatever is available; joining works with neither.
    try { state.camStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {}
  }
  $('previewVideo').srcObject = state.camStream;
  syncMediaButtons();
})();

$('lobbyForm').onsubmit = (e) => { e.preventDefault(); join(); };

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
  $('chat').hidden = !isWide();
  $('chatBtn').classList.toggle('active', isWide());
  $('lobby').hidden = true;
  $('call').hidden = false;
  setStatus('Waiting for the other person');
  updateStage();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => signal({ type: 'join', room, name: state.myName });
  state.ws.onmessage = (e) => onSignal(JSON.parse(e.data));
  state.ws.onclose = () => setStatus('Disconnected from server', 'failed');
}

function signal(msg) { state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg)); }

// ---------- Peer connection (perfect negotiation) ----------
const remoteStreams = new Map();

function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  for (const t of state.camStream.getTracks()) pc.addTrack(t, state.camStream);
  if (state.screenStream) for (const t of state.screenStream.getTracks()) pc.addTrack(t, state.screenStream);

  // Pre-negotiated channel so both sides have it without waiting.
  state.dc = pc.createDataChannel('app', { negotiated: true, id: 0 });
  state.dc.onopen = () => {
    $('controlBtn').disabled = false;
    send({ t: 'hello', name: state.myName });
    if (state.screenStream) send({ t: 'screen-on', streamId: state.screenStream.id });
  };
  state.dc.onmessage = (e) => onData(JSON.parse(e.data));

  pc.onicecandidate = ({ candidate }) => candidate && signal({ type: 'ice', candidate });
  pc.onnegotiationneeded = async () => {
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      signal({ type: 'sdp', description: pc.localDescription });
    } finally { state.makingOffer = false; }
  };
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0];
    if (stream) remoteStreams.set(stream.id, stream);
    const isScreen = stream && stream.id === state.remoteScreenStreamId;
    if (isScreen) showRemoteScreen(stream);
    else if ($('remoteCam').srcObject !== stream) $('remoteCam').srcObject = stream;
    track.onended = () => { if (isScreen) hideRemoteScreen(); };
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus(`Connected with ${state.peerName}`, 'connected');
    if (pc.connectionState === 'failed') setStatus('Connection failed', 'failed');
  };
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'full':
      $('emptyTitle').textContent = 'This room is full';
      setStatus('Room full (2 people max)', 'failed');
      break;
    case 'joined':
      state.polite = !msg.initiator;
      if (msg.initiator) { state.peerPresent = true; setStatus('Connecting', 'connecting'); createPeer(); updateStage(); }
      break;
    case 'peer-joined':
      setPeerName(msg.name);
      state.peerPresent = true;
      setStatus(`${msg.name} joined, connecting`, 'connecting');
      toast(`${msg.name} joined`);
      if (!state.pc) createPeer();
      updateStage();
      break;
    case 'peer-left':
      toast(`${state.peerName} left`);
      setStatus('Waiting for the other person');
      resetPeer();
      break;
    case 'sdp': {
      if (!state.pc) createPeer();
      const pc = state.pc;
      const d = msg.description;
      const collision = d.type === 'offer' && (state.makingOffer || pc.signalingState !== 'stable');
      state.ignoreOffer = !state.polite && collision;
      if (state.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        signal({ type: 'sdp', description: pc.localDescription });
      }
      break;
    }
    case 'ice':
      try { await state.pc?.addIceCandidate(msg.candidate); }
      catch (e) { if (!state.ignoreOffer) console.warn(e); }
      break;
  }
}

function resetPeer() {
  remoteStreams.clear();
  stopControl();
  revokeControl(false);
  state.pc?.close();
  state.pc = null; state.dc = null;
  state.peerPresent = false;
  $('remoteCam').srcObject = null;
  hideRemoteScreen();
  $('controlBtn').disabled = true;
  updateStage();
}

// ---------- Data channel messages ----------
function send(obj) { state.dc?.readyState === 'open' && state.dc.send(JSON.stringify(obj)); }

function onData(m) {
  switch (m.t) {
    case 'hello':
      setPeerName(m.name);
      if (state.pc?.connectionState === 'connected') setStatus(`Connected with ${m.name}`, 'connected');
      break;
    case 'chat': addMessage(state.peerName, m.text, 'theirs'); break;
    case 'screen-on': {
      state.remoteScreenStreamId = m.streamId;
      // The screen track may have arrived before this message; re-route it.
      const stream = remoteStreams.get(m.streamId);
      if (stream) {
        if ($('remoteCam').srcObject === stream) {
          $('remoteCam').srcObject = [...remoteStreams.values()].find((s) => s.id !== m.streamId) || null;
        }
        showRemoteScreen(stream);
      }
      break;
    }
    case 'screen-off': hideRemoteScreen(); stopControl(); break;
    case 'control-request': onControlRequest(); break;
    case 'control-granted': startControl(); break;
    case 'control-denied':
      state.controlPending = false;
      updateControlBtn();
      systemMessage(`${state.peerName} didn't allow control.`);
      break;
    case 'control-revoked':
      if (state.controlGranted) { revokeControl(false); systemMessage(`${state.peerName} released control.`); }
      if (state.controlling) { stopControl(); systemMessage(`${state.peerName} took back control.`); }
      break;
    case 'input': forwardToAgent(m.e); break;
  }
}

function showRemoteScreen(stream) {
  $('remoteScreen').srcObject = stream;
  $('remoteScreen').hidden = false;
  updateStage();
}
function hideRemoteScreen() {
  $('remoteScreen').hidden = true;
  $('remoteScreen').srcObject = null;
  state.remoteScreenStreamId = null;
  updateStage();
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
  send({ t: 'screen-on', streamId: state.screenStream.id });
  state.pc?.addTrack(track, state.screenStream);
  $('shareBtn').classList.add('active');
  $('shareBtn').querySelector('.label').textContent = 'Stop';
  toast('You are sharing your screen');
};
function stopShare() {
  if (!state.screenStream) return;
  const ids = new Set(state.screenStream.getTracks().map((t) => t.id));
  for (const s of state.pc?.getSenders() || []) if (s.track && ids.has(s.track.id)) state.pc.removeTrack(s);
  state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  send({ t: 'screen-off' });
  revokeControl();
  $('shareBtn').classList.remove('active');
  $('shareBtn').querySelector('.label').textContent = 'Share';
}

// ---------- Leave / invite ----------
$('leaveBtn').onclick = () => {
  stopShare();
  state.ws?.close();
  resetPeer();
  state.camStream.getTracks().forEach((t) => t.stop());
  location.href = '/';
};
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
  send({ t: 'chat', text });
  addMessage('You', text, 'mine');
  $('chatInput').value = '';
  autosize();
};

function addMessage(who, text, kind) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  if (kind !== 'system') {
    const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
    div.append(w);
  }
  const body = document.createElement('div'); body.className = 'body'; body.textContent = text;
  div.append(body);
  const m = $('messages');
  m.append(div);
  m.scrollTop = m.scrollHeight;
  if (kind === 'theirs' && $('chat').hidden) {
    state.unread += 1;
    $('unread').textContent = state.unread;
    $('unread').hidden = false;
    toast(`${who}: ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`);
  }
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

async function onControlRequest() {
  if (IS_MOBILE) {
    send({ t: 'control-denied' });
    return systemMessage(`${state.peerName} asked for control, but phones and tablets can't be controlled remotely.`);
  }
  if (!state.screenStream) {
    send({ t: 'control-denied' });
    return systemMessage(`${state.peerName} asked for control. Share your entire screen first, then they can ask again.`);
  }
  if (await connectAgent()) return $('controlDialog').showModal();
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
$('cancelHelperBtn').onclick = () => { closeHelperDialog(); send({ t: 'control-denied' }); };
$('helperDialog').addEventListener('cancel', () => { clearInterval(helperPoll); send({ t: 'control-denied' }); });
$('pairingCodeLink').onclick = async (e) => {
  e.preventDefault();
  const token = prompt('Pairing code shown by the DevAssist dev agent:');
  if (token && await connectAgent(token.trim())) { closeHelperDialog(); $('controlDialog').showModal(); }
};

$('allowBtn').onclick = () => {
  $('controlDialog').close();
  if (!state.agent) { send({ t: 'control-denied' }); return systemMessage('DevAssist Helper closed. Ask them to request control again.'); }
  state.controlGranted = true;
  agentSend({ type: 'control', on: true });
  send({ t: 'control-granted' });
  $('controlledBanner').hidden = false;
  addMessage('', `${state.peerName} is controlling your computer.`, 'system');
};
$('denyBtn').onclick = () => { $('controlDialog').close(); send({ t: 'control-denied' }); };
$('controlDialog').addEventListener('cancel', () => send({ t: 'control-denied' }));
$('revokeBtn').onclick = () => { revokeControl(); systemMessage('You took back control.'); };

// notifyPeer=false when the other side already ended control itself.
function revokeControl(notifyPeer = true) {
  if (!state.controlGranted) return;
  state.controlGranted = false;
  agentSend({ type: 'control', on: false });
  if (notifyPeer) send({ t: 'control-revoked' });
  $('controlledBanner').hidden = true;
}

function forwardToAgent(e) {
  if (state.controlGranted) agentSend(e);
}

// ---------- Remote control: helper side ----------
const screenEl = $('remoteScreen');

function updateControlBtn() {
  const btn = $('controlBtn');
  const label = btn.querySelector('.label');
  btn.classList.toggle('active', state.controlling);
  if (state.controlling) { label.textContent = 'Release'; btn.title = 'Stop controlling their computer'; }
  else if (state.controlPending) { label.textContent = 'Asking…'; btn.title = 'Waiting for them to allow control'; }
  else { label.textContent = 'Control'; btn.title = 'Ask to control their computer'; }
}

$('controlBtn').onclick = () => {
  if (state.controlling) {
    send({ t: 'control-revoked' });
    stopControl();
    return;
  }
  if (state.controlPending) return;
  if (screenEl.hidden) return toast(`Ask ${state.peerName} to share their screen first`);
  state.controlPending = true;
  updateControlBtn();
  send({ t: 'control-request' });
  toast(`Asking ${state.peerName} for control…`);
};

function startControl() {
  state.controlling = true;
  state.controlPending = false;
  $('toasts').replaceChildren();
  screenEl.classList.add('controlling');
  screenEl.focus({ preventScroll: true });
  $('controllingBanner').hidden = false;
  updateControlBtn();
}
function stopControl() {
  state.controlling = false;
  state.controlPending = false;
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

function input(e) { if (state.controlling) send({ t: 'input', e }); }

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

// Show the chat panel again when a window grows back to desktop width.
matchMedia('(min-width: 1025px)').addEventListener('change', (e) => {
  if (!$('call').hidden && e.matches && $('chat').hidden) setChatOpen(true);
});
