import * as C from './core.js';

// ================= storage =================
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('street-tour', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('kv', mode); const s = t.objectStore('kv'); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', (s) => s.get(k)), set: (k, v) => tx('readwrite', (s) => s.put(v, k)), del: (k) => tx('readwrite', (s) => s.delete(k)) };
})();
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ================= state =================
const $ = (id) => document.getElementById(id);
const settings = Object.assign({ city: 'רמת גן', voice: true, sim: false, simSpeed: 1, headingUp: true }, ls.get('st:settings', {}));
const saveSettings = () => ls.set('st:settings', settings);
const S = {
  g: null, cov: null, matcher: null, progress: null,
  mode: 'idle', // idle | cover | toPoint
  target: null, // {node, lat, lon, label} for toPoint
  steps: [], maneuvers: [], lastEdge: -1, lastReplan: 0,
  watchId: null, wakeLock: null, follow: true, lastFix: null, lastLL: null,
  announced: {}, simTimer: null, projects: [], offGraph: false,
};
window.__S = S; // debug handle
setTimeout(() => { window.__onFix = onFix; }, 0);
const today = () => new Date().toISOString().slice(0, 10);
const progKey = () => 'st:prog:' + settings.city;

function loadProgress() {
  S.progress = Object.assign({ covered: [], skipped: [], pause: null, days: {} }, ls.get(progKey(), {}));
  S.cov = new C.Coverage(S.g);
  S.cov.loadKeys(S.progress.covered);
  const sk = new Set(S.progress.skipped);
  for (const e of S.g.edges) e.skip = sk.has(e.key);
  S.matcher = new C.Matcher(S.g, S.cov);
}
let saveT = null;
function saveProgress(now) {
  clearTimeout(saveT);
  const doSave = () => {
    S.progress.covered = S.cov.keys();
    S.progress.skipped = S.g.edges.filter((e) => e.skip).map((e) => e.key);
    ls.set(progKey(), S.progress);
  };
  if (now) doSave(); else saveT = setTimeout(doSave, 1500);
}
function dayStats() { const d = S.progress.days[today()] || (S.progress.days[today()] = { m: 0, streets: 0, projects: 0 }); return d; }

// ================= data loading =================
const HW = '^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road)$';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(q, status, timeoutMs = 90000) {
  let lastErr;
  for (const url of OVERPASS) {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), timeoutMs);
    try {
      status && status(`מוריד נתונים… (${new URL(url).host})`);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: c.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e.name === 'AbortError' ? new Error('השרת לא ענה בזמן') : e; }
    finally { clearTimeout(t); }
  }
  throw lastErr;
}
// street data baked into the site at build time (no external server needed)
async function prebuiltList() { try { return await (await fetch('data/cities.json', { cache: 'no-cache' })).json(); } catch { return {}; } }
async function loadPrebuilt(city) {
  try {
    const m = await prebuiltList();
    if (!m[city]) return null;
    const d = await (await fetch('data/' + m[city])).json();
    const g = C.deserializeGraph(d);
    await idb.set('graph:' + city, d);
    return g;
  } catch { return null; }
}
async function downloadCity(city, status) {
  const esc = city.replace(/"/g, '\\"');
  const q1 = `[out:json][timeout:120];area["boundary"="administrative"]["name"="${esc}"]->.a;way(area.a)["highway"~"${HW}"]["access"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]["area"!="yes"];out ids bb;`;
  status('מחפש את גבולות העיר…');
  const r1 = await overpass(q1, status, 60000);
  const ways = r1.elements.filter((e) => e.type === 'way');
  if (!ways.length) throw new Error(`לא נמצאה עיר בשם "${city}" במפה`);
  const req = new Set(ways.map((w) => w.id));
  let s = 90, w = 180, n = -90, e = -180;
  for (const x of ways) if (x.bounds) { s = Math.min(s, x.bounds.minlat); w = Math.min(w, x.bounds.minlon); n = Math.max(n, x.bounds.maxlat); e = Math.max(e, x.bounds.maxlon); }
  const B = 0.006;
  status(`נמצאו ${ways.length} רחובות. מוריד את המפה…`);
  const q2 = `[out:json][timeout:180];way(${s - B},${w - B},${n + B},${e + B})["highway"~"${HW}"]["access"!~"^(no|private)$"]["area"!="yes"];(._;>;);out body qt;`;
  const r2 = await overpass(q2, status, 150000);
  status('בונה את רשת הרחובות…');
  await new Promise((r) => setTimeout(r, 30));
  const g = C.buildGraph(r2.elements, req);
  await idb.set('graph:' + city, C.serializeGraph(g));
  return g;
}

// ================= UI helpers =================
function show(id) { for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id); }
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms); }
const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0);
const fmtDist = (m) => m >= 1000 ? `${(m / 1000).toFixed(1)} ק״מ` : `${Math.max(10, Math.round(m / 10) * 10)} מ׳`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function nameOf(e) { return e.name || 'רחוב ללא שם'; }
function pointLabel(p) { return p ? p.label : ''; }

// ================= home =================
function renderHome() {
  const g = S.g, done = S.cov.coveredLen(), total = g.totalReqLen, pct = total ? Math.floor(done / total * 100) : 0;
  $('homeTitle').textContent = 'סיור ' + settings.city;
  $('pctText').textContent = pct + '%';
  $('ringArc').setAttribute('stroke-dasharray', `${(pct / 100 * 314).toFixed(0)} 314`);
  const coveredStreets = g.reqEdges.filter((e) => S.cov.covered[e.id]).length;
  $('doneText').innerHTML = `${km(done)} ק״מ <span class="muted small">· ${coveredStreets} קטעים</span>`;
  const daysWithKm = Object.values(S.progress.days).filter((d) => d.m > 2000);
  const avg = daysWithKm.length ? daysWithKm.reduce((s, d) => s + d.m, 0) / daysWithKm.length : 35000;
  const left = total - done, days = Math.max(1, Math.ceil(left * 1.4 / avg));
  $('leftText').innerHTML = `${km(left)} ק״מ <span class="muted small">· כ־${days} ימים</span>`;
  $('projCount').textContent = `${S.projects.length} פרויקטים`;
  const d = S.progress.days[today()];
  $('todayText').textContent = d && d.m > 0 ? `${km(d.m)} ק״מ · ${d.streets} קטעי רחוב חדשים · ${d.projects} פרויקטים` : 'עוד לא נסעת היום';
  const p = S.progress.pause;
  $('pauseLine').textContent = p ? `עצרת ב${p.label}` : '';
  $('resumeLabel').textContent = p ? 'המשך סיור' : (done > 0 ? 'המשך סיור' : 'התחל סיור');
  $('nearestBtn').classList.toggle('hidden', !p);
}

