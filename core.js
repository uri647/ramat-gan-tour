// Core logic: street graph, GPS matching, coverage planning, maneuvers.
// Plain ES module, no DOM — runs in the browser and in Node tests.

export const HIGHWAY_RE = /^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road)$/;

// ---------- geometry ----------
export function makeProjection(lat0, lon0) {
  const kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
  return {
    lat0, lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLL: (x, y) => [y / ky + lat0, x / kx + lon0],
  };
}
const hyp = Math.hypot;
function angleOf(dx, dy) { return Math.atan2(dy, dx); }
function normAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
// signed turn in degrees: positive = left, negative = right
export function turnDeg(inDir, outDir) { return normAngle(outDir - inDir) * 180 / Math.PI; }

function projectOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, d: hyp(px - qx, py - qy), qx, qy };
}

// ---------- graph ----------
function onewayOf(tags) {
  const o = tags.oneway;
  if (o === 'yes' || o === '1' || o === 'true') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'trunk_link' || tags.highway === 'primary_link') return o ? 0 : 0;
  return 0;
}

/**
 * Build a compact graph from Overpass elements.
 * elements: nodes (id,lat,lon) and ways (id,nodes,tags)
 * requiredWayIds: Set of way ids that must be covered (inside the city)
 */
export function buildGraph(elements, requiredWayIds) {
  const nodeLL = new Map();
  const ways = [];
  for (const el of elements) {
    if (el.type === 'node') nodeLL.set(el.id, [el.lat, el.lon]);
    else if (el.type === 'way' && el.nodes && el.tags && HIGHWAY_RE.test(el.tags.highway || '')) ways.push(el);
  }
  // projection origin = centroid of required ways (or all)
  let sl = 0, so = 0, n = 0;
  for (const w of ways) {
    if (requiredWayIds.size && !requiredWayIds.has(w.id)) continue;
    const ll = nodeLL.get(w.nodes[0]); if (!ll) continue;
    sl += ll[0]; so += ll[1]; n++;
  }
  if (!n) throw new Error('לא נמצאו רחובות');
  const proj = makeProjection(sl / n, so / n);

  const use = new Map();
  for (const w of ways) {
    w.nodes.forEach((id, i) => {
      const end = i === 0 || i === w.nodes.length - 1;
      use.set(id, (use.get(id) || 0) + (end ? 2 : 1));
    });
  }
  const gIndex = new Map(); // osm node id -> graph node idx
  const gNodes = []; // {x,y,lat,lon,osm}
  const gid = (osm) => {
    let i = gIndex.get(osm);
    if (i === undefined) {
      const ll = nodeLL.get(osm), xy = proj.toXY(ll[0], ll[1]);
      i = gNodes.length; gIndex.set(osm, i);
      gNodes.push({ x: xy[0], y: xy[1], lat: ll[0], lon: ll[1], osm });
    }
    return i;
  };
  const edges = [];
  for (const w of ways) {
    const ids = w.nodes.filter((id) => nodeLL.has(id));
    if (ids.length < 2) continue;
    const dir = onewayOf(w.tags);
    const name = w.tags.name || w.tags['name:he'] || '';
    const req = requiredWayIds.has(w.id);
    const roundabout = w.tags.junction === 'roundabout' || w.tags.junction === 'circular';
    let start = 0;
    for (let i = 1; i < ids.length; i++) {
      if (i === ids.length - 1 || use.get(ids[i]) > 1) {
        const seg = ids.slice(start, i + 1);
        if (seg[0] !== seg[seg.length - 1] || seg.length > 2) {
          const pts = seg.map((id) => { const ll = nodeLL.get(id); return proj.toXY(ll[0], ll[1]); });
          const ll = seg.map((id) => nodeLL.get(id));
          let len = 0; for (let k = 1; k < pts.length; k++) len += hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          if (len > 0.5) {
            edges.push({
              id: edges.length, key: `${w.id}_${seg[0]}_${seg[seg.length - 1]}`,
              a: gid(seg[0]), b: gid(seg[seg.length - 1]), pts, ll, len, name, dir, req, roundabout, skip: false,
            });
          }
        }
        start = i;
      }
    }
  }
  const g = { proj, nodes: gNodes, edges };
  finalizeGraph(g);
  return g;
}

