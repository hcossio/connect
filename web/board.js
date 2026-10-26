// Drawing on shared screens and the whiteboard. Everyone can draw over the
// screen on the stage with markers, squares, circles and arrows, and move or
// resize what they drew. The host can open a whiteboard (with images on it),
// hide everyone else's drawings, and erase them. Drawings travel over the
// data channel; positions are fractions of the screen or board, so they line
// up on every device whatever its size.
'use strict';

const PEN_COLORS = ['#111111', '#ffffff', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7'];
const PEN_SIZES = [3, 6, 12]; // thousandths of the board's width
const KINDS = new Set(['pen', 'rect', 'ellipse', 'arrow', 'image']);
const WB_W = 1600, WB_H = 900; // the whiteboard's shape
const draw = { tool: 'pen', color: '#ef4444', size: 6, sel: null, op: null, mine: [], order: 0, seq: 0, lastLive: 0, lastSet: 0, hinted: false };
const annLayer = $('annotLayer'), annCanvas = $('annot'), actx = annCanvas.getContext('2d');
const boardImages = new Map(); // file id -> <img>

// Which board is on the stage: the whiteboard, or the screen being shown.
function currentBoard() {
  if (board.wb) return 'wb';
  if (brw.on || state.shownId == null || screenEl.hidden) return null;
  return `s${state.shownId}`;
}
function surface() {
  if (board.wb) return { el: $('whiteboard'), vw: WB_W, vh: WB_H };
  if (!currentBoard()) return null;
  return { el: screenEl, vw: screenEl.videoWidth, vh: screenEl.videoHeight };
}
// The picture's rectangle inside the surface (it's letterboxed to fit).
function contentBox(sf) {
  const W = sf.el.clientWidth, H = sf.el.clientHeight;
  if (!sf.vw || !sf.vh || !W || !H) return null;
  const s = Math.min(W / sf.vw, H / sf.vh);
  return { x: (W - sf.vw * s) / 2, y: (H - sf.vh * s) / 2, w: sf.vw * s, h: sf.vh * s };
}
const canDraw = () => !board.hide || state.isHost;
const canEdit = (it) => it.by === state.myId || state.isHost;
const visible = (it) => !board.hide || it.by === state.hostId;

function syncBoard() {
  const key = currentBoard();
  $('whiteboard').hidden = !board.wb;
  if (board.drawing && (!key || !canDraw())) board.drawing = false;
  $('drawBar').hidden = !board.drawing;
  $('drawBar').classList.toggle('is-host', state.isHost);
  $('stage').classList.toggle('drawing', board.drawing);
  $('drawBtn').classList.toggle('active', board.drawing);
  $('dbImage').hidden = !board.wb;
  $('dbWhiteboard').classList.toggle('on', board.wb);
  $('dbWhiteboard').title = board.wb ? 'Close the whiteboard for everyone' : 'Open the whiteboard for everyone';
  $('dbHide').classList.toggle('on', board.hide);
  $('dbHide').title = board.hide ? 'Show everyone\'s drawings again and let them draw' : 'Hide everyone else\'s drawings and stop them drawing';
  for (const b of $$('#drawBar [data-tool]')) b.classList.toggle('on', b.dataset.tool === draw.tool);
  const sel = board.items.get(draw.sel);
  if (draw.sel && (!sel || sel.board !== key || !canEdit(sel))) draw.sel = null;
  $('dbDelete').hidden = !draw.sel;
  // Your own screen: offer to see it here, to see what people draw on it.
  $('selfViewBtn').hidden = !state.screenStream || brw.on || board.wb;
  $('selfViewBtn').querySelector('span').textContent = state.selfView ? 'Back' : 'See my screen';
  const sf = surface();
  annLayer.hidden = !sf;
  if (!sf) return;
  const el = sf.el;
  Object.assign(annLayer.style, {
    left: `${el.offsetLeft}px`, top: `${el.offsetTop}px`, width: `${el.clientWidth}px`, height: `${el.clientHeight}px`,
    transform: el === screenEl ? screenEl.style.transform : '',
  });
  renderBoard();
}
screenEl.addEventListener('resize', () => syncBoard()); // the shared screen changed size
screenEl.addEventListener('loadedmetadata', () => syncBoard());
new ResizeObserver(() => syncBoard()).observe($('stage'));

let paintQueued = 0;
function renderBoard() { if (!paintQueued) paintQueued = requestAnimationFrame(paintBoard); }
function paintBoard() {
  paintQueued = 0;
  const sf = surface(), key = currentBoard();
  if (!sf || annLayer.hidden) return;
  const W = annLayer.clientWidth, H = annLayer.clientHeight, dpr = devicePixelRatio || 1;
  if (annCanvas.width !== Math.round(W * dpr) || annCanvas.height !== Math.round(H * dpr)) {
    annCanvas.width = Math.round(W * dpr); annCanvas.height = Math.round(H * dpr);
  }
  actx.setTransform(dpr, 0, 0, dpr, 0, 0);
  actx.clearRect(0, 0, W, H);
  const box = contentBox(sf);
  if (!box) return;
  if (board.wb) {
    actx.fillStyle = '#fff';
    actx.beginPath(); actx.roundRect(box.x, box.y, box.w, box.h, 10); actx.fill();
  }
  // Images underneath, then everything else in the order it was drawn.
  const list = [...board.items.values(), ...board.live.values()]
    .filter((it) => it.board === key && visible(it))
    .sort((a, b) => (a.kind === 'image' ? 0 : 1) - (b.kind === 'image' ? 0 : 1) || (a.n ?? Infinity) - (b.n ?? Infinity));
  for (const it of list) paintItem(it, box);
  const sel = board.items.get(draw.sel);
  if (sel && sel.board === key && visible(sel)) paintSelection(sel, box);
}
function paintItem(it, b) {
  const X = (u) => b.x + (it.x + u * it.w) * b.w, Y = (v) => b.y + (it.y + v * it.h) * b.h;
  const lw = Math.max(1.5, (it.size / 1000) * b.w);
  actx.strokeStyle = actx.fillStyle = it.color;
  actx.lineWidth = lw; actx.lineCap = 'round'; actx.lineJoin = 'round';
  actx.setLineDash([]);
  switch (it.kind) {
    case 'pen': {
      const p = it.pts;
      actx.beginPath();
      actx.moveTo(X(p[0][0]), Y(p[0][1]));
      if (p.length === 1) actx.lineTo(X(p[0][0]) + 0.1, Y(p[0][1]));
      // Smooth through the midpoints so the line doesn't look jagged.
      for (let i = 1; i < p.length - 1; i++) {
        actx.quadraticCurveTo(X(p[i][0]), Y(p[i][1]), (X(p[i][0]) + X(p[i + 1][0])) / 2, (Y(p[i][1]) + Y(p[i + 1][1])) / 2);
      }
      if (p.length > 1) actx.lineTo(X(p.at(-1)[0]), Y(p.at(-1)[1]));
      actx.stroke();
      break;
    }
    case 'rect': actx.strokeRect(X(0), Y(0), it.w * b.w, it.h * b.h); break;
    case 'ellipse':
      actx.beginPath();
      actx.ellipse(X(0.5), Y(0.5), (it.w * b.w) / 2, (it.h * b.h) / 2, 0, 0, Math.PI * 2);
      actx.stroke();
      break;
    case 'arrow': {
      const [[u0, v0], [u1, v1]] = it.pts;
      const x0 = X(u0), y0 = Y(v0), x1 = X(u1), y1 = Y(v1);
      const a = Math.atan2(y1 - y0, x1 - x0), head = Math.max(lw * 3.5, 12);
      actx.beginPath(); actx.moveTo(x0, y0); actx.lineTo(x1, y1); actx.stroke();
      actx.beginPath();
      actx.moveTo(x1, y1);
      actx.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
      actx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
      actx.closePath(); actx.fill();
      break;
    }
    case 'image': {
      const img = boardImage(it.file);
      if (img.complete && img.naturalWidth) actx.drawImage(img, X(0), Y(0), it.w * b.w, it.h * b.h);
      else {
        actx.strokeStyle = '#9a9a9a'; actx.lineWidth = 1.5; actx.setLineDash([6, 6]);
        actx.strokeRect(X(0), Y(0), it.w * b.w, it.h * b.h);
      }
      break;
    }
  }
}
const HANDLE = () => (matchMedia('(pointer: coarse)').matches ? 22 : 12);
function selectionRect(it, b) {
  const pad = it.kind === 'image' ? 0 : Math.max(6, ((it.size / 1000) * b.w) / 2 + 4);
  return { x: b.x + it.x * b.w - pad, y: b.y + it.y * b.h - pad, w: it.w * b.w + 2 * pad, h: it.h * b.h + 2 * pad };
}
function paintSelection(it, b) {
  const r = selectionRect(it, b);
  actx.setLineDash([6, 5]); actx.lineWidth = 1.5;
  actx.strokeStyle = board.wb ? '#555' : '#fff';
  actx.strokeRect(r.x, r.y, r.w, r.h);
  actx.setLineDash([]);
  const s = HANDLE() * 0.7;
  for (const [hx, hy] of corners(r)) {
    actx.fillStyle = '#fff'; actx.strokeStyle = '#111'; actx.lineWidth = 1.5;
    actx.beginPath(); actx.roundRect(hx - s / 2, hy - s / 2, s, s, 3); actx.fill(); actx.stroke();
  }
}
const corners = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]];

