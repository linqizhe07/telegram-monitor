import assert from 'node:assert/strict';
import { test } from 'node:test';

// The live view's map in numbers (src/console/starmap.js): a plain browser script that sets
// globalThis.StarMap.
interface Room {
  k: number;
  g: number;
  zoom: number;
  fill: number;
}
interface Node {
  id: string;
  r: number;
  arc?: number | null;
  center?: boolean;
}
interface Edge {
  a: string;
  b: string;
  overlap: number;
}
interface StarMapApi {
  SHRINK_MIN: number;
  ZOOM_MIN: number;
  balance(w: number, h: number, radii: number[], news?: number): Room;
  layout(input: { w: number; h: number; g?: number; nodes: Node[]; edges?: Edge[]; galaxies?: string[][] }): Map<string, { x: number; y: number; arc: number | null }>;
  home(w: number, h: number, room: Room, focus: { x: number; y: number } | null): { x: number; y: number; z: number };
  apart(ra: number, rb: number, overlap: number): number;
  least(ra: number, rb: number): number;
}
const file = '../src/console/starmap.js';
await import(file);
const SM = (globalThis as unknown as { StarMap: StarMapApi }).StarMap;

// The stage at 1440 px wide, and a nebula's own size there (crawler.js: 44 + 1.15·√messages, at most 148, times the stage's scale).
const W = 1398;
const H = 502;
const S = Math.min(W / 1200, H / 540);
const own = (messages: number) => Math.min(148, 44 + 1.15 * Math.sqrt(messages)) * S;
const NEWS = 118 * S;
// Today's groups as the console had them: messages in the last day.
const TODAY = [1308, 1108, 96, 0, 1, 2, 17, 0, 855, 9067, 27];

function map(counts: number[], edges: Edge[] = [], galaxies: string[][] = [], arcs: Map<string, number> = new Map()) {
  const room = SM.balance(W, H, counts.map(own), NEWS);
  const nodes: Node[] = counts.map((m, i) => ({ id: `g${i}`, r: own(m) * room.k, arc: arcs.get(`g${i}`) ?? null }));
  nodes.push({ id: 'news', r: NEWS * room.k, center: true });
  const at = SM.layout({ w: W, h: H, g: room.g, nodes, edges, galaxies });
  return { room, nodes, at, dist: (a: string, b: string) => Math.hypot(at.get(a)!.x - at.get(b)!.x, at.get(a)!.y - at.get(b)!.y) };
}

/** No two nebulae on top of each other, and every centre on the map. */
function settled(m: ReturnType<typeof map>) {
  const { nodes, at, room } = m;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const [p, q] = [nodes[i], nodes[j]];
      const want = p.center || q.center ? (p.r + q.r) * 0.98 : SM.least(p.r, q.r);
      assert.ok(m.dist(p.id, q.id) >= want * 0.97, `${p.id} and ${q.id} overlap`);
    }
    const c = at.get(nodes[i].id)!;
    assert.ok(Math.abs(c.x) <= (W / 2) * room.g && Math.abs(c.y) <= (H / 2) * room.g, `${nodes[i].id} is off the map`);
  }
}

test("today's groups fit the stage at their own size, spread round the news as in the first view", () => {
  const m = map(TODAY);
  assert.deepEqual([m.room.k, m.room.g, m.room.zoom], [1, 1, 1], 'nothing shrinks, the stage is the world, the default zoom is 1');
  settled(m);
  assert.deepEqual(m.at.get('news'), { x: 0, y: 0, arc: null });
  const xs = TODAY.map((_, i) => m.at.get(`g${i}`)!.x);
  const ys = TODAY.map((_, i) => m.at.get(`g${i}`)!.y);
  assert.ok(Math.max(...xs) - Math.min(...xs) > W * 0.6, 'across the stage');
  assert.ok(Math.max(...ys) - Math.min(...ys) > H * 0.5, 'above and below the news');
  // The title's corner (520 × 84 at the top left) holds no nebula's centre.
  for (let i = 0; i < TODAY.length; i++) {
    const c = m.at.get(`g${i}`)!;
    assert.ok(!(c.x < -W / 2 + 520 && c.y < -H / 2 + 84), `g${i} is under the title`);
  }
});

