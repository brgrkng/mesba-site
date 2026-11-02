// Cloudflare Worker for the site: live aircraft, flight routes, and Mesba's vacation tracker.
// Data: aircraft from adsb.lol (Open Database License); routes and airline codes from adsbdb.com. The site can't call
// them from the browser (no CORS), so this passes them through with a CORS header for the site's own origins, trims
// them to what the globe draws, and reuses answers so many visitors make few upstream calls.
//
// Public (CORS for the site):
//   GET /?lat=23.7&lon=90.4&r=250   ->  { now, ac: [{ lat, lon, trk, gs, alt, cs, t }] }   (r in nautical miles, max 250)
//   GET /route?cs=QTR816            ->  { route: { airline, from: { iata, city, lat, lon }, to: {...} } | null }
//   GET /callsign?cs=MAS1           ->  { ac: { lat, lon, trk, gs, alt, cs, t } | null }   (that flight, if airborne)
//   GET /vacation                   ->  the trip, if Mesba has made it public: { on, place, until, flights: [...] }
//   GET /wind                       ->  { at, w: 30, h: 15, uv: [u, v, ...] }  winds at 700 hPa in m/s, 12° grid, rows south to north
// Private (same-origin page at a secret path, password in the Authorization header). Two passwords, two roles:
// ADMIN_PASSWORD edits the trip; VIEWER_PASSWORD (for his girlfriend) only reads it, public or not.
//   GET  /<ADMIN_PATH>              ->  the sign-in page; any other unknown path is a plain 404
//   POST /admin/check               ->  { role: 'admin' | 'viewer' } if the password is right
//   GET  /admin/status              ->  the full trip (either role)
//   POST /admin/resolve {flight}    ->  { flight, cs, airline, from, to } for a flight number like MH1 or MAS1 (admin)
//   PUT  /admin/trip   {trip}       ->  saves the trip (admin)
// Secrets (wrangler secret put): ADMIN_PASSWORD, VIEWER_PASSWORD, ADMIN_PATH. KV binding: VACATION.

import ADMIN_HTML from './admin.html';

const ALLOWED = ['https://brgrkng.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const UA = { 'User-Agent': 'mesba-site (github.com/brgrkng/mesba-site)' };
const memo = new Map();   // key -> { until, body }  (per isolate; the Cache API is a no-op on workers.dev)
const fails = new Map();  // ip -> { n, until }  wrong passwords, per isolate

async function remember(key, ttl, make) {
  const hit = memo.get(key);
  if (hit && Date.now() < hit.until) return hit.body;
  const body = await make();
  memo.set(key, { until: Date.now() + ttl, body });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return body;
}
const trimAc = a => ({ lat: a.lat, lon: a.lon, trk: a.track ?? a.true_heading ?? 0, gs: a.gs ?? 0,
  alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0, cs: (a.flight || '').trim(), t: a.t || '' });
const ap = a => ({ iata: a.iata_code || a.icao_code, city: a.municipality || a.name, lat: a.latitude, lon: a.longitude });

async function aircraft(q) {
  const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
  const r = Math.min(250, Math.max(10, Number(q.get('r')) || 250));
  if (!q.has('lat') || !q.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
    return null;
  // rounded, so nearby requests share one upstream call
  const url = `https://api.adsb.lol/v2/point/${lat.toFixed(1)}/${lon.toFixed(1)}/${Math.round(r)}`;
  return remember(url, 10_000, async () => {
    const up = await fetch(url, { headers: UA });
    if (!up.ok) throw new Error('upstream ' + up.status);
    const data = await up.json();
    const ac = (data.ac || []).filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)).slice(0, 400).map(trimAc);
    return JSON.stringify({ now: data.now, ac });
  });
}