// ---------- Drawing with the mouse, a pen or a finger ----------
// Pointer position as a fraction of the board, plus the layer's pixel scale.
function boardPoint(ev) {
  const sf = surface(), box = sf && contentBox(sf);
  if (!box) return null;
  const r = annCanvas.getBoundingClientRect();
  const k = annLayer.clientWidth / r.width; // undoes a zoom on phones
  const lx = (ev.clientX - r.left) * k, ly = (ev.clientY - r.top) * k;
  return { x: (lx - box.x) / box.w, y: (ly - box.y) / box.h, lx, ly, box };
}
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round4 = (n) => Math.round(n * 10000) / 10000;
const newId = () => `${state.myId}-${Date.now().toString(36)}-${(++draw.seq).toString(36)}`;

// Turn the drag in progress into an item.
function buildItem(op) {
  const base = { id: op.id, by: state.myId, board: op.key, kind: op.kind, color: draw.color, size: draw.size };
  if (op.kind === 'pen') {
    const xs = op.pts.map((p) => p.x), ys = op.pts.map((p) => p.y);
    const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(...xs) - x, h = Math.max(...ys) - y;
    return { ...base, x, y, w, h, pts: op.pts.map((p) => [round4(w ? (p.x - x) / w : 0), round4(h ? (p.y - y) / h : 0)]) };
  }
  let { x: x0, y: y0 } = op.start, { x: x1, y: y1 } = op.end || op.start;
  if (op.shift && op.kind !== 'arrow') {
    // A perfect square or circle on screen, whatever the board's shape.
    const bw = op.box.w, bh = op.box.h, d = Math.max(Math.abs(x1 - x0) * bw, Math.abs(y1 - y0) * bh);
    x1 = x0 + Math.sign(x1 - x0 || 1) * (d / bw); y1 = y0 + Math.sign(y1 - y0 || 1) * (d / bh);
  }
  const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  const item = { ...base, x, y, w, h };
  if (op.kind === 'arrow') item.pts = [[x0 === x ? 0 : 1, y0 === y ? 0 : 1], [x1 === x ? 0 : 1, y1 === y ? 0 : 1]];
  return item;
}
function hitHandle(pt) {
  const it = board.items.get(draw.sel);
  if (!it || !canEdit(it)) return null;
  const r = selectionRect(it, pt.box), reach = HANDLE();
  const i = corners(r).findIndex(([hx, hy]) => Math.abs(pt.lx - hx) <= reach && Math.abs(pt.ly - hy) <= reach);
  return i < 0 ? null : { it, corner: i };
}
function hitItem(pt) {
  const key = currentBoard();
  const list = [...board.items.values()].filter((it) => it.board === key && visible(it) && canEdit(it))
    .sort((a, b) => (b.kind === 'image' ? 0 : 1) - (a.kind === 'image' ? 0 : 1) || b.n - a.n); // topmost first
  return list.find((it) => {
    const r = selectionRect(it, pt.box);
    return pt.lx >= r.x && pt.lx <= r.x + r.w && pt.ly >= r.y && pt.ly <= r.y + r.h;
  }) || null;
}

