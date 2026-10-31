// Cloudflare Worker: live aircraft near a point, for the spotlight close-up on the site.
// Data: adsb.lol (Open Database License). The site can't call adsb.lol from the browser (no CORS), so this passes
// it through with a CORS header for the site's own origins, trims it to what the globe draws, and reuses a response
// for 10 s so many visitors looking at the same place make one upstream call.
//
// GET /?lat=23.7&lon=90.4&r=250   ->   { now, ac: [{ lat, lon, trk, gs, alt, cs, t }] }   (r in nautical miles, max 250)

const ALLOWED = ['https://brgrkng.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const memo = new Map();   // upstream url -> { at, body }  (per isolate; the Cache API is a no-op on workers.dev)

export default {
  async fetch(req) {
    const origin = req.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0], 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    if (req.method !== 'GET') return new Response('GET only', { status: 405, headers: cors });

    const q = new URL(req.url).searchParams;
    const lat = Number(q.get('lat')), lon = Number(q.get('lon'));
    const r = Math.min(250, Math.max(10, Number(q.get('r')) || 250));
    if (!q.has('lat') || !q.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return new Response('lat and lon required', { status: 400, headers: cors });

    // rounded, so nearby requests share one upstream call
    const url = `https://api.adsb.lol/v2/point/${lat.toFixed(1)}/${lon.toFixed(1)}/${Math.round(r)}`;
    let hit = memo.get(url);
    if (!hit || Date.now() - hit.at > 10_000) {
      const up = await fetch(url, { headers: { 'User-Agent': 'mesba-site (github.com/brgrkng/mesba-site)' } });
      if (!up.ok) return new Response('upstream ' + up.status, { status: 502, headers: cors });
      const data = await up.json();
      const ac = (data.ac || []).filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon)).slice(0, 400).map(a => ({
        lat: a.lat, lon: a.lon, trk: a.track ?? a.true_heading ?? 0, gs: a.gs ?? 0,
        alt: typeof a.alt_baro === 'number' ? a.alt_baro : 0, cs: (a.flight || '').trim(), t: a.t || '' }));
      hit = { at: Date.now(), body: JSON.stringify({ now: data.now, ac }) };
      memo.set(url, hit);
      if (memo.size > 200) memo.delete(memo.keys().next().value);
    }
    return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' } });
  },
};
