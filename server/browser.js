// A shared web browser for a call. It runs here on the server (headless
// Chromium), everyone in the room watches the same page as a stream of JPEG
// frames, and one person at a time drives it with their mouse and keyboard.
const fs = require('fs');
const net = require('net');
const dns = require('dns').promises;

const W = 1280, H = 800;
const MAX_SESSIONS = Number(process.env.BROWSER_MAX || 4);
const ALLOW_PRIVATE = process.env.BROWSER_ALLOW_PRIVATE === '1'; // tests browse the local server
// Google shows a captcha to most server addresses; DuckDuckGo doesn't.
const HOME = 'https://duckduckgo.com/';
const SEARCH = 'https://duckduckgo.com/?q=';

function executable() {
  const found = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((p) => p && fs.existsSync(p));
  return found || null;
}
const available = () => !!executable();
console.log('shared browser:', executable() || 'no Chromium found, the feature is off');

let launching = null; // one Chromium process, one isolated context per room
function getBrowser() {
  if (!launching) {
    const { chromium } = require('playwright-core');
    launching = chromium.launch({
      executablePath: executable(),
      // Present as an everyday Chrome: many sites refuse browsers that say they're automated.
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio', '--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    }).then((b) => {
      b.on('disconnected', () => { launching = null; });
      return b;
    }).catch((e) => { launching = null; throw e; });
  }
  return launching;
}
const sessions = new Map(); // room -> session

// Keep the browser off this server's own network: no localhost, private or
// link-local addresses (cloud metadata), and only http(s) pages.
const PRIVATE = [
  /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^::1$/, /^::$/, /^f[cd]/i, /^fe80:/i, /^::ffff:(127|10|192\.168|169\.254)\./i,
];
const isPrivateIp = (ip) => PRIVATE.some((re) => re.test(ip));
const hostChecks = new Map();
async function allowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (ALLOW_PRIVATE) return true;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  if (!hostChecks.has(host)) {
    hostChecks.set(host, dns.lookup(host, { all: true }).then((a) => a.every((r) => !isPrivateIp(r.address))).catch(() => true));
    setTimeout(() => hostChecks.delete(host), 10 * 60_000);
  }
  return hostChecks.get(host);
}

// What people type in the address bar: a URL, a bare domain, or a search.
function toUrl(text) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(t) || /^localhost(:\d+)?(\/|$)/i.test(t)) return 'https://' + t;
  return SEARCH + encodeURIComponent(t);
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function stateOf(s) {
  const driver = [...s.room.peers].find((p) => p.peerId === s.driver);
  return { type: 'browser', on: true, url: s.url, title: s.title, loading: s.loading, driver: driver ? driver.peerId : null, driverName: driver?.displayName || null, by: s.byName, w: W, h: H };
}
function announce(s) { for (const p of s.room.peers) send(p, stateOf(s)); }

async function open(room, ws, text) {
  if (sessions.has(room)) return;
  if (!available()) return send(ws, { type: 'browser-error', message: 'The shared browser isn’t available on this server.' });
  if (sessions.size >= MAX_SESSIONS) return send(ws, { type: 'browser-error', message: 'Too many shared browsers are open right now. Try again in a bit.' });
  const s = { room, driver: ws.peerId, byName: ws.displayName, url: '', title: '', loading: true, frame: null, closed: false };
  sessions.set(room, s);
  announce(s);
  try {
    const browser = await getBrowser();
    const major = browser.version().split('.')[0];
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    s.ctx = await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: 1, acceptDownloads: false, locale: 'en-US', timezoneId: 'America/New_York', userAgent: ua,
    });
    await s.ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      if (!window.chrome) window.chrome = { runtime: {} };
    });
    if (s.closed) return s.ctx.close().catch(() => {});
    await s.ctx.route('**/*', async (route) => (await allowedUrl(route.request().url()) ? route.continue() : route.abort('blockedbyclient')));
    s.page = await s.ctx.newPage();
    // Links that open a new tab open here instead, so everyone stays on one page.
    s.ctx.on('page', async (p) => {
      if (p === s.page) return;
      const url = p.url();
      await p.close().catch(() => {});
      if (url && url !== 'about:blank') go(s, url);
      else p.waitForEvent('framenavigated', { timeout: 5000 }).then((f) => go(s, f.url())).catch(() => {});
    });
    s.page.on('dialog', (d) => d.dismiss().catch(() => {}));
    s.page.on('framenavigated', (f) => {
      if (f !== s.page.mainFrame()) return;
      if (!f.url().startsWith('chrome-error:')) s.url = f.url(); // keep showing the address that failed
      announce(s);
    });
    s.page.on('load', async () => { s.loading = false; s.title = await s.page.title().catch(() => ''); announce(s); });
    s.page.on('domcontentloaded', async () => { s.title = await s.page.title().catch(() => ''); announce(s); });
    s.cdp = await s.ctx.newCDPSession(s.page);
    // The client hints too, which otherwise say "HeadlessChrome" on Linux.
    await s.cdp.send('Emulation.setUserAgentOverride', {
      userAgent: ua, acceptLanguage: 'en-US,en', platform: 'Win32',
      userAgentMetadata: {
        brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not_A Brand', version: '24' }],
        fullVersion: browser.version(), platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', bitness: '64', model: '', mobile: false,
      },
    });
    s.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      s.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      s.frame = data;
      for (const p of s.room.peers) if (p.readyState === 1 && p.bufferedAmount < 2e6) p.send(JSON.stringify({ type: 'browser-frame', data }));
    });
    await s.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    await go(s, toUrl(s.startUrl ?? text));
  } catch (e) {
    console.error('shared browser failed to start', e.message);
    for (const p of room.peers) send(p, { type: 'browser-error', message: 'The shared browser couldn’t start.' });
    close(room);
  }
}

