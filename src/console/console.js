// Console page. Everything that comes from Telegram (titles, names, messages, digests) is untrusted
// text: it is set with textContent, and digest HTML goes through an allowlist sanitizer.
'use strict';

const TOKEN = document.querySelector('meta[name="console-token"]').content;
const $ = (id) => document.getElementById(id);
let state = null;
let filter = 'all';
let lastActivityId = 0;
const feedRows = [];
const FEED_MAX = 600;

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

const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtDateTime = (t) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
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
const n = (x) => (x === null || x === undefined ? '—' : Number(x).toLocaleString());
const usd = (x) => `$${(x || 0).toFixed(x >= 1 ? 2 : 3)}`;

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
  'users.GetUsers': 'read a profile',
  'users.GetFullUser': 'read a profile',
  'messages.CheckChatInvite': 'look at an invite (no join)',
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
};
const KIND = {
  read: ['READ', 'read'],
  write: ['WRITE', 'warn'],
  event: ['EVENT', 'muted'],
  llm: ['CLAUDE', 'llm'],
  error: ['ERROR', 'bad'],
  system: ['SYS', 'muted'],
};

// ── cards ──────────────────────────────────────────────────────────────────

function card(cls, label, big, ...lines) {
  return el('div', { class: `card ${cls}` }, el('div', { class: 'label', text: label }), big, ...lines.filter(Boolean).map((l) => (l instanceof Node ? l : el('div', { class: 'line', text: l }))));
}

function renderCards(s) {
  const cards = $('cards');
  cards.replaceChildren();
  // Reader account
  if (s.account) {
    const conn = s.account.connection;
    const offline = conn && conn.state === 'offline';
    cards.append(card(offline ? 'bad' : 'ok', 'Reader account', el('div', { class: 'big', text: s.account.name }),
      conn ? el('div', { class: 'line' }, el('span', { class: `pill ${offline ? 'bad' : 'ok'}`, text: offline ? 'Telegram unreachable' : 'connected' }), ` since ${fmtDateTime(conn.since)}${offline ? ' · retrying every 3s; missed messages are fetched when it is back' : ''}`) : null,
      `Telegram id ${s.account.id} · signed in`,
      'Revoke any time: Telegram → Settings → Devices → Group Pulse → Terminate.'));
  } else {
    cards.append(card('bad', 'Reader account', el('div', { class: 'big', text: 'Not signed in' }),
      s.readerConfigured ? 'Run npm run login, then restart.' : 'Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env, then npm run login.'));
  }
  // What it did to the account
  const c = s.activity.counts;
  const writes = c.write || 0;
  const lw = s.activity.lastWrite;
  cards.append(card(writes ? 'warn' : 'ok', 'Account actions · last 24h',
    el('div', { class: 'nums' },
      el('div', {}, el('b', { text: n(c.read || 0) }), el('span', { text: 'reads' })),
      el('div', {}, el('b', { text: n(writes) }), el('span', { text: 'writes' })),
      el('div', {}, el('b', { text: n(s.activity.errors) }), el('span', { text: 'errors' }))),
    writes ? `Last write: ${METHODS[lw.method] || lw.method} · ${lw.target} · ${fmtDateTime(lw.at)}` : 'No writes: nothing joined, posted, pressed or marked read.'));
  // Delivery
  cards.append(card(s.bot ? 'ok' : 'warn', 'Delivery',
    el('div', { class: 'big', text: s.bot ? `@${s.bot.username}` : 'Console only' }),
    s.bot ? `Digests go to chat ${s.reportTo ?? '—'} through the bot.` : 'No bot token: digests stay on this page. Add TELEGRAM_BOT_TOKEN to get them in Telegram.'));
  // Claude
  cards.append(card(s.claude.ready ? 'ok' : 'warn', 'Claude',
    el('div', { class: 'big', text: s.claude.ready ? s.claude.model : 'Not set' }),
    s.claude.ready ? `Spend: ${usd(s.costs.day.costUsd)} today · ${usd(s.costs.all.costUsd)} total · ${n(s.costs.all.calls)} calls` : 'Messages are collected; no digests until ANTHROPIC_API_KEY is set.'));
}

// ── sources ────────────────────────────────────────────────────────────────

function accessPill(a) {
  if (a === 'outside') return el('span', { class: 'pill ok', text: 'Read from outside' });
  if (a === 'member') return el('span', { class: 'pill read', text: 'Member' });
  if (!a) return el('span', { class: 'pill muted', text: 'Not checked' });
  return el('span', { class: 'pill warn', text: a });
}

