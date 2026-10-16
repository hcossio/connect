// DevAssist web client: 1:1 WebRTC call with camera, mic, screen share, chat
// and remote control. Control events travel over a WebRTC data channel; the
// person being helped forwards them to the DevAssist agent on 127.0.0.1,
// which is the only piece that can move the mouse and type (browsers can't).
'use strict';

const $ = (id) => document.getElementById(id);
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }]; // add a TURN server for production
const AGENT_URL = 'ws://127.0.0.1:47800';

const state = {
  ws: null, pc: null, dc: null,
  polite: false, makingOffer: false, ignoreOffer: false,
  camStream: null, screenStream: null,
  remoteScreenStreamId: null,
  peerName: 'Peer', myName: 'Guest',
  agent: null,             // WebSocket to local agent (helped side)
  controlGranted: false,   // helped side: we allow the peer to control us
  controlling: false,      // helper side: we are controlling the peer
};

// ---------- Lobby ----------
const urlRoom = location.pathname.startsWith('/r/') ? decodeURIComponent(location.pathname.slice(3)) : '';
$('roomInput').value = urlRoom;
$('nameInput').value = localStorage.getItem('devassist:name') || '';
$('joinBtn').onclick = join;

async function join() {
  state.myName = $('nameInput').value.trim() || 'Guest';
  localStorage.setItem('devassist:name', state.myName);
  const room = $('roomInput').value.trim() || Math.random().toString(36).slice(2, 8);
  history.replaceState(null, '', `/r/${encodeURIComponent(room)}`);

  try {
    state.camStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch {
    // No camera/mic permission: join anyway (you can still share and control).
    state.camStream = new MediaStream();
  }
  $('localCam').srcObject = state.camStream;

  $('lobby').hidden = true;
  $('call').hidden = false;
  $('roomLabel').textContent = `Room: ${room}`;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => signal({ type: 'join', room, name: state.myName });
  state.ws.onmessage = (e) => onSignal(JSON.parse(e.data));
}

function signal(msg) { state.ws?.readyState === 1 && state.ws.send(JSON.stringify(msg)); }
function setStatus(t) { $('status').textContent = t; }

// ---------- Peer connection (perfect negotiation) ----------
function createPeer() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  state.pc = pc;
  for (const t of state.camStream.getTracks()) pc.addTrack(t, state.camStream);
  if (state.screenStream) for (const t of state.screenStream.getTracks()) pc.addTrack(t, state.screenStream);

  // Pre-negotiated channel so both sides have it without waiting.
  state.dc = pc.createDataChannel('app', { negotiated: true, id: 0 });
  state.dc.onopen = () => {
    $('requestControlBtn').disabled = false;
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
    const el = isScreen ? $('remoteScreen') : $('remoteCam');
    if (el.srcObject !== stream) el.srcObject = stream;
    if (isScreen) $('remoteScreen').hidden = false;
    track.onended = () => { if (isScreen) hideRemoteScreen(); };
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setStatus(`Connected with ${state.peerName}`);
    if (pc.connectionState === 'failed') setStatus('Connection failed (a TURN server may be needed)');
  };
}

async function onSignal(msg) {
  switch (msg.type) {
    case 'full': setStatus('Room is full (2 people max).'); break;
    case 'joined':
      state.polite = !msg.initiator;
      if (msg.initiator) { setStatus('Connecting…'); createPeer(); }
      break;
    case 'peer-joined':
      state.peerName = msg.name;
      setStatus(`${msg.name} joined, connecting…`);
      if (!state.pc) createPeer();
      break;
    case 'peer-left':
      setStatus('The other person left.');
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

const remoteStreams = new Map();
function camStreamFallback() {
  for (const [id, s] of remoteStreams) if (id !== state.remoteScreenStreamId) return s;
  return null;
}

function resetPeer() {
  remoteStreams.clear();
  stopControl();
  state.pc?.close();
  state.pc = null; state.dc = null;
  $('remoteCam').srcObject = null;
  hideRemoteScreen();
  $('requestControlBtn').disabled = true;
}

// ---------- Data channel messages ----------
function send(obj) { state.dc?.readyState === 'open' && state.dc.send(JSON.stringify(obj)); }

function onData(m) {
  switch (m.t) {
    case 'hello':
      state.peerName = m.name;
      if (state.pc?.connectionState === 'connected') setStatus(`Connected with ${m.name}`);
      break;
    case 'chat': addMessage(state.peerName, m.text); break;
    case 'screen-on': {
      state.remoteScreenStreamId = m.streamId;
      // The screen track may have arrived before this message; re-route it.
      const stream = remoteStreams.get(m.streamId);
      if (stream) {
        if ($('remoteCam').srcObject === stream) $('remoteCam').srcObject = camStreamFallback();
        $('remoteScreen').srcObject = stream;
        $('remoteScreen').hidden = false;
      }
      break;
    }
    case 'screen-off': hideRemoteScreen(); stopControl(); break;
    case 'control-request': onControlRequest(); break;
    case 'control-granted': startControl(); break;
    case 'control-denied': addMessage('System', `${state.peerName} declined the control request.`); break;
    case 'control-revoked':
      if (state.controlGranted) { revokeControl(false); addMessage('System', `${state.peerName} released control.`); }
      else { stopControl(); addMessage('System', 'Control was revoked.'); }
      break;
    case 'input': forwardToAgent(m.e); break;
  }
}

function hideRemoteScreen() {
  $('remoteScreen').hidden = true;
  $('remoteScreen').srcObject = null;
  state.remoteScreenStreamId = null;
}

// ---------- Media controls ----------
$('micBtn').onclick = () => {
  const t = state.camStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('micBtn').textContent = t.enabled ? 'Mute' : 'Unmute';
};
$('camBtn').onclick = () => {
  const t = state.camStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('camBtn').textContent = t.enabled ? 'Camera off' : 'Camera on';
};
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
  $('shareBtn').textContent = 'Stop sharing';
  $('shareBtn').classList.add('on');
};
function stopShare() {
  if (!state.screenStream) return;
  const ids = new Set(state.screenStream.getTracks().map((t) => t.id));
  for (const s of state.pc?.getSenders() || []) if (s.track && ids.has(s.track.id)) state.pc.removeTrack(s);
  state.screenStream.getTracks().forEach((t) => t.stop());
  state.screenStream = null;
  send({ t: 'screen-off' });
  revokeControl();
  $('shareBtn').textContent = 'Share screen';
  $('shareBtn').classList.remove('on');
}
$('leaveBtn').onclick = () => { stopShare(); state.ws?.close(); resetPeer(); location.href = '/'; };
$('copyLinkBtn').onclick = () => navigator.clipboard.writeText(location.href);

// ---------- Chat ----------
$('chatForm').onsubmit = (e) => {
  e.preventDefault();
  const text = $('chatInput').value; if (!text.trim()) return;
  send({ t: 'chat', text }); addMessage('You', text); $('chatInput').value = '';
};
function addMessage(who, text) {
  const div = document.createElement('div'); div.className = 'msg';
  const b = document.createElement('b'); b.textContent = `${who}: `;
  div.append(b, document.createTextNode(text));
  $('messages').append(div); div.scrollIntoView();
}

// ---------- Remote control: helped side ----------
// The DevAssist Helper app (or the dev agent) listens on 127.0.0.1. We try to
// reach it when control is requested; if it isn't running we offer the download
// and keep retrying until it starts.
const OS = /Windows/i.test(navigator.userAgent) ? 'windows' : /Mac/i.test(navigator.userAgent) ? 'mac' : 'linux';
const OS_LABEL = { windows: 'Windows', mac: 'Mac', linux: 'Linux' }[OS];
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
  if (!state.screenStream) {
    send({ t: 'control-denied' });
    return addMessage('System', `${state.peerName} asked for control. Share your entire screen first.`);
  }
  if (await connectAgent()) return showAllowDialog();
  $('helperRequester').textContent = state.peerName;
  $('downloadHelper').href = `/download/${OS}`;
  $('downloadHelper').textContent = `Download for ${OS_LABEL}`;
  $('helperDialog').showModal();
  helperPoll = setInterval(async () => {
    if (await connectAgent()) { closeHelperDialog(); showAllowDialog(); }
  }, 2000);
}

