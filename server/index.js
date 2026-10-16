// Signaling server: serves the web app and relays WebRTC offers/answers/ICE
// between the (max 2) peers in a room. Media never touches this server.
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PEERS = 2; // support sessions are 1:1 (helper + person being helped)

const app = express();
app.use(express.static(path.join(__dirname, '..', 'web')));
app.get('/health', (_req, res) => res.json({ ok: true }));
// Any /r/<room> path loads the app; the client reads the room from the URL.
app.get('/r/:room', (_req, res) => res.sendFile(path.join(__dirname, '..', 'web', 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** @type {Map<string, Set<import('ws')>>} */
const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on('connection', (ws) => {
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const name = String(msg.room || '').slice(0, 64);
      if (!name) return;
      const peers = rooms.get(name) || new Set();
      if (peers.size >= MAX_PEERS) return send(ws, { type: 'full' });
      room = name;
      peers.add(ws);
      rooms.set(name, peers);
      ws.displayName = String(msg.name || 'Guest').slice(0, 40);
      // The second peer to arrive is told to make the offer.
      send(ws, { type: 'joined', initiator: peers.size === 2 });
      for (const p of peers) if (p !== ws) send(p, { type: 'peer-joined', name: ws.displayName });
      return;
    }

    // Everything else (offer/answer/ice/chat) is relayed to the other peer.
    if (!room) return;
    for (const p of rooms.get(room) || []) if (p !== ws) send(p, msg);
  });

  ws.on('close', () => {
    if (!room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(ws);
    for (const p of peers) send(p, { type: 'peer-left' });
    if (peers.size === 0) rooms.delete(room);
  });
});

server.listen(PORT, () => console.log(`DevAssist running on http://localhost:${PORT}`));