function renderSources(s) {
  const t = $('sources');
  t.replaceChildren(el('thead', {}, el('tr', {}, ...['Read', 'Source', 'Access', 'Captured · 24h', 'Group volume', 'Guards at the door', 'Next digest', 'Status', ''].map((h) => el('th', { text: h })))));
  $('auto-watch').checked = Boolean(s.autoWatchNew);
  const body = el('tbody');
  if (s.sources.length === 0) {
    body.append(el('tr', {}, el('td', { colspan: 9, class: 'empty', text: 'Nothing here yet. Join a group in Telegram, or check one by name below.' })));
  }
  for (const src of s.sources) {
    const guards = [];
    if (src.door?.joinRequest) guards.push(el('span', { class: 'chip guard', text: 'join approval' }));
    if (src.door?.hiddenHistoryForNewMembers) guards.push(el('span', { class: 'chip guard', text: 'history hidden for new members' }));
    if (src.door?.telegramAntispam) guards.push(el('span', { class: 'chip guard', text: 'Telegram anti-spam' }));
    const bots = src.bots || [];
    for (const b of bots.slice(0, 4)) guards.push(el('span', { class: 'chip', text: b }));
    if (bots.length > 4) guards.push(el('span', { class: 'chip', text: `+${bots.length - 4} more`, title: bots.slice(4).join('  ') }));
    const OFF = { owner: 'switched off', left: 'you left it in Telegram', 'auto-watch off': 'new; auto-read is off', banned: 'banned' };
    const standing = ((s.privateGroups && s.privateGroups.memberships) || []).find((m) => m.chatId === src.chatId);
    const status = !src.enabled
      ? (src.offReason === 'left' || src.offReason === 'banned') && src.error
        ? el('span', { class: 'pill bad', text: src.error, title: src.error })
        : el('span', { class: 'pill muted', text: OFF[src.offReason] || 'off', title: src.error || '' })
      : standing && standing.state === 'verifying'
        ? el('span', { class: 'pill warn', text: 'check waiting in your Telegram app' })
      : standing && standing.state === 'muted'
        ? el('span', { class: 'pill muted', text: 'muted (reading works)' })
      : src.error
        ? el('span', { class: 'pill bad', text: src.error, title: src.error })
        : src.behind
          ? el('span', { class: 'pill warn', text: 'catching up on missed messages' })
          : el('div', {},
            el('span', { class: 'pill ok', text: 'up to date' }),
            el('div', { class: 'src-ref', text: src.caughtUpAt ? `caught up ${ago(src.caughtUpAt)} · every ~${Math.round(s.pollSeconds / 60)}m` : `every ~${Math.round(s.pollSeconds / 60)}m` }));
    const act = el('div', { class: 'actions' },
      el('button', { class: 'btn', text: 'Messages', onclick: () => selectSource(src.chatId) }),
      src.kind === 'watched' && src.enabled ? el('button', { class: 'btn', text: 'Catch up', onclick: (e) => action(e.target, '/api/pull', { chatId: src.chatId }) }) : null,
      src.kind === 'watched' && src.enabled ? el('button', { class: 'btn', text: 'Audit 1h', title: 'Compare the last hour with Telegram itself: anything missing?', onclick: (e) => action(e.target, '/api/audit', { chatId: src.chatId, hours: 1 }) }) : null,
      el('button', { class: 'btn', text: 'Digest now', disabled: !s.claude.ready, title: s.claude.ready ? '' : 'Needs ANTHROPIC_API_KEY', onclick: (e) => action(e.target, '/api/digest', { chatId: src.chatId }) }),
      null);
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
    body.append(el('tr', { class: src.enabled ? '' : 'off' },
      el('td', {}, sw),
      el('td', {}, el('div', { class: 'src-title', text: src.title }), el('div', { class: 'src-ref', text: src.ref }), el('div', { class: 'origin', text: src.origin === 'dialog' ? 'from your chats' : src.origin === 'manual' ? 'added by name' : '' })),
      el('td', {}, accessPill(src.access)),
      el('td', {}, el('div', { text: `${n(src.messages24h)} messages` }), el('div', { class: 'src-ref', text: `${n(src.people24h)} people · last ${ago(src.newest)}` })),
      el('td', {}, el('div', { text: src.perDay !== null ? `~${n(src.perDay)} / day` : '—' }), el('div', { class: 'src-ref', text: src.members ? `${n(src.members)} members` : '' })),
      el('td', {}, el('div', { class: 'guards' }, guards.length ? guards : el('span', { class: 'src-ref', text: src.access ? 'none seen' : '—' }))),
      el('td', {}, el('div', { text: until(src.nextDigestAt) }), el('div', { class: 'src-ref', text: src.lastDigestAt ? `last ${fmtDateTime(src.lastDigestAt)}` : 'none yet' })),
      el('td', {}, status),
      el('td', {}, act)));
  }
  t.append(body);
  // source picker for the messages panel
  const sel = $('msg-source');
  sel.hidden = s.sources.length === 0;
  const current = sel.value;
  sel.replaceChildren(...s.sources.map((x) => el('option', { value: x.chatId, text: x.title })));
  if (current && s.sources.some((x) => String(x.chatId) === current)) sel.value = current;
  // First render (nothing chosen yet): the browser has picked the first option by itself, so load it.
  if (!current && s.sources[0]) {
    sel.value = String(s.sources[0].chatId);
    loadMessages();
  }
}

