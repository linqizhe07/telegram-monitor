// Console page. Everything that comes from Telegram (titles, names, messages, digests) is untrusted
// text: it is set with textContent, and digest HTML goes through an allowlist sanitizer.
//
// Smoothness: the page refreshes every few seconds, so nothing is rebuilt that has not changed. Lists
// are keyed (a row is drawn again only when its data changes; hover, focus, open details and text
// selection survive a refresh), numbers and relative times are updated in place, and the page does no
// work while it is hidden.
'use strict';

const TOKEN = document.querySelector('meta[name="console-token"]').content;
const $ = (id) => document.getElementById(id);
let state = null;
let filter = 'all';
let lastActivityId = 0;
const feedRows = [];
const FEED_MAX = 600;
const calm = matchMedia('(prefers-reduced-motion: reduce)');

// ── helpers ────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function svgIcon(d, cls = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

/** Writes text only when it changed: an unchanged number costs nothing. */
function setText(node, text) {
  const t = String(text ?? '');
  if (node && node.textContent !== t) node.textContent = t;
}

function setTitle(node, title) {
  if (node && node.title !== title) node.title = title;
}

/** Replaces a node's children only when what they are drawn from changed. */
function paint(node, deps, build) {
  const sig = JSON.stringify(deps);
  if (node.__sig === sig) return false;
  node.__sig = sig;
  node.replaceChildren(...build());
  return true;
}

/**
 * Keeps a list's children in step with `items`, by key. A row is rendered again only when its
 * signature changes; every other row stays the same DOM node and is moved only if it is out of
 * place. `update` runs for every row after placing it, for values that change often (counts, times)
 * and are written in place.
 */
function sync(list, items, { key, sig, render, update, empty }) {
  if (!list.__rows) {
    list.replaceChildren();
    list.__rows = new Map();
  }
  const old = list.__rows;
  const next = new Map();
  const want = items.map((item) => ({ k: String(key(item)), s: sig(item), item }));
  if (want.length === 0 && empty) want.push({ k: '\u0000empty', s: empty.text, item: null });
  let cursor = list.firstChild;
  for (const w of want) {
    if (next.has(w.k)) continue; // the same key twice: the first one wins
    let row = old.get(w.k);
    if (row && row.s !== w.s) {
      if (row.node === cursor) cursor = cursor.nextSibling;
      row.node.remove();
      row = null;
    }
    if (!row) row = { node: w.item === null ? empty.render() : render(w.item), s: w.s };
    next.set(w.k, row);
    if (row.node === cursor) cursor = cursor.nextSibling;
    else list.insertBefore(row.node, cursor);
    if (update && w.item !== null) update(row.node, w.item);
  }
  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
  list.__rows = next;
}

const emptyLi = (text) => ({ text, render: () => el('li', { class: 'empty', text }) });

// Dates and numbers in English, whatever the browser's language: the interface is English.
const NUM = new Intl.NumberFormat('en-US');
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const HM = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DAY_HM = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const FULL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
const fmtTime = (t) => TIME.format(t * 1000);
const fmtHM = (t) => HM.format(t * 1000);
const fmtDateTime = (t) => DAY_HM.format(t * 1000);
const fmtFull = (t) => FULL.format(t * 1000);
/** "14:47" today, "Oct 5, 14:47" before. */
function fmtWhen(t) {
  return new Date(t * 1000).toDateString() === new Date().toDateString() ? fmtHM(t) : fmtDateTime(t);
}
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function until(t) {
  const s = t - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'due';
  if (s < 3600) return `in ${Math.ceil(s / 60)}m`;
  return `in ${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const n = (x) => (x === null || x === undefined ? '—' : NUM.format(x));

/** A relative time ("12s ago") that keeps itself current without redrawing its row. */
function setAgo(node, t, pre = '') {
  if (!t) {
    delete node.dataset.ago;
    setText(node, `${pre}—`);
    return;
  }
  if (node.dataset.ago !== String(t)) {
    node.dataset.ago = String(t);
    node.dataset.pre = pre;
    node.setAttribute('datetime', new Date(t * 1000).toISOString());
    node.title = fmtFull(t);
  }
  setText(node, `${pre}${ago(t)}`);
}
function agoEl(t, pre = '') {
  const e = el('time');
  setAgo(e, t, pre);
  return e;
}
/** A countdown ("in 3h 12m") that keeps itself current the same way. */
function untilEl(t, pre = '') {
  return el('time', { 'data-until': t, 'data-pre': pre, datetime: new Date(t * 1000).toISOString(), title: fmtFull(t) }, `${pre}${until(t)}`);
}
function tickTimes() {
  for (const e of document.querySelectorAll('time[data-ago]')) setText(e, `${e.dataset.pre || ''}${ago(Number(e.dataset.ago))}`);
  for (const e of document.querySelectorAll('time[data-until]')) setText(e, `${e.dataset.pre || ''}${until(Number(e.dataset.until))}`);
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), Math.max(5000, text.length * 60));
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': TOKEN },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ── what a request means ───────────────────────────────────────────────────

const METHODS = {
  'contacts.ResolveUsername': 'resolve a username',
  'channels.GetFullChannel': 'read group info',
  'messages.GetHistory': 'read history',
  'channels.GetMessages': 're-read messages (edits, reactions)',
  'messages.GetMessages': 're-read messages',
  'messages.GetDialogs': "list the account's own chats",
  'messages.GetPeerDialogs': 'check chats for new messages',
  'users.GetUsers': 'read a profile',
  'users.GetFullUser': 'read a profile',
  'messages.CheckChatInvite': 'look at an invite (no join)',
  'contacts.Search': 'search Telegram for public chats',
  'channels.GetChannelRecommendations': 'ask for similar channels',
  'channels.GetChannels': 'read group info',
  'upload.GetFile': 'download a file',
  'channels.JoinChannel': 'JOIN a group',
  'messages.ImportChatInvite': 'JOIN through an invite',
  'channels.LeaveChannel': 'LEAVE a group',
  'messages.SendMessage': 'SEND a message',
  'messages.GetBotCallbackAnswer': 'PRESS a button',
  'channels.ReadHistory': 'mark as read',
  'messages.ReadHistory': 'mark as read',
  'sendMessage': 'send to Telegram',
  'keep in console': 'digest kept in the console',
  stored: 'stored new messages',
  skipped: 'skipped',
  'first pull': 'first pull',
  'catch up': 'catch up',
  audit: 'audit capture against Telegram',
  'digest saved': 'digest written by Claude',
  'connection lost': 'connection to Telegram lost',
  'connection back': 'connection to Telegram back',
  'new chat': 'NEW group found in your chats',
  'left chat': 'left in Telegram: reading stopped',
  rejoined: 'rejoined: reading again',
  'switched on': 'switched on',
  'switched off': 'switched off',
  'not added': 'not added',
  setting: 'setting changed',
  'cleared storage': 'CLEARED stored data',
  reconnect: 'reconnect',
  recovered: 'RECOVERED missed messages',
  'was off': 'service was off',
  'channels.GetParticipant': 'read own membership',
  'messages.GetChats': 'read group info',
  'invite previewed': 'looked at an invite (no join)',
  'opened invite link': 'opened an invite in Telegram',
  'owner says joined': 'you said: joined',
  'owner says requested': 'you said: request sent',
  'stopped tracking': 'stopped tracking an invite',
  'not a member yet': 'not a member yet',
  'request pending': 'join request still pending',
  'request not answered': 'join request: no answer in 14 days',
  'invite link dead': 'invite link no longer works',
  'invite check deferred': 'invite check deferred (rationed)',
  'invite checks paused': 'invite checks PAUSED',
  'invite checks stopped': 'invite checks STOPPED',
  membership: 'joined: standing read',
  'history hidden': 'history before your join is hidden',
  'verification in progress': 'VERIFICATION waiting: answer it in Telegram',
  'verification over': 'verification over',
  muted: 'still cannot send (reading works)',
  removed: 'REMOVED from a group: reading stopped',
  banned: 'BANNED from a group',
  'ban over': 'ban over: reading again',
  approved: 'notification: join approved',
  verifying: 'notification: verification waiting',
  paused: 'notification: invite checks paused',
  test: 'test notification',
  'notification failed': 'notification failed',
  'notification shown': 'macOS notification',
  'internal error': 'internal error',
  'chat check failed': 'checking chats for new messages FAILED',
  'chat check back': 'checking chats for new messages works again',
  'feed failed': 'news feed not answering',
  'feed back': 'news feed answering again',
  'in the group': 'NEWS came up in a group',
  'news in the group': 'NEWS: a group is reacting',
  'group was first': 'NEWS: a group had it first',
  'news checked': 'news feeds checked',
  'news source added': 'news source added',
  'news source on': 'news source on',
  'news source off': 'news source off',
  'news source removed': 'news source removed',
  news: 'notification: news in a group',
  ahead: 'notification: a group had it first',
};
const KIND = {
  read: ['READ', 'read'],
  write: ['WRITE', 'warn'],
  event: ['EVENT', ''],
  llm: ['CLAUDE', 'llm'],
  agent: ['CLAUDE', 'agent'],
  error: ['ERROR', 'bad'],
  system: ['SYS', ''],
};

// ── sources ────────────────────────────────────────────────────────────────

const SOURCE_HEAD = ['', 'Source', 'Access', 'Last 24h', 'Volume', 'At the door', 'Reading', ''];
const ORIGIN = { dialog: 'from your chats', manual: 'added by name' };
const OFF = { owner: 'switched off', claude: 'switched off by Claude', left: 'you left it in Telegram', 'auto-watch off': 'new · auto-read is off', banned: 'banned' };
const DOTS = 'M4.5 10a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Zm4.1 0a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Zm4.1 0a1.4 1.4 0 1 0 2.8 0 1.4 1.4 0 0 0-2.8 0Z';

function accessPill(a) {
  if (a === 'outside') return el('span', { class: 'pill ok', text: 'Outside', title: 'Read from outside: the account never joined' });
  if (a === 'member') return el('span', { class: 'pill read', text: 'Member' });
  if (!a) return el('span', { class: 'pill', text: 'Not checked' });
  return el('span', { class: 'pill warn', text: a });
}

function cadence(src) {
  if (src.pushed) return 'instant · pushed by Telegram';
  if (src.peeked) return `new messages within ~${(state && state.peekSeconds) || 10}s`;
  const every = src.everyS >= 60 ? `every ~${Math.round(src.everyS / 60)}m` : `every ~${src.everyS}s`;
  return src.everyS > 60 && !src.member ? `read ${every} · quiet lately` : `read ${every}`;
}

function readingTitle(src) {
  const how = src.pushed
    ? `Telegram pushes this chat's new messages: they are read within a second or two (last push ${ago(src.lastPushAt)}).`
    : src.peeked
      ? 'The account is in this chat: one request every few seconds asks Telegram for the newest message of all such chats, and a chat with something new is read at once.'
      : src.member ? '' : 'The account is not in this chat (read from outside), so it is read on a schedule: every ~30 seconds while active.';
  return [src.error || '', src.caughtUpAt ? `Caught up ${ago(src.caughtUpAt)}.` : '', how].filter(Boolean).join(' ');
}