test('groups that share topics sit as close as they share; a galaxy sits together; the rest share the ring', () => {
  const edges = [
    { a: 'g2', b: 'g6', overlap: 0.11 },
    { a: 'g1', b: 'g9', overlap: 0.072 },
    { a: 'g2', b: 'g10', overlap: 0.025 },
  ];
  const m = map(TODAY, edges, [['g1', 'g9'], ['g2', 'g6']]);
  settled(m);
  const r = (id: string) => m.nodes.find((n) => n.id === id)!.r;
  for (const e of edges) {
    const want = SM.apart(r(e.a), r(e.b), e.overlap);
    assert.ok(Math.abs(m.dist(e.a, e.b) - want) < want * 0.2, `${e.a}–${e.b}: ${m.dist(e.a, e.b).toFixed(0)}, want ${want.toFixed(0)}`);
  }
  assert.ok(m.dist('g2', 'g6') / (r('g2') + r('g6')) < m.dist('g1', 'g9') / (r('g1') + r('g9')), 'the more they share, the closer');
  // Groups next to each other on the ring that share nothing are further apart, for their size.
  const order = [...m.at].filter(([id]) => id !== 'news').sort((p, q) => p[1].arc! - q[1].arc!).map(([id]) => id);
  const linked = new Set(edges.map((e) => [e.a, e.b].sort().join()));
  const loose = order.map((id, i) => [id, order[(i + 1) % order.length]]).filter(([a, b]) => !linked.has([a, b].sort().join()));
  const ratio = loose.map(([a, b]) => m.dist(a, b) / (r(a) + r(b))).sort((p, q) => p - q);
  assert.ok(ratio[Math.floor(ratio.length / 2)] > m.dist('g1', 'g9') / (r('g1') + r('g9')), 'the rest are spread out');
  for (const [a, b] of [['g1', 'g9'], ['g2', 'g6']]) {
    const i = order.indexOf(a);
    assert.ok([order[(i + 1) % order.length], order[(i - 1 + order.length) % order.length]].includes(b), `${a} and ${b} sit side by side`);
  }
});

test('a new day moves the groups that drew together and leaves the others in their order; the same day twice moves nothing', () => {
  const day1 = map(TODAY, [{ a: 'g2', b: 'g6', overlap: 0.11 }], [['g2', 'g6']]);
  const arcs = new Map([...day1.at].filter(([, p]) => p.arc !== null).map(([id, p]) => [id, p.arc!]));
  const again = map(TODAY, [{ a: 'g2', b: 'g6', overlap: 0.11 }], [['g2', 'g6']], arcs);
  for (const [id, p] of day1.at) assert.ok(Math.hypot(p.x - again.at.get(id)!.x, p.y - again.at.get(id)!.y) < 1, `${id} moved on the same day`);

  // Day two: g0 and g5, far apart on day one, share topics.
  const ring1 = [...day1.at].filter(([id]) => id !== 'news').sort((p, q) => p[1].arc! - q[1].arc!).map(([id]) => id);
  assert.ok(Math.abs(ring1.indexOf('g0') - ring1.indexOf('g5')) > 1, 'they did not sit side by side');
  const day2 = map(TODAY, [{ a: 'g2', b: 'g6', overlap: 0.11 }, { a: 'g0', b: 'g5', overlap: 0.09 }], [['g2', 'g6'], ['g0', 'g5']], arcs);
  settled(day2);
  const ring2 = [...day2.at].filter(([id]) => id !== 'news').sort((p, q) => p[1].arc! - q[1].arc!).map(([id]) => id);
  const i = ring2.indexOf('g0');
  assert.ok([ring2[(i + 1) % ring2.length], ring2[(i - 1 + ring2.length) % ring2.length]].includes('g5'), 'now they do');
  // Everyone else keeps their order round the ring.
  const rest = (ring: string[]) => {
    const others = ring.filter((id) => id !== 'g0' && id !== 'g5');
    const k = others.indexOf('g1');
    return [...others.slice(k), ...others.slice(0, k)];
  };
  assert.deepEqual(rest(ring2), rest(ring1));
});

test('as groups are added: first the nebulae shrink, then the world grows and the default view zooms out, then it follows the group being read', () => {
  const many = (n: number) => [...TODAY, ...Array.from({ length: n }, (_, i) => 20 + ((i * 7919) % 2400))];
  const steps = [0, 8, 25, 80, 250].map((n) => ({ n: TODAY.length + n, m: map(many(n)) }));
  const [today, more, lots, crowd, throng] = steps.map((s) => s.m.room);
  assert.deepEqual([today.k, today.g, today.zoom], [1, 1, 1]);
  assert.ok(more.k < 1 && more.k >= SM.SHRINK_MIN && more.g === 1 && more.zoom === 1, `${JSON.stringify(more)}: smaller nebulae, the same stage`);
  assert.ok(lots.k === SM.SHRINK_MIN && lots.g > 1 && lots.zoom < 1, 'as small as they go; the world grows');
  assert.ok(crowd.g > lots.g && crowd.zoom === 1 / crowd.g, 'and the default view still shows all of it');
  assert.ok(throng.zoom === SM.ZOOM_MIN && 1 / throng.g < SM.ZOOM_MIN, 'zoomed out as far as it goes');
  for (const { m } of steps.slice(0, 4)) settled(m);

  // The default view: the whole stage, leaning toward the group being read…
  assert.deepEqual(SM.home(W, H, today, { x: 400, y: -100 }), { x: 80, y: -20, z: 1 });
  // …and, when the map is bigger than the default zoom shows, around that group, never past the map's edge.
  const v = SM.home(W, H, throng, { x: 50, y: 30 });
  assert.deepEqual([v.x, v.y, v.z], [50, 30, SM.ZOOM_MIN]);
  const edge = SM.home(W, H, throng, { x: 1e6, y: -1e6 });
  assert.equal(edge.x, (W / 2) * throng.g - W / 2 / SM.ZOOM_MIN);
  assert.equal(edge.y, -((H / 2) * throng.g - H / 2 / SM.ZOOM_MIN));
});