async function action(button, path, body) {
  button.disabled = true;
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
  previewed: ['previewed', 'muted'],
  'owner-opened': ['opened in Telegram', 'muted'],
  requested: ['request pending', 'warn'],
  joined: ['joined: checking', 'read'],
  verifying: ['check waiting in Telegram', 'warn'],
  watching: ['in · reading', 'ok'],
  removed: ['removed', 'bad'],
  'no-answer': ['no answer (14 days)', 'muted'],
  'link-dead': ['link dead', 'bad'],
  refused: ['scam / fake', 'bad'],
  dismissed: ['not tracked', 'muted'],
  expired: ['expired', 'muted'],
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

/** The buttons for an invite, by where it stands. Only the one check, never a join. */
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
  if (inv.verdict === 'member' && inv.state === 'previewed' && inv.links) {
    out.push(el('button', { class: 'btn primary', text: 'Read it', onclick: (e) => inviteAction(e.target, '/api/watch', { target: inv.links.tme }, onDone) }));
  } else if (waiting && inv.verdict !== 'refused' && inv.verdict !== 'dead') {
    out.push(
      el('button', { class: `btn ${inv.verdict === 'request' ? '' : 'primary'}`, text: "I've joined", onclick: (e) => inviteAction(e.target, '/api/invite/confirm', { id: inv.id, said: 'joined' }, onDone) }),
      el('button', { class: `btn ${inv.verdict === 'request' ? 'primary' : ''}`, text: "I've sent a join request", onclick: (e) => inviteAction(e.target, '/api/invite/confirm', { id: inv.id, said: 'requested' }, onDone) }),
    );
  }
  if (inv.state === 'requested' || inv.state === 'no-answer') out.push(el('button', { class: 'btn', text: 'Check now', title: 'One invite check (rationed)', onclick: (e) => inviteAction(e.target, '/api/invite/recheck', { id: inv.id }) }));
  if (!['dismissed', 'expired', 'refused', 'watching', 'verifying', 'removed', 'link-dead', 'no-answer'].includes(inv.state)) {
    out.push(el('button', { class: 'btn', text: inv.state === 'requested' ? 'Stop tracking' : 'Not now', onclick: (e) => inviteAction(e.target, '/api/invite/dismiss', { id: inv.id }, onDone) }));
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
  const [label, cls] = INVITE_VERDICT[inv.verdict] || [inv.verdict, 'muted'];
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
      el('div', { class: 'invite-head' }, el('span', { class: `pill ${cls}`, text: label }), el('span', { class: 'title', text: inv.title || 'Invite' }), el('span', { class: 'src-ref', text: `invite ${inv.hashTail}` })),
      el('div', { class: 'inv-note', text: inv.note }),
      el('dl', { class: 'kv' }, rows),
      warningList(inv.warnings),
      el('div', { class: 'links' }, inviteButtons(inv, () => ($('probe-result').hidden = true))),
      el('div', { class: 'footnote', text: 'You join in your Telegram app. This page never joins, never answers a check, and never presses anything in Telegram. When you say you\'re in, it looks once.' }),
      el('div', { class: 'footnote', text: budgetLine(state && state.privateGroups && state.privateGroups.budget) })));
}