function readingCell(src, standing) {
  let cls = 'ok';
  let label = 'Up to date';
  let sub = cadence(src);
  if (!src.enabled) {
    if ((src.offReason === 'left' || src.offReason === 'banned') && src.error) [cls, label, sub] = ['bad', src.error, ''];
    else [cls, label, sub] = ['muted', 'Off', OFF[src.offReason] || ''];
  } else if (standing === 'verifying') [cls, label, sub] = ['warn', 'Check waiting', 'answer it in your Telegram app'];
  else if (standing === 'muted') [cls, label, sub] = ['muted', 'Muted', 'reading works'];
  else if (src.error) [cls, label, sub] = ['bad', src.error, ''];
  else if (src.behind) [cls, label, sub] = ['warn', 'Catching up', 'on missed messages'];
  return el('div', {}, el('div', { class: `state ${cls}` }, el('span', { class: 'dot' }), el('span', { text: label })), sub ? el('div', { class: 'cell-sub', text: sub }) : null);
}

function guardsCell(src) {
  const g = [];
  if (src.door?.joinRequest) g.push(el('span', { class: 'chip guard', text: 'join approval' }));
  if (src.door?.hiddenHistoryForNewMembers) g.push(el('span', { class: 'chip guard', text: 'history hidden', title: 'History is hidden from new members' }));
  if (src.door?.telegramAntispam) g.push(el('span', { class: 'chip guard', text: 'anti-spam', title: 'Telegram anti-spam is on' }));
  const bots = src.bots || [];
  if (bots.length) g.push(el('span', { class: 'chip', text: `${bots.length} bot${bots.length === 1 ? '' : 's'}`, title: bots.join('  ') }));
  return el('div', { class: 'chips-inline' }, g.length ? g : el('span', { class: 'cell-sub', text: src.access ? 'none seen' : '—' }));
}

/** Row actions in flight, by chat and action: a running catch-up does not hold up an audit. */
const busy = new Set();