function closeHelperDialog() {
  clearInterval(helperPoll);
  helperPoll = null;
  $('helperDialog').close();
}
$('cancelHelperBtn').onclick = () => { closeHelperDialog(); send({ t: 'control-denied' }); };
$('pairingCodeLink').onclick = async (e) => {
  e.preventDefault();
  const token = prompt('Pairing code shown by the DevAssist dev agent:');
  if (token && await connectAgent(token.trim())) { closeHelperDialog(); showAllowDialog(); }
};

function showAllowDialog() {
  $('requesterName').textContent = state.peerName;
  $('controlDialog').showModal();
}
$('allowBtn').onclick = () => {
  $('controlDialog').close();
  if (!state.agent) { send({ t: 'control-denied' }); return addMessage('System', 'The helper app closed. Ask again to retry.'); }
  state.controlGranted = true;
  agentSend({ type: 'control', on: true });
  send({ t: 'control-granted' });
  $('agentBtn').hidden = false;
  addMessage('System', `${state.peerName} is now controlling your computer.`);
};
$('denyBtn').onclick = () => { $('controlDialog').close(); send({ t: 'control-denied' }); };
$('agentBtn').onclick = () => revokeControl();

// notifyPeer=false when the helper side already ended control itself.
function revokeControl(notifyPeer = true) {
  if (!state.controlGranted) return;
  state.controlGranted = false;
  agentSend({ type: 'control', on: false });
  if (notifyPeer) send({ t: 'control-revoked' });
  $('agentBtn').hidden = true;
}

function forwardToAgent(e) {
  if (!state.controlGranted) return;
  agentSend(e);
}

// ---------- Remote control: helper side ----------
$('requestControlBtn').onclick = () => {
  if ($('remoteScreen').hidden) return addMessage('System', 'Ask them to share their screen first.');
  send({ t: 'control-request' });
  addMessage('System', 'Control requested…');
};
$('releaseControlBtn').onclick = () => { send({ t: 'control-revoked' }); stopControl(); };

const screenEl = $('remoteScreen');

function startControl() {
  state.controlling = true;
  screenEl.classList.add('controlling');
  screenEl.focus();
  $('controlBadge').hidden = false;
  $('requestControlBtn').hidden = true;
  $('releaseControlBtn').hidden = false;
}
function stopControl() {
  state.controlling = false;
  screenEl.classList.remove('controlling');
  $('controlBadge').hidden = true;
  $('requestControlBtn').hidden = false;
  $('releaseControlBtn').hidden = true;
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

let lastMove = 0;
screenEl.addEventListener('mousemove', (ev) => {
  const now = performance.now(); if (now - lastMove < 16) return; lastMove = now; // ~60 Hz
  const p = normalized(ev); if (p) input({ type: 'move', ...p });
});
screenEl.addEventListener('mousedown', (ev) => {
  if (!state.controlling) return; ev.preventDefault(); screenEl.focus();
  const p = normalized(ev); if (p) input({ type: 'down', button: ev.button, ...p });
});
screenEl.addEventListener('mouseup', (ev) => {
  const p = normalized(ev); if (p) input({ type: 'up', button: ev.button, ...p });
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
