// Simulates driving a whole area with the coverage planner and reports how efficient the route is.
// Runs during the Vercel build (real street data) and prints to the build log.
import { Coverage, nextTarget, turnDeg } from '../core.js';

function arcDir(e, fwd, end) {
  const p = e.pts, n = p.length;
  const [a, b] = fwd ? (end ? [p[n - 2], p[n - 1]] : [p[0], p[1]]) : (end ? [p[1], p[0]] : [p[n - 1], p[n - 2]]);
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

export function simulate(g, variant = {}, maxMs = 25000) {
  const t0 = Date.now();
  const cov = new Coverage(g);
  // start at the node closest to the centroid of required streets
  let cx = 0, cy = 0; for (const e of g.reqEdges) { cx += e.pts[0][0]; cy += e.pts[0][1]; } cx /= g.reqEdges.length; cy /= g.reqEdges.length;
  let node = 0, bd = Infinity;
  g.nodes.forEach((n, i) => { if (g.comp[i] === g.mainComp && g.out[i].length) { const d = Math.hypot(n.x - cx, n.y - cy); if (d < bd) { bd = d; node = i; } } });
  let inDir = null, driven = 0, dead = 0, uturns = 0, lefts = 0, rights = 0, targets = 0, maxDead = 0, curDead = 0, prevE = -1;
  const bias = variant.bias ? variant.bias(g, cov) : null;
  while (Date.now() - t0 < maxMs) {
    const seg = nextTarget(g, cov, [{ node, dist: 0, inDir }], null, bias);
    if (!seg) break;
    targets++;
    for (const st of seg) {
      const e = g.edges[st.e];
      if (inDir != null) {
        const d = st.e === prevE ? 180 : turnDeg(inDir, arcDir(e, st.fwd, false));
        if (Math.abs(d) > 160) uturns++; else if (d > 45) lefts++; else if (d < -45) rights++;
      }
      const isNew = e.req && !e.unreachable && !e.skip && !cov.covered[e.id];
      driven += e.len;
      if (isNew) { cov.setCovered(e.id); cov.takeTwinNewly(); maxDead = Math.max(maxDead, curDead); curDead = 0; }
      else { dead += e.len; curDead += e.len; }
      inDir = arcDir(e, st.fwd, true); node = st.fwd ? e.b : e.a; prevE = st.e;
    }
  }
  const left = cov.remaining().length;
  return {
    km: +(driven / 1000).toFixed(1), reqKm: +(g.totalReqLen / 1000).toFixed(1),
    ratio: +(driven / g.totalReqLen).toFixed(2), deadKm: +(dead / 1000).toFixed(1),
    maxDeadM: Math.round(maxDead), uturns, lefts, rights, targets, left, ms: Date.now() - t0,
  };
}

export function stats(g) {
  const short = g.reqEdges.filter((e) => e.len < 20).length;
  const deadEnds = g.nodes.filter((n, i) => g.out[i].length === 1).length;
  const oneway = g.reqEdges.filter((e) => e.dir !== 0).length;
  const unnamed = g.reqEdges.filter((e) => !e.name).length;
  return { segments: g.reqEdges.length, short, deadEnds, oneway, unnamed, twins: g.twins ? g.twins.size : 0, unreachable: g.edges.filter((e) => e.unreachable).length };
}

// candidate planner tweaks to compare
export const VARIANTS = {
  current: {},
  // prefer targets inside clusters of uncovered streets (finish a block before leaving)
  cluster: { bias: (g, cov) => (n) => {
    let k = 0; const N = g.nodes[n];
    for (const a of g.out[n]) { const e = g.edges[a.e]; if (e.req && !cov.covered[e.id]) k++; const m = a.to; for (const b of g.out[m]) { const e2 = g.edges[b.e]; if (e2.req && !cov.covered[e2.id]) k += 0.5; } }
    return -Math.min(6, k) * 25;
  } },
  // strongly finish "straggler" streets (no other uncovered street at their end) before moving on
  cleanup: { bias: (g, cov) => (n) => { let k = 0; for (const a of g.out[n]) { const e = g.edges[a.e]; if (e.req && !cov.covered[e.id]) k++; } return k <= 1 ? -90 : 0; } },
  // cluster + cleanup together
  combo: { bias: (g, cov) => (n) => {
    let k1 = 0, k = 0;
    for (const a of g.out[n]) { const e = g.edges[a.e]; if (e.req && !cov.covered[e.id]) { k1++; k++; } for (const b of g.out[a.to]) { const e2 = g.edges[b.e]; if (e2.req && !cov.covered[e2.id]) k += 0.5; } }
    return (k1 <= 1 ? -90 : 0) - Math.min(6, k) * 25;
  } },
  // stay close to where uncovered streets are densest around the start (sweep instead of jumping)
  sweep: { bias: (g, cov) => { let i = 0; return (n) => { i++; const N = g.nodes[n]; return 0.05 * (N.x + N.y); }; } },
};