function moreButton(chatId, title) {
  const b = el('button', { class: 'btn icon', title: 'More', 'aria-label': `More for ${title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, svgIcon(DOTS));
  b.addEventListener('click', () => {
    // Read when the menu opens, not when the row was drawn: a digest may have run since.
    const src = state && state.sources.find((x) => x.chatId === chatId);
    if (!src) return;
    const watched = src.kind === 'watched' && src.enabled;
    const item = (what, label, note, path, body, pending, off = false) => {
      const key = `${chatId}:${what}`;
      const running = busy.has(key);
      return { label, note: running ? 'Running…' : note, disabled: off || running, run: () => runAction(key, path, body, pending) };
    };
    openMenu(b, [
      watched && item('pull', 'Catch up now', 'Read anything missed, right away', '/api/pull', { chatId }, `Catching up on ${src.title}…`),
      watched && item('audit', 'Audit the last hour', 'Compare with Telegram: is anything missing?', '/api/audit', { chatId, hours: 1 }, `Auditing ${src.title}…`),
      item('digest', 'Digest now', state.claude.ready ? `Next one ${until(src.nextDigestAt)}${src.lastDigestAt ? ` · last ${fmtDateTime(src.lastDigestAt)}` : ''}` : 'Needs ANTHROPIC_API_KEY (Claude Desktop writes the daily one)', '/api/digest', { chatId }, `Writing a digest of ${src.title}…`, !state.claude.ready),
    ].filter(Boolean));
  });
  return b;
}

async function runAction(key, path, body, pending) {
  if (busy.has(key)) return;
  busy.add(key);
  if (pending) toast(pending);
  try {
    const r = await api(path, body);
    toast(r.message || (r.ok ? 'Done.' : 'Failed.'));
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    busy.delete(key);
  }
}

function sourceRow(src, standing) {
  const sw = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `Read ${src.title}`, title: src.enabled ? 'On: being read. Click to stop.' : 'Off: not read. Click to read it (catches up at most 24 hours).' });
  sw.checked = src.enabled;
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try {
      const r = await api('/api/toggle', { chatId: src.chatId, on: sw.checked });
      toast(r.message);
    } catch (err) {
      toast(err.message);
      sw.checked = !sw.checked;
    } finally {
      sw.disabled = false;
      refresh();
    }
  });
  const count = el('span', { class: 'num' });
  const people = el('span');
  const last = el('time');
  const reading = readingCell(src, standing);
  const tr = el('tr', { class: src.enabled ? '' : 'off' },
    el('td', {}, sw),
    el('td', {}, el('div', { class: 'src-title', text: src.title, title: src.title }), el('div', { class: 'src-sub', text: [src.ref, ORIGIN[src.origin]].filter(Boolean).join(' · ') })),
    el('td', {}, accessPill(src.access)),
    el('td', {}, el('div', {}, count, ' messages'), el('div', { class: 'cell-sub' }, people, ' people · ', last)),
    el('td', {}, el('div', { text: src.perDay !== null ? `~${n(src.perDay)} / day` : '—' }), el('div', { class: 'cell-sub', text: src.members ? `${n(src.members)} members` : '' })),
    el('td', {}, guardsCell(src)),
    el('td', {}, reading),
    el('td', {}, el('div', { class: 'row-actions' }, el('button', { class: 'btn', text: 'Messages', onclick: () => selectSource(src.chatId) }), moreButton(src.chatId, src.title))));
  tr.__update = (x) => {
    setText(count, n(x.messages24h));
    setText(people, n(x.people24h));
    setAgo(last, x.newest, 'last ');
    setTitle(reading, readingTitle(x));
  };
  return tr;
}

function renderSources(s) {
  const t = $('sources');
  if (!t.tBodies.length) t.append(el('thead', {}, el('tr', {}, SOURCE_HEAD.map((h) => el('th', { text: h })))), el('tbody'));
  $('auto-watch').checked = Boolean(s.autoWatchNew);
  const standing = new Map(((s.privateGroups && s.privateGroups.memberships) || []).map((m) => [m.chatId, m.state]));
  sync(t.tBodies[0], s.sources, {
    key: (src) => src.chatId,
    // What the row is drawn from; counts and times change often and are written in place (update).
    sig: (src) => JSON.stringify([src.title, src.ref, src.kind, src.enabled, src.offReason, src.error, src.access, src.origin, src.members, src.perDay, src.bots, src.door, src.behind, src.pushed, src.peeked, src.member, src.everyS, standing.get(src.chatId) || '', s.claude.ready, s.peekSeconds]),
    render: (src) => sourceRow(src, standing.get(src.chatId)),
    update: (row, src) => row.__update(src),
    empty: { text: 'none', render: () => el('tr', {}, el('td', { colspan: SOURCE_HEAD.length, class: 'empty', text: 'Nothing here yet. Join a group in Telegram, or check one by name below.' })) },
  });
  if (menuFor && !menuFor.isConnected) closeMenu(); // its row was drawn again, or is gone
  // The source picker of the messages panel: redrawn only when the list of sources changed.
  const sel = $('msg-source');
  sel.parentElement.hidden = s.sources.length === 0;
  const current = sel.value;
  paint(sel, s.sources.map((x) => [x.chatId, x.title]), () => s.sources.map((x) => el('option', { value: x.chatId, text: x.title })));
  if (current && s.sources.some((x) => String(x.chatId) === current)) sel.value = current;
  // First render (nothing chosen yet): the browser has picked the first option by itself, so load it.
  if (!current && s.sources[0]) {
    sel.value = String(s.sources[0].chatId);
    loadMessages();
  }
}

async function action(button, path, body, pending) {
  button.disabled = true;
  if (pending) toast(pending);
  try {
    const r = await api(path, body);
    toast(r.message || (r.ok ? 'Done.' : 'Failed.'));
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

// ── the row menu: one popover, placed next to the button that opened it ────

let menuFor = null;

function openMenu(anchor, items) {
  const menu = $('row-menu');
  if (menuFor === anchor && !menu.hidden) return closeMenu();
  closeMenu();
  menu.replaceChildren(...items.map((it) => el('button', {
    role: 'menuitem',
    disabled: it.disabled,
    onclick: () => {
      closeMenu();
      it.run();
    },
  }, el('span', { text: it.label }), it.note ? el('small', { text: it.note }) : null)));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const below = r.bottom + 6 + h <= innerHeight - 8;
  menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
  menu.style.left = `${Math.min(Math.max(8, r.right - w), innerWidth - w - 8)}px`;
  menu.style.transformOrigin = below ? 'top right' : 'bottom right';
  menuFor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function closeMenu() {
  const menu = $('row-menu');
  if (menu.hidden) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.hidden = true;
  if (menuFor) {
    menuFor.setAttribute('aria-expanded', 'false');
    if (hadFocus && menuFor.isConnected) menuFor.focus({ preventScroll: true });
  }
  menuFor = null;
}

document.addEventListener('pointerdown', (e) => {
  if (!$('row-menu').hidden && !e.target.closest('#row-menu') && e.target.closest('button') !== menuFor) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
});
$('row-menu').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...$('row-menu').querySelectorAll('button:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
});
// A scroll that moves the menu's button closes the menu; the page's own scrolling elsewhere (the
// group tabs following the crawler, a list taking a new row) does not.
addEventListener('scroll', (e) => {
  if (menuFor && (e.target === document || e.target === document.documentElement || e.target.contains?.(menuFor))) closeMenu();
}, { passive: true, capture: true });
addEventListener('resize', closeMenu, { passive: true });

// ── probe ──────────────────────────────────────────────────────────────────

const VERDICT = {
  'read-from-outside': ['Readable without joining', 'ok'],
  member: ['Already a member', 'read'],
  'join-needed': ['Must join to read', 'warn'],
  'request-needed': ['Must request to join', 'warn'],
  unsafe: ['Marked scam / fake', 'bad'],
  'not-found': ['Not found', 'bad'],
  'folder-link': ['Folder link', 'warn'],
};

// ── private groups (invite links) ──────────────────────────────────────────

const INVITE_VERDICT = {
  member: ['Already a member', 'read'],
  join: ['Private: join in your Telegram app', 'warn'],
  request: ['Private: admin approval needed', 'warn'],
  peek: ['Readable without joining, for now', 'ok'],
  paid: ['Paid: Stars subscription', 'bad'],
  refused: ['Marked SCAM / FAKE', 'bad'],
  dead: ['Link no longer works', 'bad'],
};
const INVITE_STATE = {
  previewed: ['previewed', ''],
  'owner-opened': ['opened in Telegram', ''],
  requested: ['request pending', 'warn'],
  joined: ['joined: checking', 'read'],
  verifying: ['check waiting in Telegram', 'warn'],
  watching: ['in · reading', 'ok'],
  removed: ['removed', 'bad'],
  'no-answer': ['no answer (14 days)', ''],
  'link-dead': ['link dead', 'bad'],
  refused: ['scam / fake', 'bad'],
  dismissed: ['not tracked', ''],
  expired: ['expired', ''],
};
const WARN_LABEL = { stop: 'Stop', caution: 'Careful', info: 'Note' };

async function inviteAction(button, path, body, done) {
  button.disabled = true;
  try {
    const r = await api(path, body);
    if (r && r.error) toast(r.error);
    else if (r && r.message) toast(r.message);
    else if (r && r.note) toast(r.note);
    if (done) done(r);
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

/** The buttons for an invite, by where it stands: join here (an open link), or in the app (a request, a paid group). */
function inviteButtons(inv, onDone) {
  const out = [];
  const opened = () => api('/api/invite/opened', { id: inv.id }).then(() => refresh()).catch(() => undefined);
  if (inv.links && !['watching', 'verifying', 'joined', 'removed'].includes(inv.state)) {
    out.push(
      el('a', { class: 'btn primary', href: inv.links.tg, text: 'Open in Telegram', title: 'Opens the official Telegram app at this invite', onclick: opened }),
      el('a', { class: 'btn', href: inv.links.tme, target: '_blank', rel: 'noopener noreferrer', text: 'Open t.me link', onclick: opened }),
      el('button', { class: 'btn', text: 'Copy link', onclick: () => navigator.clipboard.writeText(inv.links.tme).then(() => toast('Link copied: open it on your phone if you prefer.'), () => toast(inv.links.tme)) }),
    );
  }
  // A dead link cannot confirm anything: if the account did join, the chat-list check finds the group.
  const waiting = ['previewed', 'owner-opened', 'no-answer'].includes(inv.state) || (inv.state === 'link-dead' && inv.said);
  if (waiting && ['join', 'peek'].includes(inv.verdict) && inv.links) {
    out.unshift(el('button', { class: 'btn primary', text: 'Join here', title: 'Join with your account from this page; a check, if any, is answered at the top of the page', onclick: (e) => joinGroup(e.currentTarget, inv.links.tme, inv.title || 'this group', inv.kind === 'channel' ? 'channel' : 'group') }));
  }
  if (inv.verdict === 'member' && inv.state === 'previewed' && inv.links) {
    out.push(el('button', { class: 'btn primary', text: 'Read it', onclick: (e) => inviteAction(e.currentTarget, '/api/watch', { target: inv.links.tme }, onDone) }));
  } else if (waiting && inv.verdict !== 'refused' && inv.verdict !== 'dead') {
    out.push(
      el('button', { class: `btn ${inv.verdict === 'request' ? '' : 'primary'}`, text: "I've joined", onclick: (e) => inviteAction(e.currentTarget, '/api/invite/confirm', { id: inv.id, said: 'joined' }, onDone) }),
      el('button', { class: `btn ${inv.verdict === 'request' ? 'primary' : ''}`, text: "I've sent a join request", onclick: (e) => inviteAction(e.currentTarget, '/api/invite/confirm', { id: inv.id, said: 'requested' }, onDone) }),
    );
  }
  if (inv.state === 'requested' || inv.state === 'no-answer') out.push(el('button', { class: 'btn', text: 'Check now', title: 'One invite check (rationed)', onclick: (e) => inviteAction(e.currentTarget, '/api/invite/recheck', { id: inv.id }) }));
  if (!['dismissed', 'expired', 'refused', 'watching', 'verifying', 'removed', 'link-dead', 'no-answer'].includes(inv.state)) {
    out.push(el('button', { class: 'btn', text: inv.state === 'requested' ? 'Stop tracking' : 'Not now', onclick: (e) => inviteAction(e.currentTarget, '/api/invite/dismiss', { id: inv.id }, onDone) }));
  }
  return out;
}

function warningList(warnings) {
  return el('ul', { class: 'warns' }, warnings.map((w) => el('li', { class: w.level, title: w.evidence.length ? `Evidence: ${w.evidence.join(', ')} (docs/private-groups.md)` : '' }, el('b', { text: WARN_LABEL[w.level] || w.level }), w.text)));
}

function budgetLine(b) {
  if (!b) return '';
  return `Invite checks in the last 24 hours: ${b.used24h} of ${b.perDay} (rationed: Telegram limits link lookups the way it limits username lookups)${b.frozenUntil ? ` · PAUSED until ${fmtDateTime(b.frozenUntil)}: Telegram asked the account to slow down` : ''}.`;
}

function renderInviteCard(r) {
  const inv = r.invite;
  const box = $('probe-result');
  box.hidden = false;
  const [label, cls] = INVITE_VERDICT[inv.verdict] || [inv.verdict, ''];
  const rows = [];
  const add = (k, v) => v !== undefined && v !== null && v !== '' && rows.push(el('dt', { text: k }), el('dd', { text: String(v) }));
  if (inv.verdict !== 'dead') {
    add('Title', inv.title);
    add('Type', inv.kind);
    add('Members', inv.members ? n(inv.members) : null);
    add('About', inv.about);
    add('Telegram flags', [inv.flags.verified && 'verified', inv.flags.scam && 'SCAM', inv.flags.fake && 'FAKE', inv.flags.paid && 'paid', inv.flags.requestNeeded && 'join approval'].filter(Boolean).join(', ') || 'none');
  }
  if (r.history) add('Readable now', r.history.readable ? `yes · ~${n(r.history.perDay)} messages/day` : 'no');
  if (r.bots && r.bots.length) add('Bots in the group', r.bots.join('  '));
  box.replaceChildren(
    el('div', { class: 'invite-card' },
      el('div', { class: 'invite-head' }, el('span', { class: `pill ${cls}`, text: label }), el('span', { class: 'title', text: inv.title || 'Invite' }), el('span', { class: 'ref', text: `invite ${inv.hashTail}` })),
      el('div', { class: 'inv-note', text: inv.note }),
      el('dl', { class: 'kv' }, rows),
      warningList(inv.warnings),
      el('div', { class: 'links' }, inviteButtons(inv, () => ($('probe-result').hidden = true))),
      el('div', { class: 'footnote', text: 'Join here, or in your Telegram app. A group that approves members one by one, or charges for them, is joined in the app: a request sent from here could not be taken back. Nothing else is written to Telegram from this page, and only on your click.' }),
      el('div', { class: 'footnote', text: budgetLine(state && state.privateGroups && state.privateGroups.budget) })));
}

function renderInvites(s) {
  const pg = s.privateGroups;
  const box = $('invites');
  const list = (pg && pg.invites) || [];
  box.hidden = !pg || list.length === 0;
  if (!pg) return;
  setText($('invite-budget'), budgetLine(pg.budget));
  const focus = /^#invite-(\d+)$/.exec(location.hash);
  paint($('invite-list'), [list, focus && focus[1]], () => list.map((inv) => {
    const [label, cls] = INVITE_STATE[inv.state] || [inv.state, ''];
    const age = inv.state === 'requested' && inv.saidAt ? agoEl(inv.saidAt, 'request sent ') : inv.joinedAt ? `in since ${fmtDateTime(inv.joinedAt)}` : agoEl(inv.createdAt, 'added ');
    const next = inv.nextCheckAt && ['requested', 'owner-opened', 'previewed', 'link-dead'].includes(inv.state) ? [' · ', untilEl(inv.nextCheckAt, 'next check ')] : null;
    return el('li', { id: `invite-${inv.id}`, class: focus && Number(focus[1]) === inv.id ? 'focus' : '' },
      el('div', { class: 'inv-row' }, el('span', { class: `pill ${cls}`, text: inv.checking ? 'checking…' : label }), el('span', { class: 'title', text: inv.title || 'Invite' }), el('span', { class: 'ref' }, age, next, ` · invite ${inv.hashTail}`)),
      el('div', { class: 'inv-note', text: inv.note }),
      inv.state === 'requested' ? el('div', { class: 'footnote', text: 'Telegram has no way to withdraw a request. If the group\'s bot wants something first, it messages you in Telegram within a few minutes of the request.' }) : null,
      el('div', { class: 'links' }, inviteButtons(inv)),
      inv.warnings.length && ['previewed', 'owner-opened'].includes(inv.state) ? el('details', { class: 'inv-more' }, el('summary', { text: `Before joining (${inv.warnings.length} notes)` }), warningList(inv.warnings)) : null);
  }));
  if (focus && !renderInvites.scrolled) {
    renderInvites.scrolled = true;
    document.getElementById(`invite-${focus[1]}`)?.scrollIntoView({ block: 'center' });
  }
}

function renderBanner(s) {
  const banner = $('verify-banner');
  const held = ((s.privateGroups && s.privateGroups.memberships) || []).filter((m) => m.state === 'verifying');
  banner.hidden = held.length === 0;
  paint(banner, held, () => held.map((m) => el('section', { class: 'verify' },
    el('h3', { text: `Verification in progress in «${m.title}»: answer it here, or in your Telegram app.` }),
    el('div', { class: 'sub', text: m.cause === 'restricted' ? 'Telegram shows this account as restricted there (it cannot send messages yet).' : 'A bot addressed you there right after you joined.' }),
    m.priors ? el('div', { class: 'sub', text: `Usual timing for this bot: ${m.priors}.` }) : null,
    m.hints.length
      ? el('ul', { class: 'hints' }, m.hints.map((h) => checkItem(m, h)))
      : el('div', { class: 'sub', text: 'No check message has shown up here yet. Some appear only inside the Telegram app.' }),
    el('ul', { class: 'always' },
      el('li', { text: 'Press the button or type the answer the check asks for: nothing is chosen or guessed for you. Buttons marked “in the Telegram app” (pages inside Telegram, logins, payments) are done there.' }),
      el('li', { text: 'Real checks never ask for codes, passwords, your phone number, a wallet, or anything to paste or run.' })),
    el('div', { class: 'links' },
      m.openLink ? el('a', { class: 'btn', href: m.openLink, text: 'Open the group in Telegram' }) : null,
      el('button', { class: 'btn', text: "I've answered it — check now", onclick: (e) => inviteAction(e.currentTarget, '/api/membership/check', { chatId: m.chatId }) })))));
}

/** One check a bot put to the account: its words, its picture, its buttons, and a box for a typed answer. */
function checkItem(m, h) {
  const real = !h.suspicious;
  const key = (k) => k.kind === 'press' && real
    ? el('button', { type: 'button', class: 'btn', text: k.label, title: 'Press this button in the group, as your account', onclick: (e) => action(e.currentTarget, '/api/verify/press', { chatId: m.chatId, msgId: h.msgId, row: k.row, col: k.col }, `Pressing «${k.label}»…`) })
    : k.kind === 'telegram'
      ? el('a', { class: 'btn', href: k.open, text: `${k.label} ↗`, title: 'Opens this in your Telegram app' })
      : el('span', { class: 'key-app', text: `${k.label} · in the Telegram app${k.host ? ` (${k.host})` : ''}` });
  const rows = [];
  for (const k of h.keys || []) (rows[k.row] ??= []).push(key(k));
  const form = real
    ? el('form', { class: 'answer', autocomplete: 'off', onsubmit: (e) => answerCheck(e, m.chatId, h.msgId) },
        el('input', { name: 'answer', maxlength: '64', placeholder: 'Or type the answer it asks for (digits, a word…)', 'aria-label': `Answer to the check in ${m.title}` }),
        el('button', { type: 'submit', class: 'btn', text: 'Send answer' }))
    : null;
  return el('li', {},
    el('div', { class: 'from', text: `From ${h.sender.username ? `@${h.sender.username}` : h.sender.name}${h.sender.bot ? ' (bot)' : ''} · ${fmtTime(h.date)} · why: ${h.why.join('; ')}` }),
    h.suspicious ? el('div', { class: 'suspicious', text: h.suspicious }) : null,
    h.text ? el('div', { class: 'text', text: h.text }) : null,
    h.photo ? checkPhoto(m.chatId, h.msgId) : h.media ? el('div', { class: 'labels', text: h.media }) : null,
    rows.length ? el('div', { class: 'keys' }, rows.filter(Boolean).map((r) => el('div', { class: 'key-row' }, r))) : null,
    form,
    form ? el('div', { class: 'labels', text: 'A typed answer posts in the group as a reply to the bot: everyone there sees it.' }) : null,
    h.done ? el('div', { class: 'done', text: `Done from here at ${h.done}` }) : null);
}

async function answerCheck(e, chatId, msgId) {
  e.preventDefault();
  const form = e.currentTarget;
  const input = form.elements.answer;
  const button = form.querySelector('button');
  if (!input.value.trim()) return;
  button.disabled = true;
  try {
    const r = await api('/api/verify/answer', { chatId, msgId, text: input.value });
    toast(r.message);
    if (r.ok) input.value = '';
    refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

const checkPhotos = new Map();
/** A check's picture (often the captcha itself), fetched with the page's token and kept for the page's life. */
function checkPhoto(chatId, msgId) {
  const img = el('img', { class: 'check-photo', alt: 'The check\'s picture' });
  const key = `${chatId}:${msgId}`;
  if (checkPhotos.has(key)) {
    img.src = checkPhotos.get(key);
    return img;
  }
  fetch('/api/verify/photo', { method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': TOKEN }, body: JSON.stringify({ chatId, msgId }) })
    .then((r) => (r.ok ? r.blob() : null))
    .then((b) => {
      if (!b) return img.replaceWith(el('div', { class: 'labels', text: '[picture: see it in your Telegram app]' }));
      const url = URL.createObjectURL(b);
      checkPhotos.set(key, url);
      img.src = url;
    })
    .catch(() => undefined);
  return img;
}

/**
 * Joins on the owner's click, after one confirmation. A group that has to be joined in the app
 * (one that approves members one by one, or a paid one) opens there instead.
 */
async function joinGroup(button, target, title, type) {
  const ask = type === 'channel'
    ? `Join the channel «${title}» with your account?\n\nReading it does not need this: Watch reads a public channel from outside.`
    : `Join «${title}» with your account?\n\nMembers will see the account join. If the group checks new members, the check shows at the top of this page within a few seconds: answer it there, in the time it gives (often 1 to 5 minutes).`;
  if (!confirm(ask)) return;
  button.disabled = true;
  toast(`Joining ${title}…`);
  try {
    const r = await api('/api/join', { target });
    toast(r.message || (r.ok ? 'Joined.' : 'Not joined.'));
    if (r.state === 'app' && r.open) el('a', { href: r.open }).click(); // opens it in the Telegram app
    await refresh();
    if (discoverView) loadDiscover();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

$('notify-test').addEventListener('click', (e) => inviteAction(e.currentTarget, '/api/notify-test', {}));

function renderProbe(r) {
  if (r.invite && r.invite.id) return renderInviteCard(r);
  const box = $('probe-result');
  box.hidden = false;
  const [label, cls] = VERDICT[r.verdict] || [r.verdict, ''];
  const rows = [];
  const add = (k, v) => v !== undefined && v !== null && v !== '' && rows.push(el('dt', { text: k }), el('dd', { text: String(v) }));
  add('Title', r.title);
  add('Type', r.type);
  add('Members', r.members ? `${n(r.members)}${r.online ? ` · ${n(r.online)} online` : ''}` : null);
  if (r.history) add('History from outside', r.history.readable ? `readable · ~${n(r.history.perDay)} messages/day · newest ${ago(r.history.newest)} · ${r.history.people} people in the last ${r.history.sampled}` : `not readable (${r.history.error})`);
  if (r.door) {
    const d = r.door;
    const door = [d.joinRequest && 'join needs admin approval', d.hiddenHistoryForNewMembers && 'history hidden for new members', d.telegramAntispam && 'Telegram anti-spam on', d.slowmodeSeconds && `slow mode ${d.slowmodeSeconds}s`, d.protectedContent && 'protected content', d.membersCannot.length && `members cannot: ${d.membersCannot.join(', ')}`, d.restricted.length && `restricted: ${d.restricted.join('; ')}`].filter(Boolean);
    add('At the door', `${door.length ? door.join(' · ') : 'nothing seen'}${d.hiddenHistoryForNewMembers === null ? ' (hidden history and anti-spam are only shown to admins)' : ''}`);
  }
  if (r.bots) add('Bots in the group', r.bots.length ? r.bots.join('  ') : 'none listed');
  if (r.flags) add('Telegram flags', [r.flags.verified && 'verified', r.flags.scam && 'SCAM', r.flags.fake && 'FAKE'].filter(Boolean).join(', ') || 'none');
  add('About', r.about);
  const canWatch = r.verdict === 'read-from-outside' || r.verdict === 'member';
  const canJoin = ['read-from-outside', 'join-needed', 'request-needed'].includes(r.verdict) && r.username;
  box.replaceChildren(
    el('div', { class: 'probe-head' }, el('span', { class: `pill ${cls}`, text: label }), el('span', { text: r.summary })),
    el('dl', { class: 'kv' }, rows),
    el('div', { class: 'actions' },
      canWatch ? el('button', { class: 'btn primary', text: r.verdict === 'member' ? 'Watch it' : 'Watch it (read without joining)', onclick: (e) => watch(e.currentTarget, r.target) }) : null,
      canJoin ? el('button', { class: `btn ${canWatch ? '' : 'primary'}`, text: 'Join', onclick: (e) => joinGroup(e.currentTarget, `@${r.username}`, r.title || r.username, r.type === 'channel' ? 'channel' : 'group') }) : null,
      !canWatch && r.verdict !== 'not-found' && r.verdict !== 'unsafe' && r.verdict !== 'folder-link'
        ? el('span', { class: 'footnote', text: canJoin ? 'Not readable from outside: join it to follow it (one that approves members one by one is joined in your Telegram app).' : 'Not readable from outside. To follow it, paste its invite link here: the page shows what to expect, and you can join from here or in your Telegram app.' })
        : null));
}

async function watch(button, target) {
  button.disabled = true;
  try {
    const r = await api('/api/watch', { target });
    toast(r.message);
    if (r.ok) {
      $('probe-result').hidden = true;
      $('add-input').value = '';
      await refresh();
      if (r.chatId) selectSource(r.chatId);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const target = $('add-input').value.trim();
  if (!target) return;
  const b = $('probe-btn');
  b.disabled = true;
  b.textContent = 'Checking…';
  try {
    const r = await api('/api/probe', { target });
    if (r.error && !r.verdict) toast(r.error);
    else {
      if (r.invite) await refresh(); // the ration and the invite list moved
      renderProbe(r);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Check';
  }
});

// ── sources controls ───────────────────────────────────────────────────────

$('refresh-list').addEventListener('click', (e) => action(e.currentTarget, '/api/refresh', {}, 'Checking your chat list…'));
$('auto-watch').addEventListener('change', async (e) => {
  const box = e.currentTarget;
  box.disabled = true;
  try {
    toast((await api('/api/settings', { autoWatchNew: box.checked })).message);
  } catch (err) {
    toast(err.message);
    box.checked = !box.checked;
  } finally {
    box.disabled = false;
  }
});

// ── find groups ────────────────────────────────────────────────────────────

const FOUND_VERDICT = { good: ['GOOD', 'ok'], ok: ['WORTH A LOOK', 'read'], low: ['LOW', 'warn'], closed: ['CLOSED', ''], scam: ['LIKELY SCAM', 'bad'] };
const LANGS = { zh: 'Chinese', en: 'English', mixed: 'Chinese + English' };
const KIND_LABEL = { groups: 'groups', channels: 'channels', both: 'groups and channels' };
let discoverView = null;
let discoverKey = { topic: 'hyperliquid', query: null, kind: savedKind() };
let discoverTimer = null;
let discoverSignature = '';

// "/2": the default became both groups and channels (2026-10-07), so a choice remembered before starts over once.
function savedKind() {
  try {
    const k = localStorage.getItem('discover-kind/2');
    return k && KIND_LABEL[k] ? k : 'both';
  } catch {
    return 'both';
  }
}

// Searches from before groups/channels was asked judged both.
const sameSearch = (r, k) => (k.query ? (r.query || '').toLowerCase() === k.query.toLowerCase() : r.topic === k.topic && !r.query) && (r.kind || 'both') === k.kind;
const recentRun = (k) => discoverView && discoverView.latest.find((r) => sameSearch(r, k) && Date.now() / 1000 - r.doneAt < 12 * 3600);

async function loadDiscover() {
  clearTimeout(discoverTimer);
  try {
    discoverView = await api('/api/discover');
  } catch {
    return;
  }
  renderDiscover();
  if (discoverView.running) discoverTimer = setTimeout(loadDiscover, 1500);
}

async function startDiscover() {
  try {
    const r = await api('/api/discover', { topic: discoverKey.topic || '', query: discoverKey.query, kind: discoverKey.kind });
    toast(r.message);
  } catch (err) {
    toast(err.message);
  }
  loadDiscover();
}

/** A topic: shows its last result when it is under 12 hours old, or searches. */
function pickTopic(topic) {
  discoverKey = { topic, query: null, kind: discoverKey.kind };
  $('discover-input').value = '';
  if (recentRun(discoverKey)) renderDiscover();
  else startDiscover();
}

/** Groups, channels or both: shows the last result of that kind, if any; searching stays a click away. */
function pickKind(kind) {
  discoverKey = { ...discoverKey, kind };
  try {
    localStorage.setItem('discover-kind/2', kind);
  } catch {
    // a remembered choice is only a convenience
  }
  renderDiscover();
}

function discoverRow(a) {
  const [label, cls] = FOUND_VERDICT[a.verdict];
  const src = state?.sources.find((x) => x.chatId === a.chatId);
  const reading = Boolean(src && src.enabled);
  const member = Boolean(src && src.member);
  const target = a.private ? a.link : a.username ? `@${a.username}` : null;
  const join = !member && target
    ? el('button', { type: 'button', class: 'btn', title: a.type === 'channel' ? 'Join the channel with your account (reading it does not need this)' : 'Join with your account: members see it; a check, if any, is answered at the top of this page', onclick: (e) => joinGroup(e.currentTarget, target, a.title, a.type) }, 'Join')
    : null;
  const sub = [a.private ? `private ${a.type}` : a.username ? `@${a.username}` : null, a.private ? null : a.type, a.language ? LANGS[a.language] : null].filter(Boolean).join(' · ');
  const hide = el('button', { type: 'button', class: 'btn', title: 'Hide it from future searches', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      toast((await api('/api/discover/dismiss', { chatId: a.chatId })).message);
      e.currentTarget.closest('tr').remove();
    } catch (err) {
      toast(err.message);
    }
  } }, 'Hide');
  const open = (title) => (a.link ? el('a', { class: 'btn', href: a.link, target: '_blank', rel: 'noopener noreferrer', title }, 'Open') : null);
  const act = reading
    ? el('span', { class: 'row-actions' }, el('span', { class: 'pill ok', text: member ? 'Member' : 'Reading' }), join)
    : a.private
      ? el('span', { class: 'row-actions' }, join, open('Private: only members can read it. Join here, or in the Telegram app; it then shows up under Sources'), hide)
      : a.verdict === 'closed'
        ? el('span', { class: 'row-actions' }, join, open('Only members can read it: join here, or in the Telegram app; it then shows up under Sources'), hide)
        : el('span', { class: 'row-actions' },
            el('button', { type: 'button', class: 'btn', title: 'Read it from outside: the account does not join', onclick: (e) => action(e.currentTarget, '/api/watch', { target: `@${a.username}` }, `Starting to read ${a.title}…`) }, 'Watch'),
            join,
            hide);
  const online = a.online === null || a.online === undefined ? null : el('div', { class: 'cell-sub', text: `${n(a.online)} online` });
  const views = a.views === null || a.views === undefined ? null : el('div', { class: 'cell-sub', text: `~${n(a.views)} views a post` });
  return el('tr', {},
    el('td', {},
      a.isNew ? el('span', { class: 'pill first', text: 'NEW', title: 'Not in the previous result of this search' }) : null,
      el('span', { class: `pill ${cls}`, text: label }),
      a.was ? el('span', { class: 'score', text: `was ${FOUND_VERDICT[a.was][0].toLowerCase()}` }) : null,
      a.verdict === 'closed' ? null : el('span', { class: 'score', text: `score ${a.score}` })),
    el('td', {},
      el('div', { class: 'src-title' }, a.link && !a.private ? el('a', { href: a.link, target: '_blank', rel: 'noopener noreferrer', title: `Open ${a.title} in Telegram` }, a.title) : a.title),
      el('div', { class: 'src-sub', text: sub })),
    el('td', {}, el('span', { class: 'num', text: n(a.members) }), online),
    el('td', {}, el('span', { class: 'num', text: a.perDay === null ? '—' : a.perDay >= 10 ? n(Math.round(a.perDay)) : a.perDay.toFixed(1) }), el('div', { class: 'cell-sub', text: a.perDay === null ? '' : a.type === 'channel' ? 'posts a day' : 'messages a day' }), views),
    el('td', {}, a.speakers === null ? '—' : el('span', { class: 'num', text: String(a.speakers) }), a.speakers === null ? null : el('div', { class: 'cell-sub', text: `in the last ${a.sampled}` })),
    el('td', {}, el('div', { class: 'why' },
      a.good.map((x) => el('span', { class: 'plus', text: `+ ${x}` })),
      a.bad.map((x) => el('span', { class: 'minus', text: `− ${x}` })),
      el('span', { class: 'via', text: `found by ${a.via.join('; ')}` }))),
    el('td', {}, act));
}

function renderDiscover() {
  const v = discoverView;
  if (!v) return;
  for (const b of $('discover-topics').children) b.classList.toggle('on', !discoverKey.query && b.dataset.topic === discoverKey.topic);
  for (const b of $('discover-kinds').children) b.classList.toggle('on', b.dataset.kind === discoverKey.kind);
  const busy = Boolean(v.running);
  const status = $('discover-status');
  status.classList.toggle('searching', busy);
  $('discover-btn').disabled = busy || !v.available;
  $('discover-again').disabled = busy || !v.available;
  for (const b of $('discover-topics').children) b.disabled = busy || !v.available;
  for (const b of $('discover-kinds').children) b.disabled = busy;
  if (!v.available) setText(status, 'Needs the reader account signed in.');
  else if (busy) setText(status, `Searching for ${v.running.label} ${KIND_LABEL[v.running.kind || 'both']}: ${v.running.step}${v.running.toLook ? ` · ${v.running.looked} of ${v.running.toLook} looked at` : ''} · ${v.running.requests || 0} requests`);
  else if (v.budget) setText(status, `${Math.max(0, v.budget.perHour - v.budget.usedHour)} of ${v.budget.perHour} searches left this hour · each sends Telegram up to 45 read-only requests and takes about a minute; nothing is joined`);

  const run = v.latest.find((r) => sameSearch(r, discoverKey));
  const box = $('discover-result');
  if (!run) {
    box.hidden = true;
    const name = discoverKey.query || [...$('discover-topics').children].find((b) => b.dataset.topic === discoverKey.topic)?.textContent || discoverKey.topic;
    if (!busy && v.available) setText(status, `${status.textContent} · no search for ${name} ${KIND_LABEL[discoverKey.kind]} yet: click the topic, or Search, to run one`);
    return;
  }
  const reading = (state?.sources || []).filter((x) => x.enabled).map((x) => x.chatId).join(',');
  const signature = `${run.id}|${run.results.length}|${run.doneAt}|${reading}`;
  if (signature === discoverSignature && !box.hidden) return;
  discoverSignature = signature;
  box.hidden = false;
  const count = (verdict) => run.results.filter((r) => r.verdict === verdict).length;
  const fresh = run.results.filter((r) => r.isNew).length;
  $('discover-summary').replaceChildren(
    el('b', { text: `${run.label} ${KIND_LABEL[run.kind || 'both']}` }), ` · searched `, agoEl(run.at), ` by ${run.by} · ${run.found} found, ${run.looked} looked at${run.requests ? `, ${run.requests} requests` : ''} · `,
    el('span', { class: 'teal', text: `${count('good')} good` }), `, ${count('ok')} worth a look, ${count('low')} low, ${count('closed')} closed, `,
    el('span', { class: 'pink', text: `${count('scam')} likely scams` }),
    run.previousAt ? ` · ${fresh ? `${fresh} new` : 'nothing new'} since the same search ${ago(run.previousAt)}` : run.previousAt === null ? ' · the first such search' : '');
  const listed = run.results.filter((r) => r.verdict !== 'scam');
  const t = $('discover-table');
  t.replaceChildren(
    el('thead', {}, el('tr', {}, ['', 'Group', 'Members', 'Activity', 'Speakers', 'Why', ''].map((h) => el('th', { text: h })))),
    el('tbody', {}, listed.length ? listed.map(discoverRow) : el('tr', {}, el('td', { class: 'empty', colspan: '7', text: 'Nothing worth reading turned up. Try other words.' }))));
  const scams = run.results.filter((r) => r.verdict === 'scam');
  $('discover-scams').hidden = scams.length === 0;
  setText($('discover-scams-label'), `${scams.length} likely scam${scams.length === 1 ? '' : 's'}, kept out of the list (no links)`);
  $('discover-scam-list').replaceChildren(...scams.map((a) => el('li', {}, el('span', { class: 't', text: `${a.isNew ? 'NEW · ' : ''}${a.title}${a.username ? ` · @${a.username}` : a.private ? ' · private' : ''}` }), el('br'), el('span', { class: 'r', text: a.bad.join(' · ') }))));
  $('discover-notes').replaceChildren(...[...(run.error ? [`Stopped early: ${run.error}`] : []), ...run.notes].map((x) => el('li', { text: x })));
}

$('discover-topics').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled) pickTopic(b.dataset.topic);
});
$('discover-kinds').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && !b.disabled) pickKind(b.dataset.kind);
});
$('discover-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('discover-input').value.trim();
  if (q.length >= 2) discoverKey = { topic: '', query: q, kind: discoverKey.kind };
  startDiscover();
});
$('discover-again').addEventListener('click', startDiscover);

// ── activity feed ──────────────────────────────────────────────────────────

function feedItem(a, fresh) {
  const kind = a.ok ? a.kind : 'error';
  const [badge, cls] = KIND[kind] || [kind, ''];
  const label = METHODS[a.method] || a.method;
  const tail = `${a.detail ? ` · ${a.detail}` : ''} · ${a.actor}${a.ms !== null ? ` · ${a.ms}ms` : ''}`;
  return el('li', { class: `${kind}${fresh ? ' fresh' : ''}`, 'data-kind': kind, title: `${fmtFull(a.at)}\n${label}${a.target ? ` · ${a.target}` : ''}${tail}` },
    el('time', { text: fmtTime(a.at) }),
    el('span', { class: `kind ${cls}`, text: badge }),
    el('span', { class: 'what' }, el('b', { text: label }), a.target ? ` · ${a.target}` : '', el('span', { class: 'meta', text: tail })));
}

function shown(a) {
  const kind = a.ok ? a.kind : 'error';
  if (filter === 'llm') return kind === 'llm' || kind === 'agent' || a.actor === 'claude'; // everything Claude did: API calls, MCP reads, its actions
  return filter === 'all' ? kind !== 'system' : kind === filter;
}

function renderFeed() {
  const list = $('feed');
  const rows = feedRows.filter(shown).slice(-300).reverse();
  list.replaceChildren(...(rows.length ? rows.map((a) => feedItem(a, false)) : [el('li', { class: 'empty', text: 'Nothing yet.' })]));
}

function addActivity(a) {
  // Rows other processes write (Claude's MCP server) reach the stream a moment late, so an id can
  // arrive after a higher one: skip only what is already here.
  if (a.id <= lastActivityId && feedRows.some((r) => r.id === a.id)) return;
  lastActivityId = Math.max(lastActivityId, a.id);
  window.Crawler?.activity(a);
  feedRows.push(a);
  if (feedRows.length > FEED_MAX) feedRows.splice(0, feedRows.length - FEED_MAX);
  if (shown(a)) {
    const list = $('feed');
    if (list.firstElementChild?.classList.contains('empty')) list.replaceChildren();
    list.prepend(feedItem(a, !document.hidden));
    while (list.children.length > 300) list.lastChild.remove();
  }
  const sel = $('msg-source').value;
  if (a.method === 'messages.GetHistory' && /→ [1-9]/.test(a.detail) && state?.sources.some((s) => String(s.chatId) === sel && s.title === a.target)) scheduleMessages();
  if (a.actor === 'news' || (a.actor === 'reader' && a.method === 'stored')) scheduleNews();
  // Reads arrive every few seconds and change nothing on the page but a count: the regular refresh
  // picks that up. Anything else (stored messages, switches, errors, writes) refreshes soon.
  if (a.kind !== 'read' || !a.ok) scheduleRefresh();
}

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  for (const x of $('filters').children) x.classList.toggle('on', x === b);
  renderFeed();
});

// ── messages ───────────────────────────────────────────────────────────────

function selectSource(chatId) {
  $('msg-source').value = String(chatId);
  loadMessages();
  $('messages-panel').scrollIntoView({ behavior: calm.matches ? 'auto' : 'smooth', block: 'start' });
}
$('msg-source').addEventListener('change', loadMessages);
if (window.Crawler) {
  window.Crawler.onPick = (chatId) => {
    if (![...$('msg-source').options].some((o) => o.value === String(chatId))) return;
    $('msg-source').value = String(chatId);
    loadMessages();
  };
}

let msgTimer = null;
function scheduleMessages() {
  if (document.hidden) return void (stale = true);
  clearTimeout(msgTimer);
  msgTimer = setTimeout(loadMessages, 800);
}

let msgView = 'signal';
let msgShown = '';
$('msg-view').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  msgView = b.dataset.v;
  for (const x of $('msg-view').children) x.classList.toggle('on', x === b);
  loadMessages();
});

/** The signal header, shortened to its numbers (the whole sentence is in the tooltip). */
function signalStat(header) {
  const node = $('msg-stat');
  node.title = header || '';
  if (!header) return setText(node, '');
  const total = /^(\d+) messages/.exec(header);
  const on = /→ (\d+) on-topic lines in (\d+) conversations/.exec(header);
  setText(node, total && on ? `${n(Number(total[1]))} messages · ${n(Number(on[1]))} on-topic lines in ${n(Number(on[2]))} conversations` : header);
}

function signalLine(l) {
  return el('li', {},
    el('div', { class: 'who' },
      el('b', { text: l.author }),
      el('span', { text: fmtWhen(l.date) }),
      el('span', { text: `#${l.ids[0]}${l.ids.length > 1 ? ` +${l.ids.length - 1} joined` : ''}` }),
      l.replies ? el('span', { text: `${l.replies} ${l.replies === 1 ? 'reply' : 'replies'}` }) : null,
      l.echoes ? el('span', { text: `×${l.echoes.times} by ${l.echoes.people} people` }) : null),
    el('div', { class: 'text', text: l.text }));
}

