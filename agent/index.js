// DevAssist agent: runs on the computer being helped and injects the mouse and
// keyboard events the helper sends. It listens on 127.0.0.1 only and accepts a
// connection only with the pairing code printed below, so a random web page
// can't drive your machine. Stop it (Ctrl+C) and all control ends at once.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

let nut;
try { nut = require('@nut-tree-fork/nut-js'); } catch {
  console.error('Input library missing. Run "npm install" (it needs @nut-tree-fork/nut-js).');
  process.exit(1);
}
const { mouse, keyboard, screen, Key, Button, Point } = nut;
mouse.config.mouseSpeed = 100000; // jump, don't animate
mouse.config.autoDelayMs = 0;
keyboard.config.autoDelayMs = 0;

const PORT = Number(process.env.AGENT_PORT || 47800);
const TOKEN = process.env.AGENT_TOKEN || crypto.randomBytes(4).toString('hex');
// Pages allowed to connect, e.g. "https://assist.example.com". Empty = any origin (still needs the code).
const ALLOWED_ORIGINS = (process.env.AGENT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

const BUTTONS = { 0: Button.LEFT, 1: Button.MIDDLE, 2: Button.RIGHT };

// Browser KeyboardEvent.key -> nut-js Key for non-printable keys.
const SPECIAL = {
  Enter: Key.Enter, Backspace: Key.Backspace, Tab: Key.Tab, Escape: Key.Escape, ' ': Key.Space,
  Delete: Key.Delete, Insert: Key.Insert, Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
  ArrowUp: Key.Up, ArrowDown: Key.Down, ArrowLeft: Key.Left, ArrowRight: Key.Right, CapsLock: Key.CapsLock,
  F1: Key.F1, F2: Key.F2, F3: Key.F3, F4: Key.F4, F5: Key.F5, F6: Key.F6,
  F7: Key.F7, F8: Key.F8, F9: Key.F9, F10: Key.F10, F11: Key.F11, F12: Key.F12,
};
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

// Physical key from KeyboardEvent.code (layout independent) for shortcuts like Ctrl+C.
function keyFromCode(code) {
  let m = /^Key([A-Z])$/.exec(code); if (m) return Key[m[1]];
  m = /^Digit(\d)$/.exec(code); if (m) return Key[`Num${m[1]}`];
  return null;
}

async function toAbsolute(x, y) {
  const w = await screen.width(), h = await screen.height();
  return new Point(Math.round(clamp(x) * (w - 1)), Math.round(clamp(y) * (h - 1)));
}
const clamp = (v) => Math.min(1, Math.max(0, Number(v) || 0));

async function handle(e) {
  switch (e.type) {
    case 'move': return mouse.setPosition(await toAbsolute(e.x, e.y));
    case 'down':
      await mouse.setPosition(await toAbsolute(e.x, e.y));
      return mouse.pressButton(BUTTONS[e.button] ?? Button.LEFT);
    case 'up':
      await mouse.setPosition(await toAbsolute(e.x, e.y));
      return mouse.releaseButton(BUTTONS[e.button] ?? Button.LEFT);
    case 'wheel':
      if (e.dy > 0) await mouse.scrollDown(3); else if (e.dy < 0) await mouse.scrollUp(3);
      if (e.dx > 0) await mouse.scrollRight(3); else if (e.dx < 0) await mouse.scrollLeft(3);
      return;
    case 'text':
      return keyboard.type(String(e.text).slice(0, 10000));
    case 'keydown': {
      if (MODIFIERS.has(e.key)) return; // sent as flags with the real key
      const mods = [];
      if (e.ctrl) mods.push(Key.LeftControl);
      if (e.alt) mods.push(Key.LeftAlt);
      if (e.shift) mods.push(Key.LeftShift);
      if (e.meta) mods.push(Key.LeftSuper);
      const special = SPECIAL[e.key];
      const shortcut = e.ctrl || e.alt || e.meta;
      if (!special && !shortcut && typeof e.key === 'string' && e.key.length === 1) {
        return keyboard.type(e.key); // printable char, respects remote layout
      }
      const key = special || keyFromCode(e.code);
      if (key === undefined || key === null) return;
      await keyboard.pressKey(...mods, key);
      return keyboard.releaseKey(...mods, key);
    }
  }
}

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ req, origin }) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.searchParams.get('token') !== TOKEN) return false;
    if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) return false;
    return true;
  },
});

wss.on('connection', (ws, req) => {
  console.log(`Browser connected (${req.headers.origin || 'unknown origin'}). Remote control is possible once you click Allow.`);
  // Process events strictly in order.
  let queue = Promise.resolve();
  ws.on('message', (raw) => {
    let e; try { e = JSON.parse(raw); } catch { return; }
    queue = queue.then(() => handle(e)).catch((err) => console.error('input error:', err.message));
  });
  ws.on('close', () => console.log('Browser disconnected.'));
});

wss.on('listening', () => {
  console.log(`DevAssist agent listening on ws://127.0.0.1:${PORT}`);
  console.log(`Pairing code: ${TOKEN}`);
  console.log('Paste this code in DevAssist ("Connect agent"). Press Ctrl+C to stop all remote control.');
});