/** Adjacency, SCC filtering of unreachable required edges. Works on deserialized graphs too. */
export function finalizeGraph(g) {
  const N = g.nodes.length;
  const out = Array.from({ length: N }, () => []);
  for (const e of g.edges) {
    if (e.dir >= 0) out[e.a].push({ e: e.id, fwd: true, to: e.b });
    if (e.dir <= 0) out[e.b].push({ e: e.id, fwd: false, to: e.a });
  }
  g.out = out;
  // strongly connected components (iterative Tarjan)
  const index = new Int32Array(N).fill(-1), low = new Int32Array(N), onStack = new Uint8Array(N), comp = new Int32Array(N).fill(-1);
  const stack = []; let idx = 0, nComp = 0;
  for (let s = 0; s < N; s++) {
    if (index[s] !== -1) continue;
    const work = [[s, 0]];
    index[s] = low[s] = idx++; stack.push(s); onStack[s] = 1;
    while (work.length) {
      const top = work[work.length - 1]; const v = top[0];
      if (top[1] < out[v].length) {
        const w = out[v][top[1]++].to;
        if (index[w] === -1) { index[w] = low[w] = idx++; stack.push(w); onStack[w] = 1; work.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
        if (low[v] === index[v]) {
          let w; do { w = stack.pop(); onStack[w] = 0; comp[w] = nComp; } while (w !== v);
          nComp++;
        }
      }
    }
  }
  // main component = the one containing most required length
  const compLen = new Float64Array(nComp);
  for (const e of g.edges) if (e.req && comp[e.a] === comp[e.b]) compLen[comp[e.a]] += e.len;
  let main = 0; for (let c = 1; c < nComp; c++) if (compLen[c] > compLen[main]) main = c;
  g.comp = comp; g.mainComp = main;
  for (const e of g.edges) e.unreachable = e.req && !(comp[e.a] === main && comp[e.b] === main);
  g.reqEdges = g.edges.filter((e) => e.req && !e.unreachable);
  g.totalReqLen = g.reqEdges.reduce((s, e) => s + e.len, 0);
  buildSpatialIndex(g);
  return g;
}

export function serializeGraph(g) {
  return {
    v: 1, lat0: g.proj.lat0, lon0: g.proj.lon0,
    nodes: g.nodes.map((n) => [n.lat, n.lon, n.osm]),
    edges: g.edges.map((e) => [e.key, e.a, e.b, e.ll, e.name, e.dir, e.req ? 1 : 0, e.roundabout ? 1 : 0]),
  };
}
export function deserializeGraph(d) {
  const proj = makeProjection(d.lat0, d.lon0);
  const nodes = d.nodes.map(([lat, lon, osm]) => { const [x, y] = proj.toXY(lat, lon); return { x, y, lat, lon, osm }; });
  const edges = d.edges.map(([key, a, b, ll, name, dir, req, rb], id) => {
    const pts = ll.map(([la, lo]) => proj.toXY(la, lo));
    let len = 0; for (let k = 1; k < pts.length; k++) len += hyp(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    return { id, key, a, b, pts, ll, len, name, dir, req: !!req, roundabout: !!rb, skip: false };
  });
  const g = { proj, nodes, edges };
  finalizeGraph(g);
  return g;
}

// ---------- spatial index ----------
const CELL = 60;
function buildSpatialIndex(g) {
  const grid = new Map();
  const add = (cx, cy, item) => { const k = cx * 100003 + cy; let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(item); };
  for (const e of g.edges) {
    let acc = 0;
    for (let k = 1; k < e.pts.length; k++) {
      const [ax, ay] = e.pts[k - 1], [bx, by] = e.pts[k];
      const segLen = hyp(bx - ax, by - ay);
      const x0 = Math.floor(Math.min(ax, bx) / CELL), x1 = Math.floor(Math.max(ax, bx) / CELL);
      const y0 = Math.floor(Math.min(ay, by) / CELL), y1 = Math.floor(Math.max(ay, by) / CELL);
      const item = { e: e.id, k, off: acc, segLen };
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) add(cx, cy, item);
      acc += segLen;
    }
  }
  g.grid = grid;
}

/** Edges near a point, each with its closest projection. */
export function nearEdges(g, x, y, radius) {
  const r = Math.ceil(radius / CELL);
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  const best = new Map();
  for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
    const items = g.grid.get(i * 100003 + j); if (!items) continue;
    for (const it of items) {
      const e = g.edges[it.e];
      const [ax, ay] = e.pts[it.k - 1], [bx, by] = e.pts[it.k];
      const p = projectOnSeg(x, y, ax, ay, bx, by);
      if (p.d > radius) continue;
      const prev = best.get(it.e);
      if (!prev || p.d < prev.d) best.set(it.e, { e: it.e, d: p.d, pos: it.off + p.t * it.segLen, segDir: angleOf(bx - ax, by - ay), qx: p.qx, qy: p.qy });
    }
  }
  return [...best.values()];
}