// ================= map =================
let map, edgeLines = [], planLine, meMarker, projLayer, flagMarker;
const COLORS = { todo: '#A3ADBD', done: '#16A34A', skip: '#F87171', plan: '#2563EB', toPoint: '#7C3AED' };
function initMap() {
  if (map) { setTimeout(() => map.invalidateSize(), 50); return; }
  map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: true, rotate: true, rotateControl: false, touchRotate: false, shiftKeyRotate: false, pitchDrag: false, bearing: 0 });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', className: 'base-tiles', updateWhenIdle: false, updateInterval: 150, keepBuffer: 6 }).addTo(map);
  const renderer = L.canvas({ padding: 0.5 });
  edgeLines = [];
  for (const e of S.g.reqEdges) {
    edgeLines[e.id] = L.polyline(e.ll, { renderer, weight: 5, color: COLORS.todo, opacity: 0.9, interactive: false });
    edgeLines[e.id].addTo(map);
    styleEdge(e.id);
  }
  planLine = L.polyline([], { renderer, weight: 8, color: COLORS.plan, opacity: 0.85, interactive: false }).addTo(map);
  window.__map = map; window.__plan = planLine;
  projLayer = L.layerGroup().addTo(map);
  renderProjMarkers();
  const b = L.latLngBounds(S.g.reqEdges.map((e) => e.ll[0]));
  map.fitBounds(b);
  map.on('dragstart', () => { S.follow = false; });
  setTimeout(() => map.invalidateSize(), 50);
}
function styleEdge(id) {
  const l = edgeLines[id]; if (!l) return;
  const e = S.g.edges[id];
  if (S.cov.covered[id]) l.setStyle({ color: COLORS.done, weight: 5, dashArray: null });
  else if (e.skip) l.setStyle({ color: COLORS.skip, weight: 4, dashArray: '6 6' });
  else l.setStyle({ color: COLORS.todo, weight: 5, dashArray: null });
}
function renderProjMarkers() {
  if (!projLayer) return;
  projLayer.clearLayers();
  for (const p of S.projects) L.circleMarker([p.lat, p.lon], { radius: 9, color: '#fff', weight: 3, fillColor: '#F59E0B', fillOpacity: 1 }).addTo(projLayer);
}
function setFlag(p) {
  if (flagMarker) { flagMarker.remove(); flagMarker = null; }
  if (!p || !map) return;
  flagMarker = L.marker([p.lat, p.lon], { icon: L.divIcon({ className: '', iconSize: [26, 40], iconAnchor: [2, 38], html: '<svg width="26" height="40" viewBox="0 0 26 40"><line x1="2" y1="2" x2="2" y2="38" stroke="#0F172A" stroke-width="3" stroke-linecap="round"/><path d="M3 3 L24 10 L3 17 Z" fill="#DC2626"/></svg>' }), interactive: false }).addTo(map);
}
// ================= smooth driving view (Waze-like) =================
// GPS gives one position per second; we glide the marker between fixes on the road,
// ease the map rotation, and move the map with cheap CSS transforms every frame.
const A = { from: null, to: null, t0: 0, dur: 1000, disp: null, hdg: null, tgtHdg: null, lastFixT: 0, raf: 0, last: 0, dirty: false, lastEnd: 0, visC: null, visT: 0, el: null };
function setTarget(x, y, hdgDeg) {
  const now = performance.now();
  const dur = A.lastFixT ? Math.max(250, Math.min(1600, now - A.lastFixT)) : 0;
  A.lastFixT = now;
  if (!A.disp || Math.hypot(x - A.disp[0], y - A.disp[1]) > 150) { A.disp = [x, y]; A.from = [x, y]; A.jump = true; }
  else A.from = A.disp.slice();
  A.to = [x, y]; A.t0 = now; A.dur = dur || 1;
  if (hdgDeg != null && !isNaN(hdgDeg)) A.tgtHdg = hdgDeg;
  if (!A.raf) { A.last = now; A.raf = requestAnimationFrame(frame); }
}
function stopAnim() { if (A.raf) cancelAnimationFrame(A.raf); A.raf = 0; A.disp = null; A.lastFixT = 0; A.hdg = null; A.tgtHdg = null; }
function frame(now) {
  A.raf = requestAnimationFrame(frame);
  if (!map || !A.to) return;
  const dt = Math.min(100, now - A.last); A.last = now;
  const g = S.g;
  // position: linear glide from the previous displayed point to the new fix
  const t = Math.min(1, (now - A.t0) / A.dur);
  A.disp = [A.from[0] + (A.to[0] - A.from[0]) * t, A.from[1] + (A.to[1] - A.from[1]) * t];
  // heading: exponential ease along the shortest arc
  if (A.tgtHdg != null) {
    if (A.hdg == null) A.hdg = A.tgtHdg;
    const d = ((A.tgtHdg - A.hdg + 540) % 360) - 180;
    A.hdg = (A.hdg + d * (1 - Math.exp(-dt / 220)) + 360) % 360;
  }
  const ll = g.proj.toLL(A.disp[0], A.disp[1]);
  // rotation
  if (settings.headingUp && S.follow && A.hdg != null) {
    const want = (360 - A.hdg) % 360, cur = map.getBearing();
    if (Math.abs(((want - cur + 540) % 360) - 180) > 0.05) map.setBearing(want);
  } else if (!settings.headingUp && map.getBearing() !== 0) map.setBearing(0);
  // marker
  if (!meMarker) {
    const html = '<div class="me-marker"><div class="halo"></div><div class="arrow"></div><div class="dot"></div></div>';
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    A.el = null;
  } else meMarker.setLatLng(ll);
  if (!A.el) A.el = meMarker.getElement() && meMarker.getElement().querySelector('.me-marker');
  if (A.el) {
    A.el.style.transform = `rotate(${((A.hdg ?? 0) + map.getBearing()) % 360}deg)`;
    A.el.classList.toggle('nohdg', A.hdg == null);
  }
  // camera follow: keep the driver at a fixed screen point (lower part when heading-up)
  if (S.follow) {
    const size = map.getSize();
    const panelTop = (document.querySelector('.nav-panel')?.getBoundingClientRect().top) || size.y;
    const want = L.point(size.x / 2, settings.headingUp ? panelTop * 0.74 : panelTop * 0.5);
    if (A.jump || map.getZoom() < 15) { map.setView(ll, Math.max(map.getZoom(), 17), { animate: false }); A.jump = false; }
    const cp = map.latLngToContainerPoint(ll), off = cp.subtract(want);
    if (Math.abs(off.x) > 400 || Math.abs(off.y) > 400) map.setView(ll, map.getZoom(), { animate: false });
    else if (Math.abs(off.x) > 0.15 || Math.abs(off.y) > 0.15) { map._rawPanBy(off); map.fire('move'); A.dirty = true; }
  }
  // let tiles / street lines refresh a few times per second, not every frame
  if (A.dirty && now - A.lastEnd > 450) { A.dirty = false; A.lastEnd = now; map.fire('moveend'); }
  // only draw streets near the driver (keeps redraws cheap on the phone)
  if (!A.visC || now - A.visT > 4000 || Math.hypot(A.disp[0] - A.visC[0], A.disp[1] - A.visC[1]) > 250) refreshVisibleEdges();
}
function refreshVisibleEdges() {
  A.visC = A.disp.slice(); A.visT = performance.now();
  const R = 1600;
  for (const e of S.g.reqEdges) {
    const l = edgeLines[e.id]; if (!l) continue;
    const p = e.pts[0], q = e.pts[e.pts.length - 1];
    const near = Math.min(Math.hypot(p[0] - A.visC[0], p[1] - A.visC[1]), Math.hypot(q[0] - A.visC[0], q[1] - A.visC[1])) < R;
    if (near && !map.hasLayer(l)) l.addTo(map); else if (!near && map.hasLayer(l)) l.remove();
  }
}
// heading for the driver: road direction when on a street, else GPS / movement
function driveHeading(m, fallback) {
  if (m && m.segDir != null && m.fwd != null) {
    let h = 90 - m.segDir * 180 / Math.PI; if (!m.fwd) h += 180;
    return (h % 360 + 360) % 360;
  }
  return fallback;
}
function updateMe(lat, lon, headingDeg) { // compatibility: place marker at a raw position
  const [x, y] = S.g.proj.toXY(lat, lon); setTarget(x, y, headingDeg);
}