function plainLine(m) {
  return el('li', {},
    el('div', { class: 'who' },
      el('b', { text: m.author }),
      el('span', { text: fmtWhen(m.date) }),
      m.reactions ? el('span', { text: `${m.reactions} reactions` }) : null,
      m.replyTo ? el('span', { text: 'reply' }) : null),
    el('div', { class: 'text', text: m.text }));
}

async function loadMessages() {
  const chat = $('msg-source').value;
  const view = msgView;
  const list = $('msgs');
  const fresh = `${chat}|${view}` !== msgShown;
  let items;
  let empty;
  if (!chat) {
    items = [];
    empty = 'No source selected.';
    signalStat('');
  } else if (view === 'signal') {
    const sig = await api(`/api/signal?chat=${encodeURIComponent(chat)}&hours=24`).catch(() => null);
    if ($('msg-source').value !== chat || msgView !== view) return; // switched meanwhile
    setText($('msg-hint'), 'Noise removed, on-topic only: what Claude reads');
    signalStat(sig && sig.header);
    items = (sig ? sig.lines.slice().reverse() : []).map((l) => ({ k: `s${l.ids[0]}`, s: `${l.ids.length}|${l.replies}|${l.echoes ? l.echoes.times : 0}|${l.author}|${l.text}`, make: () => signalLine(l) }));
    empty = 'No on-topic messages in the last 24 hours.';
  } else {
    const rows = await api(`/api/messages?chat=${encodeURIComponent(chat)}&limit=150`).catch(() => []);
    if ($('msg-source').value !== chat || msgView !== view) return;
    setText($('msg-hint'), 'Every stored message, newest first');
    signalStat('');
    items = rows.slice().reverse().map((m) => ({ k: `m${m.id}`, s: `${m.reactions}|${m.author}|${m.text}`, make: () => plainLine(m) }));
    empty = 'No messages stored yet.';
  }
  if (fresh) {
    // Another source or view: start over at the top. The same one: only new lines are added, and
    // what is on screen stays where it is.
    list.__rows = null;
    list.scrollTop = 0;
    msgShown = `${chat}|${view}`;
  }
  sync(list, items, { key: (x) => x.k, sig: (x) => x.s, render: (x) => x.make(), empty: emptyLi(empty) });
}