export function nearestEdgeDistance(g, x, y, maxR = 2000) {
  for (let r = 60; r <= maxR; r *= 2) {
    const c = nearEdges(g, x, y, r);
    if (c.length) return Math.min(...c.map((m) => m.d));
  }
  return Infinity;
}

// ---------- coverage state ----------
const BIN = 15;
export class Coverage {
  constructor(g) {
    this.g = g;
    this.covered = new Uint8Array(g.edges.length);
    this.bins = new Map(); // edge id -> Uint8Array
  }
  isDone(id) { return this.covered[id] === 1; }
  coveredLen() { let s = 0; for (const e of this.g.reqEdges) if (this.covered[e.id] || e.skip) s += e.len; return s; }
  remaining() { return this.g.reqEdges.filter((e) => !this.covered[e.id] && !e.skip); }
  markRange(id, p0, p1) {
    if (this.covered[id]) return false;
    const e = this.g.edges[id];
    const n = Math.max(1, Math.round(e.len / BIN));
    let b = this.bins.get(id); if (!b) this.bins.set(id, b = new Uint8Array(n));
    const lo = Math.max(0, Math.min(p0, p1)), hi = Math.min(e.len, Math.max(p0, p1));
    const i0 = Math.min(n - 1, Math.floor(lo / e.len * n)), i1 = Math.min(n - 1, Math.floor(hi / e.len * n));
    for (let i = i0; i <= i1; i++) b[i] = 1;
    let c = 0; for (let i = 0; i < n; i++) c += b[i];
    const need = n <= 2 ? n : Math.ceil(n * 0.7);
    if (c >= need) { this.covered[id] = 1; this.bins.delete(id); return true; }
    return false;
  }
  setCovered(id) { this.covered[id] = 1; this.bins.delete(id); }
  keys() { const out = []; for (const e of this.g.edges) if (this.covered[e.id]) out.push(e.key); return out; }
  loadKeys(keys) { const s = new Set(keys); for (const e of this.g.edges) if (s.has(e.key)) this.covered[e.id] = 1; }
}