async function routeData(cs) {
  const up = await fetch(`https://api.adsbdb.com/v0/callsign/${cs}`, { headers: UA });
  if (!up.ok && up.status !== 404 && up.status !== 400) throw new Error('upstream ' + up.status);
  const fr = up.ok ? (await up.json())?.response?.flightroute : null;
  const ok = fr?.origin && fr?.destination && Number.isFinite(fr.origin.latitude) && Number.isFinite(fr.destination.latitude);
  return ok ? { airline: fr.airline?.name || '', from: ap(fr.origin), to: ap(fr.destination) } : null;
}
const validCs = cs => /^[A-Z0-9]{3,8}$/.test(cs);

async function route(q) {
  const cs = (q.get('cs') || '').trim().toUpperCase();
  if (!validCs(cs)) return null;
  return remember('route:' + cs, 3_600_000, async () => JSON.stringify({ route: await routeData(cs) }));
}

async function byCallsign(q) {
  const cs = (q.get('cs') || '').trim().toUpperCase();
  if (!validCs(cs)) return null;
  return remember('cs:' + cs, 10_000, async () => {
    const up = await fetch(`https://api.adsb.lol/v2/callsign/${cs}`, { headers: UA });
    if (!up.ok) throw new Error('upstream ' + up.status);
    const a = ((await up.json()).ac || []).find(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));
    return JSON.stringify({ ac: a ? trimAc(a) : null });
  });
}

// "MH1" (booking code) or "MAS1" (what the aircraft broadcasts) -> the broadcast callsign, airline and route
async function resolveFlight(flight) {
  const f = String(flight || '').trim().toUpperCase().replace(/\s+/g, '');
  const m = f.match(/^([A-Z0-9]{2,3})(\d{1,4}[A-Z]?)$/);
  if (!m) return { error: 'Use a flight number like MH1 or MAS1.' };
  const [, code, num] = m;
  let candidates = [f];
  if (code.length === 2) {   // a booking code: try each airline that uses it
    const up = await fetch(`https://api.adsbdb.com/v0/airline/${code}`, { headers: UA });
    const list = up.ok ? (await up.json())?.response : null;
    candidates = Array.isArray(list) ? list.map(a => a.icao + num).filter(validCs) : [];
  }
  for (const cs of candidates) {
    const r = await routeData(cs);
    if (r) return { flight: f, cs, ...r };
  }
  return candidates.length ? { flight: f, cs: candidates[0], airline: '', from: null, to: null, warning: 'No route on file; it can still be tracked live.' }
                           : { error: `No airline found for ${code}.` };
}

// ---- auth ----
async function sameSecret(a, b) {   // compare without leaking how much matched
  const [x, y] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(x, y);
}
async function authorised(req, env) {             // -> 'admin' | 'viewer' | 'no' | 'locked'
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() < f.until) return 'locked';
  const given = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  // check both every time, so the response time doesn't hint which password was close
  const [admin, viewer] = await Promise.all([env.ADMIN_PASSWORD, env.VIEWER_PASSWORD]
    .map(p => p && given ? sameSecret(given, p) : false));
  if (admin || viewer) { fails.delete(ip); return admin ? 'admin' : 'viewer'; }
  const n = f && Date.now() < f.until ? f.n + 1 : 1;
  fails.set(ip, { n, until: Date.now() + 10 * 60_000 });
  return 'no';
}

// ---- the trip, cleaned to known fields before it is stored ----
const str = (v, n) => typeof v === 'string' ? v.trim().slice(0, n) : '';
const date = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
const airport = a => a && Number.isFinite(a.lat) && Number.isFinite(a.lon)
  ? { iata: str(a.iata, 4), city: str(a.city, 60), lat: a.lat, lon: a.lon } : null;
function cleanTrip(t) {
  return {
    on: t?.on === true, public: t?.public === true, place: str(t?.place, 60), until: date(t?.until),
    flights: (Array.isArray(t?.flights) ? t.flights : []).slice(0, 8).map(f => ({
      flight: str(f.flight, 8).toUpperCase(), cs: validCs(str(f.cs, 8).toUpperCase()) ? str(f.cs, 8).toUpperCase() : '',
      date: date(f.date), airline: str(f.airline, 60), from: airport(f.from), to: airport(f.to) })).filter(f => f.cs),
    updated: new Date().toISOString(),
  };
}

