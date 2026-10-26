// The servers browsers use to find a path to each other. STUN is enough when
// both sides can reach each other directly; behind a phone carrier's shared
// address (carrier-grade NAT) or a strict firewall they can't, and the call
// only connects through a relay (TURN) that forwards the media.
//
// Relays come from, in order:
//   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_TOKEN   Cloudflare Realtime TURN
//   TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL      any TURN server
//   TURN_URLS + TURN_SECRET                          coturn with use-auth-secret
const crypto = require('crypto');

const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const TTL = 24 * 3600; // seconds a credential works
const REFRESH_MS = 6 * 3600_000; // fetch fresh ones well before that

const CF_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const CF_TOKEN = process.env.CLOUDFLARE_TURN_TOKEN;
const URLS = (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);

let cached = null, cachedAt = 0, fetching = null, lastError = null;

// Browsers refuse port 53, and trying it only slows the call down.
const usable = (urls) => [].concat(urls || []).filter((u) => !/:53(\?|$)/.test(u));

async function fromCloudflare() {
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: TTL }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Cloudflare TURN answered ${r.status}`);
  const { iceServers } = await r.json();
  return [].concat(iceServers || [])
    .map((s) => ({ ...s, urls: usable(s.urls) }))
    .filter((s) => s.urls.length);
}

function fromEnv() {
  if (!URLS.length) return null;
  if (process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + TTL}:connect`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    return [{ urls: URLS, username, credential }];
  }
  return [{ urls: URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
}

function refresh() {
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const relay = CF_ID && CF_TOKEN ? await fromCloudflare() : fromEnv();
      cached = relay ? [...STUN, ...relay.filter((s) => usable(s.urls).some((u) => /^turns?:/.test(u)))] : null;
      cachedAt = Date.now();
      lastError = null;
    } catch (err) {
      if (lastError !== err.message) console.error('TURN credentials:', err.message);
      lastError = err.message;
      cachedAt = Date.now() - REFRESH_MS + 60_000; // try again in a minute
    } finally { fetching = null; }
  })();
  return fetching;
}

const configured = () => !!((CF_ID && CF_TOKEN) || URLS.length);

// What to hand a browser joining a call right now. Never waits: the first
// fetch starts when the server does, and later ones happen in the background.
function iceServers() {
  if (configured() && Date.now() - cachedAt > REFRESH_MS) refresh();
  return cached || STUN;
}
const hasRelay = () => !!cached && cached.length > STUN.length;

if (configured()) refresh();

module.exports = { iceServers, hasRelay, configured, status: () => ({ configured: configured(), relay: hasRelay(), error: lastError }) };