function renderOrient() {
  $('orientBtn').classList.toggle('on', !!settings.headingUp);
  $('orientIcon').innerHTML = settings.headingUp
    ? '<path d="M12 3l6 16-6-4-6 4z" fill="#2563EB" stroke="#2563EB"/>'
    : '<path d="M12 3l5 9h-10z" fill="#DC2626" stroke="#DC2626"/><path d="M7 12h10l-5 9z" fill="none"/><text x="12" y="23" font-size="0"></text>';
}

// ================= voice =================
let heVoice = null;
function pickVoice() { const vs = speechSynthesis.getVoices(); heVoice = vs.find((v) => /^he|^iw/i.test(v.lang)) || null; }
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!settings.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'he-IL'; if (heVoice) u.voice = heVoice; u.rate = 1.05; speechSynthesis.speak(u); } catch {}
}
function unlockVoice() { if ('speechSynthesis' in window) { try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch {} } }

// ================= navigation =================
async function startNav(mode) {
  show('nav'); initMap(); unlockVoice();
  S.mode = mode; S.steps = []; S.maneuvers = []; S.lastEdge = -1; S.announced = {}; S.follow = true;
  S.matcher = new C.Matcher(S.g, S.cov);
  if (mode === 'toPoint' && S.progress.pause) {
    const p = S.progress.pause;
    const node = S.g.nodes.findIndex((n) => n.osm === p.nodeOsm);
    S.target = node >= 0 ? { node, lat: p.lat, lon: p.lon, label: p.label } : null;
    if (!S.target) S.mode = 'cover';
  } else S.target = null;
  setFlag(S.mode === 'toPoint' ? S.target : null);
  $('legendPlan').style.background = S.mode === 'toPoint' ? COLORS.toPoint : COLORS.plan;
  setBanner('gray', '', S.mode === 'toPoint' ? 'מחפש מיקום… אחר כך ננווט לנקודת ההמשך' : 'מחפש מיקום GPS…');
  renderNavStats();
  requestWake();
  if (settings.sim) startSim(); else startGps();
}
function stopNav() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  if (S.simTimer) { clearInterval(S.simTimer); S.simTimer = null; }
  releaseWake();
  stopAnim();
  S.mode = 'idle';
  try { speechSynthesis.cancel(); } catch {}
}
function startGps() {
  if (!('geolocation' in navigator)) { setBanner('gray', '', 'אין גישה ל-GPS במכשיר הזה'); return; }
  S.watchId = navigator.geolocation.watchPosition((pos) => {
    const c = pos.coords;
    onFix(c.latitude, c.longitude, c.accuracy, (c.heading != null && !isNaN(c.heading) && c.heading >= 0 && (c.speed || 0) > 1.5) ? c.heading : null, c.speed || 0);
  }, (err) => {
    setBanner('gray', '', err.code === 1 ? 'צריך לאשר גישה למיקום בהגדרות הטלפון' : 'אין קליטת GPS כרגע…');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

function onFix(lat, lon, acc, headingDeg, speed) {
  const g = S.g;
  const [x, y] = g.proj.toXY(lat, lon);
  const prev = S.lastFix;
  if (acc > 60) { updateMe(lat, lon, headingDeg); setBanner('gray', '', 'קליטת GPS חלשה…'); return; }
  const heading = headingDeg != null ? (90 - headingDeg) * Math.PI / 180 : null;
  const prevMatch = S.matcher.last ? { ...S.matcher.last } : null;
  const gapSec = prev ? (Date.now() - prev.t) / 1000 : 0;
  const r = S.matcher.update({ x, y, acc, heading, speed });
  if (prevMatch && r.match && gapSec > 6) fillGap(prevMatch, r.match, gapSec, r);
  S.lastFix = { x, y, t: Date.now() }; S.lastLL = [lat, lon];
  let hdg = headingDeg;
  if (hdg == null && prev && Math.hypot(x - prev.x, y - prev.y) > 4) hdg = 90 - Math.atan2(y - prev.y, x - prev.x) * 180 / Math.PI;
  const mm = r.match;
  if (mm && mm.d < 25) setTarget(mm.qx, mm.qy, driveHeading(mm, hdg)); // glued to the road
  else setTarget(x, y, hdg);

  if (prev && r.match) {
    const d = Math.hypot(x - prev.x, y - prev.y);
    if (d < 80 * (settings.sim ? (settings.simSpeed || 1) : 1)) dayStats().m += d;
  }
  if (r.newly.length) {
    for (const id of r.newly) { styleEdge(id); if (S.g.edges[id].req) dayStats().streets++; }
    saveProgress(); renderNavStats();
  }

  if (!r.match) {
    S.offGraph = true;
    const tgt = offGraphTarget();
    setBanner('gray', '', tgt ? `אתה מחוץ לאזור הסיור. סע ל${tgt.label}` : 'אתה מחוץ לאזור הסיור');
    showWaze(tgt);
    planLine.setLatLngs([]);
    $('thenChip').classList.add('hidden');
    return;
  }
  if (S.offGraph) { S.offGraph = false; showWaze(null); S.lastEdge = -1; }

  if (S.mode === 'toPoint' && S.target) {
    const [tx, ty] = g.proj.toXY(S.target.lat, S.target.lon);
    if (Math.hypot(x - tx, y - ty) < 35) {
      S.mode = 'cover'; S.target = null; setFlag(null);
      $('legendPlan').style.background = COLORS.plan;
      say('הגעת לנקודת ההמשך. ממשיכים בסיור'); toast('הגעת לנקודת ההמשך. ממשיכים בסיור');
      S.lastEdge = -1;
    }
  }
  const now = Date.now();
  if (r.match.e !== S.lastEdge || r.newly.length || now - S.lastReplan > 12000 || !S.steps.length) {
    S.lastEdge = r.match.e; replan();
  }
  updateInstruction();
}

// The phone does not give a web app GPS while it is in the background. When we come back
// after a gap, infer the streets driven in between: the shortest legal route from the last
// known point to the current one, if it is plausible for the time that passed.
function fillGap(a, b, gapSec, r) {
  const g = S.g;
  if (a.e === b.e) { if (S.cov.markRange(b.e, a.pos, b.pos)) r.newly.push(b.e); for (const t of S.cov.takeTwinNewly()) r.newly.push(t); return; }
  const ea = g.edges[a.e], eb = g.edges[b.e];
  const [ax, ay] = C.pointOnEdge(g, ea, a.pos), [bx, by] = C.pointOnEdge(g, eb, b.pos);
  const straight = Math.hypot(bx - ax, by - ay);
  if (straight < 40 || gapSec > 20 * 60) return;
  const src = C.sourcesFromMatch(g, a);
  let best = null;
  for (const [node, entryPos, fwd] of [[eb.a, 0, true], [eb.b, eb.len, false]]) {
    if ((fwd && eb.dir < 0) || (!fwd && eb.dir > 0)) continue;
    for (const s0 of src) {
      const p = C.routeToNode(g, [s0], node); if (!p) continue;
      const L = s0.dist + C.pathLength(g, p, 0, p.length) + Math.abs(b.pos - entryPos);
      if (!best || L < best.L) best = { p, L, s0, entryPos };
    }
  }
  if (!best) return;
  // plausibility: not longer than driving at ~90 km/h for the gap, and not a huge detour
  if (best.L > Math.max(400, gapSec * 25) || best.L > straight * 2.2 + 600) return;
  let added = 0;
  const mark = (id, p0, p1) => { if (!S.cov.covered[id]) { if (p0 == null) S.cov.setCovered(id); else S.cov.markRange(id, p0, p1); if (S.cov.covered[id]) { r.newly.push(id); if (g.edges[id].req) added++; } } };
  mark(a.e, a.pos, best.s0.cur.fwd ? ea.len : 0);
  for (const st of best.p) mark(st.e, null);
  mark(b.e, best.entryPos, b.pos);
  dayStats().m += best.L;
  for (const t of S.cov.takeTwinNewly()) r.newly.push(t);
  if (added) toast(`סימנתי ${added} קטעי רחוב שעברת כשהאפליקציה הייתה ברקע`, 3500);
}

function offGraphTarget() {
  if (S.mode === 'toPoint' && S.target) return S.target;
  // nearest uncovered street (straight-line) to the current position
  if (!S.lastFix) return null;
  let best = null, bd = Infinity;
  for (const e of S.cov.remaining()) {
    const mid = e.pts[Math.floor(e.pts.length / 2)];
    const d = Math.hypot(mid[0] - S.lastFix.x, mid[1] - S.lastFix.y);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return null;
  const ll = best.ll[Math.floor(best.ll.length / 2)];
  return { lat: ll[0], lon: ll[1], label: nameOf(best) };
}
function showWaze(t) {
  const b = $('wazeBtn');
  if (!t) { b.classList.add('hidden'); return; }
  b.href = `https://waze.com/ul?ll=${t.lat.toFixed(6)},${t.lon.toFixed(6)}&navigate=yes`;
  b.classList.remove('hidden');
}

function replan() {
  const g = S.g, m = S.matcher.last; if (!m) return;
  S.lastReplan = Date.now();
  const src = C.sourcesFromMatch(g, m);
  if (!src.length) return;
  let rest = [];
  let cur = src[0].cur;
  if (S.mode === 'toPoint' && S.target) {
    // pick the source that gives the shortest route
    let best = null;
    for (const s of src) { const p = C.routeToNode(g, [s], S.target.node); if (p) { const L = C.pathLength(g, p, 0, p.length) + s.dist; if (!best || L < best.L) best = { p, L, s }; } }
    if (best) { rest = best.p; cur = best.s.cur; }
    else { S.mode = 'cover'; S.target = null; setFlag(null); }
  }
  if (S.mode === 'cover') {
    let best = null;
    for (const s of src) {
      const p = C.planAhead(g, S.cov, [s], 2500);
      // score: distance until first new coverage
      let toFirst = s.dist; for (const st of p) { if (st.target) break; toFirst += g.edges[st.e].len; }
      const curUncovered = !S.cov.covered[s.cur.e] && g.edges[s.cur.e].req && !g.edges[s.cur.e].skip;
      if (curUncovered) toFirst = 0;
      if (!best || toFirst < best.toFirst - 1) best = { p, s, toFirst };
    }
    if (best) { rest = best.p; cur = best.s.cur; }
  }
  S.steps = [cur, ...rest];
  S.curPos = m.pos;
  S.maneuvers = C.buildManeuvers(g, S.steps);
  planLine.setStyle({ color: S.mode === 'toPoint' ? COLORS.toPoint : COLORS.plan });
  planLine.setLatLngs(C.stepsToLatLngs(g, S.steps, m.pos));
}

function remainingOnCur() {
  const g = S.g, m = S.matcher.last, c = S.steps[0]; if (!m || !c) return 0;
  const e = g.edges[c.e]; return c.fwd ? e.len - m.pos : m.pos;
}
const ICONS = {
  right: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20V11a3 3 0 0 1 3-3h7"/><path d="M15 4l4 4-4 4"/></svg>',
  left: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20V11a3 3 0 0 0-3-3H6"/><path d="M9 4L5 8l4 4"/></svg>',
  straight: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V5"/><path d="M7 10l5-5 5 5"/></svg>',
  uturn: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20V9a4 4 0 0 1 8 0v4"/><path d="M12 10l4 4 4-4"/></svg>',
  roundabout: '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="11" r="4"/><path d="M12 21v-6M16 8l3-3M16 5h3v3"/></svg>',
};
function setBanner(color, distText, text, icon) {
  const b = $('banner'); b.className = 'banner' + (color && color !== 'blue' ? ' ' + color : '');
  $('bannerDist').textContent = distText || '';
  $('bannerText').textContent = text;
  $('bannerIcon').innerHTML = icon ? ICONS[icon] || '' : '';
}
function updateInstruction() {
  const g = S.g;
  const color = S.mode === 'toPoint' ? 'purple' : 'blue';
  if (S.mode === 'cover' && S.steps.length <= 1 && S.cov.remaining().length === 0) {
    setBanner('green', '', 'כל הכבוד! עברת בכל רחובות העיר'); $('thenChip').classList.add('hidden'); return;
  }
  const base = remainingOnCur();
  const man = S.maneuvers[0];
  if (!man) {
    const L = base + C.pathLength(g, S.steps, 1, S.steps.length);
    const e = g.edges[S.steps[0]?.e];
    setBanner(color, fmtDist(L), S.mode === 'toPoint' ? 'המשך ישר לנקודת ההמשך' : `המשך ישר${e && e.name ? ' ב' + e.name : ''}`, 'straight');
    $('thenChip').classList.add('hidden');
    return;
  }
  const dist = base + C.pathLength(g, S.steps, 1, man.stepIndex);
  setBanner(color, fmtDist(dist), man.text, man.icon);
  const next = S.maneuvers[1];
  const chip = $('thenChip');
  if (next && C.pathLength(g, S.steps, man.stepIndex, next.stepIndex) < 400) { chip.textContent = 'אחר כך: ' + next.text; chip.classList.remove('hidden'); }
  else if (S.mode === 'toPoint') { chip.textContent = `בדרך לנקודת ההמשך · ${fmtDist(base + C.pathLength(g, S.steps, 1, S.steps.length))}`; chip.classList.remove('hidden'); }
  else chip.classList.add('hidden');
  // voice
  const key = (g.edges[S.steps[man.stepIndex].e].key) + man.text;
  const a = S.announced[key] || (S.announced[key] = {});
  if (dist <= 250 && dist > 90 && !a.far) { a.far = true; say(`בעוד ${Math.round(dist / 50) * 50} מטר, ${man.text}`); }
  else if (dist <= 45 && !a.near) { a.near = a.far = true; say(man.text); }
}

function renderNavStats() {
  const d = dayStats(), pct = Math.floor(S.cov.coveredLen() / S.g.totalReqLen * 1000) / 10;
  $('navToday').textContent = `${km(d.m)} ק״מ · ${d.streets} רחובות`;
  $('navPct').textContent = pct.toFixed(pct < 10 ? 1 : 0) + '%';
  $('navBar').style.width = pct + '%';
}

// skip the next street (blocked / not passable)
function skipNext() {
  const g = S.g;
  const st = S.steps.find((s, i) => i > 0 && g.edges[s.e].req && !S.cov.covered[s.e] && !g.edges[s.e].skip) || (S.steps[0] && !S.cov.covered[S.steps[0].e] ? S.steps[0] : null);
  if (!st) { toast('אין רחוב לדלג עליו'); return; }
  const e = g.edges[st.e];
  e.skip = true; styleEdge(e.id); saveProgress();
  toast(`דילגתי על ${nameOf(e)}`); replan(); updateInstruction();
}

// pause
function pauseHere() {
  const g = S.g, m = S.matcher.last;
  if (m) {
    const e = g.edges[m.e];
    const nodeIdx = (m.pos < e.len / 2) ? e.a : e.b;
    const n = g.nodes[nodeIdx];
    // label: this street + a crossing street name at that node
    const cross = g.out[nodeIdx].map((a) => g.edges[a.e].name).find((nm) => nm && nm !== e.name);
    const label = (e.name || 'רחוב ללא שם') + (cross ? ` פינת ${cross}` : '');
    S.progress.pause = { lat: n.lat, lon: n.lon, nodeOsm: n.osm, label };
  } else if (S.lastLL && S.progress.pause == null) {
    // not on the street grid: keep no pause point
  }
  saveProgress(true);
  stopNav();
  const d = dayStats();
  $('psKm').textContent = km(d.m); $('psStreets').textContent = d.streets; $('psProj').textContent = d.projects;
  $('psPoint').textContent = S.progress.pause ? S.progress.pause.label : '—';
  const pct = Math.floor(S.cov.coveredLen() / S.g.totalReqLen * 100);
  $('psTotal').textContent = `כל העיר: ${pct}%`;
  setFlag(S.progress.pause);
  $('pauseSheet').classList.remove('hidden');
}

// wake lock
async function requestWake() { try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
function releaseWake() { try { S.wakeLock && S.wakeLock.release(); } catch {} S.wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.mode !== 'idle') { requestWake(); A.jump = true; S.lastEdge = -1; } });

// ================= simulation =================
function startSim() {
  const g = S.g;
  let ll;
  if (S.progress.pause && S.mode === 'toPoint') {
    // start ~600m away from the pause point to demo the "drive to resume point" flow
    const far = g.reqEdges.find((e) => { const [x, y] = e.pts[0]; const [px, py] = g.proj.toXY(S.progress.pause.lat, S.progress.pause.lon); const d = Math.hypot(x - px, y - py); return d > 500 && d < 900; });
    ll = far ? far.ll[0] : g.reqEdges[0].ll[0];
  } else ll = S.lastLL || g.reqEdges[Math.floor(g.reqEdges.length / 2)].ll[0];
  let cur = g.proj.toXY(ll[0], ll[1]);
  toast('מצב ניסיון: נסיעה מדומה');
  const tick = () => {
    const step = 9 * (settings.simSpeed || 1);
    // move along the current planned line
    const line = planLine && planLine.getLatLngs();
    if (line && line.length > 1 && S.matcher.last) {
      let remain = step; const pts = line.map((p) => g.proj.toXY(p.lat, p.lng));
      // start from the closest point on the line to where we are now
      let bi = 1, bd = Infinity, p = pts[0];
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i]; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const t = L2 ? Math.max(0, Math.min(1, ((cur[0] - ax) * dx + (cur[1] - ay) * dy) / L2)) : 0;
        const q = [ax + t * dx, ay + t * dy], d = Math.hypot(q[0] - cur[0], q[1] - cur[1]);
        if (d < bd - 0.01) { bd = d; bi = i; p = q; }
        if (i > 40) break;
      }
      for (let i = bi; i < pts.length && remain > 0; i++) {
        const d = Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]);
        if (d >= remain) { const t = remain / d; p = [p[0] + t * (pts[i][0] - p[0]), p[1] + t * (pts[i][1] - p[1])]; remain = 0; }
        else { remain -= d; p = pts[i]; }
      }
      cur = p;
    }
    const [la, lo] = g.proj.toLL(cur[0] + (Math.random() - 0.5) * 3, cur[1] + (Math.random() - 0.5) * 3);
    onFix(la, lo, 6, null, step);
  };
  tick();
  S.simTimer = setInterval(tick, 1000);
}