annCanvas.addEventListener('pointerdown', (ev) => {
  if (!board.drawing || ev.button > 0) return;
  const key = currentBoard(), pt = boardPoint(ev);
  if (!key || !pt) return;
  ev.preventDefault();
  annCanvas.setPointerCapture(ev.pointerId);
  // A corner of the selected drawing resizes it, whatever tool is on.
  const handle = hitHandle(pt);
  if (handle) {
    const { it, corner } = handle;
    const ax = corner % 2 ? it.x : it.x + it.w, ay = corner < 2 ? it.y + it.h : it.y; // the opposite corner stays put
    draw.op = { type: 'resize', id: it.id, ax, ay, ratio: it.w ? it.h / it.w : 1, keep: it.kind === 'image' };
    return;
  }
  if (draw.tool === 'select') {
    const it = hitItem(pt);
    draw.sel = it?.id || null;
    if (it) draw.op = { type: 'move', id: it.id, sx: pt.x, sy: pt.y, ox: it.x, oy: it.y };
    syncBoard();
    return;
  }
  draw.sel = null;
  const start = { x: clamp01(pt.x), y: clamp01(pt.y) };
  draw.op = { type: 'draw', kind: draw.tool, id: newId(), key, start, pts: [start], shift: ev.shiftKey, box: pt.box };
  liveDraw();
  syncBoard();
});
annCanvas.addEventListener('pointermove', (ev) => {
  const op = draw.op;
  if (!op) return;
  const pt = boardPoint(ev);
  if (!pt) return;
  const x = clamp01(pt.x), y = clamp01(pt.y);
  if (op.type === 'draw') {
    if (op.kind === 'pen') {
      const last = op.pts.at(-1);
      if (Math.hypot((x - last.x) * pt.box.w, (y - last.y) * pt.box.h) < 2 || op.pts.length > 3000) return;
      op.pts.push({ x, y });
    } else { op.end = { x, y }; op.shift = ev.shiftKey; op.box = pt.box; }
    liveDraw();
  } else {
    const it = board.items.get(op.id);
    if (!it) return (draw.op = null);
    if (op.type === 'move') {
      it.x = Math.min(1 - it.w, Math.max(0, op.ox + pt.x - op.sx));
      it.y = Math.min(1 - it.h, Math.max(0, op.oy + pt.y - op.sy));
    } else {
      it.x = Math.min(op.ax, x); it.w = Math.max(0.01, Math.abs(x - op.ax));
      if (op.keep) { it.h = it.w * op.ratio; it.y = y < op.ay ? op.ay - it.h : op.ay; }
      else { it.y = Math.min(op.ay, y); it.h = Math.abs(y - op.ay); }
      if (it.kind === 'rect' || it.kind === 'ellipse') it.h = Math.max(0.01, it.h);
    }
    renderBoard();
    if (performance.now() - draw.lastSet > 50) { draw.lastSet = performance.now(); broadcast({ t: 'ann', op: 'set', item: wire(it) }); }
  }
});
function endDraw() {
  const op = draw.op;
  draw.op = null;
  if (!op) return;
  if (op.type !== 'draw') {
    const it = board.items.get(op.id);
    if (it) broadcast({ t: 'ann', op: 'set', item: wire(it) });
    return;
  }
  board.live.delete(state.myId);
  const it = buildItem(op);
  const tiny = op.kind !== 'pen' && Math.hypot(it.w * op.box.w, it.h * op.box.h) < 6;
  if (tiny) { broadcast({ t: 'ann', op: 'unlive' }); renderBoard(); return; }
  putItem(it);
  draw.mine.push(it.id);
  broadcast({ t: 'ann', op: 'add', item: wire(it) });
  // A new shape is selected, so its corners can resize it right away.
  if (op.kind !== 'pen') draw.sel = it.id;
  syncBoard();
}
annCanvas.addEventListener('pointerup', endDraw);
annCanvas.addEventListener('pointercancel', endDraw);
function liveDraw() {
  const it = buildItem(draw.op);
  board.live.set(state.myId, it);
  renderBoard();
  // Others watch it being drawn, a few times a second.
  if (performance.now() - draw.lastLive > 60) { draw.lastLive = performance.now(); broadcast({ t: 'ann', op: 'live', item: wire(it) }); }
}