// ── digests and outgoing ───────────────────────────────────────────────────

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'INS', 'S', 'STRIKE', 'DEL', 'CODE', 'PRE', 'BLOCKQUOTE', 'A', 'BR', 'SPAN', 'TG-SPOILER']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const walk = (node) => {
    const out = document.createDocumentFragment();
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out.append(c.textContent);
      else if (c.nodeType === Node.ELEMENT_NODE) {
        if (!ALLOWED.has(c.tagName)) {
          out.append(walk(c));
          continue;
        }
        const tag = c.tagName === 'TG-SPOILER' ? 'span' : c.tagName.toLowerCase();
        const e = document.createElement(tag);
        if (tag === 'a') {
          const href = c.getAttribute('href') || '';
          if (/^https:\/\//i.test(href)) {
            e.href = href;
            e.target = '_blank';
            e.rel = 'noopener noreferrer';
          }
        }
        e.append(walk(c));
        out.append(e);
      }
    }
    return out;
  };
  return walk(doc.body.firstChild);
}

// Folders: one per group, newest first. The page refreshes every few seconds, so what the owner
// opened stays open (remembered here), and an unchanged panel is not redrawn at all.
const openFolders = new Set();
const openItems = new Set();
const closedItems = new Set();
let outboxSignature = '';

