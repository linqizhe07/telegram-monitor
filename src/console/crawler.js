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

  function radiusOf(c) {
    const base = c.kind === 'news' ? 118 : Math.min(148, 44 + 1.15 * Math.sqrt(c.count));
    return base * view.s;
  }
  function pointsOf(c) {
    const raw = c.kind === 'news' ? 520 + c.count * 7 : 260 + c.count * 0.32;
    return Math.round(Math.min(2800, raw) * Math.max(0.35, Math.min(1, view.s)));
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

  /** Groups on an ellipse around the news, pushed apart where they overlap. */
  function layout() {
    const groups = order.map((k) => clouds.get(k)).filter(Boolean);
    const rx = Math.max(150, view.w * 0.37);
    const ry = Math.max(110, view.h * 0.31);
    groups.forEach((c, i) => {
      const a = -Math.PI * 0.86 + (i / Math.max(1, groups.length)) * Math.PI * 2;
      c.tx = Math.cos(a) * rx;
      c.ty = Math.sin(a) * ry;
    });
    const all = [...groups, clouds.get('news')].filter(Boolean);
    for (let it = 0; it < 60; it++) {
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i];
          const b = all[j];
          const dx = b.tx - a.tx;
          const dy = b.ty - a.ty;
          const d = Math.hypot(dx, dy) || 1;
          const want = (a.r + b.r) * 0.95;
          if (d >= want) continue;
          const push = (want - d) / 2;
          const ux = dx / d;
          const uy = dy / d;
          if (a.kind !== 'news') {
            a.tx -= ux * push;
            a.ty -= uy * push;
          }
          if (b.kind !== 'news') {
            b.tx += ux * push;
            b.ty += uy * push;
          }
        }
      }
    }
    const limX = view.w / 2 - 30;
    const limY = view.h / 2 - 24;
    // The title sits in the top-left corner: no nebula centre goes under it.
    const title = titleBox();
    for (const c of groups) {
      c.tx = Math.max(-limX + c.r * 0.6, Math.min(limX - c.r * 0.6, c.tx));
      c.ty = Math.max(-limY + c.r * 0.5, Math.min(limY - c.r * 0.5, c.ty));
      if (c.tx < title.x + title.w && c.ty < title.y + title.h + c.r * 0.3) c.ty = title.y + title.h + c.r * 0.3;
      if (!c.placed) {
        c.x = c.tx;
        c.y = c.ty;
        c.placed = true;
      }
    }
    placeLabels();
  }

  /** Each label above-right of its nebula, or in the first other spot that is free and on the stage. */
  function placeLabels() {
    const all = [...clouds.values()].filter(labelled);
    const boxes = [titleBox()];
    const hit = (b) => boxes.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
    const inside = (b) => b.x >= -view.w / 2 + 6 && b.x + b.w <= view.w / 2 - 6 && b.y >= -view.h / 2 + 4 && b.y + b.h <= view.h / 2 - 4;
    for (const c of all.slice().sort((a, b) => (a.kind === 'news' ? -1 : b.kind === 'news' ? 1 : a.ty - b.ty))) {
      const w = Math.min(230, 9 * Math.max(Array.from(c.title).length, 14));
      const h = c.kind === 'news' && !compact() ? 72 : 30;
      const spots = [[c.r * 0.28, -c.r * 0.92 - 22], [c.r * 0.28, c.r * 0.7], [-w - c.r * 0.2, -c.r * 0.6], [c.r * 0.6, -c.r * 0.2], [-w - c.r * 0.2, c.r * 0.5], [-w / 2, c.r * 0.85]];
      let pick = null;
      for (const [dx, dy] of spots) {
        const b = { x: c.tx + dx, y: c.ty + dy, w, h };
        if (!hit(b) && inside(b)) {
          pick = [dx, dy];
          break;
        }
      }
      // Nowhere free: the spot that stays on the stage.
      if (!pick) pick = spots.find(([dx, dy]) => inside({ x: c.tx + dx, y: c.ty + dy, w, h })) || spots[0];
      c.lx = pick[0];
      c.ly = pick[1] + 14;
      boxes.push({ x: c.tx + pick[0], y: c.ty + pick[1], w, h });
    }
  }

  /** Sizes, points and sprites, again only for nebulae whose size changed. */
  function rebuildClouds(force) {
    for (const c of clouds.values()) {
      const r = radiusOf(c);
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
  /** Groups that talked about the same story today: a route between them, by how many stories. */
  const bridges = [];
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
    if (compact()) placeLabels();
    showTitle();
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
    cam.tx = active ? active.x * 0.28 : 0;
    cam.ty = active ? active.y * 0.28 : 0;
    cam.tz = 1.03;
    const kc = still ? 1 : 1 - Math.exp(-dt * 1.4);
    cam.x = ease(cam.x, cam.tx + (still ? 0 : Math.sin(time * 0.07) * 9), kc);
    cam.y = ease(cam.y, cam.ty + (still ? 0 : Math.cos(time * 0.05) * 6), kc);
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

    // Nebulae: the sprite, its colour when it is the news or the group being read, and twinkles.
    for (const c of clouds.values()) {
      if (!c.sprite) continue;
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

    // Routes: groups that talked about the same story, with a packet running between them.
    for (const br of bridges) {
      const A = clouds.get(`g:${br.a}`);
      const B = clouds.get(`g:${br.b}`);
      if (!A || !B) continue;
      const mx = (A.x + B.x) / 2 + br.bend * (B.y - A.y) * 0.5;
      const my = (A.y + B.y) / 2 - br.bend * (B.x - A.x) * 0.5;
      ctx.strokeStyle = C.teal;
      ctx.globalAlpha = Math.min(0.34, 0.08 + br.w * 0.05);
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(A.x, A.y);
      ctx.quadraticCurveTo(mx, my, B.x, B.y);
      ctx.stroke();
      if (!still) {
        for (const off of br.w > 2 ? [0, 0.5] : [0]) {
          const u = (time * 0.08 + br.ph + off) % 1;
          const px = (1 - u) * (1 - u) * A.x + 2 * (1 - u) * u * mx + u * u * B.x;
          const py = (1 - u) * (1 - u) * A.y + 2 * (1 - u) * u * my + u * u * B.y;
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = C.teal;
          ctx.fillRect(px - 1.4, py - 1.4, 2.8, 2.8);
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

    // Labels.
    ctx.textBaseline = 'alphabetic';
    for (const c of clouds.values()) {
      if (!labelled(c)) continue;
      const lx = c.x + (c.lx ?? c.r * 0.28);
      const ly = c.y + (c.ly ?? -c.r * 0.92 - 8);
      ctx.font = `${c.key === activeKey ? 600 : 500} ${c.key === activeKey || c.kind === 'news' ? 14 : 12.5}px ${MONO}`;
      ctx.fillStyle = c.kind === 'news' ? C.cyan : c.key === activeKey ? C.pink : C.ink;
      ctx.globalAlpha = c.key === activeKey || c.kind === 'news' ? 1 : 0.82;
      ctx.fillText(cut(c.title, 26), lx, ly);
      ctx.font = `10.5px ${MONO}`;
      ctx.fillStyle = C.muted;
      ctx.fillText(c.sub, lx, ly + 14);
      if (c.kind === 'news' && c.words && !compact()) {
        ctx.fillStyle = C.cyan;
        ctx.globalAlpha = 0.75;
        c.words.forEach((w, i) => ctx.fillText(w, lx, ly + 30 + i * 13));
      }
    }
    ctx.globalAlpha = 1;

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
      const sz = Math.max(0.8, view.s) * 1.2;
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
      const z = 2.2 * (1 - age) + 0.6;
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

    // The denoiser's hand: grab, hold, pull to the crawler, shred.
    ctx.font = `11px ${MONO}`;
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
      const alpha = Math.min(1, age / 200) * (1 - e * 0.7);
      ctx.globalAlpha = alpha * 0.8;
      ctx.strokeStyle = '#8994a0';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(crawler.x, crawler.y);
      ctx.lineTo(q.x + q.w / 2, q.y + q.h / 2);
      ctx.stroke();
      // the claw
      ctx.beginPath();
      ctx.moveTo(q.x - 4, q.y - 3);
      ctx.lineTo(q.x + 2, q.y + q.h / 2);
      ctx.lineTo(q.x - 4, q.y + q.h + 3);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = 'rgba(12, 15, 19, 0.9)';
      ctx.fillRect(q.x, q.y, q.w, q.h);
      ctx.strokeStyle = C.faint;
      ctx.strokeRect(q.x + 0.5, q.y + 0.5, q.w - 1, q.h - 1);
      ctx.fillStyle = C.muted;
      ctx.fillText(q.label, q.x + 6, q.y + 12);
      ctx.fillRect(q.x + 5, q.y + 8, q.w - 10, 1); // struck through: it will not be read
    }
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
      const alpha = Math.min(1, age / 250) * Math.min(1, (g.ttl - age) / 700);
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 0.6;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(crawler.x, crawler.y);
      ctx.lineTo(g.x + g.w / 2, g.y + g.h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g.filled ? g.color : 'rgba(4, 5, 7, 0.86)';
      ctx.fillRect(g.x, g.y, g.w, g.h);
      ctx.strokeStyle = g.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1);
      ctx.fillStyle = g.filled ? '#140409' : g.color;
      ctx.fillText(g.label, g.x + 6, g.y + 12);
    }
    ctx.globalAlpha = 1;

    // A still picture still has to take tags away when their time is up.
    if (still && (tags.length || noise.length)) wake();
  }

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
    // Above the top-left bracket: labels sit to the right of a nebula, so this corner stays free.
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = C.pink;
    ctx.globalAlpha = 0.8 * e;
    ctx.fillText(`◢ LOCK${a.heat > 0.6 ? ' · LIVE' : ''}`, a.x - hw, a.y - hh - 6);
    ctx.globalAlpha = 1;
  }

  /** A point along two straight segments (foot → knee → hip), 0 at the foot. */
  const alongLeg = (ex, ey, kx, ky, bx, by, q) => (q < 0.5 ? [ex + (kx - ex) * q * 2, ey + (ky - ey) * q * 2] : [kx + (bx - kx) * (q - 0.5) * 2, ky + (by - ky) * (q - 0.5) * 2]);

  function drawCrawler(t, time, cloud, still) {
    const cx = crawler.x;
    const cy = crawler.y;
    const s = Math.max(0.8, view.s) * 1.2;
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
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(kx, ky);
      ctx.stroke();
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(kx, ky, 1.7 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = C.white;
      ctx.fillRect(ex - 1.4, ey - 1.4, 2.8, 2.8);
      if (!still && u < 1) {
        // A foot landing: a small ring.
        ctx.globalAlpha = 0.6 * (1 - u);
        ctx.beginPath();
        ctx.arc(ex, ey, 2 + u * 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (feeding) {
        const q = (t / 420 + i * 0.137) % 1;
        const [px, py] = alongLeg(ex, ey, kx, ky, bx, by, q);
        ctx.globalAlpha = 1;
        ctx.fillStyle = i % 3 === 0 ? C.pink : C.white;
        ctx.fillRect(px - 1.3, py - 1.3, 2.6, 2.6);
      }
    });
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(cx, cy);
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
    ctx.restore();
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
      const pairs = new Map();
      for (const k of v.keywords) {
        const ids = [...new Set(k.groups.map((g) => g.chatId))].sort((a, b) => a - b);
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.set(`${ids[i]}:${ids[j]}`, (pairs.get(`${ids[i]}:${ids[j]}`) || 0) + 1);
      }
      bridges.length = 0;
      for (const [key, w] of [...pairs].sort((p, q) => q[1] - p[1]).slice(0, 24)) {
        const [a, b] = key.split(':').map(Number);
        bridges.push({ a, b, w, bend: ((hash(key) % 100) / 100 - 0.5) * 0.8, ph: (hash(key) % 1000) / 1000 });
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

  window.Crawler = api;
  renderSpeed();
  resize();
})();