// ---------- Keeping everyone's copy the same ----------
const wire = ({ n, ...it }) => it;
function putItem(it) {
  it.n = board.items.get(it.id)?.n ?? ++draw.order;
  board.items.set(it.id, it);
}
function removeItem(id) {
  board.items.delete(id);
  if (draw.sel === id) draw.sel = null;
}
function clearBoard(key, quiet) {
  for (const [id, it] of board.items) if (it.board === key) removeItem(id);
  for (const [id, it] of board.live) if (it.board === key) board.live.delete(id);
  if (!quiet) syncBoard();
}
// Drawings arrive from other people's browsers: keep only well-formed ones.
function cleanItem(raw, from) {
  if (!raw || typeof raw !== 'object') return null;
  const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : null);
  const it = {
    id: String(raw.id || '').slice(0, 64), by: Number(raw.by) || from, board: String(raw.board || ''), kind: String(raw.kind || ''),
    color: PEN_COLORS.includes(raw.color) ? raw.color : '#ef4444', size: num(raw.size, 1, 40) ?? 6,
    x: num(raw.x, -1, 2), y: num(raw.y, -1, 2), w: num(raw.w, 0, 3), h: num(raw.h, 0, 3),
  };
  if (!it.id || !/^(wb|s\d+)$/.test(it.board) || !KINDS.has(it.kind) || [it.x, it.y, it.w, it.h].includes(null)) return null;
  if (it.kind === 'pen' || it.kind === 'arrow') {
    if (!Array.isArray(raw.pts) || !raw.pts.length) return null;
    it.pts = raw.pts.slice(0, 4000).map((p) => [num(p?.[0], 0, 1) ?? 0, num(p?.[1], 0, 1) ?? 0]);
    if (it.kind === 'arrow' && it.pts.length !== 2) return null;
  }
  if (it.kind === 'image') {
    const f = raw.file;
    if (!f || !/^[\w-]{1,64}$/.test(String(f.id))) return null;
    it.file = { id: String(f.id), name: String(f.name || 'image').slice(0, 200) };
  }
  return it;
}
function onAnn(p, m) {
  const host = p.id === state.hostId;
  switch (m.op) {
    case 'live': {
      const it = cleanItem(m.item, p.id);
      if (it && it.by === p.id) board.live.set(p.id, it);
      break;
    }
    case 'unlive': board.live.delete(p.id); break;
    case 'add': case 'set': {
      const it = cleanItem(m.item, p.id);
      if (!it) return;
      const old = board.items.get(it.id);
      // You change only your own drawings; the host can change anyone's.
      if (!host && (it.by !== p.id || (old && old.by !== p.id))) return;
      if (old) it.by = old.by;
      if (it.by === p.id) board.live.delete(p.id);
      putItem(it);
      if (m.op === 'add' && it.board === `s${state.myId}` && !state.selfView && !draw.hinted) {
        draw.hinted = true;
        toast(`${p.name} is drawing on your screen. Press See my screen to see it.`, 6000);
      }
      break;
    }
    case 'del': {
      const old = board.items.get(m.id);
      if (old && (old.by === p.id || host)) removeItem(m.id);
      break;
    }
    case 'clear':
      if (typeof m.board !== 'string') break;
      // Their own drawings, or (from the host) everyone's.
      if (host && !m.mine) clearBoard(m.board, true);
      else for (const [id, it] of board.items) if (it.board === m.board && it.by === p.id) removeItem(id);
      break;
  }
  syncBoard();
}
// The host tells someone who just joined what's open and what's drawn.
function sendBoard(id) {
  if (board.wb || board.hide) sendTo(id, { t: 'board', wb: board.wb, hide: board.hide });
  for (const it of board.items.values()) sendTo(id, { t: 'ann', op: 'add', item: wire(it) });
}
function onBoard(m) {
  const wasWb = board.wb, wasHidden = board.hide;
  board.wb = !!m.wb;
  board.hide = !!m.hide;
  if (board.wb && !wasWb) toast(`${nameOf(state.hostId)} opened the whiteboard`);
  if (!board.wb && wasWb) toast('The whiteboard was closed');
  if (board.hide && !wasHidden && !state.isHost) toast(`${nameOf(state.hostId)} hid everyone's drawings`);
  if (!board.hide && wasHidden && !state.isHost) toast('You can draw again');
  updateStage();
}
function shareBoardState() { broadcast({ t: 'board', wb: board.wb, hide: board.hide }); }