// ---------- GPS matcher ----------
export class Matcher {
  constructor(g, cov) { this.g = g; this.cov = cov; this.last = null; this.lastXY = null; }
  /** fix: {x,y,acc,heading(rad, math convention) or null,speed m/s} → match or null. Returns {match, newlyCovered:[ids]} */
  update(fix) {
    const g = this.g;
    const R = Math.min(40, Math.max(18, (fix.acc || 15) * 1.2));
    const cands = nearEdges(g, fix.x, fix.y, R);
    let moveDir = null;
    if (this.lastXY) {
      const dx = fix.x - this.lastXY[0], dy = fix.y - this.lastXY[1];
      if (hyp(dx, dy) > 3) moveDir = angleOf(dx, dy);
    }
    if (moveDir === null && fix.heading != null && fix.speed > 2) moveDir = fix.heading;
    let best = null, bestScore = Infinity;
    for (const c of cands) {
      let s = c.d;
      if (moveDir !== null) {
        const da = Math.abs(normAngle(c.segDir - moveDir));
        const undirected = Math.min(da, Math.PI - da); // 0..pi/2
        s += undirected / (Math.PI / 2) * 25;
        const e = g.edges[c.e];
        const fwd = da < Math.PI / 2;
        if ((e.dir === 1 && !fwd) || (e.dir === -1 && fwd)) s += 15; // against one-way: unlikely
      }
      if (this.last) {
        if (c.e === this.last.e) s -= 6;
        else {
          const le = g.edges[this.last.e], e = g.edges[c.e];
          if (e.a === le.a || e.a === le.b || e.b === le.a || e.b === le.b) s -= 3;
        }
      }
      if (s < bestScore) { bestScore = s; best = c; }
    }
    const newly = [];
    if (best) {
      const e = g.edges[best.e];
      let fwd = null;
      if (moveDir !== null) fwd = Math.abs(normAngle(best.segDir - moveDir)) < Math.PI / 2;
      if (this.last && this.last.e === best.e && Math.abs(best.pos - this.last.pos) > 2) fwd = best.pos > this.last.pos;
      if (fwd === null && this.last && this.last.e === best.e) fwd = this.last.fwd;
      let p0 = best.pos;
      if (this.last && this.last.e === best.e && Math.abs(best.pos - this.last.pos) < 120) p0 = this.last.pos;
      else if (this.last && this.last.e !== best.e) {
        // entering a new edge: fill from the shared node
        const le = g.edges[this.last.e];
        if (e.a === le.a || e.a === le.b) p0 = 0; else if (e.b === le.a || e.b === le.b) p0 = e.len;
        if (Math.abs(p0 - best.pos) > 60) p0 = best.pos;
        if (fwd === null) fwd = p0 === 0;
      }
      if (this.cov.markRange(best.e, p0, best.pos)) newly.push(best.e);
      this.last = { e: best.e, pos: best.pos, fwd, d: best.d, qx: best.qx, qy: best.qy };
    } else {
      this.last = null;
    }
    this.lastXY = [fix.x, fix.y];
    return { match: this.last, newly };
  }
}

// ---------- routing ----------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topV = v[0], topK = k[0];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    this.lastKey = topK; return topV;
  }
}

function arcStartDir(g, e, fwd) {
  const p = e.pts; if (fwd) return angleOf(p[1][0] - p[0][0], p[1][1] - p[0][1]);
  const n = p.length; return angleOf(p[n - 2][0] - p[n - 1][0], p[n - 2][1] - p[n - 1][1]);
}
function arcEndDir(g, e, fwd) {
  const p = e.pts, n = p.length;
  if (fwd) return angleOf(p[n - 1][0] - p[n - 2][0], p[n - 1][1] - p[n - 2][1]);
  return angleOf(p[0][0] - p[1][0], p[0][1] - p[1][1]);
}
// cost of a turn, in meters-equivalent (discourage U-turns and lefts a little)
function turnCost(deg) {
  const a = Math.abs(deg);
  if (a > 160) return 120;
  if (a > 100) return 25;
  if (deg > 45) return 10; // left
  return 0;
}

/**
 * Dijkstra over arcs (state = arc arriving at node, so turn costs apply).
 * sources: [{node, dist, inDir|null}]
 * stopWhen(nodeIdx, dist, state) -> true to stop
 */
function search(g, sources, onPop) {
  const dist = new Map(); // node -> best dist
  const prev = new Map(); // node -> {node, e, fwd}
  const inDir = new Map();
  const heap = new Heap();
  for (const s of sources) {
    if (!dist.has(s.node) || s.dist < dist.get(s.node)) {
      dist.set(s.node, s.dist); inDir.set(s.node, s.inDir ?? null); prev.set(s.node, s.prev || null);
      heap.push(s.dist, s.node);
    }
  }
  const done = new Set();
  while (heap.size) {
    const u = heap.pop(); const du = heap.lastKey;
    if (done.has(u) || du > dist.get(u)) continue;
    done.add(u);
    if (onPop(u, du, inDir.get(u)) === true) break;
    const id = inDir.get(u);
    for (const arc of g.out[u]) {
      const e = g.edges[arc.e];
      let c = e.len;
      if (id !== null) c += turnCost(turnDeg(id, arcStartDir(g, e, arc.fwd)));
      const nd = du + c;
      if (!dist.has(arc.to) || nd < dist.get(arc.to)) {
        dist.set(arc.to, nd); prev.set(arc.to, { node: u, e: arc.e, fwd: arc.fwd });
        inDir.set(arc.to, arcEndDir(g, e, arc.fwd)); heap.push(nd, arc.to);
      }
    }
  }
  return { dist, prev, inDir };
}
function pathTo(res, node) {
  const steps = []; let p = res.prev.get(node);
  while (p) { steps.push({ e: p.e, fwd: p.fwd }); p = res.prev.get(p.node); }
  return steps.reverse();
}

