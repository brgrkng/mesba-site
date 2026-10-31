// Cloudflare Worker: live aircraft near a point, and a flight's route, for the spotlight close-up on the site.
// Data: aircraft from adsb.lol (Open Database License); routes from adsbdb.com. The site can't call them from the
// browser (no CORS), so this passes them through with a CORS header for the site's own origins, trims them to what
// the globe draws, and reuses answers (aircraft 10 s, routes 1 h) so many visitors make few upstream calls.
//
// GET /?lat=23.7&lon=90.4&r=250   ->   { now, ac: [{ lat, lon, trk, gs, alt, cs, t }] }   (r in nautical miles, max 250)
// GET /route?cs=QTR816            ->   { route: { airline, from: { iata, city, lat, lon }, to: {...} } | null }

const ALLOWED = ['https://brgrkng.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const UA = { 'User-Agent': 'mesba-site (github.com/brgrkng/mesba-site)' };
const memo = new Map();   // key -> { until, body }  (per isolate; the Cache API is a no-op on workers.dev)

async function remember(key, ttl, make) {
  const hit = memo.get(key);
  if (hit && Date.now() < hit.until) return hit.body;
  const body = await make();
  memo.set(key, { until: Date.now() + ttl, body });
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return body;
}

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
    const ac = (data.ac || []).filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)).slice(0, 400).map(a => ({
      lat: a.lat, lon: a.lon, trk: a.track ?? a.true_heading ?? 0, gs: a.gs ?? 0,
      alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0, cs: (a.flight || '').trim(), t: a.t || '' }));
    return JSON.stringify({ now: data.now, ac });
  });
}

async function route(q) {
  const cs = (q.get('cs') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(cs)) return null;
  return remember('route:' + cs, 3_600_000, async () => {
    const up = await fetch(`https://api.adsbdb.com/v0/callsign/${cs}`, { headers: UA });
    if (!up.ok && up.status !== 404) throw new Error('upstream ' + up.status);
    const fr = up.ok ? (await up.json())?.response?.flightroute : null;
    const ap = a => ({ iata: a.iata_code || a.icao_code, city: a.municipality || a.name, lat: a.latitude, lon: a.longitude });
    const ok = fr?.origin && fr?.destination && Number.isFinite(fr.origin.latitude) && Number.isFinite(fr.destination.latitude);
    return JSON.stringify({ route: ok ? { airline: fr.airline?.name || '', from: ap(fr.origin), to: ap(fr.destination) } : null });
  });
}

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });

    const url = new URL(req.url);
    try {
      const body = url.pathname === '/route' ? await route(url.searchParams) : await aircraft(url.searchParams);
      if (body === null) return new Response('bad request', { status: 400, headers: cors });
      return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } });
    } catch (e) {
      return new Response(String(e.message || e), { status: 502, headers: cors });
    }
  },
};
