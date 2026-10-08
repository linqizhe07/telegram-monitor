// The live view. Each group is a nebula of points sized by its messages of the last day, the
// first-tier news is one more, and the reader is a crawler that walks to whichever group just had
// something new. It has two kinds of hands: the keyword detector (cyan) tags the words that matter,
// and the denoiser (grey) pulls out what the digest drops (stickers, one-word chatter, bot commands,
// repeats, scams) and shreds it. The noise verdicts and the news flags are the service's own (the
// denoiser's rules, the radar's matches); tickers, numbers, links and questions are simple patterns
// on the message text. Everything moves only on real events: the activity stream, the radar, the
// counts.
//
// Drawing: a nebula is rendered once into its own canvas (a sprite) and drawn from there; a frame
// only draws the sprites, a few hundred twinkles, the crawler, its legs, the links and the tags. The
// loop stops when the view is off screen or the page is hidden, and shows still pictures when the
// system asks for reduced motion. Words are drawn on the canvas, never parsed as HTML.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const C = { bg: '#040507', ink: '#dde4ea', muted: '#6c7883', faint: '#36404a', cyan: '#5cc8ec', pink: '#ff5c8a', teal: '#4fd1b0', yellow: '#e8c05a', white: '#f2f5f7' };
  const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace';
  const NUM = new Intl.NumberFormat('en-US');
  const n = (x) => (x === null || x === undefined ? '—' : NUM.format(x));
  const usd = (x) => `$${(x || 0).toFixed(x >= 1 ? 2 : 3)}`;
  const HM = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const now = () => Date.now() / 1000;
  /** At most `max` characters, counted as characters (an emoji is not cut in half), with an ellipsis. */
  const cut = (s, max) => {
    const a = Array.from(String(s ?? ''));
    return a.length > max ? `${a.slice(0, max - 1).join('')}…` : a.join('');
  };

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const setText = (node, t) => {
    if (node && node.textContent !== String(t)) node.textContent = String(t);
  };

  // ── seeded randomness: a group's nebula has the same shape on every load ──

  function rng(seed) {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

  // ── the stage ──────────────────────────────────────────────────────────

  const stage = $('stage');
  const canvas = $('stage-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { w: 0, h: 0, dpr: 1, s: 1 };
  const cam = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
  /**
   * The room the map has (starmap.js): `k` scales the nebulae, `g` the world (1: the stage), `zoom`
   * is the default view's. The stage is the world while the groups fit on it.
   */
  let room = { k: 1, g: 1, zoom: 1, fill: 0 };
  const StarMap = window.StarMap;
  /** Gas colours for the nebulae (each group keeps its own), the news, and the group being read. */
  const HUES = ['92,200,236', '112,128,255', '170,112,255', '79,209,176', '90,160,255'];
  const NEWS_RGB = '92,200,236';
  const PINK_RGB = '255,92,138';

  /** A nebula: one group, or the news. */
  const clouds = new Map();
  let order = [];
  let activeKey = null;

  function cloudFor(key, kind, title) {
    let c = clouds.get(key);
    if (!c) {
      c = { key, kind, title, chatId: kind === 'group' ? Number(key.slice(2)) : null, seed: hash(key), count: 0, sub: '', x: 0, y: 0, tx: 0, ty: 0, r: 40, n: 0, pts: null, sprite: null, tint: null, tintColor: '', glow: 0, channel: false };
      // Its gas colour, spin and orbit come from a second seed: the points' shape stays as it was.
      const R2 = rng(hash(`${key}·look`));
      c.hue = kind === 'news' ? NEWS_RGB : HUES[Math.floor(R2() * HUES.length)];
      c.spin = (0.01 + R2() * 0.018) * (R2() < 0.5 ? -1 : 1);
      c.tilt = (R2() - 0.5) * 0.9;
      c.orbitDir = R2() < 0.5 ? -1 : 1;
      c.heat = 0;
      c.base = 0;
      clouds.set(key, c);
    }
    c.title = title;
    return c;
  }

  /** A group's messages: its last 24 hours, or that day's when another day is shown. */
  const countOf = (c) => (mapDay && c.kind === 'group' ? dayCount.get(c.chatId) ?? 0 : c.count);
  /** A nebula's own size on this stage; the map scales it by `room.k` (starmap.js). */
  function ownRadius(c) {
    const base = c.kind === 'news' ? 118 : Math.min(148, 44 + 1.15 * Math.sqrt(countOf(c)));
    return base * view.s;
  }
  function pointsOf(c) {
    const raw = c.kind === 'news' ? 520 + c.count * 7 : 260 + countOf(c) * 0.32;
    return Math.round(Math.min(2800, raw) * Math.max(0.35, Math.min(1, view.s * room.k)));
  }

  function makeCloud(c) {
    const R = rng(c.seed);
    const r = c.r;
    const pts = new Float32Array(c.n * 3);
    const arms = 3 + Math.floor(R() * 3);
    const armA = Array.from({ length: arms }, () => R() * Math.PI * 2);
    const curl = (R() - 0.5) * 2.4;
    c.arms = armA;
    c.curl = curl;
    for (let i = 0; i < c.n; i++) {
      const k = R();
      let x;
      let y;
      if (k < 0.5) {
        x = gauss(R) * r * 0.32;
        y = gauss(R) * r * 0.26;
      } else if (k < 0.86) {
        const t = Math.pow(R(), 0.8);
        const a = armA[Math.floor(R() * arms)] + curl * t;
        x = Math.cos(a) * t * r + gauss(R) * r * 0.06;
        y = Math.sin(a) * t * r * 0.78 + gauss(R) * r * 0.06;
      } else {
        const a = R() * Math.PI * 2;
        const d = r * (0.55 + R() * 0.6);
        x = Math.cos(a) * d;
        y = Math.sin(a) * d * 0.8;
      }
      pts[i * 3] = x;
      pts[i * 3 + 1] = y;
      pts[i * 3 + 2] = R();
    }
    c.pts = pts;
    c.twinkle = Array.from({ length: Math.min(70, Math.round(c.n * 0.05)) }, () => ({ i: Math.floor(R() * c.n), ph: R() * 6.283, sp: 0.6 + R() * 1.8 }));
  }

  /** The nebula drawn once: a faint mesh to its nearest neighbours, then the points. */
  function renderSprite(c) {
    const size = Math.ceil((c.r * 1.3 + 16) * 2);
    const dpr = view.dpr;
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(size * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, (size / 2) * dpr, (size / 2) * dpr);
    const pts = c.pts;
    const cell = Math.max(5, c.r * 0.1);
    const grid = new Map();
    for (let i = 0; i < c.n; i++) {
      const k = `${Math.floor(pts[i * 3] / cell)},${Math.floor(pts[i * 3 + 1] / cell)}`;
      const list = grid.get(k);
      if (list) list.push(i);
      else grid.set(k, [i]);
    }
    g.strokeStyle = 'rgba(214, 226, 236, 0.1)';
    g.lineWidth = 0.5;
    g.beginPath();
    for (let i = 0; i < c.n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      let best = -1;
      let bd = cell * cell;
      let second = -1;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const list = grid.get(`${gx + dx},${gy + dy}`);
          if (!list) continue;
          for (let q = 0; q < list.length && q < 24; q++) {
            const j = list[q];
            if (j <= i) continue;
            const d = (pts[j * 3] - x) ** 2 + (pts[j * 3 + 1] - y) ** 2;
            if (d < bd) {
              second = best;
              best = j;
              bd = d;
            }
          }
        }
      }
      for (const j of pts[i * 3 + 2] > 0.7 ? [best, second] : [best]) {
        if (j < 0) continue;
        g.moveTo(x, y);
        g.lineTo(pts[j * 3], pts[j * 3 + 1]);
      }
    }
    g.stroke();
    const buckets = [[], [], [], []];
    for (let i = 0; i < c.n; i++) buckets[Math.min(3, Math.floor(pts[i * 3 + 2] * 4))].push(i);
    buckets.forEach((list, b) => {
      g.fillStyle = `rgba(232, 238, 244, ${[0.22, 0.38, 0.58, 0.85][b]})`;
      g.beginPath();
      const s = [0.7, 0.9, 1.15, 1.5][b];
      for (const i of list) g.rect(pts[i * 3] - s / 2, pts[i * 3 + 1] - s / 2, s, s);
      g.fill();
    });
    const glow = g.createRadialGradient(0, 0, 0, 0, 0, c.r);
    glow.addColorStop(0, 'rgba(210, 222, 234, 0.09)');
    glow.addColorStop(1, 'rgba(210, 222, 234, 0)');
    g.fillStyle = glow;
    g.fillRect(-c.r, -c.r, c.r * 2, c.r * 2);
    c.sprite = { canvas: cv, size };
    c.tint = null;
    c.gasCache = null;
  }

  /** The same sprite in one colour (its alpha kept), for the group being read and for the news. */
  function tintOf(c, color) {
    if (c.tint && c.tintColor === color) return c.tint;
    const cv = document.createElement('canvas');
    cv.width = c.sprite.canvas.width;
    cv.height = c.sprite.canvas.height;
    const g = cv.getContext('2d');
    g.drawImage(c.sprite.canvas, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    c.tint = { canvas: cv, size: c.sprite.size };
    c.tintColor = color;
    return c.tint;
  }

  const titleBox = () => ({ x: -view.w / 2, y: -view.h / 2, w: Math.min(520, view.w * 0.45), h: view.w < 700 ? 64 : 84 });
  /** On a narrow stage only the group being read and the news are labelled. */
  const compact = () => view.w < 700;
  const labelled = (c) => !compact() || c.key === activeKey || c.kind === 'news';

  /**
   * Where each nebula goes (starmap.js): on a ring around the news, as in the first view, the groups
   * that share topics that day side by side and as close as they share, each one otherwise kept
   * where it was. Laid out again only when something it depends on changed.
   */
  let laidFor = '';
  function layout() {
    const groups = order.map((k) => clouds.get(k)).filter(Boolean);
    const news = clouds.get('news');
    const edges = routes.map((r) => ({ a: `g:${r.a}`, b: `g:${r.b}`, overlap: r.overlap }));
    const sets = galaxies.map((g) => g.members.map((id) => `g:${id}`));
    const sig = JSON.stringify([view.w, view.h, room.g, groups.map((c) => [c.key, Math.round(c.r)]), news ? Math.round(news.r) : 0, edges, sets]);
    if (sig === laidFor) return;
    laidFor = sig;
    const nodes = groups.map((c) => ({ id: c.key, r: c.r, arc: c.arc }));
    if (news) nodes.push({ id: news.key, r: news.r, center: true });
    const at = StarMap.layout({ w: view.w, h: view.h, g: room.g, nodes, edges, galaxies: sets });
    for (const c of [...groups, news].filter(Boolean)) {
      const p = at.get(c.key);
      if (!p) continue;
      c.tx = p.x;
      c.ty = p.y;
      if (c.kind === 'group') c.arc = p.arc;
      if (!c.placed) {
        c.x = c.tx;
        c.y = c.ty;
        c.placed = true;
      }
    }
    placeLabels();
  }

  /** The default view (starmap.js): the whole map, leaning toward the group being read; or around that group, when the map is bigger than the stage shows. */
  const homeView = (active) => StarMap.home(view.w, view.h, room, active ? { x: active.x, y: active.y } : null);

  /** A galaxy's disc: around its groups' nebulae (null when fewer than two are on the stage). */
  function galaxyRing(g) {
    const cs = g.members.map((id) => clouds.get(`g:${id}`)).filter(Boolean);
    if (cs.length < 2) return null;
    const x = cs.reduce((t, c) => t + c.x, 0) / cs.length;
    const y = cs.reduce((t, c) => t + c.y, 0) / cs.length;
    const r = Math.max(...cs.map((c) => Math.hypot(c.x - x, (c.y - y) / 0.72) + c.r * 1.25)) + 18;
    return { x, y, r };
  }
  const routeMid = (r, A, B) => [(A.x + B.x) / 2 + r.bend * (B.y - A.y) * 0.5, (A.y + B.y) / 2 - r.bend * (B.x - A.x) * 0.5];
  const toScreen = (x, y) => [view.w / 2 + (x - cam.x) * cam.z, view.h / 2 + (y - cam.y) * cam.z];
  const toWorld = (sx, sy) => [cam.x + (sx - view.w / 2) / cam.z, cam.y + (sy - view.h / 2) / cam.z];

  // ── the day's map: loading it, and the day bar ─────────────────────────

  async function loadMap(day = mapDay) {
    try {
      const v = await get(`/api/map${day ? `?day=${encodeURIComponent(day)}` : ''}`);
      mapView = v;
      const was = mapDay;
      mapDay = v.map.day === v.today ? '' : v.map.day;
      dayCount.clear();
      for (const node of v.map.nodes) dayCount.set(node.chatId, node.messages);
      routes.length = 0;
      for (const e of v.map.edges) routes.push({ ...e, bend: ((hash(`${e.a}:${e.b}`) % 100) / 100 - 0.5) * 0.6, ph: (hash(`${e.a}:${e.b}`) % 1000) / 1000 });
      galaxies = v.map.galaxies.map((g) => ({ ...g, key: g.members.join(':') }));
      nodeTopics.clear();
      for (const node of v.map.nodes) nodeTopics.set(node.chatId, node.topics);
      if (view.w) rebuildClouds(false);
      void was;
      renderDays();
      wake();
    } catch {
      // the console is restarting; the next look tries again
    }
  }
  /** Each group's own topics that day (for its card). */
  const nodeTopics = new Map();
  setInterval(() => !document.hidden && !mapDay && loadMap(''), 5 * 60_000);

  let playing = 0;
  function renderDays() {
    const box = $('stage-days');
    if (!box || !mapView) return;
    // The kept days that have messages (today always).
    const days = mapView.days.filter((d) => d.messages > 0 || d.day === mapView.today).reverse();
    const shown = mapDay || mapView.today;
    const sig = JSON.stringify([days, shown, Boolean(playing)]);
    if (box.__sig === sig) return;
    box.__sig = sig;
    const label = (d) => (d.day === mapView.today ? 'Today' : d.day.slice(5).replace('-', '/'));
    box.replaceChildren(
      el('button', { type: 'button', class: `play${playing ? ' on' : ''}`, title: playing ? 'Stop' : 'Play the days: how the groups drew together and apart', 'aria-label': playing ? 'Stop playing the days' : 'Play the days', onclick: () => (playing ? stopPlay() : play()) }, playing ? '■' : '▶'),
      ...days.map((d) => el('button', { type: 'button', class: d.day === shown ? 'on' : '', title: `${d.day} · ${n(d.messages)} messages · the nebulae placed by that day's topics`, 'aria-pressed': d.day === shown ? 'true' : 'false', onclick: () => {
        stopPlay();
        loadMap(d.day === mapView.today ? '' : d.day);
      } }, label(d))),
    );
  }
  function play() {
    if (!mapView) return;
    const days = mapView.days.filter((d) => d.messages > 0 || d.day === mapView.today).reverse().map((d) => d.day);
    let i = 0;
    const step = () => {
      const d = days[i++];
      if (!d) return stopPlay();
      loadMap(d === mapView.today ? '' : d);
      playing = setTimeout(step, 2600);
    };
    playing = 1;
    step();
  }
  function stopPlay() {
    if (playing) clearTimeout(playing);
    playing = 0;
    renderDays();
  }

  /** A label's size on the screen: its title in the font drawText uses, or its second line if wider. */
  function labelSize(c) {
    ctx.font = `${c.key === activeKey ? 600 : 500} ${c.key === activeKey || c.kind === 'news' ? 14 : 12.5}px ${MONO}`;
    const title = ctx.measureText(cut(c.title, 26)).width;
    ctx.font = `10.5px ${MONO}`;
    const sub = ctx.measureText(mapDay && c.kind === 'group' ? `${n(countOf(c))} on 00/00` : String(c.sub || '')).width;
    return { w: Math.max(title, sub) + 8, h: c.kind === 'news' && !compact() ? 72 : 30 };
  }

  /**
   * Each label above-right of its nebula, or in the first other spot that is free and on the stage
   * at the default view: clear of the other labels and of what the stage shows over the map (the
   * title, the day bar, the legend, the zoom).
   */
  function placeLabels() {
    const a = clouds.get(activeKey);
    const at = StarMap.home(view.w, view.h, room, a ? { x: a.tx, y: a.ty } : null);
    const z = at.z;
    const boxes = [];
    // Where the stage is, on the map, at the default view; what lies over it is in the way there.
    const frame = { x: at.x - view.w / 2 / z, y: at.y - view.h / 2 / z };
    const s = stage.getBoundingClientRect();
    for (const e of stage.querySelectorAll('.stage-title, .stage-days, .stage-legend, .stage-zoom')) {
      const b = e.getBoundingClientRect();
      if (b.width && b.height) boxes.push({ x: frame.x + (b.left - s.left - 6) / z, y: frame.y + (b.top - s.top - 4) / z, w: (b.width + 12) / z, h: (b.height + 8) / z });
    }
    const hit = (b) => boxes.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
    const inside = (b) => b.x >= frame.x + 6 / z && b.x + b.w <= frame.x + (view.w - 6) / z && b.y >= frame.y + 4 / z && b.y + b.h <= frame.y + (view.h - 4) / z;
    for (const c of [...clouds.values()].filter(labelled).sort((p, q) => (p.kind === 'news' ? -1 : q.kind === 'news' ? 1 : p.key === activeKey ? -1 : q.key === activeKey ? 1 : p.ty - q.ty))) {
      const size = labelSize(c);
      const w = size.w / z;
      const h = size.h / z;
      const spots = [[c.r * 0.28, -c.r * 0.92 - 22 / z], [c.r * 0.28, c.r * 0.7], [-w - c.r * 0.2, -c.r * 0.6], [c.r * 0.6, -c.r * 0.2], [-w - c.r * 0.2, c.r * 0.5], [-w / 2, c.r * 0.85], [-w / 2, -c.r * 0.95 - h]];
      const box = ([dx, dy]) => ({ x: c.tx + dx, y: c.ty + dy, w, h });
      // Nowhere free: the spot that stays on the stage.
      const pick = spots.find((p) => !hit(box(p)) && inside(box(p))) || spots.find((p) => inside(box(p))) || spots[0];
      c.lx = pick[0];
      c.ly = pick[1] + 14 / z;
      boxes.push(box(pick));
    }
  }

  /** The room the map has; then sizes, points and sprites (again only for nebulae whose size changed); then where they go. */
  function rebuildClouds(force) {
    const news = clouds.get('news');
    room = StarMap.balance(view.w, view.h, [...clouds.values()].filter((c) => c.kind === 'group').map(ownRadius), news ? ownRadius(news) : 0);
    for (const c of clouds.values()) {
      const r = ownRadius(c) * room.k;
      const pts = pointsOf(c);
      if (!force && c.sprite && Math.abs(r - c.r) < c.r * 0.06 && Math.abs(pts - c.n) < c.n * 0.12) continue;
      c.r = r;
      c.n = pts;
      makeCloud(c);
      renderSprite(c);
    }
    layout();
  }

  let resizeTimer = 0;
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const dprChanged = dpr !== view.dpr;
    view.w = w;
    view.h = h;
    view.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const s = Math.max(0.42, Math.min(1.15, Math.min(w / 1200, h / 540)));
    const scaleChanged = Math.abs(s - view.s) > 0.04;
    view.s = s;
    buildSky();
    rebuildClouds(dprChanged || scaleChanged);
    if (calm.matches && shouldRun()) draw(performance.now());
    wake();
  }
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }).observe(stage);
  // A window moved to a screen of another pixel density keeps its size: the observer above does not
  // fire, so watch the density itself.
  function watchDensity() {
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener('change', () => {
      resize();
      watchDensity();
    }, { once: true });
  }
  watchDensity();

  // ── the crawler ────────────────────────────────────────────────────────

  const crawler = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, legs: [], placed: false, feedUntil: 0 };
  for (let i = 0; i < 16; i++) crawler.legs.push({ ax: 0, ay: 0, fx: 0, fy: 0, next: 0, from: 0, key: null });

  /** What the detector's hand holds: the words of the messages just read. */
  const tags = [];
  const pings = [];
  /** One per group and story in today's radar view; drawn bright for a while after a new match. */
  const links = [];
  /**
   * The day's map (src/constellation.ts): a route between two groups whose topics overlap (it
   * names them), and the galaxies such groups form. The day shown ('' = today, live), the days kept,
   * and each group's messages that day (its size, on a day that is not today).
   */
  const routes = [];
  let galaxies = [];
  let mapDay = '';
  let mapView = null;
  const dayCount = new Map();
  /** What the pointer is over (a nebula, a route or a galaxy), and the owner's own view (zoom, pan). */
  let hover = null;
  const user = { on: false, x: 0, y: 0, z: 1 };
  /** How hard the news nebula's jets burn: 1 when news just came in, fading. */
  let newsFlare = 0;
  /** When the crawler locked on to its group (the lock closes in), and the jump that took it there. */
  let lockAt = 0;
  let warp = null;
  /** Plasma behind the crawler as it moves, and the data it draws in from a nebula as it reads. */
  const trail = [];
  const streams = [];
  const KIND = {
    news: { color: C.pink, filled: true, label: 'news' },
    ticker: { color: C.cyan, label: 'ticker' },
    number: { color: C.yellow, label: 'number' },
    link: { color: C.teal, label: 'link' },
    mention: { color: C.white, label: 'mention' },
    ask: { color: C.pink, label: 'ask' },
    read: { color: C.muted, label: 'read' },
  };

  function spawnTag(text, kind, cloud) {
    const k = KIND[kind] || KIND.read;
    const label = k.filled ? `⚑ ${text} · ${k.label}` : `${text} · ${k.label}`;
    ctx.font = `11px ${MONO}`;
    const w = ctx.measureText(label).width + 12;
    const a = Math.random() * Math.PI * 2;
    const d = (60 + Math.random() * 80) * Math.max(0.6, view.s);
    const ox = cloud ? cloud.x : crawler.x;
    const oy = cloud ? cloud.y : crawler.y;
    tags.push({ label, kind, color: k.color, filled: Boolean(k.filled), w, h: 17, x: ox + Math.cos(a) * d - w / 2, y: oy + Math.sin(a) * d * 0.75, vx: Math.cos(a) * 3, vy: Math.sin(a) * 2, born: performance.now(), ttl: kind === 'news' ? 9000 : 6000 });
    while (tags.length > 18) tags.shift();
    wake();
  }

  /** What the denoiser's hand takes out: pulled from the nebula to the crawler, then shredded. */
  const noise = [];
  const dust = [];
  function spawnNoise(text, kind, cloud) {
    const raw = String(text).replace(/\s+/g, ' ').trim();
    const label = `${cut(raw, 14) || '(empty)'} · ${kind}`;
    ctx.font = `11px ${MONO}`;
    const w = ctx.measureText(label).width + 12;
    const j = Math.floor(Math.random() * Math.max(1, cloud.n));
    const x = cloud.x + (cloud.pts ? cloud.pts[j * 3] : 0) * 0.9;
    const y = cloud.y + (cloud.pts ? cloud.pts[j * 3 + 1] : 0) * 0.9;
    noise.push({ label, w, h: 17, sx: x - w / 2, sy: y - 8, x: x - w / 2, y: y - 8, born: performance.now(), hold: 700 + Math.random() * 500, pull: 900 });
    while (noise.length > 10) noise.shift();
    wake();
  }
  function shred(x, y) {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 20 + Math.random() * 60;
      dust.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: performance.now(), life: 500 + Math.random() * 500 });
    }
    while (dust.length > 160) dust.shift();
  }

  /** A ring going out: one check of every chat the account is in, or news arriving. Not in still mode. */
  function ping(x, y, color = C.cyan) {
    if (calm.matches) return;
    pings.push({ x, y, color, born: performance.now() });
    while (pings.length > 6) pings.shift();
    wake();
  }

  function focus(key) {
    if (!clouds.has(key) || key === activeKey) return;
    const to = clouds.get(key);
    // A long way to the next group: the crawler jumps, and leaves a streak behind.
    if (crawler.placed && Math.hypot(to.x - crawler.x, to.y - crawler.y) > 160) warp = { x: crawler.x, y: crawler.y, at: performance.now() };
    lockAt = performance.now();
    activeKey = key;
    showTitle();
    placeLabels();
    renderTabs();
    wake();
  }

  // ── a frame ────────────────────────────────────────────────────────────

  let raf = 0;
  let onScreen = true;
  let last = performance.now();
  let stillTimer = 0;

  function shouldRun() {
    return onScreen && !document.hidden && view.w > 0;
  }
  function wake() {
    if (!shouldRun()) return;
    if (calm.matches) {
      // Reduced motion: still pictures, at most two a second, only when something changed.
      if (!stillTimer) stillTimer = setTimeout(() => {
        stillTimer = 0;
        if (shouldRun()) draw(performance.now());
      }, 500);
      return;
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function loop(t) {
    raf = 0;
    if (!shouldRun()) return;
    if (calm.matches) return wake(); // the setting changed while running: switch to stills
    draw(t);
    raf = requestAnimationFrame(loop);
  }
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    wake();
  }).observe(stage);
  document.addEventListener('visibilitychange', wake);
  calm.addEventListener('change', () => {
    last = performance.now();
    wake();
  });

  const ease = (a, b, k) => a + (b - a) * k;

  function draw(t) {
    const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
    last = t;
    const time = t / 1000;
    const still = calm.matches;
    const active = clouds.get(activeKey);
    const newsCloud = clouds.get('news');
    // What just happened fades: a group's burst of messages, the news' flare.
    const cool = Math.exp(-dt / 90);
    for (const c of clouds.values()) c.heat *= cool;
    newsFlare *= Math.exp(-dt / 2.5);

    // Nebulae glide to their places; the camera leans toward the group being read.
    const k = still ? 1 : 1 - Math.exp(-dt * 2.2);
    for (const c of clouds.values()) {
      c.x = ease(c.x, c.tx, k);
      c.y = ease(c.y, c.ty, k);
      c.glow = ease(c.glow, c.key === activeKey ? 1 : 0, still ? 1 : 1 - Math.exp(-dt * 3));
    }
    if (user.on) {
      cam.tx = user.x;
      cam.ty = user.y;
      cam.tz = user.z;
    } else {
      const f = homeView(active);
      cam.tx = f.x + (still ? 0 : Math.sin(time * 0.07) * 9);
      cam.ty = f.y + (still ? 0 : Math.cos(time * 0.05) * 6);
      cam.tz = f.z;
    }
    const kc = still ? 1 : 1 - Math.exp(-dt * 1.4);
    cam.x = ease(cam.x, cam.tx, kc);
    cam.y = ease(cam.y, cam.ty, kc);
    cam.z = ease(cam.z, cam.tz, kc);

    // The crawler walks to the group it reads, then wanders inside it.
    if (active) {
      const wr = active.r * 0.32;
      const gx = active.x + (still ? 0 : Math.sin(time * 0.31) * wr);
      const gy = active.y + (still ? 0 : Math.sin(time * 0.23 + 1) * wr * 0.6);
      if (!crawler.placed || still) {
        crawler.x = gx;
        crawler.y = gy;
        crawler.vx = 0;
        crawler.vy = 0;
        crawler.placed = true;
      } else {
        const kk = 9;
        const damp = 2 * Math.sqrt(kk);
        crawler.vx += ((gx - crawler.x) * kk - crawler.vx * damp) * dt;
        crawler.vy += ((gy - crawler.y) * kk - crawler.vy * damp) * dt;
        crawler.x += crawler.vx * dt;
        crawler.y += crawler.vy * dt;
      }
      const speed = Math.hypot(crawler.vx, crawler.vy);
      if (speed > 4) {
        const want = Math.atan2(crawler.vy, crawler.vx);
        let d = want - crawler.heading;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        crawler.heading += d * Math.min(1, dt * 4);
      }
    }

    const W = view.w;
    const H = view.h;
    const dpr = view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawSky(time, still);
    const z = cam.z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));

    // Galaxies: groups whose topics overlap, held in one soft disc.
    for (const g of galaxies) {
      const ring = galaxyRing(g);
      if (!ring) continue;
      ctx.save();
      ctx.translate(ring.x, ring.y);
      const halo = ctx.createRadialGradient(0, 0, ring.r * 0.15, 0, 0, ring.r);
      const on = hover && hover.galaxy === g.key;
      halo.addColorStop(0, `rgba(79,209,176,${on ? 0.08 : 0.05})`);
      halo.addColorStop(0.7, `rgba(112,128,255,${on ? 0.05 : 0.03})`);
      halo.addColorStop(1, 'rgba(112,128,255,0)');
      ctx.fillStyle = halo;
      ctx.scale(1, 0.72);
      ctx.beginPath();
      ctx.arc(0, 0, ring.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.teal;
      ctx.globalAlpha = on ? 0.4 : 0.16;
      ctx.lineWidth = 0.8 / 0.72;
      ctx.setLineDash([2, 10]);
      ctx.lineDashOffset = still ? 0 : -time * 4;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Nebulae: the sprite, its colour when it is the news or the group being read, and twinkles.
    // Those the camera does not see (with their orbits) are not drawn.
    const seen = { x0: cam.x - W / 2 / z, x1: cam.x + W / 2 / z, y0: cam.y - H / 2 / z, y1: cam.y + H / 2 / z };
    const inView = (c) => c.x + c.r * 1.7 > seen.x0 && c.x - c.r * 1.7 < seen.x1 && c.y + c.r * 1.7 > seen.y0 && c.y - c.r * 1.7 < seen.y1;
    for (const c of clouds.values()) {
      if (!c.sprite || !inView(c)) continue;
      const s = c.sprite.size * (1 + (still ? 0 : c.glow * 0.012 * Math.sin(time * 1.3)));
      if (c.kind === 'group') drawOrbit(c, time, still, false);
      // The gas, turning slowly, in the group's own colour (pink while it is read).
      const gas = gasOf(c, c.hue);
      if (gas) {
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.rotate(still ? 0 : time * c.spin);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = c.kind === 'news' ? 0.85 : 0.5 * (1 - c.glow * 0.6) + 0.15;
        ctx.drawImage(gas.canvas, -s / 2, -s / 2, s, s);
        if (c.glow > 0.02 && c.kind !== 'news') {
          ctx.globalAlpha = c.glow * 0.75;
          ctx.drawImage(gasOf(c, PINK_RGB).canvas, -s / 2, -s / 2, s, s);
        }
        ctx.restore();
      }
      ctx.globalAlpha = c.kind === 'news' ? 0.45 : 0.5 + c.glow * 0.2;
      ctx.drawImage(c.sprite.canvas, c.x - s / 2, c.y - s / 2, s, s);
      const tint = c.kind === 'news' ? 0.85 : c.channel ? 0.35 * (1 - c.glow) + c.glow : c.glow;
      if (tint > 0.01) {
        ctx.globalAlpha = tint;
        const sp = tintOf(c, c.kind === 'news' || (c.channel && c.glow < 0.5) ? C.cyan : C.pink);
        ctx.drawImage(sp.canvas, c.x - s / 2, c.y - s / 2, s, s);
      }
      if (!still && c.twinkle) {
        ctx.fillStyle = c.kind === 'news' ? C.cyan : c.glow > 0.5 ? '#ffd1de' : C.white;
        for (const p of c.twinkle) {
          const a = 0.5 + 0.5 * Math.sin(time * p.sp + p.ph);
          if (a < 0.55) continue;
          ctx.globalAlpha = (a - 0.5) * 1.6;
          ctx.fillRect(c.x + c.pts[p.i * 3] - 0.9, c.y + c.pts[p.i * 3 + 1] - 0.9, 1.8, 1.8);
        }
      }
      // The core: a star with spikes, brighter the busier the group is.
      const core = c.r * (c.kind === 'news' ? 0.95 : 0.55 + 0.05 * (c.base + c.heat));
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(still ? 0 : time * 0.03 + c.tilt);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(0.95, (c.kind === 'news' ? 0.55 + newsFlare * 0.4 : 0.35 + c.glow * 0.35) * (still ? 1 : 0.9 + 0.1 * Math.sin(time * 2 + c.tilt * 7)));
      ctx.drawImage(spikeSprite(), -core, -core, core * 2, core * 2);
      ctx.restore();
      if (c.kind === 'group') drawOrbit(c, time, still, true);
    }
    ctx.globalAlpha = 1;

    // Routes: two groups whose topics overlap that day; the more they share, the brighter.
    for (const r of routes) {
      const A = clouds.get(`g:${r.a}`);
      const B = clouds.get(`g:${r.b}`);
      if (!A || !B) continue;
      const [mx, my] = routeMid(r, A, B);
      const near = hover && (hover.route === r || hover.chatId === r.a || hover.chatId === r.b);
      const lit = near || (active && (active.chatId === r.a || active.chatId === r.b));
      ctx.strokeStyle = C.teal;
      ctx.globalAlpha = Math.min(0.75, 0.16 + r.overlap * 2.4) * (lit ? 1.5 : 1);
      ctx.lineWidth = (0.6 + Math.min(2.4, r.overlap * 9)) / Math.max(0.5, cam.z);
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(mx, my, B.x, B.y);
      ctx.stroke();
      if (!still) {
        // Packets: as many as the overlap is strong.
        const packets = 1 + Math.min(3, Math.floor(r.overlap * 12));
        for (let q = 0; q < packets; q++) {
          const u = (time * 0.07 + r.ph + q / packets) % 1;
          const px = (1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * mx + u * u * B.x;
          const py = (1 - u) * (1 - u) * A.y + 2 * (1 - u) * u * my + u * u * B.y;
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = q % 2 ? C.white : C.teal;
          const z = 2.6 / Math.max(0.5, cam.z);
          ctx.fillRect(px - z / 2, py - z / 2, z, z);
        }
      }
    }
    ctx.globalAlpha = 1;

    // The news as a quasar: twin jets that flare when news comes in, and its accretion rings.
    if (newsCloud && newsCloud.sprite) {
      const q = newsCloud;
      ctx.save();
      ctx.translate(q.x, q.y);
      ctx.rotate(-0.32);
      ctx.globalCompositeOperation = 'lighter';
      const len = q.r * (1.2 + newsFlare * 0.9) * (still ? 1 : 0.96 + 0.04 * Math.sin(time * 6));
      for (const dir of [-1, 1]) {
        const jet = ctx.createLinearGradient(0, 0, 0, dir * len);
        jet.addColorStop(0, `rgba(${NEWS_RGB},${0.4 + newsFlare * 0.45})`);
        jet.addColorStop(0.6, `rgba(${NEWS_RGB},${0.08 + newsFlare * 0.15})`);
        jet.addColorStop(1, `rgba(${NEWS_RGB},0)`);
        ctx.fillStyle = jet;
        const w = 1.8 + newsFlare * 2.6;
        ctx.beginPath();
        ctx.moveTo(-w, 0);
        ctx.lineTo(w, 0);
        ctx.lineTo(0.5, dir * len);
        ctx.lineTo(-0.5, dir * len);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 0.8;
      for (const [rx, ry, a, sp] of [[q.r * 0.6, q.r * 0.15, 0.45, 26], [q.r * 0.86, q.r * 0.22, 0.22, -14], [q.r * 1.1, q.r * 0.28, 0.1, 8]]) {
        ctx.globalAlpha = Math.min(0.85, a + newsFlare * 0.3);
        ctx.setLineDash([5, 9]);
        ctx.lineDashOffset = still ? 0 : time * sp;
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Links: a group that talked about one of today's stories, to the news nebula.
    if (newsCloud) {
      for (const l of links) {
        const g = clouds.get(`g:${l.chatId}`);
        if (!g) continue;
        const mx = (g.x + newsCloud.x) / 2 + l.bend * 0.25 * (newsCloud.y - g.y);
        const my = (g.y + newsCloud.y) / 2 - l.bend * 0.25 * (newsCloud.x - g.x);
        const age = Math.max(0, t - l.born) / 1000;
        ctx.strokeStyle = l.level === 'hot' || l.level === 'first' ? C.pink : C.cyan;
        ctx.globalAlpha = age < 8 ? 0.55 : 0.2;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.quadraticCurveTo(mx, my, newsCloud.x, newsCloud.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (!still && age < 12) {
          const u = (age / 1.8) % 1;
          const px = (1 - u) * (1 - u) * g.x + 2 * (1 - u) * u * mx + u * u * newsCloud.x;
          const py = (1 - u) * (1 - u) * g.y + 2 * (1 - u) * u * my + u * u * newsCloud.y;
          ctx.globalAlpha = 1;
          ctx.fillStyle = ctx.strokeStyle;
          ctx.fillRect(px - 2, py - 2, 4, 4);
        }
      }
      ctx.globalAlpha = 1;
    }

    if (active) drawLock(active, t, time, still);

    // Pings.
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      const age = Math.max(0, t - p.born) / 1400;
      if (age >= 1 || still) {
        pings.splice(i, 1);
        continue;
      }
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.4 * (1 - age);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 18 + age * 210 * view.s, (18 + age * 210 * view.s) * 0.72, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (active && !still) {
      const sz = crawlerSize() * crawlerScale();
      const speed = Math.hypot(crawler.vx, crawler.vy);
      if (speed > 14) {
        const back = crawler.heading + Math.PI;
        for (let k = 0; k < 2; k++) {
          trail.push({ x: crawler.x + Math.cos(back) * 20 * sz + (Math.random() - 0.5) * 8, y: crawler.y + Math.sin(back) * 14 * sz + (Math.random() - 0.5) * 8, vx: Math.cos(back) * 24 + (Math.random() - 0.5) * 30, vy: Math.sin(back) * 24 + (Math.random() - 0.5) * 30, born: t, life: 450 + Math.random() * 550 });
        }
        while (trail.length > 140) trail.shift();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    const tz = crawlerScale();
    for (let i = trail.length - 1; i >= 0; i--) {
      const p = trail[i];
      const age = (t - p.born) / p.life;
      if (age >= 1 || still) {
        trail.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ctx.globalAlpha = 0.7 * (1 - age);
      ctx.fillStyle = age < 0.3 ? C.white : C.cyan;
      const z = (2.2 * (1 - age) + 0.6) * tz;
      ctx.fillRect(p.x - z / 2, p.y - z / 2, z, z);
    }
    if (warp && !still) {
      const age = (t - warp.at) / 650;
      if (age >= 1) warp = null;
      else {
        const grad = ctx.createLinearGradient(warp.x, warp.y, crawler.x, crawler.y);
        grad.addColorStop(0, `rgba(${NEWS_RGB},0)`);
        grad.addColorStop(1, `rgba(${NEWS_RGB},${0.55 * (1 - age)})`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 2.2 * (1 - age) + 0.4;
        ctx.beginPath();
        ctx.moveTo(warp.x, warp.y);
        ctx.lineTo(crawler.x, crawler.y);
        ctx.stroke();
        ctx.strokeStyle = C.cyan;
        ctx.lineWidth = 0.8;
        for (let k = 1; k <= 4; k++) {
          const f = k / 5;
          ctx.globalAlpha = 0.32 * (1 - age) * f;
          ctx.beginPath();
          ctx.ellipse(warp.x + (crawler.x - warp.x) * f, warp.y + (crawler.y - warp.y) * f, 24 * f + 8, (24 * f + 8) * 0.68, crawler.heading, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    for (let i = streams.length - 1; i >= 0; i--) {
      const p = streams[i];
      const u = (t - p.born) / p.dur;
      if (u >= 1 || still) {
        streams.splice(i, 1);
        continue;
      }
      if (u < 0) continue;
      const e = u * u;
      const mx = (p.sx + crawler.x) / 2 + p.bend * (crawler.y - p.sy);
      const my = (p.sy + crawler.y) / 2 - p.bend * (crawler.x - p.sx);
      const at = (v) => [(1 - v) * (1 - v) * p.sx + 2 * (1 - v) * v * mx + v * v * crawler.x, (1 - v) * (1 - v) * p.sy + 2 * (1 - v) * v * my + v * v * crawler.y];
      const [x1, y1] = at(e);
      const [x0, y0] = at(Math.max(0, e - 0.08));
      ctx.globalAlpha = 0.85 * Math.min(1, u * 4);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.fillStyle = p.color;
      ctx.fillRect(x1 - 1.2, y1 - 1.2, 2.4, 2.4);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    if (active) drawCrawler(t, time, active, still);

    // Shredded noise: dust in the world.
    ctx.fillStyle = '#9aa5b0';
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      const age = Math.max(0, t - d.born);
      if (age > d.life || still) {
        dust.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      ctx.globalAlpha = 0.8 * (1 - age / d.life);
      ctx.fillRect(d.x - 0.8, d.y - 0.8, 1.6, 1.6);
    }
    ctx.globalAlpha = 1;

    // ── on top, at their own size whatever the zoom: boxes, labels, what routes and galaxies mean ──
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const [csx, csy] = toScreen(crawler.x, crawler.y);
    ctx.font = `11px ${MONO}`;
    // The denoiser's hand: grab, hold, pull to the crawler, shred.
    for (let i = noise.length - 1; i >= 0; i--) {
      const q = noise[i];
      const age = Math.max(0, t - q.born);
      // Reduced motion: no pull, the tag just stands there for as long and then goes.
      const u = still ? (age >= q.hold + q.pull ? 1 : 0) : Math.max(0, Math.min(1, (age - q.hold) / q.pull));
      const e = u * u * (3 - 2 * u);
      q.x = ease(q.sx, crawler.x - q.w / 2, e);
      q.y = ease(q.sy, crawler.y - q.h / 2, e);
      if (u >= 1) {
        if (!still) shred(crawler.x, crawler.y);
        noise.splice(i, 1);
        continue;
      }
      const [bx, by] = toScreen(q.x + q.w / 2, q.y + q.h / 2);
      const x = bx - q.w / 2;
      const y = by - q.h / 2;
      const alpha = Math.min(1, age / 200) * (1 - e * 0.7);
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = '#8994a0';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      // the claw
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 3);
      ctx.lineTo(x + 2, y + q.h / 2);
      ctx.lineTo(x - 4, y + q.h + 3);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(12, 15, 19, 0.9)';
      ctx.fillRect(x, y, q.w, q.h);
      ctx.strokeStyle = C.faint;
      ctx.strokeRect(x + 0.5, y + 0.5, q.w - 1, q.h - 1);
      ctx.fillStyle = C.muted;
      ctx.fillText(q.label, x + 6, y + 12);
      ctx.fillRect(x + 5, y + 8, q.w - 10, 1); // struck through: it will not be read
    }
    ctx.globalAlpha = 1;

    // The detector's hand: tags, each with a tentacle back to the crawler.
    for (let i = tags.length - 1; i >= 0; i--) {
      const g = tags[i];
      const age = Math.max(0, t - g.born);
      if (age > g.ttl) {
        tags.splice(i, 1);
        continue;
      }
      if (!still) {
        g.x += g.vx * dt;
        g.y += g.vy * dt;
      }
      const [bx, by] = toScreen(g.x + g.w / 2, g.y + g.h / 2);
      const x = bx - g.w / 2;
      const y = by - g.h / 2;
      const alpha = Math.min(1, age / 250) * Math.min(1, (g.ttl - age) / 700);
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(csx, csy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g.filled ? g.color : 'rgba(4, 5, 7, 0.86)';
      ctx.fillRect(x, y, g.w, g.h);
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, g.w - 1, g.h - 1);
      ctx.fillStyle = g.filled ? '#140409' : g.color;
      ctx.fillText(g.label, x + 6, y + 12);
    }
    ctx.globalAlpha = 1;
    drawText(active);

    // A still picture still has to take tags away when their time is up.
    if (still && (tags.length || noise.length)) wake();
  }

  /** Everything read rather than seen, at its own size whatever the zoom: galaxies' names, the nebulae's labels, what routes share, the lock. */
  function drawText(active) {
    const z = cam.z;
    ctx.textBaseline = 'alphabetic';
    // A crowded map (more than 12 groups) names only its busiest groups and biggest galaxies at the
    // default zoom, with the one being read and the one under the pointer; zoomed in, every one.
    const crowded = order.length > 12 && z < room.zoom * 1.4;
    const busy = (g) => g.members.reduce((t, id) => t + countOf(clouds.get(`g:${id}`) ?? { count: 0 }), 0);
    const named = new Set(galaxies.slice().sort((a, b) => b.members.length - a.members.length || busy(b) - busy(a)).slice(0, crowded ? 6 : galaxies.length).map((g) => g.key));
    for (const g of galaxies) {
      const ring = galaxyRing(g);
      if (!ring || !g.topics.length) continue;
      if (!named.has(g.key) && hover?.galaxy !== g.key && !(active && g.members.includes(active.chatId))) continue;
      const [sx, sy] = toScreen(ring.x, ring.y - ring.r * 0.72);
      const big = z < 0.8;
      ctx.font = `${big ? 600 : 500} ${big ? 12.5 : 10.5}px ${MONO}`;
      ctx.fillStyle = C.teal;
      ctx.globalAlpha = hover && hover.galaxy === g.key ? 1 : big ? 0.92 : 0.62;
      const label = `✦ ${g.topics.slice(0, 3).join(' · ')}`;
      ctx.fillText(label, sx - ctx.measureText(label).width / 2, sy - 6);
    }
    // Zoomed far out, only the three busiest groups are named.
    const few = crowded || z < 0.6;
    const biggest = new Set([...clouds.values()].filter((c) => c.kind === 'group').sort((a, b) => countOf(b) - countOf(a)).slice(0, crowded ? 10 : 3).map((c) => c.key));
    for (const c of clouds.values()) {
      if (!labelled(c)) continue;
      if (few && !(c.key === activeKey || c.kind === 'news' || hover?.chatId === c.chatId || biggest.has(c.key))) continue;
      const [lx, ly] = toScreen(c.x + (c.lx ?? c.r * 0.28), c.y + (c.ly ?? -c.r * 0.92 - 8));
      ctx.font = `${c.key === activeKey ? 600 : 500} ${c.key === activeKey || c.kind === 'news' ? 14 : 12.5}px ${MONO}`;
      ctx.fillStyle = c.kind === 'news' ? C.cyan : c.key === activeKey ? C.pink : C.ink;
      ctx.globalAlpha = c.key === activeKey || c.kind === 'news' || hover?.chatId === c.chatId ? 1 : 0.82;
      ctx.fillText(cut(c.title, 26), lx, ly);
      ctx.font = `10.5px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(mapDay && c.kind === 'group' ? `${n(countOf(c))} on ${mapDay.slice(5).replace('-', '/')}` : c.sub, lx, ly + 14);
      if (c.kind === 'news' && c.words && !compact()) {
        ctx.fillStyle = C.cyan;
        ctx.globalAlpha = 0.75;
        c.words.forEach((w, i) => ctx.fillText(w, lx, ly + 30 + i * 13));
      }
    }
    // What a route stands for: the topics two groups share, and how much.
    const strongest = routes.slice(0, 2);
    ctx.font = `10.5px ${MONO}`;
    for (const r of routes) {
      const A = clouds.get(`g:${r.a}`);
      const B = clouds.get(`g:${r.b}`);
      if (!A || !B || !r.topics.length) continue;
      const near = hover && (hover.route === r || hover.chatId === r.a || hover.chatId === r.b);
      // On a narrow stage, only the route under the pointer (or every one, zoomed in).
      if (compact() ? !(near || z >= 1.35) : !(near || (active && (active.chatId === r.a || active.chatId === r.b)) || z >= 1.35 || strongest.includes(r))) continue;
      const [mx, my] = routeMid(r, A, B);
      const [sx, sy] = toScreen(0.25 * A.x + 0.5 * mx + 0.25 * B.x, 0.25 * A.y + 0.5 * my + 0.25 * B.y);
      const label = `${r.topics.slice(0, 3).join(' · ')}  ${Math.round(r.overlap * 100)}%`;
      const w = ctx.measureText(label).width + 10;
      ctx.globalAlpha = near ? 1 : 0.88;
      ctx.fillStyle = 'rgba(4, 6, 9, 0.84)';
      ctx.fillRect(sx - w / 2, sy - 9, w, 16);
      ctx.strokeStyle = near ? C.teal : 'rgba(79, 209, 176, 0.45)';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(sx - w / 2 + 0.5, sy - 8.5, w - 1, 15);
      ctx.fillStyle = C.teal;
      ctx.fillText(label, sx - w / 2 + 5, sy + 3);
    }
    if (active && lockCorner) {
      const [sx, sy] = toScreen(lockCorner.x, lockCorner.y);
      ctx.font = `10px ${MONO}`;
      ctx.fillStyle = C.pink;
      ctx.globalAlpha = 0.8 * lockCorner.e;
      ctx.fillText(`◢ LOCK${lockCorner.live ? ' · LIVE' : ''}`, sx, sy - 6);
    }
    ctx.globalAlpha = 1;
  }

  /** Where the lock's top-left bracket is (its readout goes above it, drawn with the other text). */
  let lockCorner = null;

  /** The lock on the group being read: brackets that close in when the crawler arrives, a turning scale, a radar sweep. */
  function drawLock(a, t, time, still) {
    const u = still ? 1 : Math.min(1, (t - lockAt) / 520);
    const e = 1 - Math.pow(1 - u, 3);
    const sc = 1 + (1 - e) * 0.7;
    const hw = a.r * 1.08 * sc;
    const hh = a.r * 0.86 * sc;
    const L = Math.max(8, Math.min(18, a.r * 0.22));
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.strokeStyle = C.pink;
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.2 + 0.5 * e;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * hw, sy * (hh - L));
      ctx.lineTo(sx * hw, sy * hh);
      ctx.lineTo(sx * (hw - L), sy * hh);
      ctx.stroke();
    }
    // Hairlines from the brackets toward the edges of the stage, very faint.
    ctx.globalAlpha = 0.06 * e;
    ctx.beginPath();
    ctx.moveTo(-hw - 6, 0);
    ctx.lineTo(-hw - a.r * 1.6, 0);
    ctx.moveTo(hw + 6, 0);
    ctx.lineTo(hw + a.r * 1.6, 0);
    ctx.stroke();
    // The radar sweep.
    if (!still) {
      ctx.save();
      ctx.scale(1, 0.74);
      const rr = a.r * 1.22;
      const th = time * 1.15;
      const sweep = ctx.createRadialGradient(0, 0, a.r * 0.2, 0, 0, rr);
      sweep.addColorStop(0, 'rgba(255,92,138,0)');
      sweep.addColorStop(1, 'rgba(255,92,138,0.16)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = e;
      ctx.fillStyle = sweep;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, rr, th - 0.55, th);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // A turning scale.
    ctx.rotate(still ? 0 : time * 0.12);
    ctx.globalAlpha = 0.18 * e;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    const rr = a.r * 1.24;
    for (let i = 0; i < 72; i++) {
      const ang = (i / 72) * Math.PI * 2;
      const len = i % 9 === 0 ? 7 : 3;
      ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr * 0.74);
      ctx.lineTo(Math.cos(ang) * (rr + len), Math.sin(ang) * (rr + len) * 0.74);
    }
    ctx.stroke();
    ctx.restore();
    lockCorner = { x: a.x - hw, y: a.y - hh, e, live: a.heat > 0.6 };
    ctx.globalAlpha = 1;
  }

  /** A point along two straight segments (foot → knee → hip), 0 at the foot. */
  const alongLeg = (ex, ey, kx, ky, bx, by, q) => (q < 0.5 ? [ex + (kx - ex) * q * 2, ey + (ky - ey) * q * 2] : [kx + (bx - kx) * (q - 0.5) * 2, ky + (by - ky) * (q - 0.5) * 2]);

  /**
   * How much bigger than the map's scale the crawler is drawn: it stays between 0.85 and 1.25 of its
   * own size on the screen at any zoom, so it is never lost on a map seen whole, nor huge up close.
   */
  const crawlerScale = () => Math.min(1.25, Math.max(0.85, cam.z)) / cam.z;
  const crawlerSize = () => Math.max(0.8, view.s) * 1.2;

  function drawCrawler(t, time, cloud, still) {
    const cx = crawler.x;
    const cy = crawler.y;
    const cz = crawlerScale();
    const s = crawlerSize() * cz;
    const feeding = !still && t < crawler.feedUntil;
    // Legs: each holds a point of the nebula and steps to a new one now and then (in still mode,
    // only when the crawler moves to another group). Jointed: hip, knee, foot; data runs up them
    // while it reads.
    ctx.lineCap = 'round';
    crawler.legs.forEach((leg, i) => {
      if (!leg.placed || leg.key !== cloud.key || (!still && t > leg.next)) {
        const j = Math.floor(Math.random() * cloud.n);
        let ax = cloud.x + cloud.pts[j * 3];
        let ay = cloud.y + cloud.pts[j * 3 + 1];
        const reach = 120 * s;
        const d = Math.hypot(ax - cx, ay - cy);
        if (d > reach) {
          ax = cx + ((ax - cx) / d) * reach;
          ay = cy + ((ay - cy) / d) * reach;
        }
        leg.fx = leg.placed ? leg.ax : ax;
        leg.fy = leg.placed ? leg.ay : ay;
        leg.ax = ax;
        leg.ay = ay;
        leg.from = t;
        leg.next = t + 500 + Math.random() * 1400;
        leg.placed = true;
        leg.key = cloud.key;
      }
      const u = still ? 1 : Math.min(1, Math.max(0, t - leg.from) / 220);
      const ex = ease(leg.fx, leg.ax, u);
      const ey = ease(leg.fy, leg.ay, u);
      const a = (i / crawler.legs.length) * Math.PI * 2 + crawler.heading;
      const bx = cx + Math.cos(a) * 22 * s;
      const by = cy + Math.sin(a) * 15 * s;
      const sway = still ? 0 : Math.sin(time * 3 + i) * 6;
      const kx = (bx + ex) / 2 + Math.cos(a + 1.2) * (12 + sway) * s;
      const ky = (by + ey) / 2 + Math.sin(a + 1.2) * (12 + sway) * s;
      ctx.strokeStyle = C.cyan;
      ctx.globalAlpha = 0.78;
      ctx.lineWidth = 1.3 * cz;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(kx, ky);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.8 * cz;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(kx, ky, 1.7 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.white;
      ctx.fillRect(ex - 1.4 * cz, ey - 1.4 * cz, 2.8 * cz, 2.8 * cz);
      if (!still && u < 1) {
        // A foot landing: a small ring.
        ctx.globalAlpha = 0.6 * (1 - u);
        ctx.beginPath();
        ctx.arc(ex, ey, (2 + u * 8) * cz, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (feeding) {
        const q = (t / 420 + i * 0.137) % 1;
        const [px, py] = alongLeg(ex, ey, kx, ky, bx, by, q);
        ctx.globalAlpha = 1;
        ctx.fillStyle = i % 3 === 0 ? C.pink : C.white;
        ctx.fillRect(px - 1.3 * cz, py - 1.3 * cz, 2.6 * cz, 2.6 * cz);
      }
    });
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(cz, cz);
    drawShell(crawlerSize(), time, still, feeding);
    ctx.restore();
  }

  /** The crawler's body, at the origin, at size `s`. */
  function drawShell(s, time, still, feeding) {
    // The glow, and the scanner: a cone of light ahead, sweeping.
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(glowSprite(), -80 * s, -80 * s, 160 * s, 160 * s);
    const sweep = crawler.heading + (still ? 0 : Math.sin(time * 1.6) * 0.38);
    const reach = 125 * s;
    const cone = ctx.createRadialGradient(0, 0, 10 * s, 0, 0, reach);
    cone.addColorStop(0, 'rgba(92,200,236,0.24)');
    cone.addColorStop(1, 'rgba(92,200,236,0)');
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, reach, sweep - 0.27, sweep + 0.27);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(92,200,236,0.3)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const edge of [-0.27, 0.27]) {
      ctx.moveTo(Math.cos(sweep + edge) * 12 * s, Math.sin(sweep + edge) * 12 * s);
      ctx.lineTo(Math.cos(sweep + edge) * reach, Math.sin(sweep + edge) * reach);
    }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    // Two rings turning against each other: a dashed one outside, a segmented one inside.
    ctx.strokeStyle = C.cyan;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.7;
    ctx.setLineDash([3, 5]);
    ctx.lineDashOffset = still ? 0 : -time * 18;
    ctx.beginPath();
    ctx.ellipse(0, 0, 40 * s, 27 * s, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.save();
    ctx.scale(1, 0.68);
    ctx.rotate(still ? 0 : -time * 0.7);
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 2 * s;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(0, 0, 31 * s, a0, a0 + 0.42);
      ctx.stroke();
    }
    ctx.restore();
    // The shell turns to where it goes: cilia, a hexagon with a lattice, an inner hexagon, antennae.
    ctx.rotate(crawler.heading);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 0; i < 44; i++) {
      const a = (i / 44) * Math.PI * 2;
      const r1 = 25 * s;
      const r2 = r1 + (5 + (still ? 0 : 3 * Math.sin(time * 4 + i * 0.7))) * s;
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1 * 0.68);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2 * 0.68);
    }
    ctx.stroke();
    const hex = (r) => {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r * 0.68;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
    };
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(8, 26, 34, 0.94)';
    hex(25 * s);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.26;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (const ang of [0, Math.PI / 3, (2 * Math.PI) / 3]) {
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      for (let k = -30; k <= 30; k += 6) {
        const ox = -dy * k * s;
        const oy = dx * k * s;
        ctx.moveTo(ox - dx * 40 * s, oy - dy * 40 * s);
        ctx.lineTo(ox + dx * 40 * s, oy + dy * 40 * s);
      }
    }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 0.8;
    hex(13 * s);
    ctx.stroke();
    ctx.globalAlpha = 0.85;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(19 * s, side * 6 * s);
      ctx.lineTo(37 * s, side * 13 * s);
      ctx.stroke();
      ctx.fillStyle = still || Math.sin(time * 5 + side) > 0 ? C.pink : C.cyan;
      ctx.fillRect(37 * s - 1.6, side * 13 * s - 1.6, 3.2, 3.2);
    }
    // The heart: pink, pulsing (harder while it reads), turning.
    ctx.globalCompositeOperation = 'lighter';
    const beat = still ? 0.6 : 0.5 + 0.5 * Math.sin(time * (feeding ? 9 : 4));
    ctx.globalAlpha = Math.min(1, 0.3 + beat * 0.35 + (feeding ? 0.3 : 0));
    ctx.drawImage(heartSprite(), -17 * s, -17 * s, 34 * s, 34 * s);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.rotate(still ? 0.6 : time * 0.9);
    ctx.fillStyle = C.pink;
    ctx.fillRect(-5 * s, -5 * s, 10 * s, 10 * s);
    ctx.fillStyle = C.white;
    ctx.fillRect(-1.5 * s, -1.5 * s, 3 * s, 3 * s);
  }

  let glow = null;
  function glowSprite() {
    if (glow) return glow;
    glow = document.createElement('canvas');
    glow.width = glow.height = 128;
    const g = glow.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(92, 200, 236, 0.35)');
    grad.addColorStop(0.35, 'rgba(92, 200, 236, 0.12)');
    grad.addColorStop(1, 'rgba(92, 200, 236, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return glow;
  }

  // ── deep space: what the nebulae float in ──────────────────────────────

  /** Two layers of stars and a galactic band, drawn once per size; a few bright stars breathe. */
  const sky = { layers: [], bright: [], w: 0, h: 0 };
  const SKY_PAD = 140;
  function buildSky() {
    const W = Math.ceil(view.w + SKY_PAD * 2);
    const H = Math.ceil(view.h + SKY_PAD * 2);
    if (!view.w || (sky.w === W && sky.h === H)) return;
    const R = rng(0x5eed51);
    const layer = () => {
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      return [cv, cv.getContext('2d')];
    };
    const [far, g0] = layer();
    // Far clouds of colour, very faint.
    for (const [fx, fy, fr, rgb, a] of [[0.2, 0.72, 0.42, '70,110,210', 0.08], [0.8, 0.26, 0.48, '125,80,200', 0.07], [0.56, 0.52, 0.36, '40,150,170', 0.05], [0.93, 0.85, 0.3, '200,70,130', 0.035]]) {
      const x = W * fx;
      const y = H * fy;
      const r = Math.max(W, H) * fr;
      const grad = g0.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g0.fillStyle = grad;
      g0.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // The galactic band: a river of dust across the stage.
    const band = (x) => H * 0.66 - (x - W / 2) * 0.32;
    for (let i = 0; i < 3200; i++) {
      const x = R() * W;
      const y = band(x) + gauss(R) * H * 0.085;
      g0.fillStyle = `rgba(205,218,236,${0.03 + R() * 0.12})`;
      g0.fillRect(x, y, R() < 0.9 ? 0.8 : 1.3, R() < 0.9 ? 0.8 : 1.3);
    }
    for (let i = 0; i < 900; i++) {
      g0.fillStyle = `rgba(220,230,242,${0.1 + R() * 0.22})`;
      g0.fillRect(R() * W, R() * H, 0.8, 0.8);
    }
    const [mid, g1] = layer();
    for (let i = 0; i < 260; i++) {
      const tint = R();
      g1.fillStyle = tint < 0.08 ? 'rgba(150,200,255,0.6)' : tint < 0.12 ? 'rgba(255,200,170,0.55)' : `rgba(232,238,246,${0.25 + R() * 0.4})`;
      const z = 0.9 + R() * 0.9;
      g1.fillRect(R() * W, R() * H, z, z);
    }
    sky.layers = [far, mid];
    sky.bright = Array.from({ length: 36 }, () => ({ x: R() * W, y: R() * H, z: 0.9 + R() * 1.5, ph: R() * 6.283, sp: 0.35 + R() * 1.1, color: R() < 0.18 ? C.cyan : R() < 0.1 ? '#ffd1de' : C.white }));
    sky.w = W;
    sky.h = H;
  }

  /** The sky, in screen space, sliding a little against the camera (parallax). */
  function drawSky(time, still) {
    if (!sky.layers.length) return;
    const dpr = view.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    [0.035, 0.09].forEach((f, i) => ctx.drawImage(sky.layers[i], -SKY_PAD - cam.x * f, -SKY_PAD - cam.y * f, sky.w, sky.h));
    for (const b of sky.bright) {
      const a = still ? 0.6 : 0.3 + 0.4 * (0.5 + 0.5 * Math.sin(time * b.sp + b.ph));
      const x = b.x - SKY_PAD - cam.x * 0.16;
      const y = b.y - SKY_PAD - cam.y * 0.16;
      ctx.globalAlpha = a;
      ctx.fillStyle = b.color;
      ctx.fillRect(x - b.z / 2, y - b.z / 2, b.z, b.z);
      ctx.globalAlpha = a * 0.32;
      ctx.fillRect(x - b.z * 3.2, y - 0.25, b.z * 6.4, 0.5);
      ctx.fillRect(x - 0.25, y - b.z * 3.2, 0.5, b.z * 6.4);
    }
    ctx.globalAlpha = 1;
  }

  // ── a nebula's body: gas, core, orbit ──────────────────────────────────

  /** The nebula's gas in one colour: soft clouds along its arms, with dark lanes. Half resolution (it is soft). */
  function gasOf(c, rgb) {
    if (!c.sprite) return null;
    c.gasCache ??= new Map();
    const kept = c.gasCache.get(rgb);
    if (kept) return kept;
    const size = c.sprite.size;
    const res = Math.max(0.5, view.dpr * 0.5);
    const cv = document.createElement('canvas');
    cv.width = cv.height = Math.ceil(size * res);
    const g = cv.getContext('2d');
    g.setTransform(res, 0, 0, res, (size / 2) * res, (size / 2) * res);
    g.globalCompositeOperation = 'lighter';
    const R = rng(c.seed ^ 0x2545f491);
    const r = c.r;
    const blob = (x, y, rad, a) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, `rgba(${rgb},${a})`);
      grad.addColorStop(0.45, `rgba(${rgb},${a * 0.4})`);
      grad.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    };
    blob(0, 0, r * 0.78, 0.13);
    blob(0, 0, r * 0.3, 0.2);
    const curl = c.curl ?? 1;
    for (const a0 of c.arms ?? [0, 2.1, 4.2]) {
      for (let i = 0; i < 22; i++) {
        const t = Math.pow(R(), 0.75);
        const a = a0 + curl * t;
        blob(Math.cos(a) * t * r + gauss(R) * r * 0.05, Math.sin(a) * t * r * 0.78 + gauss(R) * r * 0.05, r * (0.1 + R() * 0.16) * (1.15 - t * 0.55), 0.03 + R() * 0.045);
      }
    }
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6; i++) {
      const a = R() * Math.PI * 2;
      const d = r * (0.22 + R() * 0.5);
      const rad = r * (0.07 + R() * 0.1);
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d * 0.78;
      const grad = g.createRadialGradient(x, y, 0, x, y, rad);
      grad.addColorStop(0, 'rgba(0,0,0,0.55)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    const out = { canvas: cv, size };
    c.gasCache.set(rgb, out);
    return out;
  }

  /** A star with diffraction spikes, drawn once: the core of every nebula. */
  let spikes = null;
  function spikeSprite() {
    if (spikes) return spikes;
    const S = 160;
    spikes = document.createElement('canvas');
    spikes.width = spikes.height = S;
    const g = spikes.getContext('2d');
    g.translate(S / 2, S / 2);
    const core = g.createRadialGradient(0, 0, 0, 0, 0, S * 0.18);
    core.addColorStop(0, 'rgba(255,255,255,0.95)');
    core.addColorStop(0.25, 'rgba(225,238,255,0.5)');
    core.addColorStop(1, 'rgba(200,220,255,0)');
    g.fillStyle = core;
    g.fillRect(-S / 2, -S / 2, S, S);
    for (const [rot, len, w] of [[0, 0.5, 1.1], [Math.PI / 2, 0.5, 1.1], [Math.PI / 4, 0.28, 0.6], [-Math.PI / 4, 0.28, 0.6]]) {
      g.save();
      g.rotate(rot);
      const lg = g.createLinearGradient(-S * len, 0, S * len, 0);
      lg.addColorStop(0, 'rgba(220,235,255,0)');
      lg.addColorStop(0.5, 'rgba(240,248,255,0.85)');
      lg.addColorStop(1, 'rgba(220,235,255,0)');
      g.fillStyle = lg;
      g.fillRect(-S * len, -w / 2, S * len * 2, w);
      g.restore();
    }
    return spikes;
  }

  /** The crawler's heart: a pink glow, drawn once. */
  let heart = null;
  function heartSprite() {
    if (heart) return heart;
    heart = document.createElement('canvas');
    heart.width = heart.height = 64;
    const g = heart.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,92,138,0.9)');
    grad.addColorStop(0.4, 'rgba(255,92,138,0.35)');
    grad.addColorStop(1, 'rgba(255,92,138,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return heart;
  }

  /**
   * A group's orbit: a tilted ring, and one satellite for each step of how busy it is right now (its
   * day's messages, plus what just arrived). Drawn in two halves, so the nebula stands between them.
   */
  function drawOrbit(c, time, still, front) {
    const busy = Math.min(9, Math.round(c.base + c.heat));
    const rx = c.r * 1.12;
    const ry = c.r * 0.34;
    const pink = c.glow > 0.5;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.tilt);
    ctx.strokeStyle = pink ? C.pink : `rgb(${c.hue})`;
    ctx.globalAlpha = (front ? 0.16 : 0.08) + c.glow * (front ? 0.28 : 0.14);
    ctx.lineWidth = 0.6;
    ctx.setLineDash([2, 7]);
    ctx.lineDashOffset = still ? 0 : -time * 6 * c.orbitDir;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const w = (0.16 + c.heat * 0.06) * c.orbitDir;
    for (let i = 0; i < busy; i++) {
      const a = (still ? 0.4 : time * w) + (i / busy) * Math.PI * 2;
      if (Math.sin(a) >= 0 !== front) continue;
      for (let k = 3; k >= 0; k--) {
        const ak = a - k * 0.045 * Math.sign(w || 1);
        ctx.globalAlpha = (k === 0 ? 0.95 : 0.34 / k) * (front ? 1 : 0.45);
        ctx.fillStyle = k === 0 ? (pink ? '#ffd1de' : C.white) : pink ? C.pink : `rgb(${c.hue})`;
        const z = k === 0 ? 2.3 : 1.5;
        ctx.fillRect(Math.cos(ak) * rx - z / 2, Math.sin(ak) * ry - z / 2, z, z);
      }
    }
    ctx.restore();
  }

  // ── words: what the detector tags a kept message with ──────────────────

  const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'USDT', 'USDC', 'TON', 'TRX', 'ADA', 'ZEC', 'OKB', 'HYPE', 'SUI', 'PEPE', 'WLD', 'ARB', 'AVAX', 'LINK', 'LTC', 'BCH', 'DOT', 'NEAR', 'APT', 'ENA', 'ONDO', 'USDE', 'FDUSD', 'SHIB', 'BONK', 'WIF', 'TRUMP', 'XAUT', 'PAXG']);
  // Written in lower case these are still the coin; the rest ("link", "near", "ton", "dot"…) are
  // ordinary words unless written in capitals or as $CASHTAGS.
  const LOWER_OK = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'USDT', 'USDC', 'TRX', 'ZEC', 'OKB', 'PEPE', 'WLD', 'AVAX', 'LTC', 'BCH', 'USDE', 'FDUSD', 'SHIB', 'XAUT', 'PAXG']);
  const ALIASES = [['大饼', 'BTC'], ['比特币', 'BTC'], ['二饼', 'ETH'], ['姨太', 'ETH'], ['以太坊', 'ETH'], ['以太', 'ETH'], ['狗狗币', 'DOGE'], ['大零币', 'ZEC'], ['币安币', 'BNB'], ['瑞波', 'XRP'], ['索拉纳', 'SOL']];

  /** The notable words of a message the denoiser kept, each with what it is. At most `max`. The day's
   * news is not guessed here: the radar's own matches arrive with its view (see setNews). */
  function tagsOf(text, max = 3) {
    const out = [];
    const seen = new Set();
    const add = (word, kind, key = String(word).toLowerCase()) => {
      if (seen.has(key) || out.length >= max) return;
      seen.add(key);
      out.push([cut(word, 22), kind]);
    };
    for (const m of text.matchAll(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g)) add(m[0].toUpperCase(), 'ticker', `t:${m[0].slice(1).toUpperCase()}`);
    for (const m of text.matchAll(/\b[A-Za-z]{2,6}\b/g)) {
      const sym = m[0].toUpperCase();
      if (MAJORS.has(sym) && (m[0] === sym || LOWER_OK.has(sym))) add(sym, 'ticker', `t:${sym}`);
    }
    for (const [alias, sym] of ALIASES) if (text.includes(alias)) add(`${alias} ${sym}`, 'ticker', `t:${sym}`);
    for (const m of text.matchAll(/https?:\/\/([^\s/]+)[^\s]*/g)) add(m[1].replace(/^www\./, ''), 'link');
    for (const m of text.matchAll(/(?:[-+]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbBwW](?![A-Za-z])|[万亿]|[uU](?![A-Za-z])))|\$\d[\d,]*(?:\.\d+)?/g)) add(m[0].trim(), 'number');
    for (const m of text.matchAll(/@[A-Za-z0-9_]{4,32}/g)) add(m[0], 'mention');
    if (/[?？]\s*$/.test(text) && out.length < max) add(Array.from(text.replace(/\s+/g, ' ').trim()).slice(-14).join(''), 'ask');
    if (out.length === 0) {
      const word = (text.match(/[\p{Script=Han}]{2,6}|[A-Za-z]{4,}/u) || [])[0];
      if (word) add(word, 'read');
    }
    return out;
  }

  // ── the head-up display ────────────────────────────────────────────────

  const hud = {};
  function buildHud() {
    const stats = $('hud-stats');
    const field = (label, key, cls = '') => {
      const b = el('b', { class: cls, text: '—' });
      hud[key] = b;
      return el('span', { class: 'hud-field' }, el('span', { class: 'hud-label', text: label }), b);
    };
    stats.replaceChildren(
      field('GROUPS', 'groups'),
      field('MESSAGES', 'messages'),
      field('NEWS', 'news'),
      field('LINKS', 'links', 'cyan'),
      field('FLAGS', 'flags', 'pink'),
      field('NOISE', 'noise', 'dim'),
      field('WRITES', 'writes', 'teal'),
      field('ERRORS', 'errors'),
    );
  }
  buildHud();

  let state = null;
  let news = null;
  let pulse = null;
  let pulseStale = false;
  let lagsLoaded = false;
  const lags = [];
  let sessionTagged = 0;
  let sessionDropped = 0;
  /** The radar matches already seen (message ids of the current view), and pairs with a new one. */
  let seenHits = new Set();
  const fresh = new Map();


  function showTitle() {
    const c = clouds.get(activeKey);
    const i = order.indexOf(activeKey);
    setText($('stage-index'), String(i + 1).padStart(2, '0'));
    setText($('stage-group'), c ? c.title : 'Waiting for the reader');
    const src = c && state ? state.sources.find((x) => x.chatId === c.chatId) : null;
    const every = (sec) => (sec >= 60 ? `every ~${Math.round(sec / 60)}m` : `every ~${sec}s`);
    setText($('stage-sub'), src ? [src.perDay !== null ? `~${n(src.perDay)} / day` : `${n(src.messages24h)} today`, src.members ? `${n(src.members)} members` : '', src.pushed ? 'pushed by Telegram' : src.peeked ? `new messages within ~${state.peekSeconds}s` : src.member ? `member · read ${every(src.everyS)}` : `read from outside · ${every(src.everyS)}`].filter(Boolean).join(' · ') : '');
  }

  /** One tab per group. Redrawn only when the groups change; the active one is marked in place. */
  function renderTabs() {
    const box = $('hud-tabs');
    const want = order.map((k) => [k, clouds.get(k)?.title, Boolean(clouds.get(k)?.channel)]);
    const sig = JSON.stringify(want);
    if (box.__sig !== sig) {
      box.__sig = sig;
      box.replaceChildren(...want.map(([k, title, channel]) => el('button', {
        role: 'tab',
        'data-key': k,
        class: channel ? 'channel' : '',
        title,
        onclick: () => {
          focus(k);
          api.onPick?.(Number(k.slice(2)));
        },
      }, title)));
    }
    let on = null;
    for (const b of box.children) {
      const is = b.dataset.key === activeKey;
      b.classList.toggle('on', is);
      if (b.getAttribute('aria-selected') !== String(is)) b.setAttribute('aria-selected', String(is));
      if (is) on = b;
    }
    // Bring the active tab into view inside the strip only (the strip is positioned, so offsetLeft
    // is measured in it); the page itself never scrolls.
    if (on && (on.offsetLeft < box.scrollLeft || on.offsetLeft + on.offsetWidth > box.scrollLeft + box.clientWidth)) {
      box.scrollTo({ left: Math.max(0, on.offsetLeft - 24), behavior: calm.matches ? 'auto' : 'smooth' });
    }
  }

  // ── instruments ────────────────────────────────────────────────────────

  /** Messages stored in the last minute (for the rate), trimmed as they come in. */
  const stored = [];
  function rate() {
    const t = now();
    while (stored.length && stored[0][0] < t - 60) stored.shift();
    return stored.reduce((s, x) => s + x[1], 0);
  }
  setInterval(() => {
    if (document.hidden) return;
    const r = rate();
    setText($('i-rate'), `${r}/m`);
  }, 2000);

  /** The denoiser: what it removed over the last day, by why, across the groups. */
  function renderDenoiser() {
    if (!pulse || !pulse.noise) return;
    const kinds = ['chatter', 'sticker', 'repeat', 'command', 'spam'];
    const sum = Object.fromEntries(kinds.map((k) => [k, pulse.noise.reduce((s, x) => s + (x.removed[k] || 0), 0)]));
    const total = pulse.noise.reduce((s, x) => s + x.total, 0);
    const removed = kinds.reduce((s, k) => s + sum[k], 0);
    setText($('i-noise-pct'), total ? `${Math.round((removed / total) * 100)}% removed` : '—');
    setText($('i-noise-num'), n(removed));
    setText($('i-noise-of'), `of ${n(total)} messages today`);
    setText(hud.noise, n(removed));
    const top = Math.max(1, ...kinds.map((k) => sum[k]));
    const bars = $('i-noise-bars');
    const sig = JSON.stringify(sum);
    if (bars.__sig !== sig) {
      bars.__sig = sig;
      bars.replaceChildren(...kinds.map((k) => {
        const bar = el('i');
        bar.style.width = `${(sum[k] / top) * 100}%`;
        return el('li', {}, el('span', { text: k }), el('span', { class: 'b' }, bar), el('b', { text: n(sum[k]) }));
      }));
    }
    setText($('i-noise-note'), `this session · ${n(sessionTagged)} tagged · ${n(sessionDropped)} dropped`);
  }

  /** The keyword detector: today's top stories (dashed: how many outlets; filled: your groups). */
  /** Messages per hour over the last day, and the day's totals. */
  function renderHeat() {
    if (!pulse || !state) return;
    const grid = $('i-heat-grid');
    const rows = pulse.hours
      .map((h) => ({ ...h, src: state.sources.find((s) => s.chatId === h.chatId) }))
      .filter((h) => h.src && h.src.enabled)
      .sort((a, b) => b.counts.reduce((s, x) => s + x, 0) - a.counts.reduce((s, x) => s + x, 0))
      .slice(0, 7);
    const max = Math.max(1, ...rows.flatMap((r) => r.counts));
    const sig = JSON.stringify([rows.map((r) => [r.chatId, r.counts]), activeKey]);
    if (grid.__sig !== sig) {
      grid.__sig = sig;
      grid.replaceChildren(...rows.map((r) => el('div', { class: `heat-row${`g:${r.chatId}` === activeKey ? ' on' : ''}`, title: `${r.src.title}: messages per hour, last 24 hours` },
        el('span', { class: 'code', text: Array.from(r.src.title.replace(/[^\p{L}\p{N}]/gu, '')).slice(0, 3).join('').toUpperCase() }),
        ...r.counts.map((v, i) => el('i', { class: `l${v ? Math.min(5, 1 + Math.floor((Math.log1p(v) / Math.log1p(max)) * 5)) : 0}`, title: `${HM.format((pulse.from + i * pulse.bucketS) * 1000)} · ${n(v)} messages` })))));
    }
    const total = state.sources.reduce((s, x) => s + x.messages24h, 0);
    setText($('i-heat-total'), n(total));
    const stats = $('i-heat-stats');
    const removed = pulse.noise ? pulse.noise.reduce((s, x) => s + Object.values(x.removed).reduce((a, b) => a + b, 0), 0) : null;
    const vals = [['read', n(total), ''], ['removed', removed === null ? '—' : n(removed), 'dim'], ['linked', news && news.enabled ? n(linkedCount()) : '—', 'cyan'], ['written', n(state.activity.counts.write || 0), 'teal']];
    if (stats.__sig !== JSON.stringify(vals)) {
      stats.__sig = JSON.stringify(vals);
      stats.replaceChildren(...vals.map(([k, v, cls]) => el('div', {}, el('dt', { text: k }), el('dd', { class: cls, text: v }))));
    }
  }

  /** Messages in your groups that named today's news (every echo the radar counted, not a page of them). */
  const linkedCount = () => (news ? news.keywords.reduce((s, k) => s + k.groups.reduce((a, g) => a + g.count, 0), 0) : 0);

  /** How long new messages took from being posted to being stored: the last few, and their median. */
  function renderSpeed() {
    const list = lags.slice(-40);
    const spark = $('i-spark');
    const gauge = $('i-gauge');
    const NS = 'http://www.w3.org/2000/svg';
    setText($('i-speed-n'), list.length ? `${list.length} samples` : lagsLoaded ? 'no samples' : '—');
    spark.setAttribute('viewBox', '0 0 200 40');
    gauge.setAttribute('viewBox', '-50 -50 100 100');
    const arc = (f) => {
      const a0 = Math.PI * 0.75;
      const a1 = a0 + Math.PI * 1.5 * f;
      const r = 40;
      const large = Math.PI * 1.5 * f > Math.PI ? 1 : 0;
      return `M ${Math.cos(a0) * r} ${Math.sin(a0) * r} A ${r} ${r} 0 ${large} 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r}`;
    };
    const path = (f, cls) => {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', arc(f));
      p.setAttribute('class', cls);
      return p;
    };
    if (list.length === 0) {
      spark.replaceChildren();
      gauge.replaceChildren(path(1, 'track'));
      setText($('i-gauge-num'), '—');
      setText($('i-speed-note'), lagsLoaded ? 'no new messages in the last 6 hours' : 'waiting for the first numbers');
      return;
    }
    const recent = list.slice(-10).map((x) => x.lag).sort((a, b) => a - b);
    const median = recent[Math.floor(recent.length / 2)];
    const cap = 60;
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', list.map((x, i) => `${(i / Math.max(1, list.length - 1)) * 200},${36 - (Math.min(cap, x.lag) / cap) * 32}`).join(' '));
    spark.replaceChildren(line);
    // The gauge: three quarters of a circle, full at 0 s, empty at a minute.
    gauge.replaceChildren(path(1, 'track'), path(Math.max(0.001, 1 - Math.min(cap, median) / cap), median <= 15 ? 'good' : median <= 60 ? 'ok' : 'slow'));
    setText($('i-gauge-num'), `${median}s`);
    setText($('i-speed-note'), `median of the last ${recent.length} · fastest ${recent[0]}s`);
  }

  // ── fetching what the view needs on its own ────────────────────────────

  async function get(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  let pulseTimer = 0;
  function loadPulse(delay = 0) {
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(async () => {
      if (document.hidden) {
        pulseStale = true; // fetched when the page is shown again
        return;
      }
      pulseStale = false;
      try {
        pulse = await get('/api/pulse');
        lags.length = 0;
        lags.push(...pulse.lags.slice().reverse());
        lagsLoaded = true;
        renderHeat();
        renderSpeed();
        renderDenoiser();
      } catch {
        // the console is restarting; the next event tries again
      }
    }, delay);
  }
  setInterval(() => !document.hidden && loadPulse(), 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && pulseStale) loadPulse();
  });

  /**
   * New messages in a group: the crawler goes there; the denoiser takes out the noise and the
   * detector tags the rest. `at` is when the service stored them (for how long that took); `seed`
   * is the first look at page load, which moves nothing in the log or the counts.
   */
  const readAt = new Map();
  async function read(chatId, count, at, seed = false) {
    const c = clouds.get(`g:${chatId}`);
    if (!c) return;
    focus(c.key);
    ping(c.x, c.y, C.pink);
    // Nobody is watching, or this group was just read (a catch-up stores in bursts): no fetch.
    if (document.hidden || performance.now() - (readAt.get(chatId) || -1e9) < 1500) return;
    readAt.set(chatId, performance.now());
    try {
      const msgs = await get(`/api/messages?chat=${encodeURIComponent(chatId)}&limit=${Math.min(6, Math.max(1, count))}&noise=1`);
      let spawned = 0;
      const dropped = [];
      const tagged = [];
      // What it reads streams in from the nebula: cyan what is kept, grey what the denoiser drops.
      const t0 = performance.now();
      msgs.slice(-6).forEach((m, k) => {
        for (let q = 0; q < 3; q++) {
          const j = Math.floor(Math.random() * c.n);
          streams.push({ sx: c.x + c.pts[j * 3], sy: c.y + c.pts[j * 3 + 1], born: t0 + k * 120 + q * 60, dur: 620 + Math.random() * 420, color: m.noise ? '#8994a0' : C.cyan, bend: (Math.random() - 0.5) * 0.7 });
        }
      });
      while (streams.length > 160) streams.shift();
      crawler.feedUntil = t0 + 1600;
      for (const m of msgs.slice(-6)) {
        if (m.noise) {
          dropped.push(m.noise);
          setTimeout(() => spawnNoise(m.text || '', m.noise, c), spawned++ * 160);
          continue;
        }
        for (const [word, kind] of tagsOf(m.text || '', 2)) {
          tagged.push(word);
          setTimeout(() => spawnTag(word, kind, c), spawned++ * 160);
        }
      }
      if (seed) return;
      sessionDropped += dropped.length;
      sessionTagged += tagged.length;
      renderDenoiser();
      // Stored at `at`; the newest of them was posted at its date: that is how long it took.
      const newest = msgs[msgs.length - 1];
      if (newest && at && newest.date <= at + 5) {
        lags.push({ at, chatId, lag: Math.max(0, Math.round(at - newest.date)) });
        while (lags.length > 60) lags.shift();
        renderSpeed();
      }
    } catch {
      // nothing to tag this time
    }
  }

  /** The source an activity row is about. Rows name chats by title: an ambiguous title gives none. */
  function sourceByTitle(title) {
    if (!state) return null;
    const on = state.sources.filter((s) => s.enabled && s.title === title);
    if (on.length === 1) return on[0];
    if (on.length > 1) return null;
    const any = state.sources.filter((s) => s.title === title);
    return any.length === 1 ? any[0] : null;
  }

  // ── what the page tells it ─────────────────────────────────────────────

  const api = {
    onPick: null,

    /** The console state (every few seconds). */
    setState(s) {
      const firstTime = !state;
      state = s;
      const enabled = s.sources.filter((x) => x.enabled);
      const keys = new Set(enabled.map((x) => `g:${x.chatId}`));
      for (const k of [...clouds.keys()]) if (k.startsWith('g:') && !keys.has(k)) clouds.delete(k);
      order = enabled.slice().sort((a, b) => b.messages24h - a.messages24h || a.chatId - b.chatId).map((x) => `g:${x.chatId}`);
      for (const src of enabled) {
        const c = cloudFor(`g:${src.chatId}`, 'group', src.title);
        c.count = src.messages24h;
        c.base = Math.min(4, Math.log10(1 + src.messages24h) * 1.1);
        c.sub = `${n(src.messages24h)} today · ${src.error ? 'error' : src.behind ? 'catching up' : src.peeked || src.pushed ? 'live' : `every ~${src.everyS >= 60 ? `${Math.round(src.everyS / 60)}m` : `${src.everyS}s`}`}`;
      }
      if (s.news && !clouds.has('news')) cloudFor('news', 'news', 'first-tier news');
      if (!s.news) clouds.delete('news');
      const nc = clouds.get('news');
      if (nc && s.news) {
        nc.count = s.news.items24h;
        nc.sub = `${n(s.news.items24h)} items · ${s.news.sources} sources`;
      }
      if (view.w) rebuildClouds(false);
      if (!activeKey || !clouds.has(activeKey)) {
        activeKey = null;
        const newest = enabled.slice().sort((a, b) => (b.newest || 0) - (a.newest || 0))[0];
        if (newest) {
          focus(`g:${newest.chatId}`);
          if (firstTime) read(newest.chatId, 4, null, true);
        }
      }
      setText(hud.groups, `${enabled.length}/${s.sources.length}`);
      setText(hud.messages, n(s.sources.reduce((t, x) => t + x.messages24h, 0)));
      setText(hud.writes, n(s.activity.counts.write || 0));
      setText(hud.errors, n(s.activity.errors));
      hud.errors.className = s.activity.errors ? 'pink' : '';
      if (s.news) setText(hud.news, n(s.news.items24h));
      else {
        setText(hud.news, 'off');
        setText(hud.links, '—');
        setText(hud.flags, '—');
      }
      showTitle();
      renderTabs();
      renderHeat();
      setText($('hud-brand'), s.account ? `${s.account.name} · writes only on your click` : 'writes only on your click');
      if (!pulse) loadPulse();
      if (firstTime) loadMap('');
      wake();
    },

    /** The news radar's view (every ~20 seconds, and after news events). */
    setNews(v) {
      const prev = news;
      news = v;
      if (!v.enabled) {
        links.length = 0;
        seenHits = new Set();
        return;
      }
      const channels = new Set(v.sources.filter((x) => x.kind === 'telegram').map((x) => `g:${x.id.slice(3)}`));
      for (const c of clouds.values()) c.channel = channels.has(c.key);
      const nc = clouds.get('news');
      if (nc) {
        nc.words = v.keywords.filter((k) => k.sources.length >= 2).slice(0, 3).map((k) => cut(k.label, 30));
        if (prev && prev.enabled && v.items24h > prev.items24h) {
          ping(nc.x, nc.y, C.cyan);
          newsFlare = 1;
        }
      }
      // New matches: a message the radar matched that was not in the last view. Each becomes a flag
      // at its group, and its group's link to the story is drawn bright.
      const t0 = performance.now();
      const ids = new Set();
      for (const h of v.hits) {
        const id = `${h.chatId}:${h.messageId}`;
        ids.add(id);
        if (!prev || !prev.enabled || seenHits.has(id)) continue;
        const story = h.label.split(' · ')[0];
        const mark = h.marks && h.marks[0];
        const word = mark ? h.text.slice(mark[0], mark[1]) : h.terms[0] || story;
        fresh.set(`${h.chatId}:${h.topicId}`, t0);
        const g = clouds.get(`g:${h.chatId}`);
        if (g) {
          focus(g.key);
          spawnTag(`${cut(word, 16)} → ${cut(story, 18)}`, 'news', g);
        }
        sessionTagged++;
      }
      seenHits = ids;
      for (const [key, t1] of fresh) if (t0 - t1 > 15_000) fresh.delete(key);
      // The links: one per group and story in today's view (stories come and go with the view).
      links.length = 0;
      for (const k of v.keywords) {
        for (const g of k.groups) {
          links.push({ chatId: g.chatId, level: g.level, bend: ((hash(`${g.chatId}:${k.label}`) % 100) / 100 - 0.5) * 1.2, born: fresh.get(`${g.chatId}:${k.id}`) ?? -1e9 });
        }
      }
      setText(hud.links, n(linkedCount()));
      setText(hud.flags, n(v.alerts.length));
      setText(hud.news, n(v.items24h));
      renderHeat();
      wake();
    },

    /** One row of the activity stream, as it happens. */
    activity(a) {
      if (!a.ok) return;
      if (a.kind === 'write') {
        ping(crawler.x, crawler.y, C.pink);
        setTimeout(() => ping(crawler.x, crawler.y, C.pink), 180);
        return;
      }
      const chat = sourceByTitle(a.target);
      if (a.method === 'stored' && chat) {
        const count = Number((/^(\d+)/.exec(a.detail) || [])[1] || 1);
        stored.push([now(), count]);
        const g = clouds.get(`g:${chat.chatId}`);
        if (g) g.heat = Math.min(8, g.heat + 1 + Math.log2(count));
        rate(); // trims what is older than a minute
        read(chat.chatId, count, a.at);
        loadPulse(4000);
      } else if (a.method === 'messages.GetPeerDialogs') {
        if (clouds.get(activeKey)) ping(crawler.x, crawler.y);
      } else if (a.method === 'news in the group' || a.method === 'group was first') {
        const first = a.method === 'group was first';
        if (chat) spawnTag(first ? 'had it first' : 'HOT', 'news', clouds.get(`g:${chat.chatId}`));
      }
    },
  };

  // ── the owner's hands on the map: hover, click, drag, zoom ─────────────

  const card = $('stage-card');
  let drag = null;
  const touches = new Map();
  /** In as far as a nebula's points stay points (2.5×); out as far as the whole map, with a margin. */
  const zoomLimit = (z) => Math.min(2.5, Math.max(Math.min(room.zoom, 1 / room.g) * 0.7, z));
  /** The owner's view, at once (dragging, zooming at the pointer). */
  function setUser(x, y, z) {
    user.on = true;
    user.z = zoomLimit(z);
    user.x = x;
    user.y = y;
    cam.x = cam.tx = user.x;
    cam.y = cam.ty = user.y;
    cam.z = cam.tz = user.z;
    wake();
  }
  /** The owner's view, eased to (double-click a nebula or a galaxy). */
  function glideTo(x, y, z) {
    user.on = true;
    user.x = x;
    user.y = y;
    user.z = zoomLimit(z);
    wake();
  }
  function zoomAt(sx, sy, k) {
    const [wx, wy] = toWorld(sx, sy);
    const z = zoomLimit(cam.z * k);
    setUser(wx - (sx - view.w / 2) / z, wy - (sy - view.h / 2) / z, z);
  }
  /** Back to the default view (it follows the crawler). */
  function fit() {
    user.on = false;
    wake();
  }
  const local = (e) => {
    const b = stage.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  const onControl = (e) => e.target.closest('button, .stage-days, .stage-zoom, .stage-card');

  /** What is under a point of the stage: a nebula, else a route, else a galaxy's disc. */
  function hitAt(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    let best = null;
    let bd = Infinity;
    for (const c of clouds.values()) {
      const d = Math.hypot(wx - c.x, wy - c.y);
      if (d < c.r * 0.72 && d < bd) {
        bd = d;
        best = c;
      }
    }
    if (best) return { kind: 'cloud', c: best };
    for (const r of routes) {
      const A = clouds.get(`g:${r.a}`);
      const B = clouds.get(`g:${r.b}`);
      if (!A || !B) continue;
      const [mx, my] = routeMid(r, A, B);
      for (let i = 1; i < 24; i++) {
        const u = i / 24;
        const [px, py] = toScreen((1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * mx + u * u * B.x, (1 - u) * (1 - u) * A.y + 2 * (1 - u) * u * my + u * u * B.y);
        if (Math.hypot(px - sx, py - sy) < 7) return { kind: 'route', r };
      }
    }
    for (const g of galaxies) {
      const ring = galaxyRing(g);
      if (ring && Math.hypot(wx - ring.x, (wy - ring.y) / 0.72) < ring.r) return { kind: 'galaxy', g };
    }
    return null;
  }

  /** The card beside the pointer: what a nebula talks about, what a route stands for, what a galaxy shares. */
  function showCard(hit, sx, sy) {
    if (!card) return;
    if (!hit) {
      card.hidden = true;
      return;
    }
    const day = mapDay ? `on ${mapDay}` : 'today';
    const name = (id) => cut(clouds.get(`g:${id}`)?.title ?? '?', 20);
    const lines = [];
    if (hit.kind === 'cloud' && hit.c.kind === 'news') {
      lines.push(['First-tier news', 'h'], [`${n(hit.c.count)} items in the last day`, ''], ['Its dashed lines: groups that talked about one of its stories', 'd']);
    } else if (hit.kind === 'cloud') {
      const c = hit.c;
      const near = routes.filter((r) => r.a === c.chatId || r.b === c.chatId).slice(0, 3).map((r) => `${name(r.a === c.chatId ? r.b : r.a)} ${Math.round(r.overlap * 100)}%`);
      lines.push(
        [c.title, 'h'],
        [`${n(countOf(c))} messages ${day}`, ''],
        [`Talks about: ${(nodeTopics.get(c.chatId) || []).slice(0, 6).join(' · ') || '—'}`, 't'],
        [near.length ? `Closest by topic: ${near.join(' · ')}` : `No other group shares its topics ${day}`, 'd'],
        ['Click: its messages · double-click: zoom in', 'k'],
      );
    } else if (hit.kind === 'route') {
      const r = hit.r;
      lines.push(
        [`${name(r.a)} ↔ ${name(r.b)}`, 'h'],
        [`Same topics ${day}: ${r.topics.join(' · ')}`, 't'],
        [`Overlap ${Math.round(r.overlap * 100)}%: how much of what sets each group apart from the others is the same. The more, the closer they sit.`, 'd'],
      );
    } else {
      const g = hit.g;
      lines.push([`Galaxy · ${g.members.length} groups`, 'h'], [g.members.map(name).join(' · '), ''], [`What they share ${day}: ${g.topics.join(' · ') || '—'}`, 't'], ['Double-click: zoom in', 'k']);
    }
    card.replaceChildren(...lines.map(([text, cls]) => el('div', { class: cls, text })));
    card.hidden = false;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    card.style.left = `${Math.max(8, Math.min(view.w - w - 8, sx + 16))}px`;
    card.style.top = `${Math.max(8, Math.min(view.h - h - 8, sy + 16))}px`;
  }

  stage.addEventListener('pointerdown', (e) => {
    if (onControl(e)) return;
    touches.set(e.pointerId, local(e));
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, id: e.pointerId };
  });
  stage.addEventListener('pointermove', (e) => {
    const [sx, sy] = local(e);
    if (touches.size === 2 && touches.has(e.pointerId)) {
      // Two fingers: pinch.
      const [a, b] = [...touches.values()];
      const before = Math.hypot(a[0] - b[0], a[1] - b[1]);
      touches.set(e.pointerId, [sx, sy]);
      const [c, d] = [...touches.values()];
      const after = Math.hypot(c[0] - d[0], c[1] - d[1]);
      if (before > 0) zoomAt((c[0] + d[0]) / 2, (c[1] + d[1]) / 2, after / before);
      drag = null;
      return;
    }
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [sx, sy]);
    if (drag && e.pointerId === drag.id) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) {
        drag.moved = true;
        stage.setPointerCapture?.(e.pointerId);
        stage.classList.add('panning');
        card.hidden = true;
      }
      if (drag.moved) return setUser(drag.cx - dx / cam.z, drag.cy - dy / cam.z, cam.z);
    }
    if (onControl(e)) return;
    const hit = hitAt(sx, sy);
    hover = hit ? { chatId: hit.c?.chatId ?? null, route: hit.r ?? null, galaxy: hit.g?.key ?? null } : null;
    showCard(hit, sx, sy);
    stage.classList.toggle('pointing', Boolean(hit && hit.kind !== 'galaxy'));
    wake();
  });
  const release = (e) => {
    touches.delete(e.pointerId);
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    stage.classList.remove('panning');
    if (moved || e.type !== 'pointerup') return;
    const [sx, sy] = local(e);
    const hit = hitAt(sx, sy);
    if (hit?.kind === 'cloud' && hit.c.kind === 'group') {
      focus(hit.c.key);
      api.onPick?.(hit.c.chatId);
    }
  };
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);
  stage.addEventListener('pointerleave', () => {
    if (drag) return;
    hover = null;
    if (card) card.hidden = true;
    stage.classList.remove('pointing');
    wake();
  });
  // Plain scrolling scrolls the page; a pinch on the trackpad, or ⌘/Ctrl + scroll, zooms.
  stage.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const [sx, sy] = local(e);
    zoomAt(sx, sy, Math.exp(-e.deltaY * 0.006));
  }, { passive: false });
  stage.addEventListener('dblclick', (e) => {
    if (onControl(e)) return;
    const [sx, sy] = local(e);
    const hit = hitAt(sx, sy);
    if (hit?.kind === 'cloud') return glideTo(hit.c.x, hit.c.y, Math.max(cam.z * 1.5, room.zoom * 1.6));
    if (hit?.kind === 'galaxy') {
      const ring = galaxyRing(hit.g);
      if (ring) return glideTo(ring.x, ring.y, Math.max(cam.z * 1.3, (view.h * 0.75) / (ring.r * 2 * 0.72)));
    }
    zoomAt(sx, sy, 1.8);
  });
  $('stage-zoom')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-z]');
    if (!b) return;
    if (b.dataset.z === 'fit') return fit();
    zoomAt(view.w / 2, view.h / 2, b.dataset.z === 'in' ? 1.4 : 1 / 1.4);
  });
  stage.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomAt(view.w / 2, view.h / 2, 1.4);
    else if (e.key === '-' || e.key === '_') zoomAt(view.w / 2, view.h / 2, 1 / 1.4);
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  });

  window.Crawler = api;
  renderSpeed();
  resize();
})();
