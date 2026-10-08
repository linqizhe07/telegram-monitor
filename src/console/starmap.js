// The live view's map as numbers, for crawler.js to draw: how much room the nebulae get, and where
// each one goes. A plain script for the page (window.StarMap); the tests load it too.
//
// The stage is the world. At the default zoom (1) the map fills the stage and every nebula has its
// own size, as the first live view had them. As groups are added, the map stays balanced:
//   1. while the nebulae, with a margin, take at most FILL of the stage and fit round the ring,
//      nothing changes;
//   2. past that they shrink, to SHRINK_MIN of their size at most;
//   3. past that the world grows beyond the stage and the default view zooms out, to ZOOM_MIN at
//      most; past that the default view follows the group being read.
// Where they go: on a ring around the news, as in the first view. A galaxy's groups sit side by
// side, the most alike next to each other. Groups that share topics sit as close as they share
// (touching at CLOSE_AT and more); the others share what is left of the ring. When the ring is
// full, they fill the stage inside and around it, in the same order. A nebula keeps its place on
// the ring from one look to the next (`arc`), so a new day moves the ones that drew together or
// apart and leaves the rest where they were.
'use strict';

(function (root) {
  /** Of the stage's free area, at most this much is nebulae (their gas and a margin). */
  const FILL = 0.55;
  /** Nebulae shrink to this much of their size at most; then the world grows. */
  const SHRINK_MIN = 0.6;
  /** The default view zooms out this far at most; then it follows the group being read. */
  const ZOOM_MIN = 0.5;
  /** Two groups whose topics overlap this much (src/constellation.ts) sit as close as nebulae go. */
  const CLOSE_AT = 0.1;
  /** How far the default view leans toward the group being read, when it shows the whole map. */
  const LEAN = 0.2;
  /** A nebula's centre stays this far inside the stage (px), and more for a big one. */
  const EDGE_X = 30;
  const EDGE_Y = 24;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  /** The stage's top-left corner holds the title (on a narrow stage, the whole top): no nebula's centre goes under it. */
  const titleOf = (w) => (w < 700 ? { w, h: 80 } : { w: Math.min(520, w * 0.45), h: 84 });
  const closeness = (overlap) => clamp(overlap / CLOSE_AT, 0, 1);
  /** Centre to centre, for two groups that share topics: touching when they share much, further the less they share. */
  const apart = (ra, rb, overlap) => (ra + rb) * (1.08 + 1.25 * (1 - closeness(overlap))) + 6;
  /** The least two nebulae keep between their centres. */
  const least = (ra, rb) => (ra + rb) * 1.04 + 6;
  /** The ring round the news: as the first view had it, in a world `g` times the stage. */
  const ringOf = (w, h, g) => ({ rx: Math.max(150, w * 0.37) * g, ry: Math.max(110, h * 0.31) * g });
  /** Its length (Ramanujan's approximation). */
  const ringLength = ({ rx, ry }) => Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));

  /**
   * How much room the nebulae get on a stage `w` × `h` px, given the groups' own radii and the
   * news's (0 without it): `k` scales the nebulae, `g` the world (1: the stage), `zoom` is the
   * default view's. The nebulae shrink while they take more than FILL of the stage or more than the
   * ring; the world grows only for the first (a full ring spills inside and around it).
   */
  function balance(w, h, radii, news = 0) {
    const t = titleOf(w);
    const free = Math.max(1, (w - 2 * EDGE_X) * (h - 2 * EDGE_Y) - t.w * t.h);
    const fill = [...radii, news].reduce((sum, r) => sum + Math.PI * (1.2 * r) ** 2, 0) / free;
    // Round the ring each group takes its width and a margin: 2.08·k·Σr + 6 a group, of 92% of it.
    const round = 2.08 * radii.reduce((sum, r) => sum + r, 0);
    const kRing = round > 0 ? (ringLength(ringOf(w, h, 1)) * 0.92 - 6 * radii.length) / round : 1;
    const k = Math.max(SHRINK_MIN, Math.min(1, fill > FILL ? Math.sqrt(FILL / fill) : 1, kRing));
    const g = Math.max(1, Math.sqrt((fill * k * k) / FILL));
    return { k, g, zoom: Math.max(ZOOM_MIN, 1 / g), fill };
  }

  /**
   * An ellipse walked at equal steps of length, from its right end going down (clockwise on the
   * screen): `at(f)` is the point a fraction `f` of the way round, `fractionAt(x, y)` the way back.
   */
  function ellipse(rx, ry) {
    const N = 720;
    const len = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) {
      const a0 = ((i - 1) / N) * Math.PI * 2;
      const a1 = (i / N) * Math.PI * 2;
      len[i] = len[i - 1] + Math.hypot((Math.cos(a1) - Math.cos(a0)) * rx, (Math.sin(a1) - Math.sin(a0)) * ry);
    }
    const P = len[N];
    return {
      P,
      rx,
      ry,
      at(f) {
        const s = (((f % 1) + 1) % 1) * P;
        let lo = 0;
        let hi = N;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (len[m] <= s) lo = m;
          else hi = m;
        }
        const a = ((lo + (s - len[lo]) / (len[hi] - len[lo] || 1)) / N) * Math.PI * 2;
        return [Math.cos(a) * rx, Math.sin(a) * ry];
      },
      fractionAt(x, y) {
        let a = Math.atan2(y / ry, x / rx);
        if (a < 0) a += Math.PI * 2;
        const i = (a / (Math.PI * 2)) * N;
        const lo = Math.min(N - 1, Math.floor(i));
        return (len[lo] + (len[lo + 1] - len[lo]) * (i - lo)) / P;
      },
    };
  }

  /** The middle of some places on the ring (fractions 0–1), the short way round. */
  function meanOf(fs) {
    let x = 0;
    let y = 0;
    for (const f of fs) {
      x += Math.cos(f * Math.PI * 2);
      y += Math.sin(f * Math.PI * 2);
    }
    const f = Math.atan2(y, x) / (Math.PI * 2);
    return f < 0 ? f + 1 : f;
  }
  /** From `b` to `a` on the ring, the short way: −0.5 to 0.5. */
  const turnFrom = (a, b) => ((((a - b) % 1) + 1.5) % 1) - 0.5;

  /**
   * Items in a row, each next to the one it shares most with: the closest pair first, then whichever
   * item shares most with either end.
   */
  function chain(items, between) {
    if (items.length < 3) return items.slice();
    let first = [items[0], items[1]];
    let most = -1;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const x = between(items[i], items[j]);
        if (x > most) {
          most = x;
          first = [items[i], items[j]];
        }
      }
    }
    const row = first.slice();
    const rest = items.filter((x) => !row.includes(x));
    while (rest.length) {
      let pick = 0;
      let front = false;
      let best = -1;
      // On a tie, the back: items that share nothing keep the order they came in.
      rest.forEach((x, i) => {
        const back = between(x, row[row.length - 1]);
        const head = between(x, row[0]);
        if (back > best) [best, pick, front] = [back, i, false];
        if (head > best) [best, pick, front] = [head, i, true];
      });
      const [x] = rest.splice(pick, 1);
      if (front) row.unshift(x);
      else row.push(x);
    }
    return row;
  }

  /**
   * Where each nebula goes, in px from the stage's middle (the world is the stage times `g`).
   * `nodes`: { id, r, arc } for each group (arc: its place on the ring last time, 0–1, or none for a
   * new group), and the news as { id, r, center: true }. `edges`: { a, b, overlap }. `galaxies`:
   * lists of ids. Returns each id's { x, y, arc }.
   */
  function layout({ w, h, g = 1, nodes, edges = [], galaxies = [] }) {
    const out = new Map();
    const center = nodes.find((c) => c.center) || null;
    if (center) out.set(center.id, { x: 0, y: 0, arc: null });
    const groups = nodes.filter((c) => !c.center);
    if (!groups.length) return out;
    const node = new Map(groups.map((c) => [c.id, c]));
    const pair = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`);
    const links = new Map();
    for (const e of edges) {
      if (e.a === e.b || !node.has(e.a) || !node.has(e.b) || !(e.overlap > 0)) continue;
      const k = pair(e.a, e.b);
      if (!links.has(k) || links.get(k).o < e.overlap) links.set(k, { a: e.a, b: e.b, o: e.overlap });
    }
    const between = (a, b) => links.get(pair(a, b))?.o ?? 0;
    const was = (id) => {
      const arc = node.get(id).arc;
      return typeof arc === 'number' && Number.isFinite(arc) ? arc : null;
    };

    // The units on the ring: a galaxy's groups together, every other group alone.
    const unitOf = new Map();
    const units = [];
    for (const members of galaxies) {
      const ids = members.filter((id) => node.has(id) && !unitOf.has(id));
      if (ids.length < 2) continue;
      const u = { ids: chain(ids, between) };
      units.push(u);
      for (const id of ids) unitOf.set(id, u);
    }
    for (const c of groups) {
      if (unitOf.has(c.id)) continue;
      const u = { ids: [c.id] };
      units.push(u);
      unitOf.set(c.id, u);
    }
    const unitsBetween = (u, v) => Math.max(0, ...u.ids.flatMap((a) => v.ids.map((b) => between(a, b))));
    for (const u of units) {
      const old = u.ids.map(was).filter((f) => f !== null);
      u.at = old.length ? meanOf(old) : null;
      // A galaxy keeps the way round it had.
      const a = was(u.ids[0]);
      const b = was(u.ids[u.ids.length - 1]);
      if (u.ids.length > 1 && a !== null && b !== null && turnFrom(b, a) < 0) u.ids.reverse();
    }

    let ring;
    const placed = units.filter((u) => u.at !== null);
    if (!placed.length) {
      // A first look: each unit next to the one it shares most with.
      ring = chain(units, unitsBetween);
    } else {
      // Where they were; a new unit next to the one it shares most with, else after the group
      // before it in `nodes`, or at the end.
      ring = placed.sort((p, q) => p.at - q.at);
      for (const u of units) {
        if (u.at !== null) continue;
        let best = null;
        let most = 0;
        for (const v of ring) {
          const x = unitsBetween(u, v);
          if (x > most) [most, best] = [x, v];
        }
        if (!best) {
          const i = groups.findIndex((c) => c.id === u.ids[0]);
          for (let j = i - 1; j >= 0 && !best; j--) if (ring.includes(unitOf.get(groups[j].id))) best = unitOf.get(groups[j].id);
        }
        ring.splice(best ? ring.indexOf(best) + 1 : ring.length, 0, u);
      }
      // Units that share topics move next to each other, the closest first. Each moves once, to the
      // side of its partner nearer where it was, and never between its partner and a closer one.
      const near = [];
      for (let i = 0; i < ring.length; i++) {
        for (let j = i + 1; j < ring.length; j++) {
          const x = unitsBetween(ring[i], ring[j]);
          if (x > 0) near.push([ring[i], ring[j], x]);
        }
      }
      near.sort((p, q) => q[2] - p[2]);
      const settled = new Set();
      for (const [u, v] of near) {
        const n = ring.length;
        const iu = ring.indexOf(u);
        const iv = ring.indexOf(v);
        if (n < 3 || (iu - iv + n) % n === 1 || (iv - iu + n) % n === 1) {
          settled.add(u).add(v);
          continue;
        }
        let m = u.ids.length <= v.ids.length ? u : v;
        if (settled.has(m)) m = m === u ? v : u;
        if (settled.has(m)) continue;
        const stay = m === u ? v : u;
        ring.splice(ring.indexOf(m), 1);
        const s = ring.indexOf(stay);
        const left = ring[(s - 1 + ring.length) % ring.length];
        const right = ring[(s + 1) % ring.length];
        const toLeft = m.at !== null && stay.at !== null ? turnFrom(m.at, stay.at) < 0 : false;
        // The side whose neighbour shares less with `stay`, when one side already shares more.
        const lw = unitsBetween(left, stay);
        const rw = unitsBetween(right, stay);
        const side = lw === rw ? toLeft : lw < rw;
        ring.splice(side ? s : s + 1, 0, m);
        settled.add(m).add(stay);
      }
    }

    // A galaxy turns its ends to its neighbours on the ring: the group that shares most with the unit
    // before it comes first (two passes settle it).
    if (ring.length > 1) {
      for (let pass = 0; pass < 2; pass++) {
        ring.forEach((u, i) => {
          if (u.ids.length < 2) return;
          const before = ring[(i - 1 + ring.length) % ring.length].ids;
          const after = ring[(i + 1) % ring.length].ids;
          const [first, last] = [u.ids[0], u.ids[u.ids.length - 1]];
          const now = between(before[before.length - 1], first) + between(last, after[0]);
          const turned = between(before[before.length - 1], last) + between(first, after[0]);
          if (turned > now) u.ids.reverse();
        });
      }
    }

    // Around the ring: groups that share topics as close as they share, the others an equal share
    // of what is left (a big nebula more), or all closer together when the ring is crowded.
    const seq = ring.flatMap((u) => u.ids);
    const n = seq.length;
    const r = (id) => node.get(id).r;
    const ring0 = ringOf(w, h, g);
    const E = ellipse(ring0.rx, ring0.ry);
    // A step from each group to the next, and from the last back to the first (with three or more:
    // with two, the second faces the first across the ring unless they share topics).
    const steps = [];
    for (let i = 0; i < (n > 2 ? n : n - 1); i++) {
      const a = seq[i];
      const b = seq[(i + 1) % n];
      const o = between(a, b);
      if (n === 2 && o <= 0) steps.push({ len: E.P / 2, flex: false });
      else steps.push({ len: o > 0 ? apart(r(a), r(b), o) : least(r(a), r(b)), flex: o <= 0, weight: r(a) + r(b) });
    }
    let fixed = 0;
    let flex = 0;
    let flexWeight = 0;
    for (const s of steps) {
      if (s.flex) {
        flex += s.len;
        flexWeight += s.weight;
      } else fixed += s.len;
    }
    const spare = E.P - fixed - flex;
    const squeeze = spare < 0 ? E.P / (fixed + flex) : 1;
    for (const s of steps) s.len = s.flex && spare > 0 && flexWeight > 0 ? s.len + (spare * s.weight) / flexWeight : s.len * squeeze;
    const rel = [0];
    for (let i = 1; i < n; i++) rel.push(rel[i - 1] + steps[i - 1].len / E.P);
    // Turned to where they were; a first look starts where the first view did (left, above the middle).
    const known = seq.map((id, i) => [was(id), rel[i]]).filter(([f]) => f !== null);
    const offset = known.length ? meanOf(known.map(([f, x]) => (((f - x) % 1) + 1) % 1)) : E.fractionAt(E.rx * Math.cos(-Math.PI * 0.86), E.ry * Math.sin(-Math.PI * 0.86));

    // Then each one settles: drawn to its place on the ring, to the groups it shares topics with,
    // away from any it would touch, and kept on the stage and off the title.
    const crowded = squeeze < 1;
    const pos = seq.map((id, i) => {
      const arc = (((offset + rel[i]) % 1) + 1) % 1;
      const [x, y] = E.at(arc);
      return { id, r: r(id), x, y, tx: x, ty: y, arc };
    });
    const all = center ? [...pos, { id: center.id, r: center.r, x: 0, y: 0, fixed: true }] : pos;
    const index = new Map(pos.map((p) => [p.id, p]));
    const springs = [...links.values()].map(({ a, b, o }) => [index.get(a), index.get(b), apart(r(a), r(b), o), closeness(o)]);
    const limX = (w / 2 - EDGE_X) * g;
    const limY = (h / 2 - EDGE_Y) * g;
    const T = titleOf(w);
    const titleX = (-w / 2 + T.w) * g;
    const titleY = (-h / 2 + T.h) * g;
    const hold = crowded ? 0.02 : 0.12;
    const rounds = crowded ? 220 : 90;
    for (let it = 0; it < rounds; it++) {
      for (const [p, q, want, s] of springs) {
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d <= want) continue;
        const m = ((d - want) * 0.06 * s) / d;
        p.x += dx * m;
        p.y += dy * m;
        q.x -= dx * m;
        q.y -= dy * m;
      }
      for (const p of pos) {
        p.x += (p.tx - p.x) * hold;
        p.y += (p.ty - p.y) * hold;
      }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const p = all[i];
          const q = all[j];
          const want = p.fixed || q.fixed ? (p.r + q.r) * 0.98 + 4 : least(p.r, q.r);
          let dx = q.x - p.x;
          let dy = q.y - p.y;
          if (dx >= want || dx <= -want || dy >= want || dy <= -want) continue;
          let d = Math.hypot(dx, dy);
          if (d >= want) continue;
          if (d < 0.01) {
            // On top of each other: apart along a direction of their own.
            dx = Math.cos(i * 2.4 + j);
            dy = Math.sin(i * 2.4 + j);
            d = 1;
          }
          const push = (want - d) / d;
          if (p.fixed) {
            q.x += dx * push;
            q.y += dy * push;
          } else if (q.fixed) {
            p.x -= dx * push;
            p.y -= dy * push;
          } else {
            p.x -= (dx * push) / 2;
            p.y -= (dy * push) / 2;
            q.x += (dx * push) / 2;
            q.y += (dy * push) / 2;
          }
        }
      }
      for (const p of pos) {
        p.x = clamp(p.x, -limX + p.r * 0.6, limX - p.r * 0.6);
        p.y = clamp(p.y, -limY + p.r * 0.5, limY - p.r * 0.5);
        if (p.x < titleX && p.y < titleY + p.r * 0.3) p.y = titleY + p.r * 0.3;
      }
    }
    for (const p of pos) out.set(p.id, { x: p.x, y: p.y, arc: p.arc });
    return out;
  }

  /**
   * The default view of a stage `w` × `h` with the room `b` (balance()): the whole map, leaning
   * toward the group being read (`focus`, its { x, y }); or, when the map is bigger than that zoom
   * shows, around that group.
   */
  function home(w, h, b, focus) {
    const z = b.zoom;
    const X = Math.max(0, (w / 2) * b.g - w / (2 * z));
    const Y = Math.max(0, (h / 2) * b.g - h / (2 * z));
    if (!focus) return { x: 0, y: 0, z };
    if (X < 1 && Y < 1) return { x: focus.x * LEAN, y: focus.y * LEAN, z };
    return { x: clamp(focus.x, -X, X), y: clamp(focus.y, -Y, Y), z };
  }

  root.StarMap = { FILL, SHRINK_MIN, ZOOM_MIN, CLOSE_AT, balance, layout, home, apart, least, ringOf, ringLength };
})(globalThis);