async function go(s, url) {
  if (!s.page || s.closed) return;
  if (!(await allowedUrl(url))) {
    for (const p of s.room.peers) send(p, { type: 'browser-error', message: 'That address can’t be opened in the shared browser.' });
    return;
  }
  s.url = url;
  s.loading = true; announce(s);
  const err = await s.page.goto(url, { waitUntil: 'commit', timeout: 30_000 }).then(() => null, (e) => e);
  if (err && !/interrupted|aborted|closed/i.test(err.message) && !s.closed) {
    s.loading = false; announce(s);
    for (const p of s.room.peers) send(p, { type: 'browser-error', message: `Couldn’t open ${new URL(url).host}.` });
  }
}

function close(room) {
  const s = sessions.get(room);
  if (!s) return;
  s.closed = true;
  sessions.delete(room);
  for (const p of room.peers) send(p, { type: 'browser', on: false });
  s.ctx?.close().catch(() => {});
  // Free the memory when no room is using it.
  if (!sessions.size && launching) {
    const l = launching; launching = null;
    l.then((b) => b.close()).catch(() => {});
  }
}

const BUTTONS = ['left', 'middle', 'right'];
async function input(s, e) {
  const page = s.page;
  if (!page) return;
  const x = Math.max(0, Math.min(1, +e.x || 0)) * W, y = Math.max(0, Math.min(1, +e.y || 0)) * H;
  const button = BUTTONS[e.button] || 'left';
  switch (e.type) {
    case 'move': return page.mouse.move(x, y);
    case 'down': await page.mouse.move(x, y); return page.mouse.down({ button });
    case 'up': await page.mouse.move(x, y); return page.mouse.up({ button });
    case 'click': await page.mouse.move(x, y); return page.mouse.click(x, y, { button });
    case 'wheel': await page.mouse.move(x, y); return page.mouse.wheel(Math.max(-2000, Math.min(2000, +e.dx || 0)), Math.max(-2000, Math.min(2000, +e.dy || 0)));
    case 'keydown': return page.keyboard.down(String(e.key).slice(0, 32));
    case 'keyup': return page.keyboard.up(String(e.key).slice(0, 32));
    case 'text': return page.keyboard.insertText(String(e.text || '').slice(0, 5000));
  }
}

// Messages from people in the room. Returns true when it handled one.
function handle(room, ws, msg) {
  if (!msg.type.startsWith('browser-')) return false;
  const s = sessions.get(room);
  switch (msg.type) {
    case 'browser-open': open(room, ws, msg.url); break;
    case 'browser-close': close(room); break;
    case 'browser-take': if (s) { s.driver = ws.peerId; announce(s); } break;
    case 'browser-release': if (s && s.driver === ws.peerId) { s.driver = null; announce(s); } break;
    case 'browser-nav':
      if (!s || s.driver !== ws.peerId) break;
      if (!s.page) { if (msg.action === 'go') s.startUrl = msg.url; break; } // still starting: go there first

      if (msg.action === 'back') s.page.goBack({ timeout: 15_000 }).catch(() => {});
      else if (msg.action === 'forward') s.page.goForward({ timeout: 15_000 }).catch(() => {});
      else if (msg.action === 'reload') s.page.reload({ timeout: 30_000 }).catch(() => {});
      else if (msg.action === 'go') go(s, toUrl(msg.url));
      break;
    case 'browser-input':
      if (s?.page && s.driver === ws.peerId && msg.e) input(s, msg.e).catch(() => {});
      break;
  }
  return true;
}

// Someone joined a room with the browser open: show them where it is.
function joined(room, ws) {
  const s = sessions.get(room);
  if (!s) return;
  send(ws, stateOf(s));
  if (s.frame) send(ws, { type: 'browser-frame', data: s.frame });
}
// Someone left: they can't keep driving.
function left(room, ws) {
  const s = sessions.get(room);
  if (s && s.driver === ws.peerId) { s.driver = null; announce(s); }
}

module.exports = { handle, joined, left, close, available, toUrl };
