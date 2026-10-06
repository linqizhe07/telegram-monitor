// The live view. Each group is a nebula of points sized by its messages of the last day, the
// first-tier news is one more, and the reader is a crawler that walks to whichever group just had
// something new. It has two kinds of hands: the keyword detector (cyan) tags the words that matter
// (tickers, numbers, links, questions, and, when the news radar matched it, the day's news, drawn as
// a flag and a link to the news nebula), and the denoiser (grey) pulls out what the digest drops
// (stickers, one-word chatter, bot commands, repeats, scams) and shreds it. The verdicts are the
// service's own (the radar's matches, the denoiser's rules); everything moves only on real events.
//
// Drawing: a cloud is rendered once into its own canvas (a sprite) and drawn from there; a frame
// only draws the sprites, a few hundred twinkles, the crawler, its legs, the links and the tags. The
// loop stops when the view is off screen or the page is hidden, and slows to a still picture when
// the system asks for reduced motion. Words are drawn on the canvas, never parsed as HTML.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const C = { bg: '#040507', ink: '#dde4ea', muted: '#6c7883', faint: '#36404a', cyan: '#5cc8ec', pink: '#ff5c8a', teal: '#4fd1b0', yellow: '#e8c05a', white: '#f2f5f7' };
  const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "PingFang SC", monospace';
  const NUM = new Intl.NumberFormat('en-US');
  const n = (x) => (x === null || x === undefined ? '—' : NUM.format(x));
  const HM = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const now = () => Date.now() / 1000;

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

  // ── seeded randomness: a group's cloud has the same shape on every load ──

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

  /** A cloud: one group, or the news. */
  const clouds = new Map();
  let order = [];
  let activeKey = null;

  function cloudFor(key, kind, title) {
    let c = clouds.get(key);
    if (!c) {
      c = { key, kind, title, chatId: kind === 'group' ? Number(key.slice(2)) : null, seed: hash(key), count: 0, sub: '', x: 0, y: 0, tx: 0, ty: 0, r: 40, n: 0, pts: null, sprite: null, tint: null, tintColor: '', glow: 0, channel: false };
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

  /** The cloud drawn once: a faint mesh to its nearest neighbours, then the points. */
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

  const titleBox = () => ({ x: -view.w / 2, y: -view.h / 2, w: Math.min(520, view.w * 0.45), h: view.w < 700 ? 64 : 84 });
  /** On a narrow stage only the group being read and the news are labelled. */
  const compact = () => view.w < 700;
  const labelled = (c) => !compact() || c.key === activeKey || c.kind === 'news';

  /** Each label above-right of its nebula, or in the first other spot that is free and on the stage. */
  function placeLabels() {
    const all = [...clouds.values()].filter(labelled);
    const boxes = [titleBox()];
    const hit = (b) => boxes.some((o) => b.x < o.x + o.w && o.x < b.x + b.w && b.y < o.y + o.h && o.y < b.y + b.h);
    const inside = (b) => b.x >= -view.w / 2 + 6 && b.x + b.w <= view.w / 2 - 6 && b.y >= -view.h / 2 + 4 && b.y + b.h <= view.h / 2 - 4;
    for (const c of all.slice().sort((a, b) => (a.kind === 'news' ? -1 : b.kind === 'news' ? 1 : a.ty - b.ty))) {
      const w = Math.min(230, 9 * Math.max(c.title.length, 14));
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

  /** Sizes, points and sprites, again only for clouds whose size changed. */
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
    rebuildClouds(dprChanged || scaleChanged);
    if (calm.matches) draw(performance.now());
    wake();
  }
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  }).observe(stage);

  // ── the crawler ────────────────────────────────────────────────────────

  const crawler = { x: 0, y: 0, vx: 0, vy: 0, heading: 0, legs: [], placed: false };
  for (let i = 0; i < 16; i++) crawler.legs.push({ ax: 0, ay: 0, fx: 0, fy: 0, next: 0, from: 0 });

  /** Tags: the words of the messages just read. */
  const tags = [];
  const pings = [];
  const links = [];
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

  /** What the denoiser took out: pulled from the nebula to the crawler, then shredded. */
  const noise = [];
  const dust = [];
  function spawnNoise(text, kind, cloud) {
    const raw = text.replace(/\s+/g, ' ').trim();
    const word = raw.length > 14 ? `${raw.slice(0, 13)}…` : raw || '(empty)';
    const label = `${word} · ${kind}`;
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

  function ping(x, y, color = C.cyan) {
    pings.push({ x, y, color, born: performance.now() });
    while (pings.length > 6) pings.shift();
    wake();
  }

  function focus(key) {
    if (!clouds.has(key) || key === activeKey) return;
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
  let frames = 0;
  let stillTimer = 0;

  function shouldRun() {
    return onScreen && !document.hidden && view.w > 0;
  }
  function wake() {
    if (!shouldRun()) return;
    if (calm.matches) {
      // Reduced motion: a still picture, redrawn twice a second at most.
      if (!stillTimer) stillTimer = setTimeout(() => {
        stillTimer = 0;
        draw(performance.now());
      }, 500);
      return;
    }
    if (!raf) raf = requestAnimationFrame(loop);
  }
  function loop(t) {
    raf = 0;
    if (!shouldRun()) return;
    draw(t);
    raf = requestAnimationFrame(loop);
  }
  new IntersectionObserver((entries) => {
    onScreen = entries.some((e) => e.isIntersecting);
    wake();
  }).observe(stage);
  document.addEventListener('visibilitychange', wake);

  const ease = (a, b, k) => a + (b - a) * k;

  function draw(t) {
    const dt = Math.min(0.05, Math.max(0.001, (t - last) / 1000));
    last = t;
    frames++;
    const time = t / 1000;
    const still = calm.matches;
    const active = clouds.get(activeKey);
    const newsCloud = clouds.get('news');

    // Clouds glide to their places; the camera leans toward the group being read.
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
    const z = cam.z;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W / 2 - cam.x * z), dpr * (H / 2 - cam.y * z));

    // Clouds: the sprite, its colour when it is the news or the group being read, and twinkles.
    for (const c of clouds.values()) {
      if (!c.sprite) continue;
      const s = c.sprite.size * (1 + (still ? 0 : c.glow * 0.012 * Math.sin(time * 1.3)));
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
    }
    ctx.globalAlpha = 1;

    // Links: a message that named the day's news, from its group to the news cloud.
    if (newsCloud) {
      for (const l of links) {
        const g = clouds.get(`g:${l.chatId}`);
        if (!g) continue;
        const mx = (g.x + newsCloud.x) / 2 + l.bend * 0.25 * (newsCloud.y - g.y);
        const my = (g.y + newsCloud.y) / 2 - l.bend * 0.25 * (newsCloud.x - g.x);
        const age = (t - l.born) / 1000;
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
      const name = c.title.length > 26 ? `${c.title.slice(0, 25)}…` : c.title;
      ctx.font = `${c.key === activeKey ? 600 : 500} ${c.key === activeKey || c.kind === 'news' ? 14 : 12.5}px ${MONO}`;
      ctx.fillStyle = c.kind === 'news' ? C.cyan : c.key === activeKey ? C.pink : C.ink;
      ctx.globalAlpha = c.key === activeKey || c.kind === 'news' ? 1 : 0.82;
      ctx.fillText(name, lx, ly);
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

    // Pings: one check of every chat the account is in.
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      const age = (t - p.born) / 1400;
      if (age >= 1) {
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

    if (active) drawCrawler(t, time, active, still);

    // The denoiser's hand: grab, hold, pull to the crawler, shred.
    ctx.font = `11px ${MONO}`;
    for (let i = noise.length - 1; i >= 0; i--) {
      const q = noise[i];
      const age = t - q.born;
      // Reduced motion: no pull, the tag just stands there for as long and then goes.
      const u = still ? (age >= q.hold + q.pull ? 1 : 0) : Math.max(0, Math.min(1, (age - q.hold) / q.pull));
      const e = u * u * (3 - 2 * u);
      q.x = ease(q.sx, crawler.x - q.w / 2, e);
      q.y = ease(q.sy, crawler.y - q.h / 2, e);
      if (u >= 1) {
        shred(crawler.x, crawler.y);
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
      const age = t - d.born;
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
      const age = t - g.born;
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

    if (frames % 15 === 0) setText(hud.frame, String(frames).padStart(4, '0'));
    // A still picture still has to take tags away when their time is up.
    if (still && (tags.length || noise.length || pings.length)) wake();
  }

  function drawCrawler(t, time, cloud, still) {
    const cx = crawler.x;
    const cy = crawler.y;
    const s = Math.max(0.8, view.s) * 1.2;
    // Legs: each holds a point of the cloud and steps to a new one now and then.
    ctx.lineWidth = 0.8;
    crawler.legs.forEach((leg, i) => {
      if (t > leg.next || !leg.placed) {
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
      }
      const u = still ? 1 : Math.min(1, (t - leg.from) / 220);
      const ex = ease(leg.fx, leg.ax, u);
      const ey = ease(leg.fy, leg.ay, u);
      const a = (i / crawler.legs.length) * Math.PI * 2 + crawler.heading;
      const bx = cx + Math.cos(a) * 22 * s;
      const by = cy + Math.sin(a) * 15 * s;
      const sway = still ? 0 : Math.sin(time * 3 + i) * 6;
      const kx = (bx + ex) / 2 + Math.cos(a + 1.2) * (10 + sway) * s;
      const ky = (by + ey) / 2 + Math.sin(a + 1.2) * (10 + sway) * s;
      ctx.strokeStyle = C.cyan;
      ctx.globalAlpha = 0.62;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(kx, ky, ex, ey);
      ctx.stroke();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = C.cyan;
      for (const q of [0.35, 0.65]) {
        const px = (1 - q) * (1 - q) * bx + 2 * (1 - q) * q * kx + q * q * ex;
        const py = (1 - q) * (1 - q) * by + 2 * (1 - q) * q * ky + q * q * ey;
        ctx.fillRect(px - 1, py - 1, 2, 2);
      }
      ctx.fillStyle = C.white;
      ctx.fillRect(ex - 1.5, ey - 1.5, 3, 3);
    });
    ctx.globalAlpha = 1;
    // Body: a glow, a ring of cilia, the shell and the core.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(glowSprite(), -70 * s, -70 * s, 140 * s, 140 * s);
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(crawler.heading);
    ctx.strokeStyle = C.cyan;
    ctx.globalAlpha = 0.65;
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
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(8, 26, 34, 0.92)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 24 * s, 16 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let x = -30; x <= 30; x += 4.5) {
      ctx.moveTo(x * s, -18 * s);
      ctx.lineTo((x + 10) * s, 18 * s);
    }
    ctx.stroke();
    ctx.restore();
    ctx.rotate(still ? 0.6 : time * 0.9);
    ctx.fillStyle = C.pink;
    ctx.fillRect(-5 * s, -5 * s, 10 * s, 10 * s);
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

  // ── words: what a message is tagged with ───────────────────────────────

  const MAJORS = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'USDT', 'USDC', 'TON', 'TRX', 'ADA', 'ZEC', 'OKB', 'HYPE', 'SUI', 'PEPE', 'WLD', 'ARB', 'AVAX', 'LINK', 'LTC', 'BCH', 'DOT', 'NEAR', 'APT', 'ENA', 'ONDO', 'USDE', 'FDUSD', 'SHIB', 'BONK', 'WIF', 'TRUMP', 'XAUT', 'PAXG']);
  const ALIASES = [['大饼', 'BTC'], ['比特币', 'BTC'], ['二饼', 'ETH'], ['姨太', 'ETH'], ['以太坊', 'ETH'], ['以太', 'ETH'], ['狗狗币', 'DOGE'], ['大零币', 'ZEC'], ['币安币', 'BNB'], ['瑞波', 'XRP'], ['索拉纳', 'SOL']];
  /** The notable words of a message the denoiser kept, each with what it is. At most `max`. The day's
   * news is not guessed here: the radar's own matches arrive with its view (see setNews). */
  function tagsOf(text, max = 3) {
    const out = [];
    const seen = new Set();
    const add = (word, kind) => {
      const w = word.length > 22 ? `${word.slice(0, 21)}…` : word;
      const key = w.toLowerCase();
      if (seen.has(key) || out.length >= max) return;
      seen.add(key);
      out.push([w, kind]);
    };
    for (const m of text.matchAll(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g)) add(m[0].toUpperCase(), 'ticker');
    for (const m of text.matchAll(/\b[A-Za-z]{2,6}\b/g)) if (MAJORS.has(m[0].toUpperCase())) add(m[0].toUpperCase(), 'ticker');
    for (const [alias, sym] of ALIASES) if (text.includes(alias)) add(`${alias} ${sym}`, 'ticker');
    for (const m of text.matchAll(/https?:\/\/([^\s/]+)[^\s]*/g)) add(m[1].replace(/^www\./, ''), 'link');
    for (const m of text.matchAll(/(?:[-+]?\$?\d[\d,]*(?:\.\d+)?\s?(?:%|[kKmMbBwW万亿]|u\b|U\b))|\$\d[\d,]*(?:\.\d+)?/g)) add(m[0].trim(), 'number');
    for (const m of text.matchAll(/@[A-Za-z0-9_]{4,32}/g)) add(m[0], 'mention');
    if (/[?？]\s*$/.test(text) && out.length < max) add(text.replace(/\s+/g, ' ').trim().slice(-14), 'ask');
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
      el('span', { class: 'hud-field' }, el('span', { class: 'hud-label', text: 'SWARM' }), el('b', { text: 'group-pulse' })),
      field('GROUPS', 'groups'),
      field('MESSAGES', 'messages'),
      field('NEWS', 'news'),
      field('LINKS', 'links', 'cyan'),
      field('FLAGS', 'flags', 'pink'),
      field('NOISE', 'noise', 'dim'),
      field('WRITES', 'writes', 'teal'),
      field('T', 'uptime'),
      field('FRAME', 'frame'),
    );
  }
  buildHud();

  let state = null;
  let news = null;
  let pulse = null;
  let startedAt = 0;
  const lags = [];
  let sessionTagged = 0;
  const seenHits = new Set();
  let sessionDropped = 0;

  setInterval(() => {
    if (!startedAt || document.hidden) return;
    const s = Math.max(0, Math.floor(now() - startedAt));
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    setText(hud.uptime, `${hh}:${mm}:${ss}`);
  }, 1000);

  function showTitle() {
    const c = clouds.get(activeKey);
    const i = order.indexOf(activeKey);
    setText($('stage-index'), String(i + 1).padStart(2, '0'));
    setText($('stage-group'), c ? c.title : 'Waiting for the reader');
    const src = c && state ? state.sources.find((x) => x.chatId === c.chatId) : null;
    setText($('stage-sub'), src ? [src.perDay !== null ? `~${n(src.perDay)} / day` : `${n(src.messages24h)} today`, src.members ? `${n(src.members)} members` : '', src.peeked ? `new messages within ~${state.peekSeconds}s` : src.member ? 'member' : 'read from outside · every ~30s'].filter(Boolean).join(' · ') : '');
  }

  function renderTabs() {
    const box = $('hud-tabs');
    const want = order.map((k) => [k, clouds.get(k)?.title, k === activeKey, clouds.get(k)?.channel]);
    const sig = JSON.stringify(want);
    if (box.__sig === sig) return;
    box.__sig = sig;
    box.replaceChildren(...want.map(([k, title, on, channel]) => el('button', {
      role: 'tab',
      'aria-selected': on ? 'true' : 'false',
      class: `${on ? 'on' : ''}${channel ? ' channel' : ''}`,
      title,
      onclick: () => {
        focus(k);
        api.onPick?.(Number(k.slice(2)));
      },
    }, title)));
    // Bring the active tab into view inside the strip only: the page itself never scrolls.
    const on = box.querySelector('.on');
    if (on && (on.offsetLeft < box.scrollLeft || on.offsetLeft + on.offsetWidth > box.scrollLeft + box.clientWidth)) {
      box.scrollTo({ left: on.offsetLeft - 24, behavior: calm.matches ? 'auto' : 'smooth' });
    }
  }

  // ── instruments ────────────────────────────────────────────────────────

  function logLine(verb, what, cls = '', when) {
    const at = HM.format(when ? when * 1000 : Date.now());
    const list = $('i-log-list');
    list.prepend(el('li', { class: `${when ? '' : 'fresh '}${cls}` }, el('time', { text: at }), el('b', { text: verb }), el('span', { text: what })));
    while (list.children.length > 18) list.lastChild.remove();
  }

  /** What a row of the activity stream reads as in the crawl log, or null when it is not worth a line. */
  function describe(a) {
    if (!a.ok) return ['error', `${a.method} · ${a.target}`, 'pink'];
    if (a.kind === 'write') return ['WRITE', `${a.method} · ${a.target}`, 'pink'];
    if (a.method === 'stored') return ['read', `${a.target} +${Number((/^(\d+)/.exec(a.detail) || [])[1] || 1)}`, ''];
    if (a.method === 'messages.GetPeerDialogs') return ['peek', `${(/→ (\d+)/.exec(a.detail) || [])[1] ?? '?'} chats · ${a.ms ?? '?'}ms`, 'dim'];
    if (a.method === 'messages.GetHistory' && /→ 0 messages/.test(a.detail)) return ['scan', a.target, 'dim'];
    if (a.method === 'in the group') return ['link', `${a.target} · ${a.detail}`.slice(0, 60), 'cyan'];
    if (a.method === 'news in the group') return ['flag', `HOT · ${a.target}`, 'pink'];
    if (a.method === 'group was first') return ['flag', `FIRST · ${a.target}`, 'pink'];
    if (a.method === 'feed failed' || a.method === 'feed back' || a.method === 'news checked') return ['feed', `${a.target} · ${a.method}`, 'cyan'];
    if (a.method === 'connection lost' || a.method === 'connection back') return ['net', a.method, a.method === 'connection lost' ? 'pink' : ''];
    return null;
  }

  const stored = [];
  function rate() {
    const t = now();
    while (stored.length && stored[0][0] < t - 60) stored.shift();
    return stored.reduce((s, x) => s + x[1], 0);
  }
  setInterval(() => {
    if (document.hidden) return;
    const r = rate();
    setText($('i-log-rate'), `${r} msg/m`);
    setText($('i-rate'), `${r}/m`);
  }, 2000);

  const removedOf = (chatId) => {
    const x = pulse && pulse.noise ? pulse.noise.find((r) => r.chatId === chatId) : null;
    return x ? Object.values(x.removed).reduce((a, b) => a + b, 0) : 0;
  };

  /** Each nebula: its messages of the day, the part the denoiser removed in grey. */
  function renderGroups() {
    if (!state) return;
    const list = state.sources.filter((s) => s.enabled).sort((a, b) => b.messages24h - a.messages24h);
    const max = Math.max(1, ...list.map((s) => s.messages24h));
    setText($('i-groups-n'), `${list.length}/${state.sources.length}`);
    const box = $('i-groups-list');
    const sig = JSON.stringify([list.map((s) => [s.chatId, s.title, s.messages24h, removedOf(s.chatId)]), activeKey]);
    if (box.__sig === sig) return;
    box.__sig = sig;
    box.replaceChildren(...list.slice(0, 8).map((s) => {
      const on = `g:${s.chatId}` === activeKey;
      const ch = clouds.get(`g:${s.chatId}`)?.channel;
      const removed = Math.min(s.messages24h, removedOf(s.chatId));
      const kept = el('i');
      const cut = el('i', { class: 'cut' });
      kept.style.width = `${Math.max(s.messages24h ? 2 : 0, ((s.messages24h - removed) / max) * 100)}%`;
      cut.style.width = `${(removed / max) * 100}%`;
      return el('li', { class: `${on ? 'on' : ''}${ch ? ' channel' : ''}`, title: `${s.title}: ${n(s.messages24h)} messages today, ${n(removed)} removed as noise` },
        el('div', { class: 'row' }, el('span', { class: 'name', text: s.title }), el('span', { class: 'count', text: s.messages24h ? `${n(s.messages24h)}${removed ? ` · ${Math.round((removed / s.messages24h) * 100)}%` : ''}` : '0' })),
        el('div', { class: 'bar' }, kept, cut));
    }));
  }

  /** The denoiser: what it removed today, by why, across the groups. */
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

  function renderRadar() {
    const svg = $('i-radar-svg');
    if (!news) return;
    const topics = news.keywords.filter((k) => k.sources.length >= 2 || k.groups.length).sort((a, b) => b.score - a.score).slice(0, 7);
    const sig = JSON.stringify(topics.map((k) => [k.id, k.sources.length, k.groups.map((g) => g.count)]));
    if (svg.__sig === sig) return;
    svg.__sig = sig;
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      return e;
    };
    svg.setAttribute('viewBox', '-100 -86 200 172');
    svg.replaceChildren();
    const m = Math.max(3, topics.length);
    const pt = (i, r) => [Math.cos(-Math.PI / 2 + (i / m) * Math.PI * 2) * r, Math.sin(-Math.PI / 2 + (i / m) * Math.PI * 2) * r];
    for (const ring of [0.33, 0.66, 1]) svg.append(mk('polygon', { points: Array.from({ length: m }, (_, i) => pt(i, ring * 62).join(',')).join(' '), class: 'ring' }));
    for (let i = 0; i < m; i++) svg.append(mk('line', { x1: 0, y1: 0, x2: pt(i, 62)[0], y2: pt(i, 62)[1], class: 'spoke' }));
    const maxSources = Math.max(1, ...topics.map((k) => k.sources.length));
    const maxEcho = Math.max(1, ...topics.map((k) => k.groups.reduce((s, g) => s + g.count, 0)));
    svg.append(mk('polygon', { class: 'outlets', points: Array.from({ length: m }, (_, i) => pt(i, topics[i] ? 10 + 52 * (topics[i].sources.length / maxSources) : 4).join(',')).join(' ') }));
    svg.append(mk('polygon', { class: 'echo', points: Array.from({ length: m }, (_, i) => pt(i, topics[i] ? 4 + 58 * (Math.log1p(topics[i].groups.reduce((s, g) => s + g.count, 0)) / Math.log1p(maxEcho)) : 4).join(',')).join(' ') }));
    topics.forEach((k, i) => {
      const [x, y] = pt(i, 76);
      const label = mk('text', { x, y: y + 3, 'text-anchor': Math.abs(x) < 8 ? 'middle' : x > 0 ? 'start' : 'end', class: k.groups.length ? 'hit' : '' });
      label.textContent = (k.label.split(' · ')[0] || '').slice(0, 9);
      svg.append(label);
    });
    const echoed = news.keywords.filter((k) => k.groups.length).length;
    const hot = news.alerts.filter((a) => a.kind === 'hot').length;
    const first = news.alerts.filter((a) => a.kind === 'first').length;
    const bars = $('i-radar-bars');
    const top = Math.max(1, echoed, hot, first);
    bars.replaceChildren(...[['stories', echoed, 'teal'], ['hot', hot, 'pink'], ['had it first', first, 'yellow']].map(([label, v, cls]) => {
      const bar = el('i', { class: cls });
      bar.style.width = `${(v / top) * 100}%`;
      return el('li', {}, el('span', { text: label }), el('span', { class: 'b' }, bar), el('b', { text: v }));
    }));
  }

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
        el('span', { class: 'code', text: [...r.src.title.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 3).join('').toUpperCase() }),
        ...r.counts.map((v, i) => el('i', { class: `l${v ? Math.min(5, 1 + Math.floor((Math.log1p(v) / Math.log1p(max)) * 5)) : 0}`, title: `${HM.format((pulse.from + i * pulse.bucketS) * 1000)} · ${n(v)} messages` })))));
    }
    const total = state.sources.reduce((s, x) => s + x.messages24h, 0);
    setText($('i-heat-total'), n(total));
    const stats = $('i-heat-stats');
    const removed = pulse.noise ? pulse.noise.reduce((s, x) => s + Object.values(x.removed).reduce((a, b) => a + b, 0), 0) : null;
    const vals = [['read', n(total), ''], ['removed', removed === null ? '—' : n(removed), 'dim'], ['linked', news ? n(news.hits.length) : '—', 'cyan'], ['written', n(state.activity.counts.write || 0), 'teal']];
    if (stats.__sig !== JSON.stringify(vals)) {
      stats.__sig = JSON.stringify(vals);
      stats.replaceChildren(...vals.map(([k, v, cls]) => el('div', {}, el('dt', { text: k }), el('dd', { class: cls, text: v }))));
    }
  }

  function renderSpeed() {
    const list = lags.slice(-40);
    const spark = $('i-spark');
    const gauge = $('i-gauge');
    const NS = 'http://www.w3.org/2000/svg';
    if (list.length === 0) return;
    const recent = list.slice(-10).map((x) => x.lag).sort((a, b) => a - b);
    const median = recent[Math.floor(recent.length / 2)];
    const cap = 60;
    const pts = list.map((x, i) => `${(i / Math.max(1, list.length - 1)) * 200},${36 - (Math.min(cap, x.lag) / cap) * 32}`).join(' ');
    spark.setAttribute('viewBox', '0 0 200 40');
    spark.replaceChildren();
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts);
    spark.append(line);
    // The gauge: three quarters of a circle, full at 0 s, empty at a minute.
    gauge.setAttribute('viewBox', '-50 -50 100 100');
    const frac = 1 - Math.min(cap, median) / cap;
    const arc = (f) => {
      const a0 = Math.PI * 0.75;
      const a1 = a0 + Math.PI * 1.5 * f;
      const r = 40;
      const large = Math.PI * 1.5 * f > Math.PI ? 1 : 0;
      return `M ${Math.cos(a0) * r} ${Math.sin(a0) * r} A ${r} ${r} 0 ${large} 1 ${Math.cos(a1) * r} ${Math.sin(a1) * r}`;
    };
    gauge.replaceChildren();
    for (const [f, cls] of [[1, 'track'], [Math.max(0.001, frac), median <= 15 ? 'good' : median <= 60 ? 'ok' : 'slow']]) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', arc(f));
      p.setAttribute('class', cls);
      gauge.append(p);
    }
    setText($('i-gauge-num'), `${median}s`);
    setText($('i-speed-note'), `median of the last ${recent.length} · fastest ${recent[0]}s`);
  }

  // The reader as code: what it is doing, typed out as it happens.
  const code = { queue: [], typing: null, timer: 0, doneAt: [] };
  function say(line, cls = '') {
    code.queue.push([line, cls]);
    if (code.queue.length > 6) code.queue.splice(0, code.queue.length - 6);
    if (!code.timer) typeNext();
  }
  function typeNext() {
    code.timer = 0;
    const pre = $('i-code-pre');
    if (!code.typing) {
      const next = code.queue.shift();
      if (!next) return;
      const line = el('div', { class: next[1] }, el('span'), el('i', { class: 'cursor' }));
      pre.append(line);
      while (pre.children.length > 13) pre.firstChild.remove();
      for (const c of pre.querySelectorAll('.cursor')) if (c.parentNode !== line) c.remove();
      code.typing = { text: next[0], at: 0, node: line.firstChild };
    }
    const tp = code.typing;
    const step = calm.matches || document.hidden ? tp.text.length : Math.max(1, Math.ceil(tp.text.length / 26));
    tp.at = Math.min(tp.text.length, tp.at + step);
    tp.node.textContent = tp.text.slice(0, tp.at);
    if (tp.at >= tp.text.length) {
      code.typing = null;
      code.doneAt.push(Date.now());
    }
    code.timer = setTimeout(typeNext, code.typing ? 28 : 160);
  }
  setInterval(() => {
    if (document.hidden) return;
    const since = Date.now() - 60_000;
    while (code.doneAt.length && code.doneAt[0] < since) code.doneAt.shift();
    setText($('i-code-rate'), `${code.doneAt.length} l/m`);
  }, 2000);

  function renderStatus() {
    if (!state) return;
    const a = state.account;
    const conn = a && a.connection;
    const parts = a
      ? [a.name, `ID ${a.id}`, conn ? (conn.state === 'offline' ? 'Telegram unreachable · retrying' : `connected since ${HM.format(conn.since * 1000)}`) : 'signed in', 'revoke in Telegram → Devices']
      : ['not signed in'];
    parts.push(state.bot ? `digests via @${state.bot.username}` : 'digests stay on this page', state.claude.ready ? `Claude ${state.claude.model}` : 'Claude API not set: digests come from Claude Desktop', state.notifications ? 'macOS notifications on' : 'notifications off', `messages kept ${state.retentionDays} days`);
    const box = $('hud-status');
    const sig = JSON.stringify(parts);
    if (box.__sig === sig) return;
    box.__sig = sig;
    box.replaceChildren(...parts.map((p, i) => el('span', { class: i === 0 ? 'who' : '' }, p)));
    setText($('hud-brand'), a ? `${a.name} · read-only` : 'read-only');
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
      try {
        pulse = await get('/api/pulse');
        lags.length = 0;
        lags.push(...pulse.lags.slice().reverse());
        renderHeat();
        renderSpeed();
        renderGroups();
        renderDenoiser();
      } catch {
        // the console is restarting; the next event tries again
      }
    }, delay);
  }
  setInterval(() => !document.hidden && loadPulse(), 60_000);

  /** New messages in a group: the crawler goes there and tags their words. */
  const readAt = new Map();
  async function read(chatId, count) {
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
      if (dropped.length) {
        logLine('drop', `${dropped.length} · ${[...new Set(dropped)].join(', ')}`, 'dim');
        say(`denoise(drop=${dropped.length})  # ${[...new Set(dropped)].join(', ')}`, 'dim');
        sessionDropped += dropped.length;
      }
      if (tagged.length) {
        logLine('tag', tagged.join('  '), 'cyan');
        say(`detect(${tagged.slice(0, 3).map((w) => `"${w}"`).join(', ')})`, 'cyan');
        sessionTagged += tagged.length;
      }
      renderDenoiser();
      const newest = msgs[msgs.length - 1];
      if (newest) {
        lags.push({ at: now(), chatId, lag: Math.max(0, Math.round(now() - newest.date)) });
        if (lags.length > 60) lags.shift();
        renderSpeed();
      }
    } catch {
      // nothing to tag this time
    }
  }

  // ── what the page tells it ─────────────────────────────────────────────

  const api = {
    onPick: null,

    /** The console state (every few seconds). */
    setState(s) {
      state = s;
      startedAt = s.startedAt || startedAt;
      const enabled = s.sources.filter((x) => x.enabled);
      const keys = new Set(enabled.map((x) => `g:${x.chatId}`));
      for (const k of [...clouds.keys()]) if (k.startsWith('g:') && !keys.has(k)) clouds.delete(k);
      const before = order.join();
      order = enabled.slice().sort((a, b) => b.messages24h - a.messages24h || a.chatId - b.chatId).map((x) => `g:${x.chatId}`);
      for (const src of enabled) {
        const c = cloudFor(`g:${src.chatId}`, 'group', src.title);
        c.count = src.messages24h;
        c.sub = `${n(src.messages24h)} today · ${src.error ? 'error' : src.behind ? 'catching up' : src.peeked || src.pushed ? 'live' : `every ~${src.everyS >= 60 ? `${Math.round(src.everyS / 60)}m` : `${src.everyS}s`}`}`;
      }
      if (!clouds.has('news') && s.news) cloudFor('news', 'news', 'first-tier news');
      const n0 = clouds.get('news');
      if (n0 && s.news) {
        n0.count = s.news.items24h;
        n0.sub = `${n(s.news.items24h)} items · ${s.news.sources} sources`;
      }
      if (order.join() !== before) {
        // A new order of the groups: the clouds keep their shapes and glide to their new places.
        layout();
      }
      if (view.w) rebuildClouds(false);
      if (!activeKey || !clouds.has(activeKey)) {
        const newest = enabled.slice().sort((a, b) => (b.newest || 0) - (a.newest || 0))[0];
        if (newest) {
          focus(`g:${newest.chatId}`);
          if (!api.seeded) {
            api.seeded = true;
            read(newest.chatId, 4);
          }
        }
      }
      setText(hud.groups, `${enabled.length}/${s.sources.length}`);
      setText(hud.messages, n(s.sources.reduce((t, x) => t + x.messages24h, 0)));
      setText(hud.writes, n(s.activity.counts.write || 0));
      if (s.news) setText(hud.news, n(s.news.items24h));
      showTitle();
      renderTabs();
      renderGroups();
      renderHeat();
      renderStatus();
      if (!pulse) loadPulse();
      wake();
    },

    /** The news radar's view (every ~20 seconds, and after news events). */
    setNews(v) {
      const prev = news;
      news = v;
      if (!v.enabled) return;
      const channels = new Set(v.sources.filter((x) => x.kind === 'telegram').map((x) => `g:${x.id.slice(3)}`));
      for (const c of clouds.values()) c.channel = channels.has(c.key);
      const nc = clouds.get('news');
      if (nc) {
        nc.words = v.keywords.filter((k) => k.sources.length >= 2).slice(0, 3).map((k) => k.label.length > 30 ? `${k.label.slice(0, 29)}…` : k.label);
        if (prev && v.items24h > prev.items24h) {
          ping(nc.x, nc.y, C.cyan);
          logLine('feed', `+${v.items24h - prev.items24h} news items`, 'cyan');
          say(`news.fetch()  # +${v.items24h - prev.items24h} items`);
        }
      }
      // One link per group and story; the ones that arrived while watching are drawn bright.
      const known = new Set(links.map((l) => `${l.chatId}:${l.topicId}`));
      const levels = new Map(v.keywords.flatMap((k) => k.groups.map((g) => [`${g.chatId}:${k.id}`, g.level])));
      const pairs = new Map();
      for (const h of v.hits) pairs.set(`${h.chatId}:${h.topicId}`, h);
      // The detector's verdicts from the radar: each newly matched message becomes a flag at its group.
      for (const h of v.hits) {
        const id = `${h.chatId}:${h.messageId}`;
        if (seenHits.has(id)) continue;
        seenHits.add(id);
        if (!prev) continue;
        const mark = h.marks && h.marks[0];
        const word = mark ? h.text.slice(mark[0], mark[1]) : (h.terms[0] || h.label);
        const g = clouds.get(`g:${h.chatId}`);
        if (g) {
          focus(g.key);
          spawnTag(`${word} → ${h.label.split(' · ')[0]}`, 'news', g);
        }
        sessionTagged++;
      }
      for (const [key, h] of pairs) {
        if (known.has(key)) continue;
        links.push({ chatId: h.chatId, topicId: h.topicId, level: levels.get(key) || 'echo', bend: ((hash(key) % 100) / 100 - 0.5) * 1.2, born: prev ? performance.now() : -1e9 });
        if (prev) {
          logLine('link', `${h.group} → ${h.label}`, 'cyan');
          say(`link("${h.group.slice(0, 14)}", "${h.label.split(' · ')[0]}")`, 'cyan');
        }
      }
      for (const l of links) l.level = levels.get(`${l.chatId}:${l.topicId}`) || l.level;
      setText(hud.links, n(v.hits.length));
      setText(hud.flags, n(v.alerts.length));
      setText(hud.news, n(v.items24h));
      renderRadar();
      renderHeat();
      wake();
    },

    /** The rows the page loaded at the start: written into the log only (nothing moves for the past). */
    history(rows) {
      for (const a of rows.slice(-120)) {
        const d = describe(a);
        if (d) logLine(d[0], d[1], d[2], a.at);
      }
    },

    /** One row of the activity stream, as it happens. */
    activity(a) {
      const d = describe(a);
      if (d) logLine(d[0], d[1], d[2]);
      if (!a.ok) return;
      if (a.kind === 'write') {
        say(`# WRITE: ${a.method}`, 'pink');
        return;
      }
      const chat = state ? state.sources.find((s) => s.title === a.target) : null;
      if (a.method === 'stored' && chat) {
        const count = Number((/^(\d+)/.exec(a.detail) || [])[1] || 1);
        stored.push([now(), count]);
        say(`read("${a.target.slice(0, 16)}")  # +${count}`);
        read(chat.chatId, count);
        loadPulse(4000);
      } else if (a.method === 'messages.GetPeerDialogs') {
        if (clouds.get(activeKey)) ping(crawler.x, crawler.y);
        say(`peek(chats=${(/→ (\d+)/.exec(a.detail) || [])[1] ?? '?'})  # ${a.ms ?? '?'}ms`, 'dim');
      } else if (a.method === 'news in the group' || a.method === 'group was first') {
        const first = a.method === 'group was first';
        say(`flag("${a.target.slice(0, 16)}", ${first ? 'first' : 'hot'}=True)`, 'pink');
        if (chat) spawnTag(first ? 'had it first' : 'HOT', 'news', clouds.get(`g:${chat.chatId}`));
      } else if (a.method === 'connection lost' || a.method === 'connection back') {
        say(`# ${a.method}`, 'dim');
      }
    },
  };

  say('# reader.py · reads your groups, never writes', 'dim');
  say('groups = watch(read_only=True)');
  say('news = radar(first_tier=True)');
  window.Crawler = api;
  resize();
})();
