// Vercel build: copy the static app to dist/ and pre-bake street data for the default cities,
// so the app works on first open without depending on public Overpass servers from the phone.
import { cpSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { buildGraph, serializeGraph } from '../core.js';

const CITIES = [{ name: 'רמת גן', file: 'ramat-gan.json' }];
const HW = '^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road)$';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out + '/data', { recursive: true });
for (const f of readdirSync('.')) {
  if (['dist', 'scripts', 'node_modules', '.git', '.vercel', 'vercel.json', 'package.json', 'README.md'].includes(f)) continue;
  cpSync(f, `${out}/${f}`, { recursive: true });
}

async function overpass(q, timeoutMs) {
  let last;
  for (const url of ENDPOINTS) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'street-tour-build/1.0' }, signal: c.signal });
      if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; console.log('  overpass failed:', url, e.message || e); }
    finally { clearTimeout(t); }
  }
  throw last;
}

const manifest = {};
for (const city of CITIES) {
  try {
    console.log('Fetching', city.name);
    const q1 = `[out:json][timeout:90];area["boundary"="administrative"]["name"="${city.name}"]->.a;way(area.a)["highway"~"${HW}"]["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]["area"!="yes"];out ids bb;`;
    const r1 = await overpass(q1, 100000);
    const ways = r1.elements.filter((e) => e.type === 'way');
    if (!ways.length) throw new Error('no streets');
    let s = 90, w = 180, n = -90, e = -180;
    for (const x of ways) if (x.bounds) { s = Math.min(s, x.bounds.minlat); w = Math.min(w, x.bounds.minlon); n = Math.max(n, x.bounds.maxlat); e = Math.max(e, x.bounds.maxlon); }
    const B = 0.006;
    const q2 = `[out:json][timeout:150];way(${s - B},${w - B},${n + B},${e + B})["highway"~"${HW}"]["access"!~"^(no|private)$"]["area"!="yes"];(._;>;);out body qt;`;
    const r2 = await overpass(q2, 170000);
    const g = buildGraph(r2.elements, new Set(ways.map((x) => x.id)));
    const data = serializeGraph(g);
    data.city = city.name; data.builtAt = new Date().toISOString();
    writeFileSync(`${out}/data/${city.file}`, JSON.stringify(data));
    manifest[city.name] = city.file;
    console.log(`  ok: ${g.reqEdges.length} street segments, ${(g.totalReqLen / 1000).toFixed(0)} km`);
  } catch (e) {
    console.log('  skipped', city.name, '-', e.message || e, '(the app will download it on the phone instead)');
  }
}
writeFileSync(`${out}/data/cities.json`, JSON.stringify(manifest));
console.log('Build done:', Object.keys(manifest));