// ---------- The toolbar ----------
function setDrawing(on) {
  board.drawing = on;
  if (!on) { draw.sel = null; draw.op = null; }
  syncBoard();
}
function setWhiteboard(on) {
  if (!state.isHost) return;
  board.wb = on;
  shareBoardState();
  if (on) board.drawing = true;
  updateStage();
}
$('drawBtn').onclick = () => {
  if (board.drawing) return setDrawing(false);
  if (brw.on && !board.wb) return toast('Drawing isn\'t available on the shared browser');
  if (!canDraw()) return toast(`${nameOf(state.hostId)} turned drawing off`);
  if (!currentBoard()) {
    if (state.isHost) return setWhiteboard(true);
    if (state.screenStream) { state.selfView = true; updateStage(); }
    else return toast('Draw on a shared screen, or ask the host to open the whiteboard');
  }
  setDrawing(true);
};
$('selfViewBtn').onclick = () => { state.selfView = !state.selfView; updateStage(); };
for (const b of $$('#drawBar [data-tool]')) b.onclick = () => { draw.tool = b.dataset.tool; if (draw.tool !== 'select') draw.sel = null; syncBoard(); };
for (const c of PEN_COLORS) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'db-color', title: 'Color' });
  b.style.setProperty('--c', c);
  b.onclick = () => {
    draw.color = c;
    const it = board.items.get(draw.sel);
    if (it && it.kind !== 'image') { it.color = c; broadcast({ t: 'ann', op: 'set', item: wire(it) }); }
    syncToolbar();
  };
  $('dbColors').append(b);
}
for (const s of PEN_SIZES) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'db-size', title: ['Thin', 'Medium', 'Thick'][PEN_SIZES.indexOf(s)] });
  b.style.setProperty('--d', `${4 + PEN_SIZES.indexOf(s) * 4}px`);
  b.onclick = () => {
    draw.size = s;
    const it = board.items.get(draw.sel);
    if (it && it.kind !== 'image') { it.size = s; broadcast({ t: 'ann', op: 'set', item: wire(it) }); }
    syncToolbar();
  };
  $('dbSizes').append(b);
}
function syncToolbar() {
  [...$('dbColors').children].forEach((b, i) => b.classList.toggle('on', PEN_COLORS[i] === draw.color));
  [...$('dbSizes').children].forEach((b, i) => b.classList.toggle('on', PEN_SIZES[i] === draw.size));
  syncBoard();
}
syncToolbar();
function deleteSelected() {
  const it = board.items.get(draw.sel);
  if (!it || !canEdit(it)) return;
  removeItem(it.id);
  broadcast({ t: 'ann', op: 'del', id: it.id });
  syncBoard();
}
$('dbDelete').onclick = deleteSelected;
$('dbUndo').onclick = () => {
  const key = currentBoard();
  while (draw.mine.length) {
    const id = draw.mine.pop(), it = board.items.get(id);
    if (!it) continue;
    if (it.board !== key) { draw.mine.push(id); break; }
    removeItem(id);
    broadcast({ t: 'ann', op: 'del', id });
    break;
  }
  syncBoard();
};
$('dbClear').onclick = () => {
  const key = currentBoard();
  for (const [id, it] of board.items) if (it.board === key && it.by === state.myId) removeItem(id);
  broadcast({ t: 'ann', op: 'clear', board: key, mine: true });
  syncBoard();
};
$('dbClearAll').onclick = () => {
  if (!state.isHost) return;
  const key = currentBoard();
  clearBoard(key);
  broadcast({ t: 'ann', op: 'clear', board: key });
};
$('dbWhiteboard').onclick = () => setWhiteboard(!board.wb);
$('dbHide').onclick = () => {
  if (!state.isHost) return;
  board.hide = !board.hide;
  shareBoardState();
  toast(board.hide ? 'Only your drawings show now, and others can\'t draw' : 'Everyone\'s drawings show again', 3000);
  syncBoard();
};
$('dbDone').onclick = () => setDrawing(false);
addEventListener('keydown', (e) => {
  if (!board.drawing || e.target.closest('input, textarea, [contenteditable]')) return;
  if (e.key === 'Escape') setDrawing(false);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && draw.sel) { e.preventDefault(); deleteSelected(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $('dbUndo').click(); }
});