/** Shortest path from sources to a target node. */
export function routeToNode(g, sources, target) {
  const res = search(g, sources, (u) => u === target);
  if (!res.dist.has(target)) return null;
  return pathTo(res, target);
}

/** Find the next uncovered required arc reachable from sources (greedy nearest, with turn-aware tie-break). */
export function nextTarget(g, cov, sources, extraDone) {
  let best = null, bestScore = Infinity, stopAt = Infinity;
  const res = search(g, sources, (u, du, id) => {
    if (du > stopAt) return true;
    for (const arc of g.out[u]) {
      const e = g.edges[arc.e];
      if (!e.req || e.unreachable || e.skip || cov.covered[e.id] || (extraDone && extraDone.has(e.id))) continue;
      let score = du;
      if (id !== null) score += turnCost(turnDeg(id, arcStartDir(g, e, arc.fwd)));
      // prefer finishing dead-end-ish / isolated streets so nothing is left behind
      const endNode = arc.to;
      let pending = 0;
      for (const a2 of g.out[endNode]) { const e2 = g.edges[a2.e]; if (e2.req && !e2.skip && !cov.covered[e2.id] && a2.e !== e.id && !(extraDone && extraDone.has(a2.e))) pending++; }
      if (pending === 0) score -= 15;
      if (score < bestScore) { bestScore = score; best = { node: u, arc }; stopAt = du + 60; }
    }
    return false;
  });
  if (!best) return null;
  const steps = pathTo(res, best.node);
  steps.push({ e: best.arc.e, fwd: best.arc.fwd, target: true });
  return steps;
}

/** Plan ahead greedily up to maxLen meters. Returns steps [{e,fwd,target}] */
export function planAhead(g, cov, sources, maxLen = 3000, maxTargets = 80) {
  const plan = []; const tmp = new Set(); let len = 0; let src = sources; let targets = 0;
  while (len < maxLen && targets < maxTargets) {
    const seg = nextTarget(g, cov, src, tmp);
    if (!seg) break;
    for (const s of seg) {
      plan.push(s); len += g.edges[s.e].len;
      const e = g.edges[s.e];
      if (e.req) tmp.add(s.e);
    }
    targets++;
    const last = seg[seg.length - 1], le = g.edges[last.e];
    src = [{ node: last.fwd ? le.b : le.a, dist: 0, inDir: arcEndDir(g, le, last.fwd) }];
  }
  return plan;
}

/** Sources for routing from a matched position on an edge. */
export function sourcesFromMatch(g, m) {
  const e = g.edges[m.e];
  const S = [];
  const canF = e.dir >= 0, canB = e.dir <= 0;
  if ((m.fwd === true || m.fwd === null) && canF) S.push({ node: e.b, dist: e.len - m.pos, inDir: arcEndDir(g, e, true), cur: { e: e.id, fwd: true } });
  if ((m.fwd === false || m.fwd === null) && canB) S.push({ node: e.a, dist: m.pos, inDir: arcEndDir(g, e, false), cur: { e: e.id, fwd: false } });
  if (!S.length) { // moving against a one-way (or unknown): allow the legal end with U-turn penalty
    if (canF) S.push({ node: e.b, dist: e.len - m.pos + 50, inDir: null, cur: { e: e.id, fwd: true } });
    if (canB) S.push({ node: e.a, dist: m.pos + 50, inDir: null, cur: { e: e.id, fwd: false } });
  }
  return S;
}

// ---------- maneuvers ----------
function turnText(deg) {
  const a = Math.abs(deg), side = deg > 0 ? 'שמאלה' : 'ימינה';
  if (a > 165) return 'בצע פניית פרסה';
  if (a > 120) return 'פנה חדות ' + side;
  if (a > 45) return 'פנה ' + side;
  if (a > 20) return 'פנה קלות ' + side;
  return 'המשך ישר';
}
export function maneuverIcon(deg) {
  const a = Math.abs(deg);
  if (a > 165) return 'uturn';
  if (a > 20) return deg > 0 ? 'left' : 'right';
  return 'straight';
}

/**
 * From a list of steps (first = current edge, partially driven), produce maneuvers:
 * [{stepIndex (turn happens at the start of this step), deg, text, icon, name}]
 */
