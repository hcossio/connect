// Link previews. When someone pastes a call link into WhatsApp, iMessage,
// Slack and the like, the app reads the page's Open Graph tags: a scheduled
// meeting shows its title, date and time, and a picture card with the same.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'web', 'index.html');
const FALLBACK_TZ = process.env.DEFAULT_TZ || 'America/New_York';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const validTz = (tz) => {
  try { return !!tz && !!new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; }
};

// "Thursday, October 30" and "3:00 PM EDT", in the host's time zone.
function when(s) {
  const timeZone = validTz(s.tz) ? s.tz : FALLBACK_TZ;
  const d = new Date(s.at);
  return {
    date: d.toLocaleDateString('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
    // "New York time", so people elsewhere know which clock it is.
    zone: timeZone.includes('/') ? `${timeZone.split('/').pop().replace(/_/g, ' ')} time` : '',
  };
}
const length = (m) => (m >= 60 ? `${+(m / 60).toFixed(1)} hour${m === 60 ? '' : 's'}` : `${m} min`);

function meta(s, origin, room) {
  if (!s) {
    return {
      title: 'Join my call on Connect',
      description: 'Video call with screen sharing and chat. Open the link to join, nothing to install.',
      image: `${origin}/img/og.png`,
    };
  }
  const w = when(s);
  // The image changes with the title and time, so a rescheduled meeting gets a fresh card.
  const v = crypto.createHash('sha1').update(`${s.title}|${s.at}|${s.minutes}|${s.tz || ''}`).digest('hex').slice(0, 10);
  return {
    title: s.title,
    description: `${w.date} · ${w.time}${w.zone ? ` (${w.zone})` : ''} · ${length(s.minutes)}. Open the link to join on Connect.`,
    image: `${origin}/og/${encodeURIComponent(room)}.png?v=${v}`,
  };
}

let template = null;
function page(s, origin, room, url) {
  template ||= fs.readFileSync(INDEX, 'utf8');
  const m = meta(s, origin, room);
  const tags = [
    `<meta name="description" content="${esc(m.description)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Connect">',
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.description)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(m.image)}">`,
    '<meta property="og:image:type" content="image/png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n  ');
  return template
    .replace('<title>Connect</title>', `<title>${esc(s ? `${s.title} · Connect` : 'Connect')}</title>\n  ${tags}`);
}

// ---------- The picture card ----------
// Drawn by the same Chromium the shared browser uses, then kept in memory.
const cards = new Map(); // key -> PNG buffer
let launching = null, idle = null;
function chromium() {
  const exe = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
  if (!exe) return null;
  if (!launching) {
    const l = launching = require('playwright-core').chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] })
      .then((b) => { b.on('disconnected', () => { if (launching === l) launching = null; }); return b; })
      .catch((e) => { launching = null; throw e; });
  }
  clearTimeout(idle);
  // Close it when no one has asked for a card in a minute.
  idle = setTimeout(() => { const l = launching; launching = null; l?.then((b) => b.close()).catch(() => {}); }, 60_000);
  return launching;
}

function cardHtml(s) {
  const w = when(s);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #000; color: #fff; font-family: "Liberation Sans", Arial, Helvetica, sans-serif;
    display: flex; flex-direction: column; justify-content: space-between; padding: 72px 80px; }
  .brand { display: flex; align-items: center; gap: 18px; font-size: 34px; font-weight: 700; }
  .brand i { width: 54px; height: 54px; border-radius: 14px; background: #fff; display: grid; place-items: center; }
  .label { font-size: 26px; letter-spacing: .14em; text-transform: uppercase; color: #9a9a9a; margin-bottom: 18px; }
  h1 { font-size: ${s.title.length > 40 ? 64 : 80}px; line-height: 1.08; font-weight: 700; max-height: 2.2em; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .when { display: flex; gap: 16px; flex-wrap: wrap; }
  .when span { font-size: 28px; padding: 12px 24px; border: 2px solid #fff; border-radius: 999px; }
  .when span + span { border-color: #5a5a5a; color: #d0d0d0; }
  </style></head><body>
  <div class="brand"><i><svg width="30" height="30" viewBox="0 0 32 32"><path d="M11 8v15l4-4 3 6 2.5-1.2-3-5.8H23z" fill="#000"/></svg></i>Connect</div>
  <div><p class="label">Scheduled meeting</p><h1>${esc(s.title)}</h1></div>
  <div class="when"><span>${esc(w.date)}</span><span>${esc(w.time)}</span><span>${esc(length(s.minutes))}</span>${w.zone ? `<span>${esc(w.zone)}</span>` : ''}</div>
  </body></html>`;
}

async function card(s) {
  const key = `${s.room}|${s.title}|${s.at}|${s.minutes}|${s.tz || ''}`;
  if (cards.has(key)) return cards.get(key);
  const launch = chromium();
  if (!launch) return null;
  const browser = await launch;
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  try {
    const p = await ctx.newPage();
    await p.setContent(cardHtml(s), { waitUntil: 'load' });
    const png = await p.screenshot({ type: 'png' });
    if (cards.size > 200) cards.delete(cards.keys().next().value);
    cards.set(key, png);
    return png;
  } finally {
    await ctx.close().catch(() => {});
  }
}

module.exports = { page, card, when, validTz, chromium };
