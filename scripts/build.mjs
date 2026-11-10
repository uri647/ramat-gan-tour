// Vercel build: copy the static app to dist/ and pre-bake street data for the default cities,
// so the app works on first open without depending on public map servers from the phone.
// Source: OpenStreetMap main API (tiles of the city's bounding box) + Nominatim for the city boundary.
import { cpSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { buildGraph, serializeGraph, HIGHWAY_RE } from '../core.js';

const CITIES = [{ name: 'רמת גן', query: 'Ramat Gan, Israel', file: 'ramat-gan.json' }];
const UA = 'ramat-gan-tour-build/1.0 (https://github.com/uri647/ramat-gan-tour)';

const out = 'dist';
const isMain = process.argv[1] && process.argv[1].endsWith('build.mjs');
if (isMain) {
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '/data', { recursive: true });
for (const f of readdirSync('.')) {
  if (['dist', 'scripts', 'node_modules', '.git', '.vercel', 'vercel.json', 'package.json', 'README.md', '.gitignore'].includes(f)) continue;
  cpSync(f, `${out}/${f}`, { recursive: true });
}
}

async function get(url, timeoutMs = 60000, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
      if (r.status === 400 || r.status === 509) return { status: r.status, text: await r.text() };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { status: 200, text: await r.text() };
    } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    finally { clearTimeout(t); }
  }
  throw last;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
const attr = (s, k) => { const m = s.match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`)); return m ? unxml(m[1]) : null; };

/** Parse OSM XML: collects all nodes (lat/lon) and road ways into the maps. */
export function parseOsm(xml, nodes, ways) {
  for (const m of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const id = +attr(m[1], 'id'), lat = +attr(m[1], 'lat'), lon = +attr(m[1], 'lon');
    if (id && !isNaN(lat)) nodes.set(id, [lat, lon]);
  }
  for (const m of xml.matchAll(/<way\s([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const body = m[2];
    const tags = {};
    for (const t of body.matchAll(/<tag\s([^>]*?)\/>/g)) tags[attr(t[1], 'k')] = attr(t[1], 'v');
    if (!HIGHWAY_RE.test(tags.highway || '')) continue;
    if (/^(no|private)$/.test(tags.access || '') || /^(no|private)$/.test(tags.motor_vehicle || '') || tags.area === 'yes') continue;
    const id = +attr(m[1], 'id');
    if (ways.has(id)) continue;
    ways.set(id, { type: 'way', id, nodes: [...body.matchAll(/<nd\s+ref="(\d+)"/g)].map((x) => +x[1]), tags });
  }
}

function pointInPoly(lat, lon, geo) {
  const polys = geo.type === 'Polygon' ? [geo.coordinates] : geo.type === 'MultiPolygon' ? geo.coordinates : [];
  let inside = false;
  for (const poly of polys) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

async function fetchTile(s, w, n, e, nodes, ways, depth = 0) {
  const r = await get(`https://api.openstreetmap.org/api/0.6/map?bbox=${w.toFixed(5)},${s.toFixed(5)},${e.toFixed(5)},${n.toFixed(5)}`, 90000);
  if (r.status === 400 && depth < 3) { // too many nodes: split in four
    const ml = (s + n) / 2, mo = (w + e) / 2;
    for (const [a, b, c, d] of [[s, w, ml, mo], [s, mo, ml, e], [ml, w, n, mo], [ml, mo, n, e]]) await fetchTile(a, b, c, d, nodes, ways, depth + 1);
    return;
  }
  if (r.status !== 200) throw new Error('tile failed ' + r.status);
  parseOsm(r.text, nodes, ways);
}

export async function buildCity(city) {
  const nom = JSON.parse((await get(`https://nominatim.openstreetmap.org/search?format=json&polygon_geojson=1&limit=5&q=${encodeURIComponent(city.query)}`)).text);
  const place = nom.find((p) => p.geojson && /Polygon/.test(p.geojson.type));
  if (!place) throw new Error('city boundary not found');
  const [bs, bn, bw, be] = place.boundingbox.map(Number);
  const B = 0.006, S0 = bs - B, N0 = bn + B, W0 = bw - B, E0 = be + B, T = 0.012;
  const tiles = [];
  for (let s = S0; s < N0; s += T) for (let w = W0; w < E0; w += T) tiles.push([s, w, Math.min(s + T, N0), Math.min(w + T, E0)]);
  console.log(`  boundary ok, ${tiles.length} tiles`);
  const nodes = new Map(), ways = new Map();
  let done = 0;
  const queue = tiles.slice();
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (queue.length) { const t = queue.shift(); await fetchTile(...t, nodes, ways); done++; if (done % 10 === 0) console.log(`  ${done}/${tiles.length} tiles`); }
  }));
  const req = new Set();
  for (const w of ways.values()) if (w.nodes.some((id) => { const ll = nodes.get(id); return ll && pointInPoly(ll[0], ll[1], place.geojson); })) req.add(w.id);
  const elements = [];
  for (const [id, [lat, lon]] of nodes) elements.push({ type: 'node', id, lat, lon });
  for (const w of ways.values()) elements.push(w);
  const g = buildGraph(elements, req);
  return g;
}

if (isMain) {
const manifest = {};
for (const city of CITIES) {
  try {
    console.log('Fetching', city.name);
    const g = await buildCity(city);
    const data = serializeGraph(g);
    data.city = city.name; data.builtAt = new Date().toISOString();
    writeFileSync(`${out}/data/${city.file}`, JSON.stringify(data));
    manifest[city.name] = city.file;
    console.log(`  ok: ${g.reqEdges.length} street segments, ${(g.totalReqLen / 1000).toFixed(0)} km, ${g.edges.filter((e) => e.unreachable).length} unreachable`);
  } catch (e) {
    console.log('  skipped', city.name, '-', e.message || e, '(the app will download it on the phone instead)');
  }
}
writeFileSync(`${out}/data/cities.json`, JSON.stringify(manifest));
console.log('Build done:', Object.keys(manifest));
}
