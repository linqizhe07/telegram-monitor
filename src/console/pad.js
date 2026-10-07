// The pad: a controller for Telegram, on this page. The Messages panel is its screen: ▲▼ pick a
// message, ◀▶ switch chats. A replies, X reacts, Y saves to Saved Messages, START writes to the
// chat, SELECT opens it in the Telegram app, LT marks the chat read, RT mutes it, RB shows the
// message's bot buttons, LB switches Signal / All, ≡ has the rest (copy a link, the author, join,
// leave). It answers to the mouse, the keyboard, and a real game controller (the browser's Gamepad
// API: Xbox, PlayStation, Switch Pro and the like, connected to this Mac).
//
// A press that writes goes to the service as one request, and the service lets exactly that one
// through (src/controller.ts). What other people see (a post, a reply, a bot's button, leaving,
// joining) is armed by the first press and sent by the second, within 5 seconds. Everything from
// Telegram (titles, names, messages, button labels) is set as text, never as HTML.
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
    /** The picked message: { id, author, user, date, text }. */
    pick: null,
    /** What the pad may do in this chat (src/controller.ts PadChat), and for which chat. */
    look: null,
    lookFor: '',
    lookError: '',
    /** idle | compose | react | keys | more */
    mode: 'idle',
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

  // ── where: the chat and the message ────────────────────────────────────

  const sourceSelect = () => $('msg-source');
  const source = () => (P.getState()?.sources || []).find((x) => String(x.chatId) === s.chatId) || null;
  const title = () => s.look?.title || source()?.title || 'this chat';
  const username = () => {
    const ref = source()?.ref || '';
    const name = s.look?.username || (ref.startsWith('@') ? ref.slice(1) : '');
    return NAME.test(name) ? name : '';
  };
  /** The -100… id without its prefix, for t.me/c/… and tg://privatepost links (supergroups and channels only). */
  const internal = () => (/^-100\d+$/.test(s.chatId) ? s.chatId.slice(4) : '');

  function links(msgId) {
    const u = username();
    const c = internal();
    const id = Number.isInteger(msgId) && msgId > 0 ? msgId : null;
    if (u) return { app: `tg://resolve?domain=${u}${id ? `&post=${id}` : ''}`, web: `https://t.me/${u}${id ? `/${id}` : ''}` };
    if (c && id) return { app: `tg://privatepost?channel=${c}&post=${id}`, web: `https://t.me/c/${c}/${id}` };
    return { app: null, web: null };
  }

  const rows = () => [...document.querySelectorAll('#msgs > li[data-id]')];

  function readPick(li) {
    return {
      id: Number(li.dataset.id),
      author: li.dataset.author || '',
      user: NAME.test(li.dataset.user || '') ? li.dataset.user : '',
      date: Number(li.dataset.date) || 0,
      text: li.querySelector('.text')?.textContent || '',
    };
  }

  function mark() {
    for (const li of document.querySelectorAll('#msgs > li.picked')) if (!s.pick || Number(li.dataset.id) !== s.pick.id) li.classList.remove('picked');
    if (!s.pick) return null;
    const li = rows().find((x) => Number(x.dataset.id) === s.pick.id) || null;
    li?.classList.add('picked');
    return li;
  }

  /** Keeps the picked row in view inside the list, without moving the page. */
  function reveal(li) {
    const list = $('msgs');
    const a = list.getBoundingClientRect();
    const b = li.getBoundingClientRect();
    if (b.top < a.top) list.scrollTop -= a.top - b.top + 8;
    else if (b.bottom > a.bottom) list.scrollTop += b.bottom - a.bottom + 8;
  }

  function pickRow(li) {
    s.pick = readPick(li);
    if (s.mode !== 'compose') s.mode = 'idle';
    disarm();
    reveal(mark());
    render();
  }

  /** ▲ newer, ▼ older (the list shows the newest first). */
  function move(step) {
    const list = rows();
    if (list.length === 0) return say('No messages here yet.', 'bad');
    const i = s.pick ? list.findIndex((x) => Number(x.dataset.id) === s.pick.id) : -1;
    const next = i < 0 ? 0 : Math.min(list.length - 1, Math.max(0, i + step));
    pickRow(list[next]);
  }

  function switchChat(step) {
    const sel = sourceSelect();
    const opts = [...sel.options];
    if (opts.length === 0) return say('No sources yet.', 'bad');
    const i = opts.findIndex((o) => o.value === sel.value);
    sel.value = opts[(i + step + opts.length) % opts.length].value;
    sel.dispatchEvent(new Event('change'));
    chatChanged();
  }

  function chatChanged() {
    const now = sourceSelect().value;
    if (now === s.chatId) return;
    s.chatId = now;
    s.pick = null;
    s.mode = 'idle';
    s.replyTo = null;
    disarm();
    if (s.lookFor !== now) {
      s.look = null;
      s.lookError = '';
    }
    mark();
    scheduleLook();
    render();
  }

  let lookTimer = 0;
  function scheduleLook(fresh = false) {
    clearTimeout(lookTimer);
    if (!s.open || !s.chatId) return;
    lookTimer = setTimeout(() => look(fresh), 350);
  }

  async function look(fresh = false) {
    const chatId = s.chatId;
    if (!chatId) return;
    const r = await P.api('/api/pad/look', { chatId, fresh }).catch((err) => ({ ok: false, message: err.message }));
    if (chatId !== s.chatId) return; // switched meanwhile
    s.lookFor = chatId;
    if (r.ok && r.chat) {
      s.look = r.chat;
      s.lookError = '';
    } else {
      s.lookError = r.message || 'Could not read this chat.';
    }
    render();
  }

  // ── saying, arming, sending ────────────────────────────────────────────

  function say(text, tone = '') {
    s.status = { text, tone };
    render();
    if (tone === 'ok' || tone === 'bad') rumble(tone === 'ok');
    if (tone === 'ok' || tone === 'bad') {
      const screen = $('pad-screen');
      screen.classList.remove('flash-ok', 'flash-bad');
      void screen.offsetWidth;
      screen.classList.add(tone === 'ok' ? 'flash-ok' : 'flash-bad');
    }
  }

  let armTimer = 0;
  /** What others see goes on the second press: the first arms it for a few seconds. */
  function arm(what, label, run) {
    if (s.armed && s.armed.what === what && Date.now() < s.armed.until) {
      disarm();
      return run();
    }
    s.armed = { what, until: Date.now() + ARM_MS };
    const bar = $('pad-arm');
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
    $('pad-arm').classList.remove('run');
    if (s.status.tone === 'armed') s.status = { text: '', tone: '' };
  }

  /** One request to the service; `quiet`: say nothing when it went well (a look, not a write). */
  async function call(path, body, quiet = false) {
    if (s.busy) return null;
    s.busy = true;
    pad.classList.add('busy');
    render();
    try {
      const r = await P.api(path, body);
      if (r.chat) {
        s.look = r.chat;
        s.lookFor = String(r.chat.chatId);
      }
      if (!(quiet && r.ok)) say(r.message || (r.ok ? 'Done.' : 'Not done.'), r.ok ? 'ok' : 'bad');
      return r;
    } catch (err) {
      say(err.message, 'bad');
      return null;
    } finally {
      s.busy = false;
      pad.classList.remove('busy');
      render();
    }
  }

  const needPick = () => {
    if (s.pick) return true;
    say('Pick a message first: ▲▼, or click one in Messages.', 'bad');
    return false;
  };
  const needChat = () => {
    if (s.chatId) return true;
    say('No chat: pick a source in Messages.', 'bad');
    return false;
  };

  // ── the actions ────────────────────────────────────────────────────────

  function write(replyTo) {
    if (!needChat()) return;
    if (s.look?.sendBlock) return say(s.look.sendBlock, 'bad');
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
    const where = title();
    const many = s.look?.members ? ` (${fmt.format(s.look.members)} members)` : '';
    const replyTo = s.replyTo;
    const chatId = s.chatId;
    arm(`send|${chatId}|${replyTo}|${text}`, `Press START (Enter) again to ${replyTo ? `reply to #${replyTo}` : 'post'} in «${where}»: everyone there sees it${many}.`, async () => {
      const r = await call('/api/pad/send', { chatId, text, replyTo });
      if (r?.ok) {
        $('pad-text').value = '';
        count();
        s.mode = 'idle';
        s.replyTo = null;
        render();
        setTimeout(() => P.loadMessages(), 2500);
      }
    });
  }

  function save() {
    if (!needPick()) return;
    if (s.look?.noforwards) return say(`«${title()}» protects its content: nothing can be saved from it.`, 'bad');
    call('/api/pad/save', { chatId: s.chatId, msgId: s.pick.id });
  }

  function markRead() {
    if (!needChat()) return;
    call('/api/pad/read', { chatId: s.chatId });
  }

  function mute() {
    if (!needChat()) return;
    call('/api/pad/mute', { chatId: s.chatId, on: !s.look?.muted });
  }

  function openReact() {
    if (!needPick()) return;
    const allowed = s.look?.reactions;
    if (allowed && allowed.length === 0) return say(`«${title()}» allows no reactions.`, 'bad');
    s.react = { list: [...(allowed ? allowed.slice(0, 8) : QUICK), '✕'], i: 0 };
    s.mode = 'react';
    disarm();
    s.status = { text: '', tone: '' };
    render();
  }

  function sendReaction(i) {
    const e = s.react.list[i];
    if (!e || !s.pick) return;
    const msgId = s.pick.id;
    s.mode = 'idle';
    call('/api/pad/react', { chatId: s.chatId, msgId, emoji: e === '✕' ? null : e });
  }

  async function openKeys() {
    if (!needPick()) return;
    const msgId = s.pick.id;
    const r = await call('/api/pad/buttons', { chatId: s.chatId, msgId }, true);
    if (!r?.ok || !r.rows) return;
    s.keys = { rows: r.rows, r: 0, c: 0, msgId };
    s.mode = 'keys';
    say(`${r.rows.flat().length} buttons under #${msgId}: ◀▲▼▶ to choose, A to press (twice: the bot sees it).`);
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
    if (!href) return say('No link for this one: open it in your Telegram app.', 'bad');
    el('a', { href }).click(); // tg:// opens the Telegram app; nothing is sent from here
    say(what, 'ok');
  }

  function openInTelegram() {
    if (!needChat()) return;
    const l = links(s.pick?.id ?? Number(rows()[0]?.dataset.id));
    open(l.app, s.pick ? `Opened #${s.pick.id} in Telegram.` : `Opened «${title()}» in Telegram.`);
  }

  function openMore() {
    if (!needChat()) return;
    const l = links(s.pick?.id);
    const items = [];
    if (l.web) items.push({ label: s.pick ? `Copy the link to #${s.pick.id}` : 'Copy the chat\'s link', run: () => copy(l.web) });
    if (l.web) items.push({ label: 'Open it in the browser (t.me)', run: () => window.open(l.web, '_blank', 'noopener,noreferrer') });
    if (s.pick?.user) items.push({ label: `Open ${s.pick.author} (@${s.pick.user}) in Telegram`, run: () => open(`tg://resolve?domain=${s.pick.user}`, `Opened @${s.pick.user} in Telegram.`) });
    items.push({ label: 'Read this chat\'s state again', run: () => look(true).then(() => say('Read again.', 'ok')) });
    if (s.look && !s.look.member && username()) items.push({ label: `Join «${title()}»`, run: join });
    if (s.look?.member) items.push({ label: `Leave «${title()}»…`, danger: true, run: leave });
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
    const where = title();
    arm(`join|${s.chatId}`, `Press A again to JOIN «${where}» with your account: its members see you join.`, async () => {
      const r = await call('/api/join', { target: `@${u}` });
      if (r?.state === 'app' && r.open) open(r.open, r.message);
      look(true);
      P.refresh();
    });
  }

  function leave() {
    const where = title();
    const chatId = s.chatId;
    arm(`leave|${chatId}`, `Press A again to LEAVE «${where}». It goes off Sources, and the messages stored for it are deleted.`, async () => {
      const r = await call('/api/pad/leave', { chatId });
      if (r?.ok) {
        s.mode = 'idle';
        setTimeout(() => P.refresh(), 1500);
      }
    });
  }

  function back() {
    if (s.armed) {
      disarm();
      return say('Not sent.');
    }
    if (s.mode !== 'idle') {
      s.mode = 'idle';
      if (document.activeElement === $('pad-text')) $('pad-text').blur();
      return render();
    }
    if (s.pick) {
      s.pick = null;
      mark();
      return render();
    }
  }

  // ── one press, from any of the three inputs ────────────────────────────

  function press(k) {
    flashKey(k);
    if (k === 'toggle') return toggle();
    if (!s.open) return;
    if (sourceSelect().value !== s.chatId) chatChanged(); // picked elsewhere meanwhile (the source list, the live view)
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
      const k2 = s.keys;
      if (k === 'up') k2.r = Math.max(0, k2.r - 1);
      else if (k === 'down') k2.r = Math.min(k2.rows.length - 1, k2.r + 1);
      else if (k === 'left') k2.c = Math.max(0, k2.c - 1);
      else if (k === 'right') k2.c += 1;
      else if (k === 'A') return pressKey();
      k2.c = Math.min(k2.c, (k2.rows[k2.r]?.length || 1) - 1);
      disarm();
      return render();
    }
    if (s.mode === 'more') {
      const n = s.more.items.length;
      if (k === 'up') s.more.i = (s.more.i - 1 + n) % n;
      else if (k === 'down') s.more.i = (s.more.i + 1) % n;
      else if (k === 'A') {
        const item = s.more.items[s.more.i];
        if (!item?.danger && item?.run !== join) s.mode = 'idle';
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
      case 'left':
        return switchChat(-1);
      case 'right':
        return switchChat(1);
      case 'A':
        return needPick() && write(s.pick.id);
      case 'X':
        return openReact();
      case 'Y':
        return save();
      case 'LB':
        return P.setView(P.view() === 'signal' ? 'all' : 'signal');
      case 'RB':
        return openKeys();
      case 'LT':
        return markRead();
      case 'RT':
        return mute();
      case 'select':
        return openInTelegram();
      case 'start':
        return write(null);
      case 'more':
        return openMore();
    }
  }

  function flashKey(k) {
    const b = pad.querySelector(`.pad-key[data-k="${k}"]`);
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 120);
  }

  // ── drawing ────────────────────────────────────────────────────────────

  function chip(text, tone = '', tip = '') {
    return el('span', { class: `chip ${tone}`, text, title: tip || null });
  }

  function render() {
    if (!s.open) return;
    const opts = [...sourceSelect().options];
    const i = opts.findIndex((o) => o.value === s.chatId);
    const L = s.look && s.lookFor === s.chatId ? s.look : null;
    const now = Math.floor(Date.now() / 1000);

    const chips = [];
    if (L) {
      chips.push(chip(L.type === 'channel' ? 'channel' : L.type === 'group' ? 'group' : 'supergroup'));
      chips.push(L.member ? chip('in it', 'ok') : chip('outside', 'warn', 'The account is not in this chat: it is read from outside.'));
      if (L.sendBlock) chips.push(chip('read-only', 'warn', L.sendBlock));
      if (L.unread) chips.push(chip(`${fmt.format(L.unread)} unread`));
      if (L.muted) chips.push(chip('muted'));
      if (L.slowmode) chips.push(chip(L.nextSendAt > now ? `post in ${L.nextSendAt - now}s` : `slow ${L.slowmode}s`, L.nextSendAt > now ? 'warn' : ''));
      if (L.noforwards) chips.push(chip('protected', 'warn', 'Protected content: nothing can be forwarded or saved.'));
    } else if (s.lookError) chips.push(chip('?', 'bad', s.lookError));
    $('pad-chat').replaceChildren(
      el('span', { class: 'nav-n', text: opts.length ? `◂ ${i + 1}/${opts.length} ▸` : '◂ 0/0 ▸' }),
      el('span', { class: 't', text: s.chatId ? title() : 'No sources yet' }),
      ...chips,
    );

    const m = s.pick;
    $('pad-msg').replaceChildren(
      ...(m
        ? [
            el('div', { class: 'who' }, el('b', { text: m.author || 'someone' }), m.user ? el('span', { text: `@${m.user}` }) : null, el('span', { text: m.date ? P.fmtWhen(m.date) : '' }), el('span', { text: `#${m.id}` })),
            el('div', { class: 'tx', text: m.text || '(no text)' }),
          ]
        : [el('div', { class: 'hint', text: s.chatId ? '▲▼ pick a message (or click one in Messages) · START writes to the chat · ◀▶ other chats' : 'Pick a source in Messages, or ◀▶.' })]),
    );
    $('pad-msg').hidden = s.mode === 'compose' && !m;

    // The layer: reactions, a message's buttons, or the More list.
    const layer = $('pad-layer');
    if (s.mode === 'react') {
      layer.hidden = false;
      layer.replaceChildren(
        el('div', { class: 'react-row', role: 'listbox', 'aria-label': 'Reactions' },
          s.react.list.map((e, j) => el('button', { type: 'button', class: j === s.react.i ? 'on' : '', role: 'option', 'aria-selected': j === s.react.i ? 'true' : 'false', title: e === '✕' ? 'Take my reaction back' : `React ${e} (${j + 1})`, text: e, onclick: () => sendReaction(j) }))),
        el('div', { class: 'layer-hint', text: '◀▶ choose · A send · 1–9 directly · B back' }),
      );
    } else if (s.mode === 'keys') {
      layer.hidden = false;
      layer.replaceChildren(
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
        el('div', { class: 'layer-hint', text: '◀▲▼▶ choose · A press · B back' }),
      );
    } else if (s.mode === 'more') {
      layer.hidden = false;
      layer.replaceChildren(
        el('div', { class: 'more-list', role: 'menu' },
          s.more.items.map((it, j) => el('button', { type: 'button', role: 'menuitem', class: `${j === s.more.i ? 'on' : ''}${it.danger ? ' danger' : ''}`, text: it.label, onclick: () => {
            s.more.i = j;
            press('A');
          } }))),
      );
    } else layer.hidden = true;

    const compose = $('pad-compose');
    compose.hidden = s.mode !== 'compose';
    if (s.mode === 'compose') setText($('pad-compose-head'), s.replyTo ? `Reply to ${s.pick?.author || 'the message'} · #${s.replyTo} · in «${title()}»` : `New message in «${title()}»`);

    const st = $('pad-status');
    st.className = `lcd-status ${s.status.tone}`;
    setText(st, s.busy ? 'Asking Telegram…' : s.status.text || s.lookError);
    if (!s.busy && !s.status.text && s.lookError) st.className = 'lcd-status bad';

    // Labels that follow the state.
    setText($('pad-start'), s.mode === 'compose' ? (s.armed ? 'Post: again!' : 'Post') : 'Write');
    setText($('pad-rt'), L?.muted ? 'Unmute' : 'Mute');
    const label = (k, text) => setText(pad.querySelector(`.pad-key[data-k="${k}"] span`), text);
    label('A', s.mode === 'idle' ? 'Reply' : s.mode === 'compose' ? 'Post' : s.mode === 'keys' ? 'Press' : 'Choose');
    const dim = (k, on, why) => {
      const b = pad.querySelector(`.pad-key[data-k="${k}"]`);
      b.classList.toggle('dim', Boolean(on));
      b.title = on ? why : b.dataset.tip || b.title;
    };
    dim('A', s.mode === 'idle' && (!s.pick || L?.sendBlock), L?.sendBlock || 'Pick a message first');
    dim('start', s.mode === 'idle' && L?.sendBlock, L?.sendBlock || '');
    dim('X', s.mode === 'idle' && (!s.pick || (L?.reactions && L.reactions.length === 0)), !s.pick ? 'Pick a message first' : 'No reactions here');
    dim('Y', s.mode === 'idle' && (!s.pick || L?.noforwards), !s.pick ? 'Pick a message first' : 'Protected content');
    dim('RB', s.mode === 'idle' && !s.pick, 'Pick a message first');
    dim('LT', L && !L.member, 'The account is not in this chat');
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function count() {
    const v = $('pad-text').value;
    setText($('pad-count'), `${fmt.format(v.length)} / 4,096`);
    $('pad-count').classList.toggle('over', v.length > 4096);
  }

  // ── open, close ────────────────────────────────────────────────────────

  function toggle(force) {
    s.open = typeof force === 'boolean' ? force : !s.open;
    pad.hidden = !s.open;
    document.body.classList.toggle('pad-open', s.open);
    $('pad-toggle').setAttribute('aria-expanded', String(s.open));
    try {
      localStorage.setItem('pad-open', s.open ? '1' : '0');
    } catch {
      // private window: the pad just starts closed next time
    }
    if (s.open) {
      s.chatId = '';
      chatChanged();
      if (!s.look) scheduleLook();
      render();
    } else {
      disarm();
      s.mode = 'idle';
    }
  }

  // ── inputs: mouse, keyboard, game controller ───────────────────────────

  for (const b of pad.querySelectorAll('.pad-key')) {
    b.dataset.tip = b.title;
    b.addEventListener('click', () => press(b.dataset.k));
  }
  $('pad-close').addEventListener('click', () => toggle(false));
  $('pad-toggle').addEventListener('click', () => toggle());
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      flashKey('start');
      post();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      press('B');
    }
  });

  // Clicking a message picks it (unless text is being selected for copying).
  $('msgs').addEventListener('click', (e) => {
    const li = e.target.closest('#msgs > li[data-id]');
    if (!li || e.target.closest('a') || String(window.getSelection()) !== '') return;
    pickRow(li);
  });
  // The list is redrawn by the page: keep the mark on the picked message.
  new MutationObserver(() => {
    if (s.open && sourceSelect().value !== s.chatId) chatChanged();
    mark();
  }).observe($('msgs'), { childList: true });
  sourceSelect().addEventListener('change', chatChanged);

  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'A', r: 'A', a: 'A', Escape: 'B', b: 'B', e: 'X', x: 'X', s: 'Y', y: 'Y',
    '[': 'LB', ']': 'RB', u: 'LT', m: 'RT', o: 'select', n: 'start', '.': 'more',
  };
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing) return;
    // Enter and Space on a focused button or link are that element's own click.
    if ((e.key === 'Enter' || e.key === ' ') && t instanceof HTMLElement && t.closest('button, a, summary')) return;
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      return toggle();
    }
    if (!s.open) return;
    if (s.mode === 'react' && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      return sendReaction(Number(e.key) - 1);
    }
    const k = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!k) return;
    e.preventDefault();
    press(k);
  });

  // A game controller (standard mapping): A B X Y, LB RB LT RT, View/Select, Menu/Start, the
  // right stick's press for More, the d-pad or the left stick to move (held: repeats).
  const PADMAP = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'select', 9: 'start', 11: 'more', 12: 'up', 13: 'down', 14: 'left', 15: 'right', 16: 'toggle' };
  const MOVES = new Set(['up', 'down', 'left', 'right']);
  let gp = null;
  let raf = 0;
  const held = new Map();

  function device(name) {
    const short = (name || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    setText($('pad-device'), gp === null ? 'PAD · keyboard' : `PAD · ${short || 'controller'}`);
    pad.classList.toggle('gp', gp !== null);
  }

  addEventListener('gamepadconnected', (e) => {
    gp = e.gamepad.index;
    device(e.gamepad.id);
    if (!s.open) toggle(true);
    say(`Controller connected: ${e.gamepad.id.replace(/\s*\(.*?\)\s*/g, ' ').trim().slice(0, 40)}. ◀▲▼▶ move · A reply · X react · Y save · START write.`, 'ok');
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
      if (g && !document.hidden) {
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
        for (const k of [...held.keys()]) if (!down.has(k)) held.delete(k);
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

  // Slow-mode countdowns and a chat picked elsewhere (the source list, the live view).
  setInterval(() => {
    if (!s.open || document.hidden) return;
    if (sourceSelect().value !== s.chatId) chatChanged();
    else if (s.look?.nextSendAt) render();
  }, 1000);

  let start = false;
  try {
    start = localStorage.getItem('pad-open') === '1';
  } catch {
    // no storage: closed
  }
  device('');
  count();
  if (start) toggle(true);
})();