function folderIcon() {
  const svg = svgIcon('M1.5 3.5A1.5 1.5 0 0 1 3 2h4.2l1.6 1.8H17a1.5 1.5 0 0 1 1.5 1.5v8.2A1.5 1.5 0 0 1 17 15H3a1.5 1.5 0 0 1-1.5-1.5z', 'folder-icon');
  svg.setAttribute('viewBox', '0 0 20 16');
  return svg;
}

// Claude's digests are Markdown. Shown as text nodes only (headings, list lines, **bold**): nothing
// from the digest is ever parsed as HTML.
/** Where a group's messages open in Telegram ("https://t.me/name/"), or null (a basic group has no message links). */
function messageBase(chatId) {
  const s = state?.sources.find((x) => x.chatId === chatId);
  if (s && s.ref.startsWith('@')) return `https://t.me/${s.ref.slice(1)}/`;
  const id = String(chatId);
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/` : null;
}

function renderMarkdown(escaped, base = null) {
  const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // **bold**, and citations [#id](link) made clickable only when the link opens that very message of
  // the digest's own group. Any other link stays text: an invite, a bot start or a proxy link in a
  // digest (Claude could be led to write one by what it read) is never one click away.
  const inline = (text) => {
    const out = [];
    const re = /\*\*(.+?)\*\*|\[#(\d{1,12})\]\((https:\/\/t\.me\/[A-Za-z0-9_/]{1,80}?\/(\d{1,12}))\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      const cite = m[1] === undefined;
      if (cite && !(base && m[2] === m[4] && m[3].toLowerCase() === `${base}${m[4]}`.toLowerCase())) continue;
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(cite ? el('a', { href: m[3], target: '_blank', rel: 'noopener noreferrer', text: `#${m[2]}` }) : el('b', { text: m[1] }));
      last = re.lastIndex;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  };
  const box = el('div', { class: 'md' });
  for (const raw of decode(escaped).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    const item = /^(\s*)((?:\d+\.)|[-*])\s+(.*)$/.exec(line);
    if (!line) box.append(el('div', { class: 'md-gap' }));
    else if (heading) box.append(el('div', { class: 'md-h' }, inline(heading[1])));
    else if (item) box.append(el('div', { class: `md-li${item[1].length >= 2 ? ' md-li2' : ''}` }, el('span', { class: 'md-mark', text: item[2] === '*' ? '-' : item[2] }), ' ', inline(item[3])));
    else box.append(el('div', { class: 'md-p' }, inline(line.trim())));
  }
  return box;
}

const TRASH = 'M3.5 5.5h13M8 5.5v-2h4v2M5.5 5.5l.8 10.2a1 1 0 0 0 1 .8h5.4a1 1 0 0 0 1-.8l.8-10.2M8.5 8.5v5M11.5 8.5v5';