function renderInvites(s) {
  const pg = s.privateGroups;
  const box = $('invites');
  const list = (pg && pg.invites) || [];
  box.hidden = !pg || list.length === 0;
  if (!pg) return;
  $('invite-budget').textContent = budgetLine(pg.budget);
  const focus = /^#invite-(\d+)$/.exec(location.hash);
  $('invite-list').replaceChildren(...list.map((inv) => {
    const [label, cls] = INVITE_STATE[inv.state] || [inv.state, 'muted'];
    const age = inv.state === 'requested' && inv.saidAt ? `request sent ${ago(inv.saidAt)}` : inv.joinedAt ? `in since ${fmtDateTime(inv.joinedAt)}` : `added ${ago(inv.createdAt)}`;
    const next = inv.nextCheckAt && ['requested', 'owner-opened', 'previewed', 'link-dead'].includes(inv.state) ? ` · next check ${until(inv.nextCheckAt)}` : '';
    const li = el('li', { id: `invite-${inv.id}`, class: focus && Number(focus[1]) === inv.id ? 'focus' : '' },
      el('div', { class: 'inv-row' }, el('span', { class: `pill ${cls}`, text: inv.checking ? 'checking…' : label }), el('span', { class: 'title', text: inv.title || 'Invite' }), el('span', { class: 'src-ref', text: `${age}${next} · invite ${inv.hashTail}` })),
      el('div', { class: 'inv-note', text: inv.note }),
      inv.state === 'requested' ? el('div', { class: 'footnote', text: 'Telegram has no way to withdraw a request. If the group\'s bot wants something first, it messages you in Telegram within a few minutes of the request.' }) : null,
      el('div', { class: 'links' }, inviteButtons(inv)),
      inv.warnings.length && ['previewed', 'owner-opened'].includes(inv.state) ? el('details', { class: 'inv-more' }, el('summary', { text: `Before joining (${inv.warnings.length} notes)` }), warningList(inv.warnings)) : null);
    return li;
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
  banner.replaceChildren(...held.map((m) => el('section', { class: 'verify' },
    el('h3', { text: `Verification in progress in «${m.title}»: answer it in your Telegram app.` }),
    el('div', { class: 'sub', text: m.cause === 'restricted' ? 'Telegram shows this account as restricted there (it cannot send messages yet).' : 'A bot addressed you there right after you joined.' }),
    m.priors ? el('div', { class: 'sub', text: `Usual timing for this bot: ${m.priors}.` }) : null,
    m.hints.length ? el('ul', { class: 'hints' }, m.hints.map((h) => el('li', {},
      el('div', { class: 'from', text: `From ${h.sender.username ? `@${h.sender.username}` : h.sender.name}${h.sender.bot ? ' (bot)' : ''} · ${fmtTime(h.date)} · why: ${h.why.join('; ')}` }),
      h.suspicious ? el('div', { class: 'suspicious', text: h.suspicious }) : null,
      h.text ? el('div', { class: 'text', text: h.text }) : null,
      h.media ? el('div', { class: 'labels', text: h.media }) : null,
      h.buttons.length ? el('div', { class: 'labels', text: `Buttons (labels only, answer in Telegram): ${h.buttons.join(' · ')}` }) : null))) : null,
    el('ul', { class: 'always' },
      el('li', { text: 'This page cannot answer checks and cannot see all of them. Some appear only inside the Telegram app (pages inside Telegram, or messages only you can see).' }),
      el('li', { text: 'Real checks never ask for codes, passwords, your phone number, a wallet, or anything to paste or run.' })),
    el('div', { class: 'links' },
      m.openLink ? el('a', { class: 'btn primary', href: m.openLink, text: 'Open the group in Telegram' }) : null,
      el('button', { class: 'btn', text: "I've answered it — check now", onclick: (e) => inviteAction(e.target, '/api/membership/check', { chatId: m.chatId }) })))));
}

$('notify-test').addEventListener('click', (e) => inviteAction(e.target, '/api/notify-test', {}));

function renderProbe(r) {
  if (r.invite && r.invite.id) return renderInviteCard(r);
  const box = $('probe-result');
  box.hidden = false;
  const [label, cls] = VERDICT[r.verdict] || [r.verdict, 'muted'];
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
  box.replaceChildren(
    el('div', {}, el('span', { class: `pill ${cls}`, text: label }), ' ', el('span', { text: r.summary })),
    el('dl', { class: 'kv' }, rows),
    el('div', { class: 'actions' },
      canWatch ? el('button', { class: 'btn primary', text: r.verdict === 'member' ? 'Watch it' : 'Watch it (read without joining)', onclick: (e) => watch(e.target, r.target) }) : null,
      !canWatch && r.verdict !== 'not-found' && r.verdict !== 'unsafe' && r.verdict !== 'folder-link'
        ? el('span', { class: 'src-ref', text: 'Not readable from outside. To follow it, join in your Telegram app with its invite link (paste the link here first: the page shows what to expect). Nothing has been joined.' })
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
    b.textContent = 'Check (read-only)';
  }
});

// ── sources controls ───────────────────────────────────────────────────────

$('refresh-list').addEventListener('click', (e) => action(e.target, '/api/refresh', {}));
$('auto-watch').addEventListener('change', async (e) => {
  const box = e.target;
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

// ── activity feed ──────────────────────────────────────────────────────────

function feedItem(a) {
  const kind = a.ok ? a.kind : 'error';
  const [badge, cls] = KIND[kind] || [kind, 'muted'];
  const what = el('span', { class: 'what' },
    el('b', { text: METHODS[a.method] || a.method }),
    a.target ? ` · ${a.target}` : '',
    a.detail ? el('span', { class: 'meta', text: ` · ${a.detail}` }) : null,
    el('span', { class: 'meta', text: ` · ${a.actor}${a.ms !== null ? ` · ${a.ms}ms` : ''}` }));
  return el('li', { class: kind, 'data-kind': kind }, el('time', { text: fmtTime(a.at), title: new Date(a.at * 1000).toString() }), el('span', { class: `pill ${cls}`, text: badge }), what);
}

function shown(a) {
  const kind = a.ok ? a.kind : 'error';
  return filter === 'all' ? kind !== 'system' : kind === filter;
}

function renderFeed() {
  const list = $('feed');
  const rows = feedRows.filter(shown).slice(-300).reverse();
  list.replaceChildren(...(rows.length ? rows.map(feedItem) : [el('li', {}, el('span', { class: 'empty', text: 'Nothing yet.' }))]));
}

function addActivity(a) {
  if (a.id <= lastActivityId) return;
  lastActivityId = a.id;
  feedRows.push(a);
  if (feedRows.length > FEED_MAX) feedRows.splice(0, feedRows.length - FEED_MAX);
  if (shown(a)) {
    const list = $('feed');
    if (list.firstChild?.querySelector?.('.empty')) list.replaceChildren();
    list.prepend(feedItem(a));
    while (list.children.length > 300) list.lastChild.remove();
  }
  const sel = $('msg-source').value;
  if (a.method === 'messages.GetHistory' && /→ [1-9]/.test(a.detail) && state?.sources.some((s) => String(s.chatId) === sel && s.title === a.target)) scheduleMessages();
  scheduleRefresh();
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
  $('msgs').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
$('msg-source').addEventListener('change', loadMessages);

let msgTimer = null;
function scheduleMessages() {
  clearTimeout(msgTimer);
  msgTimer = setTimeout(loadMessages, 800);
}

let msgView = 'signal';
$('msg-view').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  msgView = b.dataset.v;
  for (const x of $('msg-view').children) x.classList.toggle('on', x === b);
  loadMessages();
});

async function loadMessages() {
  const chat = $('msg-source').value;
  const list = $('msgs');
  if (!chat) {
    list.replaceChildren(el('li', { class: 'empty', text: 'No source selected.' }));
    return;
  }
  if (msgView === 'signal') {
    const sig = await api(`/api/signal?chat=${encodeURIComponent(chat)}&hours=24`).catch(() => null);
    $('msg-hint').textContent = sig ? sig.header : '';
    list.replaceChildren(...(sig && sig.lines.length
      ? sig.lines.slice().reverse().map((l) => el('li', {},
        el('div', { class: 'who' }, el('b', { text: l.author }), ` · ${fmtDateTime(l.date)} · #${l.ids[0]}${l.ids.length > 1 ? ` +${l.ids.length - 1} joined` : ''}${l.replies ? ` · ${l.replies} replies` : ''}${l.echoes ? ` · ×${l.echoes.times} by ${l.echoes.people} people` : ''}`),
        el('div', { class: 'text', text: l.text })))
      : [el('li', { class: 'empty', text: 'No on-topic messages in the last 24 hours.' })]));
    return;
  }
  $('msg-hint').textContent = 'Every stored message, unfiltered, newest first.';
  const rows = await api(`/api/messages?chat=${encodeURIComponent(chat)}&limit=150`).catch(() => []);
  list.replaceChildren(...(rows.length
    ? rows.slice().reverse().map((m) => el('li', {},
      el('div', { class: 'who' }, el('b', { text: m.author }), ` · ${fmtDateTime(m.date)}${m.reactions ? ` · ${m.reactions} reactions` : ''}${m.replyTo ? ' · reply' : ''}`),
      el('div', { class: 'text', text: m.text })))
    : [el('li', { class: 'empty', text: 'No messages stored yet.' })]));
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

function renderOutbox(s) {
  $('out-hint').textContent = s.bot
    ? 'What the service sent to Telegram, newest first.'
    : 'No bot token, so nothing is sent to Telegram: digests are kept here, newest first.';
  const list = $('outbox');
  if (s.outbox.length === 0) {
    list.replaceChildren(el('li', { class: 'empty', text: s.claude.ready ? 'No digests yet. They run at the daily hour, or press Digest now.' : 'No digests yet: Claude is not configured.' }));
    return;
  }
  list.replaceChildren(...s.outbox.map((o) => el('li', {},
    el('div', { class: 'head' }, el('span', { class: `pill ${o.delivered ? 'ok' : 'muted'}`, text: o.delivered ? 'sent' : 'kept here' }), el('span', { text: `${fmtDateTime(o.at)} · to chat ${o.chatId}` })),
    el('div', { class: 'body' }, sanitize(o.html)))));
}

// ── storage ────────────────────────────────────────────────────────────────

let storageNow = null;
async function loadStorage() {
  storageNow = await api('/api/storage').catch(() => null);
  if (!storageNow) return;
  const s = storageNow;
  $('storage-now').textContent =
    `Stored now: ${n(s.messages)} messages from ${n(s.sources)} sources · ${n(s.people)} names · ${n(s.activity)} activity rows · ` +
    `${n(s.digests)} digests${s.digestFiles ? ` (+${n(s.digestFiles)} files)` : ''} · ${(s.bytes / 1048576).toFixed(1)} MB on disk. ` +
    `Messages older than ${s.retentionDays} days are deleted automatically.`;
}

$('clear-btn').addEventListener('click', async (e) => {
  const what = { messages: $('clear-messages').checked, activity: $('clear-activity').checked, digests: $('clear-digests').checked };
  if (!what.messages && !what.activity && !what.digests) return toast('Choose what to clear first.');
  await loadStorage();
  const s = storageNow || {};
  const list = [
    what.messages ? `${n(s.messages)} messages and ${n(s.people)} names` : null,
    what.activity ? `${n(s.activity)} activity rows` : null,
    what.digests ? `${n(s.digests)} digests and their files` : null,
  ].filter(Boolean);
  if (!confirm(`Delete permanently: ${list.join(', ')}?\n\nThis cannot be undone. Sources, switches and reading positions are kept, so nothing is downloaded again.`)) return;
  const b = e.target;
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

// ── refresh loop and live stream ───────────────────────────────────────────

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 1500);
}

async function refresh() {
  try {
    state = await api('/api/state');
    renderBanner(state);
    renderCards(state);
    renderSources(state);
    renderInvites(state);
    renderOutbox(state);
    $('notify-test').hidden = !state.notifications;
  } catch (err) {
    setLive(false, 'console not reachable');
  }
}

function setLive(on, text) {
  $('live').className = `live ${on ? 'on' : 'off'}`;
  $('live-text').textContent = text;
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('open', () => setLive(true, 'live'));
  es.addEventListener('activity', (e) => addActivity(JSON.parse(e.data)));
  es.addEventListener('error', () => setLive(false, 'reconnecting…'));
}

(async () => {
  await refresh();
  const initial = await api('/api/activity?limit=400').catch(() => []);
  for (const a of initial) {
    feedRows.push(a);
    lastActivityId = Math.max(lastActivityId, a.id);
  }
  renderFeed();
  connect();
  loadStorage();
  setInterval(refresh, 10_000);
  setInterval(loadStorage, 60_000);
  setInterval(() => $('msg-source').value && loadMessages(), 30_000);
})();