// ---- today's winds at 700 hPa (about 3 km up, where weather clouds are steered), from Open-Meteo (CC BY 4.0) ----
// One upstream call every 3 hours for everyone: the grid is kept in KV, and the old one is served if Open-Meteo fails.
async function wind(env) {
  const old = JSON.parse((await env.VACATION.get('wind')) || 'null');
  if (old && Date.now() - old.at < 3 * 36e5) return JSON.stringify(old);
  const lat = [], lon = [];
  for (let j = 0; j < 15; j++) for (let i = 0; i < 30; i++) { lat.push(-84 + j * 12); lon.push(-174 + i * 12); }
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
                          '&current=wind_speed_700hPa,wind_direction_700hPa&wind_speed_unit=ms', { headers: UA });
    if (!r.ok) throw new Error('open-meteo ' + r.status);
    const uv = (await r.json()).flatMap(({ current: c }) => {        // direction is where it blows from
      const a = c.wind_direction_700hPa * Math.PI / 180, s = c.wind_speed_700hPa;
      return [Math.round(-s * Math.sin(a) * 10) / 10, Math.round(-s * Math.cos(a) * 10) / 10];
    });
    const now = { at: Date.now(), w: 30, h: 15, uv };
    await env.VACATION.put('wind', JSON.stringify(now));
    return JSON.stringify(now);
  } catch (e) {
    if (old) return JSON.stringify(old);
    throw e;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], 'Vary': 'Origin' };
    const json = (body, status = 200, extra = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json', ...extra } });
    const notFound = () => new Response('Not found', { status: 404 });

    // ---- private: the admin page and its API (same origin only, never CORS) ----
    if (env.ADMIN_PATH && path === '/' + env.ADMIN_PATH && req.method === 'GET')
      return new Response(ADMIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' } });
    if (path.startsWith('/admin/')) {
      if (req.method === 'OPTIONS' || !env.ADMIN_PATH) return notFound();
      const role = await authorised(req, env);
      if (role === 'locked') return json({ error: 'Too many wrong passwords. Try again in 10 minutes.' }, 429);
      if (role === 'no') return json({ error: 'Wrong password.' }, 401);
      const noStore = { 'Cache-Control': 'no-store' };
      const trip = async () => (await env.VACATION.get('trip')) || JSON.stringify({ on: false, flights: [] });
      if (path === '/admin/check' && req.method === 'POST') return json({ role }, 200, noStore);
      if (path === '/admin/status' && req.method === 'GET') return json(await trip(), 200, noStore);
      if (role !== 'admin') return json({ error: 'Only Mesba can change this.' }, 403);
      if (path === '/admin/resolve' && req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        return json(await resolveFlight(body.flight), 200, noStore);
      }
      if (path === '/admin/trip' && req.method === 'PUT') {
        const trip = cleanTrip(await req.json().catch(() => null));
        await env.VACATION.put('trip', JSON.stringify(trip));
        return json(trip, 200, noStore);
      }
      return notFound();
    }

    // ---- public ----
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });
    try {
      let body;
      if (path === '/') body = await aircraft(url.searchParams);
      else if (path === '/route') body = await route(url.searchParams);
      else if (path === '/callsign') body = await byCallsign(url.searchParams);
      else if (path === '/vacation') {           // only what Mesba chose to make public
        const t = env.VACATION ? JSON.parse((await env.VACATION.get('trip')) || '{}') : {};
        body = JSON.stringify(t.public ? { on: t.on, place: t.place, until: t.until, flights: t.flights } : { on: false, flights: [] });
      }
      else if (path === '/wind') body = await remember('wind', 6e5, () => wind(env));
      else return notFound();
      if (body === null) return new Response('bad request', { status: 400, headers: cors });
      return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } });
    } catch (e) {
      return new Response(String(e.message || e), { status: 502, headers: cors });
    }
  },
};