/** The owner's delete button on one digest (or message): asks once, then deletes it for good. */
async function deleteDigest(button, item, folder) {
  const what = folder.key === 'other' ? 'message' : 'digest';
  const where = [
    'It goes from this page and from the digests Claude reads back before writing the next one',
    item.format === 'markdown' ? ', and its file in data/digests/ is deleted' : '',
    '.',
    item.delivered ? ' The copy already sent to Telegram stays there.' : '',
  ].join('');
  if (!confirm(`Delete this ${what} for good?\n\n${folder.title}\n${item.heading || fmtDateTime(item.at)}\n\n${where} This cannot be undone.`)) return;
  button.disabled = true;
  try {
    const r = await api('/api/digest/delete', { id: item.id });
    toast(r.message);
    await refresh();
    loadStorage();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function renderOutbox(s) {
  setText($('out-hint'), s.bot ? 'What the service sent to Telegram, one folder per group' : 'Kept here and in data/digests/, one folder per group');
  const folders = s.digestFolders || [];
  const signature = JSON.stringify(folders.map((f) => [f.key, f.items.map((i) => [i.id, i.delivered])]));
  if (signature === outboxSignature) return;
  outboxSignature = signature;
  const list = $('outbox');
  if (folders.length === 0) {
    list.replaceChildren(el('li', { class: 'empty', text: s.claude.ready ? 'No digests yet. They run at the daily hour, or use Digest now in a source\'s menu.' : 'No digests yet. Ask Claude Desktop to summarise a group, or wait for the daily task.' }));
    return;
  }
  list.replaceChildren(...folders.map((f) => {
    const folder = el('details', { class: 'folder', open: openFolders.has(f.key) },
      el('summary', {},
        folderIcon(),
        el('span', { class: 'folder-title', text: f.title }),
        el('span', { class: 'folder-meta', text: `${f.count} ${f.key === 'other' ? 'message' : 'digest'}${f.count === 1 ? '' : 's'} · latest ${fmtDateTime(f.latestAt)}` })),
      el('ol', { class: 'folder-items' }, f.items.map((item, i) => {
        const key = String(item.id);
        // The newest one opens with its folder, unless the owner closed it.
        const open = openItems.has(key) || (i === 0 && !closedItems.has(key));
        const d = el('details', { class: 'digest-item', open },
          el('summary', {},
            el('span', { class: `pill ${item.delivered ? 'ok' : ''}`, text: item.delivered ? 'sent' : 'kept here' }),
            el('span', { class: 'digest-heading', text: item.heading || fmtDateTime(item.at) }),
            el('span', { class: 'digest-at', text: fmtDateTime(item.at) })),
          el('div', { class: 'body' }, item.format === 'markdown' ? renderMarkdown(item.body, f.chatId === null ? null : messageBase(f.chatId)) : sanitize(item.body)));
        d.addEventListener('toggle', () => {
          if (d.open) {
            openItems.add(key);
            closedItems.delete(key);
          } else {
            openItems.delete(key);
            closedItems.add(key);
          }
        });
        const del = el('button', { type: 'button', class: 'icon-btn digest-del', title: f.key === 'other' ? 'Delete this message' : 'Delete this digest', 'aria-label': `Delete «${item.heading || fmtDateTime(item.at)}»` }, svgIcon(TRASH));
        del.addEventListener('click', () => deleteDigest(del, item, f));
        return el('li', { class: 'digest-row' }, d, del);
      })));
    folder.addEventListener('toggle', () => (folder.open ? openFolders.add(f.key) : openFolders.delete(f.key)));
    return el('li', {}, folder);
  }));
}

// ── news radar ─────────────────────────────────────────────────────────────

const openTopics = new Set();

function span(lag) {
  const s = Math.abs(Math.round(lag));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m` : `${s}s`;
}

function lagBadge(lag, source) {
  if (lag < 0) return el('span', { class: 'lag before', text: `${span(lag)} before the first report`, title: 'The group was talking about it before the first outlet reported it' });
  return el('span', { class: `lag${lag < 1800 ? ' fast' : ''}`, text: `+${span(lag)}${source ? ` after ${source}` : ''}`, title: 'How long after the first report this came up in the group' });
}

/** Message text with the named keywords marked (text nodes only). */
function marked(text, marks) {
  const out = [];
  let last = 0;
  for (const [a, b] of marks || []) {
    if (a < last || b > text.length) continue;
    if (a > last) out.push(text.slice(last, a));
    out.push(el('mark', { text: text.slice(a, b) }));
    last = b;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function safeLink(href, text) {
  return /^https:\/\//i.test(href || '') ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text }) : el('span', { text });
}

const LEVEL = { hot: ['HOT', 'hot'], first: ['Had it first', 'first'], echo: ['came up', 'read'] };
const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

function topicSig(k) {
  return JSON.stringify([k.label, k.headline, k.terms, k.sources.map((x) => [x.name, x.at, x.tier, x.link, x.title]), k.groups.map((g) => [g.chatId, g.title, g.count, g.people, g.level, g.firstLag, g.messages.map((m) => [m.messageId, m.text])])]);
}

/** What a topic shows when opened. Built on the first open, not for every topic on every refresh. */
function topicBody(k) {
  return el('div', { class: 'topic-body' },
    el('div', { class: 'src-links' }, k.sources.map((src) => el('div', { class: 'src-link' }, el('span', { class: 'who', text: `${src.name} · ${fmtWhen(src.at)}` }), safeLink(src.link, src.title)))),
    k.terms.length ? el('div', { class: 'terms' }, el('span', { class: 'eyebrow', text: 'Looked for' }), k.terms.map((t) => el('span', { class: 'chip', text: t }))) : null,
    k.groups.length === 0 ? el('div', { class: 'quiet-note', text: 'Not mentioned in your groups (yet).' }) : null,
    ...k.groups.map((g) => el('div', { class: `echo-group ${g.level}` },
      el('div', { class: 'echo-head' }, el('b', { text: g.title }), el('span', { text: `${plural(g.count, 'message', 'messages')} from ${plural(g.people, 'person', 'people')} · first` }), lagBadge(g.firstLag, k.sources[0] && k.sources[0].name)),
      ...g.messages.map((m) => el('div', { class: 'echo-msg' }, el('span', { class: 'at', text: `${fmtHM(m.date)} ${m.author}`, title: `#${m.messageId}` }), ...marked(m.text, m.marks))))));
}

function topicItem(k) {
  const d = el('details', { class: 'topic', open: openTopics.has(k.id) });
  const build = () => {
    if (d.__built) return;
    d.__built = true;
    d.append(topicBody(k));
  };
  d.addEventListener('toggle', () => (d.open ? openTopics.add(k.id) : openTopics.delete(k.id)));
  const echoes = k.groups.map((g) => {
    const [label, cls] = LEVEL[g.level] || LEVEL.echo;
    return el('span', { class: `pill ${cls}`, text: `${g.level === 'echo' ? `×${g.count}` : label} · ${g.title}`, title: `${plural(g.count, 'message', 'messages')} from ${plural(g.people, 'person', 'people')}` });
  });
  // Built on the click, before the browser opens it, so it never opens empty.
  d.append(el('summary', { onclick: build },
    el('div', { class: 'topic-head' }, el('span', { class: 'topic-label', text: k.label }), ...echoes),
    k.headline ? el('div', { class: 'topic-headline', text: k.headline }) : null,
    // A space between the sources, so a long line breaks after a "·", never before one.
    el('div', { class: 'topic-sources' }, k.sources.flatMap((src, i) => [i ? ' ' : null, el('span', { class: src.tier === 1 ? 't1' : '', title: src.title }, `${src.name} ${fmtHM(src.at)}`)]))));
  if (d.open) build();
  return el('li', {}, d);
}

function hitItem(h) {
  return el('li', {},
    el('div', { class: 'hit-meta' }, el('b', { text: h.group }), el('span', { text: `${h.author} · ${fmtWhen(h.date)}`, title: `#${h.messageId}` }), lagBadge(h.lag, h.source)),
    el('div', { class: 'hit-text' }, ...marked(h.text, h.marks)),
    el('div', { class: 'hit-about' }, 'about ', el('span', { text: h.label })));
}

function alertItem(a) {
  return el('li', { class: a.kind },
    el('div', { class: 'head' }, el('span', { class: `pill ${a.kind === 'hot' ? 'hot' : 'first'}`, text: a.kind === 'hot' ? 'HOT' : 'Had it first' }), el('span', { text: a.group }), el('span', { class: 'meta', text: fmtWhen(a.at) })),
    el('div', { class: 'detail', text: a.detail }));
}

const NEWS_HEAD = ['', 'Source', 'Kind', 'Tier', 'Read', 'Last read', 'Items · 24h', 'Delay', 'Status', ''];

function newsSourceRow(src) {
  const sw = el('input', { type: 'checkbox', role: 'switch', 'aria-label': `Use ${src.name}` });
  sw.checked = src.enabled;
  sw.addEventListener('change', async () => {
    sw.disabled = true;
    try {
      toast((await api('/api/news/toggle', { id: src.id, on: sw.checked })).message);
    } catch (err) {
      toast(err.message);
      sw.checked = !sw.checked;
    } finally {
      sw.disabled = false;
      loadNews(true);
    }
  });
  const [cls, label] = !src.enabled ? ['muted', 'Off']
    : src.error ? ['bad', src.error]
    : src.kind === 'telegram' ? ['ok', 'Read with the groups']
    : src.lastOkAt ? ['ok', 'Answering'] : ['muted', 'Not read yet'];
  let host = '';
  try {
    host = src.url ? new URL(src.url).hostname.replace(/^www\./, '') : '';
  } catch {
    host = '';
  }
  const last = el('time');
  const items = el('span');
  const tr = el('tr', { class: src.enabled ? '' : 'off' },
    el('td', {}, sw),
    el('td', {}, el('div', { class: 'src-title', text: src.name }), el('div', { class: 'src-sub', text: host })),
    el('td', { text: src.kind === 'rss' ? 'RSS feed' : 'Telegram channel' }),
    el('td', { text: src.tier === 1 ? 'First tier' : 'Tier 2' }),
    el('td', { text: src.kind === 'rss' ? (src.everyS >= 60 ? `every ${Math.round(src.everyS / 60)}m` : `every ${src.everyS}s`) : 'with the sources' }),
    el('td', {}, last),
    el('td', {}, items),
    el('td', { text: src.delayMin === null ? '—' : `~${src.delayMin}m`, title: 'Median time from publication to the radar seeing it (recent items)' }),
    el('td', { title: src.error || '' }, el('div', { class: `state ${cls}` }, el('span', { class: 'dot' }), el('span', { text: label }))),
    el('td', {}, src.builtin || src.kind === 'telegram' ? null : el('button', { class: 'btn', text: 'Remove', onclick: (e) => newsAction(e.currentTarget, '/api/news/remove', { id: src.id }) })));
  tr.__update = (x) => {
    setAgo(last, x.lastFetchAt);
    setText(items, n(x.items24h));
  };
  return tr;
}

async function newsAction(button, path, body, pending) {
  button.disabled = true;
  if (pending) toast(pending);
  try {
    const r = await api(path, body);
    toast(r.message || (r.ok ? 'Done.' : 'Failed.'));
    await loadNews(true);
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

function renderNews(v) {
  const panel = $('news-panel');
  panel.hidden = !v.enabled;
  document.querySelector('#nav a[href="#news-panel"]').hidden = !v.enabled;
  window.Crawler?.setNews(v);
  if (!v.enabled) return;
  const on = v.sources.filter((x) => x.enabled);
  const failing = on.filter((x) => x.kind === 'rss' && x.error);
  setText($('news-status'), `${n(v.items24h)} items today from ${on.filter((x) => x.items24h > 0).length} sources${failing.length ? ` · ${failing.length} not answering` : ''}`);
  setText($('news-sources-label'), `News sources · ${on.length} on${failing.length ? ` · not answering: ${failing.map((x) => x.name).join(', ')}` : ''}`);
  // Alerts: what was escalated today.
  sync($('news-alerts'), v.alerts, { key: (a) => `${a.chatId}:${a.topicId}:${a.kind}`, sig: (a) => `${a.group}|${a.at}|${a.detail}`, render: alertItem });
  // Keywords: confirmed by two outlets, or showing up in a group, first.
  const rank = (k) => (k.groups.some((g) => g.level === 'hot') ? 3 : k.groups.some((g) => g.level === 'first') ? 2 : k.groups.length ? 1 : 0);
  const main = v.keywords.filter((k) => k.sources.length >= 2 || k.groups.length > 0).sort((a, b) => rank(b) - rank(a) || b.score - a.score);
  const single = v.keywords.filter((k) => !(k.sources.length >= 2 || k.groups.length > 0));
  sync($('news-topics'), main, { key: (k) => k.id, sig: topicSig, render: topicItem, empty: emptyLi(v.items24h ? 'No story carried by two outlets yet today.' : 'Reading the feeds… the first keywords appear within a minute.') });
  $('news-more').hidden = single.length === 0;
  setText($('news-more-label'), `Single-source headlines (${single.length})`);
  sync($('news-single'), single.slice(0, 40), { key: (k) => k.id, sig: topicSig, render: topicItem });
  // In the groups: newest first.
  sync($('news-hits'), v.hits, {
    key: (h) => `${h.chatId}:${h.messageId}:${h.topicId}`,
    sig: (h) => JSON.stringify([h.group, h.author, h.date, h.text, h.marks, h.lag, h.source, h.label]),
    render: hitItem,
    empty: emptyLi("Nothing in your groups has named today's news yet."),
  });
  const t = $('news-sources');
  if (!t.tBodies.length) t.append(el('thead', {}, el('tr', {}, NEWS_HEAD.map((h) => el('th', { text: h })))), el('tbody'));
  sync(t.tBodies[0], v.sources, {
    key: (x) => x.id,
    sig: (x) => JSON.stringify([x.name, x.url, x.kind, x.tier, x.everyS, x.enabled, x.builtin, x.error, Boolean(x.lastOkAt), x.delayMin]),
    render: newsSourceRow,
    update: (row, x) => row.__update(x),
  });
}

let newsLoading = false;
let newsLoadedAt = 0;
async function loadNews(force) {
  if (newsLoading && !force) return;
  newsLoading = true;
  try {
    const v = await api('/api/news');
    newsLoadedAt = Date.now();
    renderNews(v);
  } catch {
    // the console is reconnecting; the next refresh tries again
  } finally {
    newsLoading = false;
  }
}

$('news-refresh').addEventListener('click', (e) => newsAction(e.currentTarget, '/api/news/refresh', {}, 'Reading every feed…'));
$('feed-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('feed-url').value.trim();
  if (!url) return;
  const b = $('feed-btn');
  b.disabled = true;
  b.textContent = 'Reading…';
  try {
    const r = await api('/api/news/feed', { url, name: $('feed-name').value.trim() });
    toast(r.message);
    if (r.ok) {
      $('feed-url').value = '';
      $('feed-name').value = '';
    }
    await loadNews(true);
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
    b.textContent = 'Add feed';
  }
});

// ── storage ────────────────────────────────────────────────────────────────

let storageNow = null;
async function loadStorage() {
  storageNow = await api('/api/storage').catch(() => null);
  if (!storageNow) return;
  const s = storageNow;
  setText($('storage-now'),
    `${n(s.messages)} messages from ${n(s.sources)} sources · ${n(s.people)} names · ${n(s.activity)} activity rows · ` +
    `${n(s.outbox)} digests & outgoing messages${s.digestFiles ? ` (+${n(s.digestFiles)} files)` : ''} · ${(s.bytes / 1048576).toFixed(1)} MB on disk · ` +
    `messages older than ${s.retentionDays} days are deleted automatically`);
}

$('clear-btn').addEventListener('click', async () => {
  const b = $('clear-btn');
  const what = { messages: $('clear-messages').checked, activity: $('clear-activity').checked, digests: $('clear-digests').checked };
  if (!what.messages && !what.activity && !what.digests) return toast('Choose what to clear first.');
  await loadStorage();
  const s = storageNow || {};
  const list = [
    what.messages ? `${n(s.messages)} messages and ${n(s.people)} names` : null,
    what.activity ? `${n(s.activity)} activity rows` : null,
    what.digests ? `${n(s.outbox)} digests & outgoing messages, and their files` : null,
  ].filter(Boolean);
  if (!confirm(`Delete permanently: ${list.join(', ')}?\n\nThis cannot be undone. Sources, switches and reading positions are kept, so nothing is downloaded again.`)) return;
  b.disabled = true;
  try {
    const r = await api('/api/clear', what);
    toast(r.message);
    if (what.activity) {
      feedRows.length = 0;
      lastActivityId = 0;
      for (const a of await api('/api/activity?limit=400').catch(() => [])) {
        feedRows.push(a);
        lastActivityId = Math.max(lastActivityId, a.id);
      }
      renderFeed();
    }
    await refresh();
    await loadStorage();
    loadMessages();
  } catch (err) {
    toast(err.message);
  } finally {
    b.disabled = false;
  }
});

// ── folding: each module folds away under its heading, remembered on this computer ─

const FOLDED = 'console-folded';
const CHEVRON = 'M6 8l4 4 4-4';

function foldedIds() {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch {
    return new Set(); // a remembered fold is only a convenience
  }
}

function setFolded(section, on) {
  section.classList.toggle('folded', on);
  const b = section.querySelector('.fold');
  if (b) {
    b.setAttribute('aria-expanded', String(!on));
    b.title = on ? 'Show this section' : 'Fold this section away';
  }
  const ids = foldedIds();
  if (on) ids.add(section.id);
  else ids.delete(section.id);
  try {
    localStorage.setItem(FOLDED, JSON.stringify([...ids]));
  } catch {
    // a private window or blocked storage: it folds, it is just not remembered
  }
}

/** A fold button for every module: on each panel's heading, and at the head of the live view's stats line. */
function makeFoldable() {
  const remembered = foldedIds();
  for (const section of document.querySelectorAll('#crawler, main > .panel, main > .split > .panel')) {
    const button = el('button', { type: 'button', class: 'fold', 'aria-expanded': 'true', 'aria-controls': section.id, title: 'Fold this section away' }, svgIcon(CHEVRON, 'chev'));
    if (section.id === 'crawler') {
      button.classList.add('hud-fold');
      button.append(el('span', { class: 'idx', text: '01' }), 'Live');
      section.querySelector('.hud-top').prepend(button);
    } else {
      const h2 = section.querySelector('.panel-head h2');
      button.append(...h2.childNodes);
      h2.append(button);
    }
    button.addEventListener('click', () => setFolded(section, !section.classList.contains('folded')));
    if (remembered.has(section.id)) setFolded(section, true);
  }
  // Going to a folded module (the header's links, or the address) opens it first.
  const open = (hash) => {
    const s = hash && hash.length > 1 ? document.getElementById(hash.slice(1)) : null;
    if (s?.classList.contains('folded')) setFolded(s, false);
  };
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (a) open(a.getAttribute('href'));
  });
  addEventListener('hashchange', () => open(location.hash));
  open(location.hash);
}

// ── refresh loop and live stream ───────────────────────────────────────────

// While the page is hidden nothing is fetched or drawn; it catches up the moment it is shown again.
let stale = false;

let newsTimer = null;
function scheduleNews() {
  if (document.hidden) return void (stale = true);
  if (newsTimer) return;
  newsTimer = setTimeout(() => {
    newsTimer = null;
    loadNews();
  }, 2500);
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 3000);
}