// ---------- Images on the whiteboard ----------
function boardImage(f) {
  let img = boardImages.get(f.id);
  if (!img) {
    img = new Image();
    img.onload = renderBoard;
    img.src = fileUrl({ id: f.id, name: f.name });
    boardImages.set(f.id, img);
  }
  return img;
}
$('dbImage').onclick = () => $('dbFile').click();
$('dbFile').onchange = () => {
  const file = $('dbFile').files[0];
  $('dbFile').value = '';
  if (file) addBoardImage(file);
};
async function addBoardImage(file) {
  if (!board.wb) return;
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return toast('Pick a PNG, JPEG, GIF or WebP image');
  if (file.size > MAX_FILE_MB * 1048576) return toast(`Images can be up to ${MAX_FILE_MB} MB`);
  toast('Adding the image…', 2000);
  let out;
  try {
    const r = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-Token': tx.token, 'Content-Type': file.type }, body: file });
    out = await r.json();
    if (!r.ok) throw new Error(out.error);
  } catch (e) { return toast(e.message || 'Couldn\'t add the image'); }
  const f = { id: out.id, name: out.name };
  const img = boardImage(f);
  await new Promise((res) => { if (img.complete) res(); else { img.addEventListener('load', res, { once: true }); img.addEventListener('error', res, { once: true }); } });
  // Half the board's width, centered, keeping its shape.
  const aspect = img.naturalWidth && img.naturalHeight ? (img.naturalHeight / img.naturalWidth) * (WB_W / WB_H) : 0.6;
  let w = 0.5, h = w * aspect;
  if (h > 0.8) { h = 0.8; w = h / aspect; }
  const it = { id: newId(), by: state.myId, board: 'wb', kind: 'image', color: '#111111', size: 1, x: (1 - w) / 2, y: (1 - h) / 2, w, h, file: f };
  putItem(it);
  draw.mine.push(it.id);
  draw.sel = it.id;
  broadcast({ t: 'ann', op: 'add', item: wire(it) });
  setDrawing(true);
}
// Drop or paste an image straight onto the whiteboard.
$('stage').addEventListener('dragover', (e) => { if (board.wb && e.dataTransfer.types.includes('Files')) e.preventDefault(); });
$('stage').addEventListener('drop', (e) => {
  if (!board.wb) return;
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f && canDraw()) addBoardImage(f);
});
addEventListener('paste', (e) => {
  if (!board.wb || !canDraw() || e.target.closest('input, textarea')) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); addBoardImage(f); }
});