export function buildManeuvers(g, steps) {
  const out = [];
  for (let i = 1; i < steps.length; i++) {
    const p = steps[i - 1], s = steps[i];
    const pe = g.edges[p.e], se = g.edges[s.e];
    if (se.roundabout && pe.roundabout) continue;
    const deg = p.e === s.e ? 180 : turnDeg(arcEndDir(g, pe, p.fwd), arcStartDir(g, se, s.fwd));
    if (se.roundabout && !pe.roundabout) {
      let j = i; while (j < steps.length && g.edges[steps[j].e].roundabout) j++;
      const exitName = j < steps.length ? g.edges[steps[j].e].name : '';
      // count exits
      let exits = 0;
      for (let k = i; k < j; k++) {
        const e = g.edges[steps[k].e], node = steps[k].fwd ? e.b : e.a;
        if (k < j - 1) exits += g.out[node].filter((a) => !g.edges[a.e].roundabout).length > 0 ? 1 : 0;
      }
      out.push({ stepIndex: i, deg: 0, icon: 'roundabout', name: exitName, text: `בכיכר צא ביציאה ה${ordinal(exits + 1)}` + (exitName ? ` ל${exitName}` : '') });
      i = j; // skip roundabout internals (the exit step itself has no separate maneuver)
      continue;
    }
    if (pe.roundabout && !se.roundabout) continue;
    const nameChange = se.name && se.name !== pe.name;
    if (Math.abs(deg) > 20 || (nameChange && Math.abs(deg) > 8)) {
      let text = p.e === s.e ? 'בסוף הרחוב הסתובב וחזור' : turnText(deg);
      if (se.name && p.e !== s.e) text += (Math.abs(deg) <= 20 ? ' ברחוב ' : ' לרחוב ') + se.name;
      out.push({ stepIndex: i, deg, text, icon: p.e === s.e ? 'uturn' : maneuverIcon(deg), name: se.name });
    }
  }
  return out;
}
function ordinal(n) { return ['ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית'][n - 1] || `${n}`; }

export function pathLength(g, steps, fromIdx, toIdx) {
  let s = 0; for (let i = fromIdx; i < toIdx; i++) s += g.edges[steps[i].e].len; return s;
}

/** lat/lon polyline for a list of steps, starting at offset `startPos` along the first step. */
export function stepsToLatLngs(g, steps, startPos = null) {
  const out = [];
  steps.forEach((s, i) => {
    const e = g.edges[s.e];
    let ll = s.fwd ? e.ll : [...e.ll].reverse();
    if (i === 0 && startPos != null) ll = trimStart(g, e, s.fwd, startPos);
    for (const p of ll) out.push(p);
  });
  return out;
}
function trimStart(g, e, fwd, pos) {
  // pos is distance from edge start (a). For reverse travel, remaining = pos from b side.
  const pts = e.pts; const res = [];
  const along = fwd ? pos : e.len - pos;
  const seq = fwd ? pts : [...pts].reverse();
  let acc = 0;
  for (let k = 1; k < seq.length; k++) {
    const L = hyp(seq[k][0] - seq[k - 1][0], seq[k][1] - seq[k - 1][1]);
    if (acc + L >= along) {
      const t = L ? (along - acc) / L : 0;
      if (!res.length) res.push(g.proj.toLL(seq[k - 1][0] + t * (seq[k][0] - seq[k - 1][0]), seq[k - 1][1] + t * (seq[k][1] - seq[k - 1][1])));
      res.push(g.proj.toLL(seq[k][0], seq[k][1]));
    }
    acc += L;
  }
  return res.length ? res : [g.proj.toLL(seq[seq.length - 1][0], seq[seq.length - 1][1])];
}

/** Point along an edge (distance from a). */
export function pointOnEdge(g, e, pos) {
  let acc = 0;
  for (let k = 1; k < e.pts.length; k++) {
    const [ax, ay] = e.pts[k - 1], [bx, by] = e.pts[k]; const L = hyp(bx - ax, by - ay);
    if (acc + L >= pos) { const t = L ? (pos - acc) / L : 0; return [ax + t * (bx - ax), ay + t * (by - ay)]; }
    acc += L;
  }
  return e.pts[e.pts.length - 1];
}