let inflight = null;
let queued = null;
/**
 * One refresh at a time. A call while one runs gets the next one, which starts when it ends: so
 * `await refresh()` after an action always sees the state after that action.
 * `first`: the page's first draw, which happens even in a background tab.
 */
function refresh(first) {
  if (document.hidden && !first) {
    stale = true;
    return Promise.resolve();
  }
  if (inflight) {
    queued ??= inflight.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  }
  inflight = (async () => {
    try {
      state = await api('/api/state');
      renderBanner(state);
      window.Crawler?.setState(state);
      setText($('foot-up'), state.startedAt ? `Running since ${fmtWhen(state.startedAt)}` : '');
      renderSources(state);
      renderInvites(state);
      renderOutbox(state);
      if (discoverView) renderDiscover(); // "Reading" follows a Watch
      if ($('notify-test').hidden !== !state.notifications) $('notify-test').hidden = !state.notifications;
      if (!state.news) $('news-panel').hidden = true;
      else if (Date.now() - newsLoadedAt > 20_000) loadNews();
    } catch {
      setLive(false, 'Console not reachable');
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  tickTimes();
  if (!stale) return;
  stale = false;
  refresh();
  loadNews(true);
  loadMessages();
});

function setLive(on, text) {
  $('live').className = `live ${on ? 'on' : 'off'}`;
  setText($('live-text'), text);
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => setLive(true, 'Live'));
  es.addEventListener('activity', (e) => addActivity(JSON.parse(e.data)));
  es.addEventListener('error', () => setLive(false, 'Reconnecting…'));
}

/** The header's section links follow the scroll (one observer, no scroll handler). */
function followSections() {
  const links = new Map([...document.querySelectorAll('#nav a')].map((a) => [a.getAttribute('href').slice(1), a]));
  const inView = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) inView.add(e.target.id);
      else inView.delete(e.target.id);
    }
    const current = [...links.keys()].find((id) => inView.has(id));
    for (const [id, a] of links) {
      if (id === current) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    }
  }, { rootMargin: '-72px 0px -62% 0px' });
  for (const id of links.keys()) if ($(id)) io.observe($(id));
}

(async () => {
  makeFoldable();
  followSections();
  await refresh(true);
  const initial = await api('/api/activity?limit=400').catch(() => []);
  for (const a of initial) {
    feedRows.push(a);
    lastActivityId = Math.max(lastActivityId, a.id);
  }
  window.Crawler?.history(initial);
  renderFeed();
  connect();
  loadStorage();
  loadDiscover();
  setInterval(refresh, 10_000);
  setInterval(() => !document.hidden && loadStorage(), 60_000);
  setInterval(() => !document.hidden && $('msg-source').value && loadMessages(), 30_000);
  setInterval(() => !document.hidden && tickTimes(), 10_000);
})();