// ================= projects =================
const STAGES = ['חפירה', 'שלד', 'גמר', 'הריסה', 'עגורן', 'אחר'];
const ROLES = ['יזם', 'קבלן', 'מנהל עבודה', 'אדריכל', 'אחר'];
let draft = null;
async function loadProjects() { S.projects = (await idb.get('projects')) || []; }
async function saveProjects() { await idb.set('projects', S.projects); }

function openProject() {
  const g = S.g, m = S.matcher && S.matcher.last;
  const ll = S.lastLL || (map ? [map.getCenter().lat, map.getCenter().lng] : [g.nodes[0].lat, g.nodes[0].lon]);
  const street = m ? g.edges[m.e].name : '';
  draft = { id: Date.now(), lat: ll[0], lon: ll[1], street, address: street ? `${street}, ${settings.city}` : settings.city, created: new Date().toISOString(), stage: '', contacts: [{ role: 'קבלן', name: '', phone: '' }], note: '', photos: [] };
  $('pjAddress').value = draft.address; $('pjNote').value = '';
  renderDraft();
  $('projectSheet').classList.remove('hidden');
  // better address (house number) from OpenStreetMap, if online
  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${ll[0]}&lon=${ll[1]}&accept-language=he&zoom=18`).then((r) => r.json()).then((j) => {
    const a = j.address || {}; const road = a.road || street; const num = a.house_number ? ' ' + a.house_number : '';
    if (road && draft && $('pjAddress').value === draft.address) { draft.address = `${road}${num}, ${a.city || a.town || settings.city}`; $('pjAddress').value = draft.address; }
  }).catch(() => {});
}
function renderDraft() {
  $('pjStages').innerHTML = STAGES.map((s) => `<button type="button" class="chip ${draft.stage === s ? 'on' : ''}" data-stage="${s}">${s}</button>`).join('');
  $('pjContacts').innerHTML = draft.contacts.map((c, i) => `
    <div class="contact" data-i="${i}">
      <div class="row gap8 wrap">${ROLES.map((r) => `<button type="button" class="chip role ${c.role === r ? 'on' : ''}" data-role="${r}">${r}</button>`).join('')}</div>
      <input type="text" placeholder="שם" value="${esc(c.name)}" data-f="name" autocomplete="off">
      <input type="tel" placeholder="טלפון" value="${esc(c.phone)}" data-f="phone" inputmode="tel" autocomplete="off">
    </div>`).join('');
  const box = $('pjPhotos'); box.querySelectorAll('img').forEach((n) => n.remove());
  draft.photos.forEach((p, k) => { const img = document.createElement('img'); img.className = 'thumb'; img.src = p; img.alt = 'תמונה של הפרויקט'; img.addEventListener('click', () => openViewer(draft.photos, k)); box.appendChild(img); });
}
$('pjStages').addEventListener('click', (ev) => { const b = ev.target.closest('[data-stage]'); if (!b) return; draft.stage = draft.stage === b.dataset.stage ? '' : b.dataset.stage; renderDraft(); });
$('pjContacts').addEventListener('click', (ev) => { const b = ev.target.closest('[data-role]'); if (!b) return; const i = +b.closest('.contact').dataset.i; draft.contacts[i].role = b.dataset.role; renderDraft(); });
$('pjContacts').addEventListener('input', (ev) => { const f = ev.target.dataset.f; if (!f) return; const i = +ev.target.closest('.contact').dataset.i; draft.contacts[i][f] = ev.target.value; });
$('pjAddContact').addEventListener('click', () => { draft.contacts.push({ role: 'יזם', name: '', phone: '' }); renderDraft(); });
$('pjPhotoInput').addEventListener('change', async (ev) => {
  const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try { draft.photos.push(await shrinkImage(f, 1280)); renderDraft(); } catch { toast('לא הצלחתי לטעון את התמונה'); }
});
function shrinkImage(file, max) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.72)); };
    img.onerror = rej; img.src = url;
  });
}
function vcardFor(p, contacts) {
  const clean = (v) => String(v || '').replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1');
  return contacts.map((c) => {
    const name = (c.name || '').trim() || `${c.role || ''} ${p.street || ''}`.trim() || 'איש קשר';
    const phone = (c.phone || '').replace(/[^\d+]/g, '');
    return ['BEGIN:VCARD', 'VERSION:3.0', `N:;${clean(name)};;;`, `FN:${clean(name)}`, phone ? `TEL;TYPE=CELL:${phone}` : '', 'END:VCARD'].filter(Boolean).join('\r\n');
  }).join('\r\n');
}
function openVcard(p, contacts) {
  const list = contacts.filter((c) => c.name || c.phone); if (!list.length) return false;
  const blob = new Blob([vcardFor(p, list)], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `${(list[0].name || 'contact').replace(/[^\p{L}\p{N} _-]/gu, '')}.vcf`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
function closeProject() { $('projectSheet').classList.add('hidden'); draft = null; }
$('projectSheet').addEventListener('click', (ev) => { if (ev.target.id === 'projectSheet' && S.editIndex != null) { S.editIndex = null; closeProject(); } });
async function saveDraft(withContacts) {
  const p = { ...draft, address: $('pjAddress').value, note: $('pjNote').value, contacts: draft.contacts.filter((c) => c.name || c.phone) };
  if (withContacts && $('pjSaveContacts').checked) openVcard(p, p.contacts); // must run inside the tap
  const editing = S.editIndex != null;
  if (editing) { S.projects[S.editIndex] = p; S.editIndex = null; }
  else { S.projects.unshift(p); dayStats().projects++; saveProgress(); }
  closeProject();
  await saveProjects(); renderProjMarkers();
  if (editing) { renderProjects(); toast('עודכן'); }
  else toast(withContacts ? 'הפרויקט נשמר' : 'הנקודה נשמרה. אפשר להשלים פרטים ברשימת הפרויקטים');
}
$('pjLater').addEventListener('click', () => saveDraft(false));
$('pjSave').addEventListener('click', () => saveDraft(true));

function renderProjects() {
  const list = $('projList');
  if (!S.projects.length) { list.innerHTML = '<div class="card muted center">עוד אין פרויקטים. בזמן הסיור לחץ "מצאתי פרויקט".</div>'; return; }
  list.innerHTML = S.projects.map((p, i) => `
    <div class="proj" data-i="${i}">
      <div class="proj-top">
        ${p.photos && p.photos.length === 1 ? `<img src="${p.photos[0]}" alt="תמונת הפרויקט" data-photo="0">` : ''}
        <div class="col gap4 grow">
          <b>${esc(p.address)}</b>
          <div class="row gap8 center-y">${p.stage ? `<span class="stage-tag">${esc(p.stage)}</span>` : ''}<span class="muted small">${new Date(p.created).toLocaleDateString('he-IL')}</span></div>
          ${p.note ? `<div class="muted small">${esc(p.note)}</div>` : ''}
        </div>
      </div>
      ${p.photos && p.photos.length > 1 ? `<div class="photo-strip">${p.photos.map((ph, k) => `<img src="${ph}" alt="תמונה ${k + 1}" data-photo="${k}">`).join('')}</div>` : ''}
      ${(p.contacts || []).map((c, ci) => `<div class="contact-line"><span>${esc(c.role)} · ${esc(c.name || '')}</span><span class="row gap8 center-y">${c.phone ? `<a href="tel:${esc(c.phone.replace(/[^\d+]/g, ''))}">${esc(c.phone)}</a>` : ''}<button type="button" class="mini-btn" data-act="vcf1" data-ci="${ci}">שמור</button></span></div>`).join('')}
      <div class="proj-actions">
        <a href="https://waze.com/ul?ll=${p.lat},${p.lon}&navigate=yes" target="_blank" rel="noopener">Waze</a>
        <button type="button" data-act="edit">עריכה</button>
        <button type="button" class="del" data-act="del">מחק</button>
      </div>
    </div>`).join('');
}
$('projList').addEventListener('click', async (ev) => {
  const ph = ev.target.closest('[data-photo]');
  if (ph) { const p0 = S.projects[+ph.closest('.proj').dataset.i]; openViewer(p0.photos, +ph.dataset.photo); return; }
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const i = +b.closest('.proj').dataset.i, p = S.projects[i];
  if (b.dataset.act === 'vcf1') { openVcard(p, [p.contacts[+b.dataset.ci]]); return; }
  if (b.dataset.act === 'vcf') openVcard(p, p.contacts);
  if (b.dataset.act === 'del') {
    if (b.dataset.armed) { S.projects.splice(i, 1); await saveProjects(); renderProjects(); renderProjMarkers(); }
    else { b.dataset.armed = '1'; b.textContent = 'בטוח? לחץ שוב'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'מחק'; } }, 3000); }
  }
  if (b.dataset.act === 'edit') {
    draft = JSON.parse(JSON.stringify(p)); if (!draft.contacts.length) draft.contacts.push({ role: 'קבלן', name: '', phone: '' });
    $('pjAddress').value = draft.address; $('pjNote').value = draft.note || ''; renderDraft();
    $('projectSheet').classList.remove('hidden');
    S.editIndex = i;
  }
});
$('projExport').addEventListener('click', async () => {
  const rows = [['כתובת', 'שלב', 'תאריך', 'תפקיד', 'שם', 'טלפון', 'הערה', 'קו רוחב', 'קו אורך']];
  for (const p of S.projects) {
    const cs = p.contacts && p.contacts.length ? p.contacts : [{}];
    for (const c of cs) rows.push([p.address, p.stage, new Date(p.created).toLocaleDateString('he-IL'), c.role || '', c.name || '', c.phone || '', p.note || '', p.lat, p.lon]);
  }
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const file = new File([csv], 'projects.csv', { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'פרויקטים' }); return; } catch {} }
  const url = URL.createObjectURL(file); const a = document.createElement('a'); a.href = url; a.download = 'projects.csv'; document.body.appendChild(a); a.click(); a.remove();
});

// ================= photo viewer =================
const V = { photos: [], i: 0, zoom: false, sx: 0 };
function openViewer(photos, i) {
  if (!photos || !photos.length) return;
  V.photos = photos; V.i = i || 0; V.zoom = false; renderViewer();
  $('viewer').classList.remove('hidden');
}
function renderViewer() {
  const img = $('viewerImg'); img.src = V.photos[V.i];
  img.classList.toggle('zoomed', V.zoom);
  $('viewerCount').textContent = V.photos.length > 1 ? `${V.i + 1} / ${V.photos.length}` : '';
  $('viewerPrev').classList.toggle('hidden', V.photos.length < 2); $('viewerNext').classList.toggle('hidden', V.photos.length < 2);
  const box = $('viewerBox'); box.scrollLeft = 0; box.scrollTop = 0;
}
function viewerStep(d) { V.i = (V.i + d + V.photos.length) % V.photos.length; V.zoom = false; renderViewer(); }
$('viewerClose').addEventListener('click', () => $('viewer').classList.add('hidden'));
$('viewerPrev').addEventListener('click', () => viewerStep(-1));
$('viewerNext').addEventListener('click', () => viewerStep(1));
let lastTap = 0;
$('viewerImg').addEventListener('click', (ev) => {
  const now = Date.now();
  if (now - lastTap < 320) { // double tap: zoom in around the tapped point / zoom out
    const box = $('viewerBox'), img = $('viewerImg');
    const r = img.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    V.zoom = !V.zoom; img.classList.toggle('zoomed', V.zoom);
    if (V.zoom) requestAnimationFrame(() => { box.scrollLeft = img.scrollWidth * fx - box.clientWidth / 2; box.scrollTop = img.scrollHeight * fy - box.clientHeight / 2; });
  }
  lastTap = now;
});
$('viewerBox').addEventListener('touchstart', (ev) => { V.sx = ev.touches[0].clientX; }, { passive: true });
$('viewerBox').addEventListener('touchend', (ev) => {
  if (V.zoom || V.photos.length < 2) return;
  const dx = ev.changedTouches[0].clientX - V.sx;
  if (Math.abs(dx) > 60) viewerStep(dx < 0 ? 1 : -1);
}, { passive: true });

// ================= areas =================
async function openArea(city) {
  settings.city = city; saveSettings();
  if (map) { map.remove(); map = null; meMarker = null; flagMarker = null; }
  let g = null;
  try { const d = await idb.get('graph:' + city); if (d) g = C.deserializeGraph(d); } catch {}
  if (!g) g = await loadPrebuilt(city);
  if (!g) return false;
  S.g = g; loadProgress(); await loadProjects(); renderHome(); show('home');
  return true;
}
async function showSetup() {
  const m = await prebuiltList();
  $('areaList').innerHTML = Object.keys(m).map((c) => `<button type="button" class="btn primary big" data-area="${esc(c)}">${esc(c)}</button>`).join('') || '';
  show('setup');
}
$('areaList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-area]'); if (!b) return;
  b.disabled = true; $('loadStatus').textContent = 'טוען…';
  const ok = await openArea(b.dataset.area);
  $('loadStatus').textContent = ok ? '' : 'לא הצלחתי לטעון את האזור';
  b.disabled = false;
});

// ================= wiring =================
$('loadCityBtn').addEventListener('click', async () => {
  const city = $('cityInput').value.trim(); if (!city) return;
  const btn = $('loadCityBtn'); btn.disabled = true;
  try {
    let g = S.forceDownload ? null : await loadPrebuilt(city);
    S.forceDownload = false;
    if (!g) g = await downloadCity(city, (m) => { $('loadStatus').textContent = m; });
    settings.city = city; saveSettings();
    S.g = g; loadProgress(); await loadProjects();
    if (map) { map.remove(); map = null; meMarker = null; flagMarker = null; }
    $('loadStatus').textContent = '';
    renderHome(); show('home');
  } catch (e) {
    $('loadStatus').textContent = 'שגיאה: ' + (e.message || e) + '. נסה שוב בעוד דקה.';
  } finally { btn.disabled = false; }
});
$('resumeBtn').addEventListener('click', () => startNav(S.progress.pause ? 'toPoint' : 'cover'));
$('nearestBtn').addEventListener('click', () => startNav('cover'));
$('pauseBtn').addEventListener('click', pauseHere);
$('foundBtn').addEventListener('click', openProject);
$('blockedBtn').addEventListener('click', skipNext);
$('recenterBtn').addEventListener('click', () => { S.follow = true; A.jump = true; });
$('orientBtn').addEventListener('click', () => {
  settings.headingUp = !settings.headingUp; saveSettings(); renderOrient();
  if (!settings.headingUp) { try { map.setBearing(0); } catch {} }
  S.follow = true; A.jump = true;
  toast(settings.headingUp ? 'המפה מסתובבת לפי כיוון הנסיעה' : 'צפון למעלה');
});
renderOrient();
$('muteBtn').addEventListener('click', () => { settings.voice = !settings.voice; saveSettings(); $('muteBtn').classList.toggle('off', !settings.voice); toast(settings.voice ? 'הוראות קוליות פעילות' : 'הוראות קוליות כבויות'); });
$('psHome').addEventListener('click', () => { $('pauseSheet').classList.add('hidden'); renderHome(); show('home'); });
$('psContinue').addEventListener('click', () => { $('pauseSheet').classList.add('hidden'); startNav('cover'); });
$('openProjects').addEventListener('click', () => { renderProjects(); show('projects'); });
$('projBack').addEventListener('click', () => { renderHome(); show('home'); });
$('openSettings').addEventListener('click', () => {
  $('stVoice').checked = settings.voice; $('stSim').checked = settings.sim; $('stSimSpeed').value = String(settings.simSpeed || 1);
  const g = S.g;
  $('stInfo').textContent = `${settings.city}: ${g.reqEdges.length} קטעי רחוב, ${km(g.totalReqLen)} ק״מ לכיסוי` + (g.edges.some((e) => e.unreachable) ? ` (${g.edges.filter((e) => e.unreachable).length} קטעים מנותקים לא נכללו)` : '');
  $('settingsSheet').classList.remove('hidden');
});
$('stVoice').addEventListener('change', (e) => { settings.voice = e.target.checked; saveSettings(); $('muteBtn').classList.toggle('off', !settings.voice); });
$('stSim').addEventListener('change', (e) => { settings.sim = e.target.checked; saveSettings(); });
$('stSimSpeed').addEventListener('change', (e) => { settings.simSpeed = +e.target.value; saveSettings(); });
$('stClose').addEventListener('click', () => { $('settingsSheet').classList.add('hidden'); renderHome(); });
$('stReload').addEventListener('click', () => { S.forceDownload = true; $('settingsSheet').classList.add('hidden'); $('cityInput').value = settings.city; show('setup'); $('loadCityBtn').click(); });
$('stCity').addEventListener('click', () => { if (S.mode !== 'idle') stopNav(); $('settingsSheet').classList.add('hidden'); $('cityInput').value = ''; showSetup(); });
$('stReset').addEventListener('click', (ev) => {
  const b = ev.currentTarget;
  if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'בטוח? כל הרחובות יסומנו מחדש כלא נסועים. לחץ שוב'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'אפס את ההתקדמות'; }, 4000); return; }
  delete b.dataset.armed; b.textContent = 'אפס את ההתקדמות';
  ls.set(progKey(), {}); loadProgress(); if (map) S.g.reqEdges.forEach((e) => styleEdge(e.id));
  $('settingsSheet').classList.add('hidden'); renderHome(); toast('ההתקדמות אופסה');
});
$('muteBtn').classList.toggle('off', !settings.voice);

// ================= boot =================
(async function boot() {
  try {
    const d = await idb.get('graph:' + settings.city);
    if (d) {
      S.g = C.deserializeGraph(d); loadProgress(); await loadProjects();
      renderHome(); show('home'); return;
    }
    const g = await loadPrebuilt(settings.city);
    if (g) { S.g = g; loadProgress(); await loadProjects(); renderHome(); show('home'); return; }
  } catch (e) { console.error(e); }
  $('cityInput').value = settings.city;
  showSetup();
})();
