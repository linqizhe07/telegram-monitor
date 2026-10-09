// The controller: Telegram from the keyboard, the mouse or a game controller, full screen. Groups
// across the top (LB/RB, or ◀▶), the group's messages in the middle with the newest at the bottom
// (▲▼ pick one), what the picked one says and everything that can be done with it on the right,
// and along the bottom the buttons for what can be done now. A replies, START writes, X reacts, Y
// saves to Saved Messages, LT marks the chat read, RT mutes it, SELECT switches All / Signal, the
// menu (☰, or .) has the rest: open in Telegram, copy a link, the author, a bot's buttons, join,
// leave. B goes back, and closes the controller.
//
// Every press that writes goes to the service as one request, and the service lets exactly that one
// through (src/controller.ts). What other people see (a post, a reply, a bot's button, joining,
// leaving) is armed by the first press and sent by the second, within 5 seconds, after letting go:
// a held key, a key's auto-repeat or a double-click never sends. Everything from Telegram (titles,
// names, messages, button labels) is set as text, never as HTML.
'use strict';

(() => {
  const P = window.Pulse;
  if (!P) return;
  const $ = (id) => document.getElementById(id);
  const pad = $('pad');
  const QUICK = ['👍', '❤', '🔥', '🎉', '😁', '🤔', '👎', '🙏'];
  const ARM_MS = 5000;
  const NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
  const fmt = new Intl.NumberFormat('en-US');

  const s = {
    open: false,
    chatId: '',
    /** The group's messages, oldest first, and which one is picked (an index). */
    list: [],
    at: -1,
    view: 'all',
    look: null,
    lookFor: '',
    lookError: '',
    /** list | compose | react | keys | more */
    mode: 'list',
    replyTo: null,
    armed: null,
    react: { list: [], i: 0 },
    keys: { rows: [], r: 0, c: 0, msgId: 0 },
    more: { items: [], i: 0 },
    busy: false,
    status: { text: '', tone: '' },
  };

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  };
  const setText = (node, text) => {
    if (node && node.textContent !== text) node.textContent = text;
  };

  // ── the groups, the chat, the picked message ───────────────────────────

  /** Groups in the order of the live view's tabs (busiest first), the ones switched off last. */
  function groups() {
    const all = P.getState()?.sources || [];
    return [...all.filter((x) => x.enabled).sort((a, b) => b.messages24h - a.messages24h || a.chatId - b.chatId), ...all.filter((x) => !x.enabled)];
  }
  const source = () => groups().find((x) => String(x.chatId) === s.chatId) || null;
  /** What the controller knows of the chat on it now: never a look that came back for another chat. */
  const L = () => (s.look && s.lookFor === s.chatId && String(s.look.chatId) === s.chatId ? s.look : null);
  const title = () => L()?.title || source()?.title || 'this chat';
  const username = () => {
    const ref = source()?.ref || '';
    const name = L()?.username || (ref.startsWith('@') ? ref.slice(1) : '');
    return NAME.test(name) ? name : '';
  };
  const internal = () => (/^-100\d+$/.test(s.chatId) ? s.chatId.slice(4) : '');
  const picked = () => (s.at >= 0 && s.at < s.list.length ? s.list[s.at] : null);

  /** Which app the chat on the controller lives in. */
  const app = () => (source()?.platform === 'discord' ? 'Discord' : 'Telegram');

  function links(msgId) {
    const d = source()?.discord;
    // A Discord channel opens at the channel (its messages carry Discord's ids, not these).
    if (d) return { app: d.link.replace('https://discord.com/', 'discord://-/'), web: d.link };
    const u = username();
    const c = internal();
    const id = Number.isInteger(msgId) && msgId > 0 ? msgId : null;
    if (u) return { app: `tg://resolve?domain=${u}${id ? `&post=${id}` : ''}`, web: `https://t.me/${u}${id ? `/${id}` : ''}` };
    if (c && id) return { app: `tg://privatepost?channel=${c}&post=${id}`, web: `https://t.me/c/${c}/${id}` };
    return { app: null, web: null };
  }

  function switchGroup(step) {
    const all = groups();
    if (!all.length) return say('No groups yet.', 'bad');
    const i = all.findIndex((x) => String(x.chatId) === s.chatId);
    goTo(String(all[(i + step + all.length) % all.length].chatId));
  }

  function goTo(chatId) {
    if (chatId === s.chatId) return;
    s.chatId = chatId;
    s.list = [];
    s.at = -1;
    s.mode = 'list';
    s.replyTo = null;
    disarm();
    s.status = { text: '', tone: '' };
    if (s.lookFor !== chatId) {
      s.look = null;
      s.lookError = '';
    }
    render();
    loadMessages(true);
    look();
  }

  let loading = 0;
  /** The group's messages, oldest first; `fresh`: a new group, the newest picked. */
  async function loadMessages(fresh = false) {
    const chatId = s.chatId;
    if (!chatId) return;
    const mine = ++loading;
    const rows =
      s.view === 'signal'
        ? ((await P.api(`/api/signal?chat=${encodeURIComponent(chatId)}&hours=24`).catch(() => null))?.lines || []).map((l) => ({ id: l.ids[0], author: l.author, user: l.username, date: l.date, text: l.text, joined: l.ids.length - 1 }))
        : (await P.api(`/api/messages?chat=${encodeURIComponent(chatId)}&limit=200`).catch(() => [])).map((m) => ({ id: m.id, author: m.author, user: m.username, date: m.date, text: m.text, reactions: m.reactions, replyTo: m.replyTo }));
    if (mine !== loading || chatId !== s.chatId) return; // another group, or a newer load
    const keep = picked()?.id;
    s.list = rows.map((r) => ({ ...r, user: NAME.test(r.user || '') ? r.user : '' }));
    const i = keep ? s.list.findIndex((m) => m.id === keep) : -1;
    s.at = fresh || i < 0 ? s.list.length - 1 : i;
    render(true);
  }

  async function look(fresh = false) {
    const chatId = s.chatId;
    if (!chatId) return;
    const r = await P.api('/api/pad/look', { chatId, fresh }).catch((err) => ({ ok: false, message: err.message }));
    if (chatId !== s.chatId) return;
    s.lookFor = chatId;
    if (r.ok && r.chat) {
      s.look = r.chat;
      s.lookError = '';
    } else s.lookError = r.message || 'Could not read this chat.';
    render();
  }

  function move(step) {
    if (!s.list.length) return say('No messages here yet.', 'bad');
    s.at = Math.min(s.list.length - 1, Math.max(0, (s.at < 0 ? s.list.length - 1 : s.at) + step));
    if (s.mode === 'compose' && s.replyTo !== null) s.replyTo = picked().id; // the reply follows the pick
    else if (s.mode !== 'compose') s.mode = 'list';
    disarm();
    render(true);
  }

  // ── saying, arming, sending ────────────────────────────────────────────

  function say(text, tone = '') {
    s.status = { text, tone };
    render();
    if (tone === 'ok' || tone === 'bad') rumble(tone === 'ok');
  }

  let armTimer = 0;
  /** What others see goes on the second press, after letting go: the first arms it for a few seconds. */
  function arm(what, label, run) {
    if (s.armed && s.armed.what === what && Date.now() < s.armed.until) {
      if (!s.armed.released || Date.now() - s.armed.at < 400) return; // the same press, held or bounced
      disarm();
      return run();
    }
    s.armed = { what, label, until: Date.now() + ARM_MS, at: Date.now(), released: false };
    const bar = $('pad-arm-bar');
    bar.classList.remove('run');
    void bar.offsetWidth;
    bar.classList.add('run');
    say(label, 'armed');
    clearTimeout(armTimer);
    armTimer = setTimeout(() => {
      if (s.armed && Date.now() >= s.armed.until) {
        disarm();
        say('Not sent: it was not confirmed in time.');
      }
    }, ARM_MS + 50);
  }

  function disarm() {
    if (!s.armed) return;
    s.armed = null;
    clearTimeout(armTimer);
    $('pad-arm-bar').classList.remove('run');
    if (s.status.tone === 'armed') s.status = { text: '', tone: '' };
  }

  /** One request to the service; `quiet`: say nothing when it went well (a look, not a write). */
  async function call(path, body, quiet = false) {
    if (s.busy) return null;
    s.busy = true;
    render();
    try {
      const r = await P.api(path, body);
      if (r.chat && String(r.chat.chatId) === s.chatId) {
        s.look = r.chat;
        s.lookFor = s.chatId;
      }
      if (!(quiet && r.ok)) say(r.message || (r.ok ? 'Done.' : 'Not done.'), r.ok ? 'ok' : 'bad');
      return r;
    } catch (err) {
      say(err.message, 'bad');
      return null;
    } finally {
      s.busy = false;
      render();
    }
  }

  const needPick = () => {
    if (picked()) return true;
    say('Pick a message first: ▲▼, or click one.', 'bad');
    return false;
  };
  const needChat = () => {
    if (s.chatId) return true;
    say('No group yet.', 'bad');
    return false;
  };

  // ── the actions ────────────────────────────────────────────────────────

  function write(replyTo) {
    if (!needChat()) return;
    if (L()?.sendBlock) return say(L().sendBlock, 'bad');
    s.mode = 'compose';
    s.replyTo = replyTo;
    disarm();
    s.status = { text: '', tone: '' };
    render();
    $('pad-text').focus();
  }

  function post() {
    const text = $('pad-text').value.trim();
    if (!text) return say('Type the message first.', 'bad');
    const many = L()?.members ? ` (${fmt.format(L().members)} members)` : '';
    const replyTo = s.replyTo;
    const chatId = s.chatId;
    arm(`send|${chatId}|${replyTo}|${text}`, `Press Enter (START) again to ${replyTo ? `reply to #${replyTo}` : 'post'} in «${title()}»: everyone there sees it${many}.`, async () => {
      const r = await call('/api/pad/send', { chatId, text, replyTo });
      if (r?.ok) {
        $('pad-text').value = '';
        count();
        s.mode = 'list';
        s.replyTo = null;
        render();
        setTimeout(() => chatId === s.chatId && loadMessages(true), 2500);
      }
    });
  }

  function save() {
    if (!needPick()) return;
    if (L()?.noforwards) return say(`«${title()}» protects its content: nothing can be saved from it.`, 'bad');
    call('/api/pad/save', { chatId: s.chatId, msgId: picked().id });
  }

  function markRead() {
    if (!needChat()) return;
    call('/api/pad/read', { chatId: s.chatId });
  }

  function mute() {
    if (!needChat()) return;
    if (!L()) {
      look(true);
      return say("Reading this chat's state first: press again in a moment.", 'bad');
    }
    call('/api/pad/mute', { chatId: s.chatId, on: !L().muted });
  }

  function openReact() {
    if (!needPick()) return;
    const allowed = L()?.reactions;
    if (allowed && allowed.length === 0) return say(`«${title()}» allows no reactions.`, 'bad');
    s.react = { list: [...(allowed ? allowed.slice(0, 8) : QUICK), '✕'], i: 0 };
    s.mode = 'react';
    disarm();
    s.status = { text: '', tone: '' };
    render();
  }

  function sendReaction(i) {
    const e = s.react.list[i];
    const m = picked();
    if (!e || !m) return;
    s.mode = 'list';
    call('/api/pad/react', { chatId: s.chatId, msgId: m.id, emoji: e === '✕' ? null : e });
  }

  async function openKeys() {
    if (!needPick()) return;
    const msgId = picked().id;
    const chatId = s.chatId;
    const r = await call('/api/pad/buttons', { chatId, msgId }, true);
    if (!r?.ok || !r.rows || s.chatId !== chatId || picked()?.id !== msgId) return;
    s.keys = { rows: r.rows, r: 0, c: 0, msgId };
    s.mode = 'keys';
    say(`${r.rows.flat().length} buttons under #${msgId}: arrows to choose, A to press (twice: the bot sees it).`);
  }

  function pressKey() {
    const k = s.keys.rows[s.keys.r]?.[s.keys.c];
    if (!k) return;
    if (k.kind === 'telegram' && k.open) return open(k.open, `«${k.label}» opens in Telegram.`);
    if (k.kind !== 'press') return say(`«${k.label}» works only in your Telegram app${k.host ? ` (it opens ${k.host})` : ''}.`, 'bad');
    const { msgId } = s.keys;
    const chatId = s.chatId;
    arm(`press|${chatId}|${msgId}|${k.row}|${k.col}`, `Press A again to press «${k.label}»: the bot sees it.`, () => call('/api/pad/press', { chatId, msgId, row: k.row, col: k.col }));
  }

  function open(href, what) {
    if (!href) return say(`No link for this one: open it in your ${app()} app.`, 'bad');
    el('a', { href }).click(); // tg:// (or discord://) opens the app; nothing is sent from here
    say(what, 'ok');
  }

  function openInTelegram() {
    if (!needChat()) return;
    const m = picked();
    open(links(m?.id ?? s.list.at(-1)?.id).app, m && app() === 'Telegram' ? `Opened #${m.id} in Telegram.` : `Opened «${title()}» in ${app()}.`);
  }

  function openMore() {
    if (!needChat()) return;
    const m = picked();
    const l = links(m?.id);
    const items = [];
    items.push({ label: `Open it in the ${app()} app`, key: 'O', run: openInTelegram });
    if (l.web) items.push({ label: m && app() === 'Telegram' ? `Copy the link to #${m.id}` : "Copy the chat's link", run: () => copy(l.web) });
    if (m?.user) items.push({ label: `Open ${m.author} (@${m.user}) in Telegram`, run: () => open(`tg://resolve?domain=${m.user}`, `Opened @${m.user} in Telegram.`) });
    if (m) items.push({ label: "The message's bot buttons", key: 'K', run: openKeys });
    items.push({ label: s.view === 'all' ? 'Show the signal only (noise removed)' : 'Show every message', key: 'V', run: toggleView });
    items.push({ label: "Read this chat's state again", run: () => look(true).then(() => say('Read again.', 'ok')) });
    if (L() && !L().member && username()) items.push({ label: `Join «${title()}»…`, arming: true, run: join });
    if (L()?.member) items.push({ label: `Leave «${title()}»…`, danger: true, arming: true, run: leave });
    s.more = { items, i: 0 };
    s.mode = 'more';
    disarm();
    s.status = { text: '', tone: '' };
    render();
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      say(`Copied ${text}`, 'ok');
    } catch {
      say(text);
    }
  }

  function join() {
    const u = username();
    arm(`join|${s.chatId}`, `Press A again to JOIN «${title()}» with your account: its members see you join.`, async () => {
      const r = await call('/api/join', { target: `@${u}` });
      if (r?.state === 'app' && r.open) open(r.open, r.message);
      look(true);
      P.refresh();
    });
  }

  function leave() {
    const chatId = s.chatId;
    arm(`leave|${chatId}`, `Press A again to LEAVE «${title()}». It goes off Sources, and the messages stored for it are deleted.`, async () => {
      const r = await call('/api/pad/leave', { chatId });
      if (r?.ok) {
        s.mode = 'list';
        setTimeout(() => P.refresh(), 1500);
      }
    });
  }

  function toggleView() {
    s.view = s.view === 'all' ? 'signal' : 'all';
    s.mode = 'list';
    loadMessages(true);
    render();
  }

  function back() {
    if (s.armed) {
      disarm();
      return say('Not sent.');
    }
    if (s.mode !== 'list') {
      s.mode = 'list';
      if (document.activeElement === $('pad-text')) $('pad-text').blur();
      return render();
    }
    toggle(false);
  }

  // ── one press, from any of the three inputs ────────────────────────────

  function press(k) {
    if (k === 'toggle') return toggle();
    if (!s.open) return;
    if (k === 'B') return back();
    if (s.mode === 'compose') {
      if (k === 'start' || k === 'A') return post();
      return;
    }
    if (s.mode === 'react') {
      const n = s.react.list.length;
      if (k === 'left' || k === 'up') s.react.i = (s.react.i - 1 + n) % n;
      else if (k === 'right' || k === 'down') s.react.i = (s.react.i + 1) % n;
      else if (k === 'A' || k === 'X') return sendReaction(s.react.i);
      return render();
    }
    if (s.mode === 'keys') {
      const kk = s.keys;
      if (k === 'up') kk.r = Math.max(0, kk.r - 1);
      else if (k === 'down') kk.r = Math.min(kk.rows.length - 1, kk.r + 1);
      else if (k === 'left') kk.c = Math.max(0, kk.c - 1);
      else if (k === 'right') kk.c += 1;
      else if (k === 'A') return pressKey();
      kk.c = Math.min(kk.c, (kk.rows[kk.r]?.length || 1) - 1);
      disarm();
      return render();
    }
    if (s.mode === 'more') {
      const n = s.more.items.length;
      if (k === 'up') s.more.i = (s.more.i - 1 + n) % n;
      else if (k === 'down') s.more.i = (s.more.i + 1) % n;
      else if (k === 'A') {
        const item = s.more.items[s.more.i];
        if (!item?.arming) s.mode = 'list';
        item?.run();
      }
      if (k !== 'A') disarm();
      return render();
    }
    switch (k) {
      case 'up':
        return move(-1);
      case 'down':
        return move(1);
      case 'pageup':
        return move(-8);
      case 'pagedown':
        return move(8);
      case 'home':
        return move(-1e6);
      case 'end':
        return move(1e6);
      case 'left':
      case 'LB':
        return switchGroup(-1);
      case 'right':
      case 'RB':
        return switchGroup(1);
      case 'A':
        return needPick() && write(picked().id);
      case 'X':
        return openReact();
      case 'Y':
        return save();
      case 'LT':
        return markRead();
      case 'RT':
        return mute();
      case 'select':
        return toggleView();
      case 'start':
        return write(null);
      case 'more':
        return openMore();
      case 'open':
        return openInTelegram();
      case 'keys':
        return openKeys();
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────

  /** A button as the controller shows it: its glyph (A, B, X, Y, LB…) and, small, its key. */
  const glyph = (g) => el('span', { class: `g g-${g.toLowerCase().replace(/[^a-z]/g, '') || 'n'}`, text: g });
  const kbd = (k) => el('kbd', { text: k });

  function chips() {
    const L0 = L();
    const out = [];
    const chip = (text, tone = '', tip = '') => out.push(el('span', { class: `chip ${tone}`, text, title: tip || null }));
    if (L0) {
      chip(L0.type === 'channel' ? 'channel' : L0.type === 'group' ? 'group' : 'supergroup');
      if (L0.members) chip(`${fmt.format(L0.members)} members`);
      if (L0.member) chip('in it', 'ok');
      else chip('outside', 'warn', 'The account is not in this chat: it is read from outside.');
      if (L0.sendBlock) chip('read-only', 'warn', L0.sendBlock);
      if (L0.unread) chip(`${fmt.format(L0.unread)} unread`);
      if (L0.muted) chip('muted');
      const now = Math.floor(Date.now() / 1000);
      if (L0.slowmode) chip(L0.nextSendAt > now ? `post in ${L0.nextSendAt - now}s` : `slow mode ${L0.slowmode}s`, L0.nextSendAt > now ? 'warn' : '');
      if (L0.noforwards) chip('protected', 'warn', 'Protected content: nothing can be forwarded or saved.');
    } else if (s.lookError) chip('?', 'bad', s.lookError);
    else chip('reading…');
    return out;
  }

  /** What can be done now, with its button: the side list and the prompts along the bottom. */
  function actions() {
    const L0 = L();
    const m = picked();
    const no = (why) => ({ off: true, why });
    const can = { off: false, why: '' };
    if (s.mode === 'compose') {
      return [
        { g: 'START', k: 'Enter', label: s.armed ? 'Send: again!' : s.replyTo ? 'Reply' : 'Post', run: post },
        { g: 'B', k: 'Esc', label: s.armed ? 'Not now' : 'Back', run: back },
        { g: '', k: 'Shift+Enter', label: 'New line' },
      ];
    }
    if (s.mode === 'react') return [{ g: '◀▶', k: '← →', label: 'Choose' }, { g: 'A', k: 'Enter', label: 'Send it', run: () => sendReaction(s.react.i) }, { g: '', k: '1–9', label: 'Pick directly' }, { g: 'B', k: 'Esc', label: 'Back', run: back }];
    if (s.mode === 'keys') return [{ g: '✣', k: 'arrows', label: 'Choose' }, { g: 'A', k: 'Enter', label: s.armed ? 'Press: again!' : 'Press', run: pressKey }, { g: 'B', k: 'Esc', label: 'Back', run: back }];
    if (s.mode === 'more') return [{ g: '▲▼', k: '↑ ↓', label: 'Choose' }, { g: 'A', k: 'Enter', label: s.armed ? 'Do it: again!' : 'Do it', run: () => press('A') }, { g: 'B', k: 'Esc', label: 'Back', run: back }];
    return [
      { g: 'A', k: 'R', label: 'Reply', run: () => press('A'), ...(m ? (L0?.sendBlock ? no(L0.sendBlock) : can) : no('Pick a message first')) },
      { g: 'START', k: 'N', label: 'Write', run: () => press('start'), ...(L0?.sendBlock ? no(L0.sendBlock) : can) },
      { g: 'X', k: 'E', label: 'React', run: () => press('X'), ...(m ? (L0?.reactions && L0.reactions.length === 0 ? no('No reactions here') : can) : no('Pick a message first')) },
      { g: 'Y', k: 'S', label: 'Save to Saved Messages', run: () => press('Y'), ...(m ? (L0?.noforwards ? no('Protected content') : can) : no('Pick a message first')) },
      { g: 'LT', k: 'U', label: 'Mark the chat read', run: () => press('LT'), ...(L0 && !L0.member ? no('The account is not in this chat') : can) },
      { g: 'RT', k: 'M', label: L0?.muted ? 'Unmute' : 'Mute', run: () => press('RT') },
      { g: 'SELECT', k: 'V', label: s.view === 'all' ? 'Signal only' : 'All messages', run: () => press('select') },
      { g: '☰', k: '.', label: 'More: open, link, author, bot buttons, join, leave', run: () => press('more') },
    ];
  }

  function render(scroll = false) {
    if (!s.open) return;
    // The groups across the top.
    const all = groups();
    const strip = $('pad-groups');
    const sig = JSON.stringify(all.map((x) => [x.chatId, x.title, x.enabled]));
    if (strip.__sig !== sig) {
      strip.__sig = sig;
      strip.replaceChildren(...all.map((x) => el('button', { type: 'button', role: 'tab', 'data-chat': x.chatId, class: x.enabled ? '' : 'off', title: x.title, onclick: () => goTo(String(x.chatId)) }, x.title)));
    }
    for (const b of strip.children) {
      const on = b.dataset.chat === s.chatId;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      if (on && (b.offsetLeft < strip.scrollLeft || b.offsetLeft + b.offsetWidth > strip.scrollLeft + strip.clientWidth)) strip.scrollTo({ left: Math.max(0, b.offsetLeft - 40) });
    }
    setText($('pad-chat-title'), s.chatId ? title() : 'No groups yet');
    $('pad-chips').replaceChildren(...chips());
    for (const b of $('pad-view').children) b.classList.toggle('on', b.dataset.v === s.view);

    // The messages.
    const list = $('pad-list');
    const lsig = JSON.stringify([s.chatId, s.view, s.list.map((m) => m.id)]);
    if (list.__sig !== lsig) {
      list.__sig = lsig;
      list.replaceChildren(
        ...(s.list.length
          ? s.list.map((m, i) => el('li', { 'data-i': i, onclick: (e) => {
            if (String(window.getSelection()) !== '' || e.target.closest('a')) return;
            s.at = i;
            if (s.mode === 'compose' && s.replyTo !== null) s.replyTo = m.id;
            else if (s.mode !== 'compose') s.mode = 'list';
            disarm();
            render();
          } },
            el('div', { class: 'who' }, el('b', { text: m.author || 'someone' }), m.user ? el('span', { text: `@${m.user}` }) : null, el('span', { text: P.fmtWhen(m.date) }), el('span', { text: `#${m.id}` }), m.replyTo ? el('span', { text: `↩ #${m.replyTo}` }) : null, m.reactions ? el('span', { text: `${m.reactions} reactions` }) : null, m.joined ? el('span', { text: `+${m.joined} joined` }) : null),
            el('div', { class: 'tx', text: m.text || '(no text)' })))
          : [el('li', { class: 'empty', text: s.chatId ? 'No messages stored for this group yet.' : 'No groups yet.' })]),
      );
      scroll = true;
    }
    for (const li of list.children) li.classList.toggle('sel', Number(li.dataset.i) === s.at);
    const sel = list.querySelector('li.sel');
    if (sel && scroll) sel.scrollIntoView({ block: 'nearest' });

    // The compose box.
    const compose = $('pad-compose');
    compose.hidden = s.mode !== 'compose';
    if (s.mode === 'compose') {
      const to = s.replyTo ? s.list.find((m) => m.id === s.replyTo) : null;
      $('pad-reply').replaceChildren(
        s.replyTo
          ? el('span', {}, el('b', { text: `↩ ${to?.author || 'the message'} · #${s.replyTo}` }), ' ', el('span', { class: 'q', text: (to?.text || '').slice(0, 90) }))
          : el('span', {}, el('b', { text: `New message in «${title()}»` })),
      );
    }
    setText($('pad-arm-text'), s.armed && s.mode === 'compose' ? s.armed.label : '');

    // The side: the picked message, a layer (reactions, buttons, more), what can be done.
    const m = picked();
    $('pad-sel').replaceChildren(
      ...(m
        ? [
            el('div', { class: 'who' }, el('b', { text: m.author || 'someone' }), m.user ? el('span', { text: `@${m.user}` }) : null),
            el('div', { class: 'meta', text: `${P.fmtWhen(m.date)} · #${m.id}${m.reactions ? ` · ${m.reactions} reactions` : ''}` }),
            el('div', { class: 'tx', text: m.text || '(no text)' }),
          ]
        : [el('div', { class: 'hint', text: s.list.length ? '▲▼ pick a message, or click one.' : 'Nothing to pick yet.' })]),
    );
    const layer = $('pad-layer');
    if (s.mode === 'react') {
      layer.hidden = false;
      layer.replaceChildren(
        el('div', { class: 'layer-title', text: 'React' }),
        el('div', { class: 'react-row', role: 'listbox', 'aria-label': 'Reactions' },
          s.react.list.map((e, j) => el('button', { type: 'button', class: j === s.react.i ? 'on' : '', role: 'option', 'aria-selected': j === s.react.i ? 'true' : 'false', title: e === '✕' ? 'Take my reaction back' : `React ${e} (${j + 1})`, text: e, onclick: () => sendReaction(j) }))),
      );
    } else if (s.mode === 'keys') {
      layer.hidden = false;
      layer.replaceChildren(
        el('div', { class: 'layer-title', text: `Bot buttons under #${s.keys.msgId}` }),
        el('div', { class: 'keys-grid' },
          s.keys.rows.map((row, r) => el('div', { class: 'keys-row' },
            row.map((k, c) => el('button', {
              type: 'button',
              class: `${r === s.keys.r && c === s.keys.c ? 'on' : ''} k-${k.kind}`,
              title: k.kind === 'press' ? 'Press it (twice: the bot sees it)' : k.kind === 'telegram' ? 'Opens in Telegram' : `Only in your Telegram app${k.host ? ` (${k.host})` : ''}`,
              text: `${k.kind === 'press' ? '' : k.kind === 'telegram' ? '↗ ' : '⌂ '}${k.label}`,
              onclick: () => {
                s.keys.r = r;
                s.keys.c = c;
                pressKey();
                render();
              },
            }))))),
      );
    } else if (s.mode === 'more') {
      layer.hidden = false;
      layer.replaceChildren(
        el('div', { class: 'layer-title', text: 'More' }),
        el('div', { class: 'more-list', role: 'menu' },
          s.more.items.map((it, j) => el('button', { type: 'button', role: 'menuitem', class: `${j === s.more.i ? 'on' : ''}${it.danger ? ' danger' : ''}`, onclick: () => {
            s.more.i = j;
            press('A');
          } }, it.label, it.key ? kbd(it.key) : null))),
      );
    } else layer.hidden = true;

    const acts = actions();
    $('pad-actions').replaceChildren(...acts.filter((a) => a.run).map((a) => el('li', {},
      el('button', { type: 'button', class: a.off ? 'off' : '', title: a.off ? a.why : a.label, onclick: (e) => {
        if (e.detail > 1) return; // a double-click is one press
        if (a.off) return say(a.why, 'bad');
        a.run();
      } }, a.g ? glyph(a.g) : null, el('span', { class: 'l', text: a.label }), kbd(a.k)))));
    $('pad-prompts').replaceChildren(
      ...(s.mode === 'list' ? [el('span', { class: 'p' }, glyph('▲▼'), el('span', { text: 'Message' }), kbd('↑ ↓')), el('span', { class: 'p' }, glyph('LB'), glyph('RB'), el('span', { text: 'Group' }), kbd('← →'))] : []),
      ...acts.map((a) => el('span', { class: `p${a.off ? ' off' : ''}` }, a.g ? glyph(a.g) : null, el('span', { text: a.label.replace(/^More: .*/, 'More') }), kbd(a.k))),
      s.mode === 'list' ? el('span', { class: 'p' }, glyph('B'), el('span', { text: 'Close' }), kbd('Esc')) : null,
    );

    const st = $('pad-status');
    st.className = `pad-status ${s.status.tone}`;
    setText(st, s.busy ? 'Asking Telegram…' : s.status.text || s.lookError);
    if (!s.busy && !s.status.text && s.lookError) st.className = 'pad-status bad';
  }

  function count() {
    const v = $('pad-text').value;
    setText($('pad-count'), `${fmt.format(v.length)} / 4,096`);
  }

  // ── open, close ────────────────────────────────────────────────────────

  let refresher = 0;
  let before = null;
  function toggle(force) {
    s.open = typeof force === 'boolean' ? force : !s.open;
    pad.hidden = !s.open;
    document.body.classList.toggle('pad-open', s.open);
    $('pad-toggle').setAttribute('aria-expanded', String(s.open));
    try {
      localStorage.setItem('pad-open', s.open ? '1' : '0');
    } catch {
      // private window: it just starts closed next time
    }
    clearInterval(refresher);
    if (s.open) {
      before = document.activeElement;
      // Start on the group the page shows (Messages), else the busiest.
      const shown = $('msg-source')?.value;
      const first = shown && groups().some((x) => String(x.chatId) === shown) ? shown : String(groups()[0]?.chatId ?? '');
      s.chatId = '';
      if (first) goTo(first);
      else render();
      refresher = setInterval(() => {
        if (!document.hidden && s.mode === 'list') loadMessages();
      }, 15_000);
    } else {
      disarm();
      s.mode = 'list';
      if (before && document.contains(before)) before.focus?.();
    }
  }

  // ── inputs: mouse, keyboard, game controller ───────────────────────────

  $('pad-close').addEventListener('click', () => toggle(false));
  $('pad-toggle').addEventListener('click', () => toggle());
  $('pad-view').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (b && b.dataset.v !== s.view) toggleView();
  });
  // A key or a button let go: the next press is a new one (what arms needs one before it fires).
  const released = () => {
    if (s.armed) s.armed.released = true;
  };
  document.addEventListener('keyup', released);
  document.addEventListener('pointerup', released);
  $('pad-compose').addEventListener('submit', (e) => {
    e.preventDefault();
    post();
  });
  $('pad-text').addEventListener('input', () => {
    disarm();
    count();
    render();
  });
  $('pad-text').addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // an input method is still composing (Chinese, Japanese…)
    if (e.repeat) return e.key === 'Enter' && !e.shiftKey ? e.preventDefault() : undefined; // a held key is one press
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      post();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      press('B');
    }
  });

  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end',
    Enter: 'A', r: 'A', a: 'A', Escape: 'B', b: 'B', e: 'X', x: 'X', s: 'Y', y: 'Y',
    '[': 'LB', ']': 'RB', u: 'LT', m: 'RT', v: 'select', n: 'start', '.': 'more', o: 'open', k: 'keys',
  };
  const MOVES = new Set(['up', 'down', 'left', 'right', 'pageup', 'pagedown']);
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      return toggle();
    }
    if (!s.open) return;
    // Enter and Space on a focused button are that button's own click.
    if ((e.key === 'Enter' || e.key === ' ') && t instanceof HTMLElement && t.closest('button, a') && pad.contains(t)) return;
    const k = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (e.repeat && !MOVES.has(k)) return; // held: one press (moving may repeat)
    if (s.mode === 'react' && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      return sendReaction(Number(e.key) - 1);
    }
    if (!k) return;
    e.preventDefault();
    press(k);
  });

  // A game controller (standard mapping): A B X Y, LB RB LT RT, View/Select, Menu/Start, the right
  // stick's press for More, the d-pad or the left stick to move (held: repeats).
  const PADMAP = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'select', 9: 'start', 11: 'more', 12: 'up', 13: 'down', 14: 'left', 15: 'right', 16: 'toggle' };
  let gp = null;
  let raf = 0;
  const held = new Map();

  function device(name) {
    const short = (name || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    setText($('pad-device'), gp === null ? 'keyboard · mouse' : short || 'controller');
    pad.classList.toggle('gp', gp !== null);
  }

  addEventListener('gamepadconnected', (e) => {
    gp = e.gamepad.index;
    device(e.gamepad.id);
    if (!s.open) toggle(true);
    say('Controller connected. ▲▼ message · LB/RB group · A reply · X react · Y save · START write · B back.', 'ok');
    poll();
  });
  addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== gp) return;
    gp = null;
    held.clear();
    device('');
    say('Controller disconnected: the keyboard and the mouse still work.');
  });

  function poll() {
    cancelAnimationFrame(raf);
    const tick = (t) => {
      if (gp === null) return;
      const g = navigator.getGamepads?.()[gp];
      if (g && !document.hidden && document.hasFocus()) {
        const ax = g.axes || [];
        const stick = { up: (ax[1] ?? 0) < -0.6, down: (ax[1] ?? 0) > 0.6, left: (ax[0] ?? 0) < -0.6, right: (ax[0] ?? 0) > 0.6 };
        const down = new Set();
        for (const [i, k] of Object.entries(PADMAP)) if (g.buttons[i]?.pressed || (g.buttons[i]?.value ?? 0) > 0.5) down.add(k);
        for (const [k, on] of Object.entries(stick)) if (on) down.add(k);
        for (const k of down) {
          const h = held.get(k);
          if (!h) {
            held.set(k, { next: t + 380 });
            press(k);
          } else if (MOVES.has(k) && t >= h.next) {
            h.next = t + 110;
            press(k);
          }
        }
        for (const k of [...held.keys()]) {
          if (down.has(k)) continue;
          held.delete(k);
          released();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function rumble(ok) {
    const g = gp === null ? null : navigator.getGamepads?.()[gp];
    const a = g?.vibrationActuator;
    if (!a?.playEffect) return;
    a.playEffect('dual-rumble', ok ? { duration: 60, strongMagnitude: 0.15, weakMagnitude: 0.5 } : { duration: 200, strongMagnitude: 0.7, weakMagnitude: 0.3 }).catch(() => undefined);
  }

  // Slow-mode countdowns tick on the chips.
  setInterval(() => {
    if (s.open && !document.hidden && L()?.nextSendAt) render();
  }, 1000);

  device('');
  count();
  let start = false;
  try {
    start = localStorage.getItem('pad-open') === '1';
  } catch {
    // no storage: closed
  }
  if (start) setTimeout(() => P.getState() && toggle(true), 1500);
})();
