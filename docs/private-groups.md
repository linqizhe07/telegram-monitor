# Private groups: preview, join in the Telegram app, verified membership

Implementation spec for tg-pulse. Phase 1 is built (2026-10-06). Phase 2 is specified and deferred.
Written 2026-10-05 for the lead engineer.

## Implementation status (Phase 1, 2026-10-06)

Built as specified in `src/invite-rules.ts` (pure rules), `src/invites.ts` (`InviteTracker`),
`src/notify.ts`, plus the store, reader, request-supervisor, console and MCP changes. Where the
build departs from the text below:

1. **Open risk 1 is fixed.**
   - The periodic chat-list check runs hourly.
   - A membership notice loads the chat list only when it can mean a join, a leave or a removal:
     - a chat that is not a source yet;
     - a source whose bundled object shows the account out;
     - a source that was off because the account had left;
     - a notice with no chat object.
   - Routine info changes are ignored. The same chat triggers at most one check an hour (`Reader.membershipNotice`).
2. **Rejoined chats count as new joins.** `onReconciled` also receives `back` (sources the account rejoined), so a rejoin after a kick gets the same watching for a check.
3. **A dead link offers no "I've joined".** If the account did join, the chat-list check finds the group. A dead row is still re-checked once when a chat with the same title appears.
4. **Joins found by the chat list.**
   - Such a chat is looked at for checks for 10 minutes before its standing is known, so the first page fetched is not missed.
   - Its participant entry is read once, not twice.
5. **Standing checks for one chat run one at a time.** A standing read less than 2 minutes old is reused, because the chat-list find and the owner's "I've joined" usually arrive together.
6. **Public sources read from outside.**
   - Only an explicit ban (`channelForbidden`) switches reading off, with `reader_off_reason` `banned`; "not a member" is normal for these.
   - A timed ban resumes reading at `until + 60 s`, at most 3 times.
7. **Every `payments.*` request is a write**, `GetPaymentForm` included.
8. **A link checked in the last 10 minutes is answered from that check**, whatever its state (dead links too).

Verified live so far:

- **L0: tests.** 111 unit tests pass, and the typecheck is clean.
- **L1: no writes.** The service was restarted 2026-10-06 00:08 and 00:10 UTC. Since then there have been 0 writes and 0 blocked writes.
- **L2: previews (partial).**
  - A made-up hash got one `CheckChatInvite`. Telegram answered `INVITE_HASH_EXPIRED` (not `INVALID`) for an unknown hash, and the row became `link-dead`.
  - Looking again within 10 minutes, through MCP `check_group`, sent nothing to Telegram.
  - With the tool token, the owner-only routes answered 403.
- **L3: notifications.** `osascript` exited cleanly, and the owner confirmed the test notification appeared (2026-10-06).
- **Still to run.** L2 with real links, and L4–L9. They need the owner, and a test group run from a second account.

## Owner-click joins and answers (2026-10-07)

At the owner's request ("应该直接在这个界面就能加入群聊，完成人机验证"), part of Phase 2 is built on the
Phase 1 stack (GramJS, layer 198), within the lines Phase 2 drew (section 8):

- **Join on a click.** `channels.joinChannel` for a public group or channel, `messages.importChatInvite`
  for an open invite link (`src/owner-actions.ts`). Each passes the request door on a one-shot permit
  that matches that exact request (`superviseRequests().permit`); every other write is still refused.
  - Refused before anything is sent: Telegram's SCAM/FAKE flags, a likely scam in the latest search,
    and `restriction_reason` for every platform.
  - Sent to the app instead (table rows 5, 6 and 15): groups that need a join request, and paid ones.
    A software request cannot be withdrawn, and a guard bot's join web view is bound to the session
    that sent it.
  - Rationed: 3 joins an hour and 10 a day. `PEER_FLOOD` holds joins for a day; a flood wait holds
    them for as long as Telegram asks.
- **The human's answer, relayed.** For a check caught by `matchChallenge` while its window is open:
  - a plain callback button the owner picks is pressed with its exact data (`messages.getBotCallbackAnswer`);
  - a typed answer of at most 64 characters goes as a reply to the check (`messages.sendMessage`);
  - the check's photo is downloaded for the banner (a read).

  Link buttons to Telegram open the app (`tg://resolve`). Web views, URL logins, phone, location and
  peer requests, games and payments stay in the app (table row 40). Nothing is chosen, ranked,
  guessed or retried. Presses are capped at 10 and answers at 5 per check.
- **Still never:** joining or answering on Claude's word (these routes are not in the tool token's
  list), a join request, a web view, a payment, a leave, an automatic re-join, or reading private chats.

## How to read this

- **Evidence ids** come from the research pass of 2026-10-05 (`fact-sheet.md`, `research-facts.txt`). Prefixes:
  - M = mtproto, CB = captcha-bots, AL = account-limits, GJ = gramjs-and-prior-art;
  - SP = silent-member-purge, PF = profile-and-cas-filters, PG = private-group-no-link;
  - UF = unofficial-client-flag, GM = guard-miniapp, WM = welcome-message, CM = community;
  - RR = restriction-reason, RC = read-capacity, ST = stack-trust, MC = mtcute, BN = binance.
- **Verdict labels** follow each id:
  - U: upheld by the skeptic.
  - C: corrected; the corrected wording is the one relied on.
  - M: a fact the skeptic added.
  - R: a research claim with no skeptic verdict.
  - I: an inference.
  - **LT**: only a live test can settle it.
- **GramJS citations** are `node_modules/telegram/<path>:<line>` in the installed `telegram` 2.26.22. That release speaks MTProto layer 198 (`tl/AllTLObjects.js:4`). Every GramJS API named for Phase 1 was checked there.
- **tg-pulse citations** come from the working tree as it stood on the evening of 2026-10-05.
  - That tree has uncommitted work in progress, "chat-list discovery":
    - `Reader.membership()`, `Reader.reconcile()` and `reconcileSoon()`;
    - `connection.onMembershipNotice` and `isMembershipNotice()`;
    - `/api/toggle`, `/api/refresh` and `/api/settings`;
    - MCP `set_monitoring` and `refresh_sources`;
    - the `reader_origin` column.
  - This spec builds on that work. Line numbers will drift; the function names are the anchors.
- **mtcute citations** (Phase 2 only) point into the 0.32.4 tarballs unpacked in the research scratchpad, written here as `mtcute:core/...` and `mtcute:convert/...`. Re-check them in `node_modules` once Phase 2 installs the package.

---

## 1. Summary and scope

### What the owner gets

The reader is the owner's **main** Telegram account. For a private group reached by an invite link, Phase 1 gives the owner:

1. **A read-only preview** of the invite link (one `messages.checkChatInvite`). It shows:
   - title, type and member count;
   - whether admin approval is needed;
   - the scam, fake and verified flags;
   - a paid-subscription flag;
   - the preview window, if Telegram offers one.

   It also shows honest warnings, each tied to evidence (section 3.1.3).
2. **Deep links** that open the official app: `https://t.me/+HASH` and `tg://join?invite=HASH`. The owner joins, or requests to join, **in the official Telegram app**. Any verification appears there, because it is the owner's own account, and the owner answers it there.
3. **"I've joined" and "I've sent a request" buttons.**
   - The service then makes **one** `checkChatInvite`.
   - `ChatInviteAlready` means it has the chat, with its access hash. The chat becomes a source, switched on, with its peer saved, so it is never resolved by name again.
   - A pending request is re-checked rarely, on a fixed schedule under a daily cap (section 5.2). This continues until approval, a dead link, or 14 days with no answer. Approval brings a console card and a macOS notification.
4. **Post-join health.**
   - The account's own state in the chat (member, muted pending verification, removed, banned until a date) is read at a few sensible moments, not by hard polling.
   - While the account is restricted, or a bot has addressed it right after the join, the console shows a banner: **"Verification in progress: answer it in your Telegram app."** The bot messages that address the account are shown with it, read-only.
   - A removed state appears when reads fail with `CHANNEL_PRIVATE`, or when the chat comes back as `channelForbidden`.
   - The first pull carries the hidden-history caveat.
5. **MCP tools for preview and status only.** Claude can preview an invite and report status. It cannot confirm, dismiss, re-check or answer anything.
6. **Everything in the activity log**: every Telegram call (already recorded by `superviseRequests`), every owner gesture, every state change and every notification.

### Hard lines in Phase 1

- No software join.
- No answer to any challenge.
- No press, vote, post, read mark or web-view request.

Section 3.5 makes this a property of the code: the request supervisor refuses every request classified as a write, before it reaches GramJS.

### Why the owner joins in the app

- **GramJS 2.26.22 cannot do it safely.** It speaks layer 198, is archived and is npm-deprecated (ST-24 C, GJ-01 C). Its join methods are the old `importChatInvite#6c50051c` and `joinChannel#24b524c5`, both returning `Updates` (`tl/apiTl.js:1620`, `:1861`). The live layer is 229, where both return `messages.ChatInviteJoinResult` (CB-06 C, M-11 U). So a layer-198 client:
  - cannot see a guard bot's join web view (M-11 U, GM-15 U);
  - cannot see ephemeral or welcome messages (M-12 C, CB-08 U, GJ-26 U);
  - cannot see Communities (CM-12 U).

  What the server sends a layer-198 client that joins a guard-bot chat is unknown (M-m03 M, **LT**).
- **The owner's own app already handles all of it.** It speaks the live layer, shows every challenge kind, including Mini Apps and messages only the owner can see, and is where the owner would answer anyway.
- **Mini App challenges cannot be finished elsewhere.** A guard bot's `query_id` reaches only the session that sent the join (GM-04 U, inference with API support). A join started in software therefore could not be finished in the app.
- **A software request cannot be undone.** There is no user-side way to cancel a pending request (M-10 C, GM-m11 M).

### Phase 2 (deferred, section 8)

Phase 2 covers software-initiated joins with a relay for the human's chosen answer, on a layer-229 stack (`@mtcute/node` and `@mtcute/core` 0.32.4, pinned, importing the GramJS session). It includes every item from the adversarial critique. It may start only after:

- the supply-chain check and cold-cutover live tests (fact sheet T0, T9);
- the Phase 1 live tests in section 7.

### Out of scope for both phases

- Creating accounts.
- Automatic solving, OCR or guessing.
- Paying Stars.
- Wallet steps.
- Folder-link joins on the owner's main account.
- Joining public groups that can be read from outside (CB-01 U, M-33 C).

---

## 2. Phase 1 state machine

### 2.1 Invite (one row per invite link in the `invites` table)

```
                 preview (1 checkChatInvite, budgeted)
   invite link ─────────────────────────────────────────▶ previewed ──┬─▶ refused  (scam / fake: no links offered)
                                                             │        ├─▶ link-dead (INVITE_HASH_*)
                                                             │        └─▶ watching  (already a member: switch on reading)
                                     owner clicks a deep link│
                                                             ▼
                                                        owner-opened
                                                             │
                       owner: "I've joined" / "I've sent a request"   (ONE checkChatInvite)
                                                             │
              ┌──────────────────────────────┬───────────────┴──────────────────┐
              ▼                              ▼                                  ▼
          joined ───────────┐         requested ──(schedule, ≤17 checks/14 d)──▶ no-answer
   (ChatInviteAlready)      │              │  approval seen (check, or chat-list match + check)
              │             │              └──────────────────────────────▶ joined
              ▼             │
   post-join health (3 reads)
              │             │
     restricted, or a bot   │ not restricted, no bot message
     addressed the account  │ addressed to the account
              ▼             ▼
          verifying ──────▶ watching ◀── unmuted, or the 15-min window passed while still a member
              │             │
              └──────┬──────┘
                     ▼   pull fails CHANNEL_PRIVATE / CHAT_FORBIDDEN, or the chat-list check says "left"
                  removed   (sub-kind: left | banned | banned-until <date>; reading switched off)
```

Side exits:
- `dismissed`: the owner pressed **Stop tracking**. This is allowed from any non-terminal state.
- `expired`: a `previewed` or `owner-opened` row saw no owner action for 7 days.

The lead's sketch was *invite → previewed → owner-opened → joined/requested → (verifying) → watching/removed*. That path is the spine above. `owner-opened` is informational: the owner may also confirm straight from `previewed`, for example after opening the link from Claude Desktop.

### 2.2 States

| State | Meaning | Telegram calls while in it |
|---|---|---|
| `previewed` | Facts stored from one `checkChatInvite`. | none |
| `owner-opened` | The owner clicked a deep link in the console. Informational only. | none |
| `requested` | Telegram shows no membership yet, and either the owner said "request" or the link needs approval. | Scheduled `checkChatInvite` (section 5.2). |
| `joined` | Telegram confirmed membership; post-join health is running. Lasts seconds; stored so that a restart resumes it. | `channels.getChannels`, `channels.getParticipant(self)`, `channels.getFullChannel` (once each). |
| `verifying` | The account is personally restricted, or a bot addressed it within 15 min of the join. The banner is shown. | Scheduled `channels.getChannels` (section 5.2), plus one on a membership notice for this chat. |
| `watching` | A member, reading. A long mute that stays after the schedule shows as a "muted (reading works)" pill. | Normal reader pulls only. |
| `removed` | No longer a member: left, kicked, banned, or banned until a date. Reading is switched off. | none, except one re-check after `until` for public groups (section 3.4). |
| `no-answer` | A request was tracked for 14 days with no approval. Telegram never reports a decline (M-10 C). | none (**Check now** spends one budgeted check) |
| `link-dead` | `INVITE_HASH_EXPIRED`, `INVITE_HASH_INVALID` or `INVITE_HASH_EMPTY`. A later chat-list match can still link it. | none |
| `refused` | Telegram flags the chat as scam or fake. | none |
| `dismissed`, `expired` | Terminal. | none |

### 2.3 Transitions

| From | Trigger | Telegram call | To | Side effects |
|---|---|---|---|---|
| none | **Check** in the console (`/api/probe`), or MCP `check_group`, with an invite link | `messages.checkChatInvite` (budget: owner or MCP lane) | `previewed` / `refused` / `link-dead` / `watching` (when already a member) | Row created or refreshed. Activity: `invite previewed`. |
| `previewed` | Console deep-link click | none | `owner-opened` | Activity (actor `owner`): `opened invite link`. |
| `previewed`, `owner-opened`, `link-dead` | **I've joined** (page token) | ONE `checkChatInvite` (owner lane) | `Already` → `joined`. `ChatInvite` with `request_needed` → `requested`. `ChatInvite`/`Peek` otherwise → stays, note "not a member yet". `INVITE_HASH_*` → `link-dead`. | Activity: `owner says joined`, then the result. |
| `previewed`, `owner-opened` | **I've sent a request** (page token) | ONE `checkChatInvite` (owner lane) | `Already` → `joined`. Otherwise → `requested`, with the schedule started. | Activity: `owner says requested`. |
| `requested` | Schedule due | `checkChatInvite` (background lane) | `Already` → `joined`. `INVITE_HASH_*` → `link-dead`. 14 days → `no-answer`. | Approval: macOS notification "Join approved". |
| `requested`, `owner-opened`, `link-dead` | The chat-list check adds a chat whose normalised title equals the invite title | `checkChatInvite` (background lane) to confirm; without the budget, it waits for the budget | `joined` when `Already` names the same chat id | Title alone never links (section 3.1.6). |
| `joined` | Post-join health done | (see the `joined` row in 2.2) | `verifying` or `watching` | Source switched on, peer saved, cursor seeded from `available_min_id`, first pull. |
| `verifying` | Re-check shows no personal send restriction, and 15 min have passed since `joinedAt` | `channels.getChannels` | `watching` | Activity: `verification over`. Banner removed. |
| `verifying` | Schedule exhausted while still muted (7 days) | none | `watching` with the "muted (reading works)" pill | — |
| `joined`, `verifying`, `watching` | Pull fails with `CHANNEL_PRIVATE` or `CHAT_FORBIDDEN`, or the chat-list check reports it left | `channels.getChannels` (or `messages.getChats` for a basic group) | `removed` | Reading switched off (`reader_off_reason` `left`). Notification. |
| any non-terminal | **Stop tracking** (page token) | none | `dismissed` | — |

### 2.4 Membership sub-state (per chat, table `memberships`)

This applies to chats joined through an invite and to chats the chat-list check newly finds (section 3.1.7).

| Self state | Read from (primary first) | Rule |
|---|---|---|
| `member` | `Channel.left` false, with no personal send restriction | — |
| `verifying` | `Channel.banned_rights` sets `send_messages` or `send_plain` for this account, and `until_date` is 0 or in the future; or a matched bot message within 15 min of the join | Personal means a flag that is **not** also set in `default_banned_rights` (M-14 U, CB-12 U). |
| `muted` | Same as `verifying`, but past the verifying schedule | Reading still works (M-14 U, CB-22 U). |
| `removed` | `Channel.left` true; `ChannelParticipantLeft`; `USER_NOT_PARTICIPANT`; or `Chat.left` for a basic group | A bot "kick" is a ban followed by an unban, so the account can rejoin (SP-21 U, SP-22 U). |
| `banned` | `channelForbidden` with no `until_date`, or one more than 366 days out; or `banned_rights.view_messages` | (CB-12 U, SP-23 C) |
| `banned-until` | `channelForbidden.until_date` within 366 days | Shieldy kicks for 45 s; Rose anti-raid bans for 1 h (CB-18 U, CB-26 R). |
| `unknown` | Any other error | Kept with the error text; re-checked on the next trigger. |

**`CHANNEL_PRIVATE` is ambiguous.** It covers "not a member" and "banned" alike (M-01 C, SP-23 C). For a private group, whether `getChannels` returns a `Channel` with `left`, or a `channelForbidden`, after a kick is **LT** (fact sheet T11; section 7, L7). The classifier handles every shape. When it cannot tell, it says "removed (left, kicked or banned)".

---

## 3. Phase 1 files and interfaces

### Build order

Each step is testable on its own:

1. **Read-only gate and no-retry list:** `reader-client.ts`, plus `activity.ts` carve-outs (3.5, 3.6).
2. **Store:** the `invites` and `memberships` tables and their methods (3.3).
3. **`src/notify.ts`:** pure argv builder and notifier (3.2).
4. **`src/invites.ts`:** pure functions first (classify, warnings, links, budget, schedule, self state, hint matcher), then the `InviteTracker` (3.1).
5. **`reader.ts`:** hooks (`onBatch`, `onAccessLost`, `discovery.onReconciled`), `ReaderError.code`, `toSourceInfo`, `parseRef` folder-link and `t.me/c` forms (3.4).
6. **Console:** token split, routes, state additions, UI and copy (3.7, 3.8).
7. **`src/mcp.ts`:** `check_group` preview output and `invite_status` (3.9).
8. **`src/main.ts`:** wiring (3.10).

### 3.1 `src/invites.ts` (new)

#### 3.1.1 Types

```ts
export type InviteVerdict = 'member' | 'peek' | 'join' | 'request' | 'paid' | 'refused' | 'dead';
export type InviteState =
  | 'previewed' | 'owner-opened' | 'requested' | 'joined' | 'verifying' | 'watching'
  | 'removed' | 'no-answer' | 'link-dead' | 'refused' | 'dismissed' | 'expired';
export type SelfStateName = 'member' | 'verifying' | 'muted' | 'removed' | 'banned' | 'banned-until' | 'unknown';

export interface InviteFacts {
  verdict: InviteVerdict;
  title: string;
  kind: 'channel' | 'supergroup' | 'group';
  members: number | null;
  about: string;                       // ≤ 400 chars, plain text
  verified: boolean; scam: boolean; fake: boolean;
  requestNeeded: boolean;
  paid: boolean;                       // chatInvite.subscription_pricing present
  peekUntil: number | null;            // chatInvitePeek.expires
  chat: { chatId: number; peer: string | null; entity: unknown } | null;  // Already / Peek only
}

export interface Warning { level: 'stop' | 'caution' | 'info'; code: string; text: string; evidence: string[] }

export interface InviteView {
  id: number; state: InviteState; verdict: InviteVerdict;
  title: string; kind: InviteFacts['kind']; members: number | null; about: string;
  flags: { verified: boolean; scam: boolean; fake: boolean; paid: boolean; requestNeeded: boolean };
  peekUntil: number | null;
  hashTail: string;                    // first 4 chars only (logs, MCP)
  links: { tme: string; tg: string } | null;   // null for refused; console only
  warnings: Warning[];
  said: 'joined' | 'requested' | null; saidAt: number | null; openedAt: number | null;
  chatId: number | null; joinedAt: number | null;
  checking: boolean; lastCheckAt: number | null; nextCheckAt: number | null; checks: number;
  note: string;                        // the one owner-facing line for the current state
}

export interface SelfState { state: SelfStateName; until: number | null; detail: string; viaRequest?: boolean; joinedAt?: number }

export interface ChallengeHint {       // in memory only; never stored, never sent to MCP or the LLM
  chatId: number; msgId: number; date: number;
  sender: { id: string; username: string | null; name: string; bot: boolean; viaBot: boolean };
  why: string[];                       // e.g. ['a button carries your account id']
  text: string;                        // ≤ 500 chars, plain
  buttons: string[];                   // labels only; URL buttons as 'link to <host> (not opened here)'
  media: string | null;                // '[photo]' / '[video]' → 'see it in your Telegram app'
  suspicious: string | null;           // e.g. 'posted by a person through an inline bot, not by a group bot'
}
```

#### 3.1.2 Pure functions

| Function | Rules | Evidence |
|---|---|---|
| `inviteHash(input: string): string \| null` | Delegates to `parseRef` (reader.ts) and returns `hash` for `kind: 'invite'`. The hash must match `^[A-Za-z0-9_-]{8,64}$`. | Link forms `t.me/+<hash>`, `t.me/joinchat/<hash>`, `tg://join?invite=<hash>` (core.telegram.org/api/links, "Chat invite links"). GramJS's own parser misses `t.me/+` (`Utils.js:100-104`, GJ-19 U). |
| `deepLinks(hash)` | Returns `{ tme: 'https://t.me/+' + hash, tg: 'tg://join?invite=' + hash }`. Only a validated hash is ever placed in a URL. | Same doc. |
| `classifyInvite(inv, now): InviteFacts` | See the next table. | (see next table) |
| `warningsFor(f: InviteFacts): Warning[]` | 3.1.3 | — |
| `classifySelf({ chat?, participant?, error? }, now): SelfState` | 2.4; the code sketch is in 3.1.5. | M-14 U, CB-12 U, SP-23 C, M-10 C |
| `matchChallenge(m, self, joinedAt): ChallengeHint \| null` | 3.1.6 | CB-38 U, CB-17 C, CB-21 U |
| `pendingSchedule(saidAt, n)` / `verifySchedule(joinedAt, n)` | 5.2 | — |

`classifyInvite` maps each `checkChatInvite` result:

| Result | Verdict | Details | Evidence |
|---|---|---|---|
| `ChatInviteAlready{chat}` | `member` | `chat` may be a `Channel` or a basic `Chat`. The peer comes from `peerOf(chat)` (reader.ts). | `api.d.ts:6581-6582`; `apiTl.js:525` |
| `ChatInvitePeek{chat, expires}` | `peek` | — | `api.d.ts:6637-6639`; `apiTl.js:527` |
| `ChatInvite`, scam or fake set | `refused` | — | flags at `api.d.ts:6599-6600` |
| `ChatInvite`, `subscriptionPricing` set | `paid` | — | `api.d.ts:6608` |
| `ChatInvite`, `requestNeeded` set | `request` | — | `api.d.ts:6597` |
| `ChatInvite`, otherwise | `join` | `kind`: `broadcast` → channel, `megagroup` → supergroup, otherwise group (`api.d.ts:6594-6596`). Members from `participantsCount` (`:6605`). | `apiTl.js:526` (no chat id in `chatInvite`) |
| `INVITE_HASH_EXPIRED`, `INVITE_HASH_INVALID`, `INVITE_HASH_EMPTY` | `dead` | — | — |

#### 3.1.3 Pre-join warnings

The console shows these in the order listed. MCP prints them as text. Each `evidence` array holds the ids shown.

Shown for verdicts `join`, `request`, `paid` and `peek`:

| Code | Level | Text (UI copy) | Evidence |
|---|---|---|---|
| `visible` | caution | "This is your own Telegram account. When you join, members and admins see it: you appear in the member list, a «joined» line may appear in the chat, and the admin log records which invite link you used. Your name, photo and @username are visible to them." | AL-28 R (official doc), M-31 I |
| `guard-unknown` | caution | "Nothing visible before joining tells whether this group screens newcomers with a bot. If there is a check, it appears in your Telegram app right after you join (or after approval). Answer it there." | CB-m06 M, M-m02 M, M-06 C, CB-39 C |
| `windows` | caution | "Some checks give very little time: as little as 10 seconds with Join Captcha Bot, 60 seconds by default with Shieldy. Join when you can answer at once. A missed or failed check usually removes you, and repeated failed joins can end in a permanent ban (Join Captcha Bot: after 10 failed joins, or 3 failed quiz polls)." | CB-20 C, CB-16 U, CB-18 U, CB-m03 M |
| `filters` | info | "Some groups remove newcomers with no check at all. Causes include the CAS ban list (also applied after the fact), rules on account id, name script, a missing @username or photo, and anti-raid mode. Waiting does not get past id rules." | CB-29 U, PF-17/18/19 U, CB-19 C, PF-08 C, PF-24 C, CB-26 R |
| `purge` | info | "Silent members can be removed later, for example by Combot's inactivity kicker after 1–60 days. Reading never counts as activity. If that happens, this page shows it and stops reading the group." | SP-01 U, SP-04 C, SP-05 U, SP-11 U |
| `hidden-history` | info | "Private groups can hide earlier messages from new members, and that is only known after joining. If so, the digest starts at your join." | M-02 U, M-03 C, M-06 C |
| `spread` | info | "A ban in one group can follow you: CAS bans and Rose federation bans apply across many groups." | CB-m10 M, CB-29 U |
| `scam-portal` | caution | "Real checks never ask for your login code, password or phone number, a wallet connection or signature, or for you to paste or run anything on your computer. A «verify» bot that asks for any of these is a scam. Check the bot's exact @username." | CB-33 C, M-25 U |
| `unofficial-flag` | info | "Telegram may label accounts that use unofficial apps on their profile. Whether this service's session causes that is not known yet (a live test checks it). Admins who open your profile could see it." | UF-01 C, UF-02 C, UF-09 C, UF-07 REFUTED (a single report says the label clears hours after the session ends), **LT** |
| `ai-terms` | caution | "Messages from this group will be summarised by Claude. Telegram's terms restrict using chat content to deploy AI without each member's consent. Whether to accept that is your decision." | M-29 U, AL-22 C |

Shown only under the listed condition:

| Condition | Code | Level | Text | Evidence |
|---|---|---|---|---|
| `request` | `request` | caution | "Joining sends a request that an admin or a bot must approve. Telegram has no way to withdraw it, approval can take minutes or days, and you are not told about a decline. A bot may message you about the request within 5 minutes. An admin who chats with you sees your account's registration month and phone country." | M-10 C, CB-03 C, M-32 U, CB-04 C, CB-m12 M, M-m15 M |
| `request` | `guard-miniapp` | caution | "Groups that approve requests may show a bot page (a Mini App) inside the join itself. Finish it in your Telegram app. This service never opens verification pages." | CB-05 U, CB-06 C, GM-01 U, GM-04 U, GM-14 U |
| `paid` | `paid` | stop | "This link charges a Telegram Stars subscription to join. This service never pays. Paying is your decision, made in your Telegram app." | CB-m07 M, M-09 C |
| `refused` | `scam-flag` | stop | "Telegram marks this group as SCAM" (or FAKE). Not offered: no links are shown. | M-05 U |
| `peek` | `peek` | info | "Readable without joining until HH:MM. Telegram offers this time-limited preview for some links. It is not a way to keep reading: to follow the group, join in your Telegram app." | M-07 U, CB-m01 M, AL-29 R |
| title matches `/binance\|币安\|幣安/i` | `brand` | caution | "Binance's official groups are public and can be read without joining. A private «Binance» group reached by invite is not on Binance's official list, and Telegram's verified badge does not prove a group is official." | BN-01 U, BN-08 U, BN-05 C, BN-16 C, BN-m01 M |
| `member` | `member` | info | "This account is already in this group." | M-07 U |
| `dead` | `dead` | stop | "This invite link no longer works (expired or revoked)." | — |

#### 3.1.4 `InviteBudget`: the ration for `checkChatInvite`

This class is persisted in kv `invite_budget` as JSON: `{ at: [ms, lane][], frozenUntil, floods: ms[] }`.

```ts
export type Lane = 'owner' | 'background' | 'mcp';
export class InviteBudget {
  constructor(store: Store, nowMs: () => number, limits?: Partial<Limits>);
  take(lane: Lane): { ok: true } | { ok: false; reason: string; retryAt: number };
  flood(seconds: number): void;        // freeze: max(2 × seconds, 6 h); a 2nd flood within 24 h → 24 h
  view(): { used24h: number; background24h: number; mcp24h: number; frozenUntil: number | null; reason: string | null };
}
// Limits (defaults): perDay 20, backgroundPerDay 12, mcpPerDay 5, minGapMs 30_000,
//                    backgroundGapMs 120_000, cacheMs 600_000 (same hash previewed < 10 min ago → cached, no call)
```

The justification for these numbers is in section 5.2.

#### 3.1.5 `InviteTracker`

```ts
export interface TrackerDeps {
  raw: TelegramClient;                 // connection.raw: already wrapped by superviseRequests (paced, recorded, write-gated)
  reader: Reader;
  store: Store;
  activity: Activity;
  config: Config;
  notify: Notifier;                    // src/notify.ts
  self: { id: string; username: string | null };
  defaults: ChatDefaults;
  now: () => number;                   // unix seconds
}
export class InviteTracker {
  constructor(deps: TrackerDeps);
  start(): () => void;                 // loads rows, expires stale ones, re-arms schedules, 30 s tick; returns stop
  preview(target: string, lane: 'owner' | 'mcp'): Promise<{ probe: ProbeResult; invite: InviteView } | { error: string }>;
  opened(id: number): InviteView;                                         // page only
  confirm(id: number, said: 'joined' | 'requested'): InviteView;          // page only; returns at once, check runs async
  recheck(id: number): InviteView;                                        // page only; budgeted ('owner' lane)
  dismiss(id: number): InviteView;                                        // page only
  checkMembership(chatId: number): Promise<SelfState>;                    // page only ("I've answered it — check now", "I've rejoined")
  watchMember(hash: string): Promise<{ ok: boolean; message: string; chatId?: number }>; // /api/watch for an invite link of a chat already joined
  onBatch(chatId: number, batch: MtMessage[]): void;                      // reader hook; synchronous, no requests
  onAccessLost(chatId: number, err: ReaderError): Promise<void>;          // reader hook
  onReconciled(r: { added: SourceInfo[]; left: ChatRow[] }, first: boolean): void; // chat-list hook
  onNotice(n: { chatId: number | null }): void;                           // connection membership notice
  views(): { invites: InviteView[]; memberships: MembershipView[]; budget: ReturnType<InviteBudget['view']> };
}
```

**Telegram calls (all reads)**

None of these spends the resolve budget: every peer comes from a saved address. `getInputEntity` returns an `InputPeer*` as-is (`client/users.js:227-234`, `Utils.js:144-147`), and an `InputPeerChannel` becomes an `InputChannel` with no request (`Utils.js:295-300`, `tl/api.js:454-482`).

| Purpose | Call | Schema and class evidence |
|---|---|---|
| Preview and confirm | `raw.invoke(new Api.messages.CheckChatInvite({ hash }))` | `apiTl.js:1619` (`messages.checkChatInvite#3eadb1bb hash:string = ChatInvite`); `api.d.ts:23799`. Results `api.d.ts:6581`, `:6591`, `:6637`. Read-only; the admin side shows only joins and requests (M-07 U, but its invisibility to admins is an inference, **LT** T7). |
| Own state (primary) | `raw.invoke(new Api.channels.GetChannels({ id: [inputPeerChannel] }))` | `apiTl.js:1853`; `api.d.ts:27098`. `Channel.left` `:1046`, `bannedRights` `:1078`, `defaultBannedRights` `:1079`, `accessHash` `:1071`, `min` `:1052`. `ChannelForbidden.untilDate` `:1148`. `ChatBannedRights` `:11423` (`viewMessages` `:11425`, `sendMessages` `:11426`, `sendMedia` `:11427`, `sendPlain` `:11444`, `untilDate` `:11445`). |
| Own state (once after a join: `via_request`, join date) | `raw.invoke(new Api.channels.GetParticipant({ channel: inputPeerChannel, participant: new Api.InputPeerSelf() }))` | `apiTl.js:1852`; `api.d.ts:27086` (result `channels.ChannelParticipant` `:19666`). `ChannelParticipantSelf{viaRequest, inviterId, date}` `:7491-7496`. `ChannelParticipantBanned{left, kickedBy, bannedRights}` `:7553-7559`. `ChannelParticipantLeft` `:7573`. `InputPeerSelf` `:51`. |
| Hidden history | `raw.invoke(new Api.channels.GetFullChannel({ channel: inputPeerChannel }))` | `apiTl.js:1854`; `api.d.ts:27108`. `ChannelFull.availableMinId` `:1254`, `hiddenPrehistory` `:1218` (admin-only; never trusted, M-03 C). |
| Basic group state | `raw.invoke(new Api.messages.GetChats({ id: [chatId] }))` | `apiTl.js:1596`; `api.d.ts:23489`. `chat#41cbf256 … left deactivated … migrated_to` at `apiTl.js:82`; `chatForbidden` at `:83`. |

**Why `getChannels` and `getParticipant(self)` together.** The lead asked for the account's own state "through channels.GetParticipant on self". The research says own restrictions are authoritative on the `Channel` object (`banned_rights`, next to `default_banned_rights`). TDLib derives status from it, and tdesktop logs "Got self banned participant" when `getParticipant(self)` returns `channelParticipantBanned` (M-14 U). So:
- `getChannels` is the primary read, re-run on the schedule. It is one call and can be batched for up to 100 chats.
- `getParticipant(self)` runs **once** after a join, for `via_request` and the join `date` (M-10 C), and as a fallback classifier.

This is listed for review in Appendix A.

**`preview(target, lane)`**

1. Parse the invite hash. A non-invite target goes to the existing `probe()`, unchanged.
2. Reuse the row with this hash if one is active. If `lastCheckAt` is less than 10 min old, return the cached facts with no call.
3. Call `budget.take(lane)`. On refusal, return `{ error: 'Invite checks are rationed: next one possible at HH:MM.' }`.
4. Make one `CheckChatInvite`, then `classifyInvite`.
   - **Flood wait:** call `budget.flood(seconds)` and record the error. There is **no** automatic retry (section 3.5).
   - **`member` or `peek` with a `Channel`:** also run the existing `probe()` channel details by calling the exported `probeChannel` (see 3.4) on `inv.chat`. That function already does `GetFullChannel` and two `getMessages` (`src/probe.ts`, `channel()`).
5. Upsert the row, compute the warnings, record activity `invite previewed` (target: title; detail: verdict and `invite AbCd…`), and return the `ProbeResult`-compatible fields plus `invite: InviteView`.

**`confirm(id, said)`**

1. Record activity (actor `owner`): `owner says joined` or `owner says requested`. Set `said` and `saidAt`.
2. Set `checking = true` and return the view at once. The page refreshes on the activity row.
3. Asynchronously, with a 120 s timeout:
   1. `budget.take('owner')`. If refused, set `next_check_at = retryAt` and the note "Invite checks are rationed; this check runs by itself at HH:MM." That scheduled run **is** the one check.
   2. Make one `CheckChatInvite`.
4. Handle the result:

| Result | New state and action |
|---|---|
| `Already` | `postJoin(chat)`, then `joined` |
| `ChatInvite` or `Peek`, and `said` is `requested` or `requestNeeded` is set | `requested`, with the schedule from section 5.2 |
| `ChatInvite` or `Peek`, otherwise | Stay. Note: "Telegram does not show this account in «X» yet. If the app showed a check or a page, finish it there, then press «I've joined» again." |
| `INVITE_HASH_*` | `link-dead`. Note: "This link no longer works. If you did join, the group appears under Sources by itself within about 10 minutes (the account's chat list is checked automatically)." |
| `FLOOD_WAIT` | `budget.flood`; state unchanged; note with the time it resumes |
| `FROZEN_*` | Stop every scheduled check; the account card shows the freeze (AL-14 U) |

**`postJoin(chat)`**

The chat comes from `ChatInviteAlready`, or from a chat-list match confirmed by `ChatInviteAlready`. The steps, in this order, are all paced reads:

1. `GetChannels([peer])` → `classifySelf` (for a basic group, `GetChats`).
2. `GetParticipant(self)` → `viaRequest`, `joinedAt = date`. For a basic group, `joinedAt = now`.
3. `GetFullChannel` → `historyFrom = availableMinId`, when greater than 0.
4. **Make it a source.**
   - If `config.reportTo === null`: state `joined` with the note "Set PULSE_OWNER_IDS or PULSE_REPORT_TO in .env so digests have somewhere to go; then it is read automatically." This is the same rule as `/api/watch` and `reconcileOnce`.
   - Otherwise, build `info = toSourceInfo(chat)`. That function throws for a restriction with platform `all`; on a throw, state `joined`, note "Telegram restricts this chat for every client: not read" (RR-01 U).
   - If a `chats` row already exists (the chat-list check may have added it, switched off when auto-read is off): `updateChat(id, { enabled: true, readerError: null, readerPeer: info.peer })` and `setKv('reader_off_reason:'+id, '')`.
   - Otherwise: `store.watchChat(info, reportTo, null, defaults)`, then `updateChat(id, { readerOrigin: 'dialog' })`. Origin `dialog` makes the source membership-dependent, so the chat-list check's leave and rejoin logic applies to it.
   - An invite-confirmed chat is switched on even when auto-read is off. The owner asked for this one (Appendix A).
5. **Hidden history.** If `historyFrom > 0` and the chat's `readerCursor` is null, set `readerCursor = historyFrom` and `reader_cursor_date:<id> = now`. The first pull then starts right after the visible floor, and nothing is reported as a 24-hour catch-up. Readable ids are greater than `available_min_id` (M-03 C).
   - Write `memberships.history_from`.
   - Activity: `history hidden`: "this group hides messages from before your join: reading starts after message #N (joined HH:MM)".
6. Write `memberships` (`state`, `joined_at`, `via_request`, `invite_id`).
7. Set the state.
   - **`verifying`** if the self state is `verifying`.
   - **`watching` (provisional)** otherwise. The 15-minute window from `joinedAt` stays open for bot hints, because Shieldy does not mute pending candidates (CB-18 U).
   - While provisional, the console shows a soft line: "If a check appears in your Telegram app, answer it there."
8. Call `reader.pullNow(chatId)`. The first page passes through `onBatch`.
9. Activity: `membership`: "member since HH:MM · via request · history from #N".

**`classifySelf` sketch**

```ts
export function classifySelf(i: { chat?: Api.TypeChat; participant?: Api.TypeChannelParticipant; error?: string }, now: number): SelfState {
  const YEAR = 366 * 86_400;
  const c = i.chat;
  if (c instanceof Api.ChannelForbidden || c instanceof Api.ChatForbidden) {
    const until = c instanceof Api.ChannelForbidden ? c.untilDate ?? 0 : 0;
    return until > now && until - now <= YEAR
      ? { state: 'banned-until', until, detail: 'removed by the group until this time (a kick or a timed ban)' }
      : { state: 'banned', until: null, detail: 'banned from the group (or removed with no end date)' };
  }
  if (c instanceof Api.Channel) {
    if (c.left) return { state: 'removed', until: null, detail: 'not a member any more (left or removed)' };
    const own = c.bannedRights, dflt = c.defaultBannedRights;
    const personal = (k: 'sendMessages' | 'sendPlain' | 'sendMedia' | 'viewMessages') => Boolean(own?.[k]) && !dflt?.[k];
    const live = own && (own.untilDate === 0 || own.untilDate > now);
    if (live && personal('viewMessages')) return { state: 'banned', until: own!.untilDate || null, detail: 'banned' };
    if (live && (personal('sendMessages') || personal('sendPlain')))
      return { state: 'verifying', until: own!.untilDate || null, detail: 'cannot send messages yet (often until a check is passed)' };
    return { state: 'member', until: null, detail: live && personal('sendMedia') ? 'media restricted (reading works)' : '' };
  }
  if (c instanceof Api.Chat) return c.left || c.deactivated
    ? { state: 'removed', until: null, detail: c.deactivated ? 'upgraded to a supergroup' : 'not a member any more' }
    : { state: 'member', until: null, detail: '' };
  const p = i.participant;
  if (p instanceof Api.ChannelParticipantSelf) return { state: 'member', until: null, detail: '', viaRequest: Boolean(p.viaRequest), joinedAt: p.date };
  if (p instanceof Api.ChannelParticipantLeft) return { state: 'removed', until: null, detail: 'not a member any more' };
  if (p instanceof Api.ChannelParticipantBanned)
    return p.left || p.bannedRights.viewMessages
      ? { state: p.bannedRights.untilDate > now && p.bannedRights.untilDate - now <= YEAR ? 'banned-until' : 'banned', until: p.bannedRights.untilDate || null, detail: 'banned' }
      : { state: 'verifying', until: p.bannedRights.untilDate || null, detail: 'restricted in this group' };
  if (i.error && /USER_NOT_PARTICIPANT/.test(i.error)) return { state: 'removed', until: null, detail: 'not a member' };
  if (i.error && /CHANNEL_PRIVATE|CHAT_FORBIDDEN/.test(i.error)) return { state: 'removed', until: null, detail: 'removed (left, kicked or banned)' };
  return { state: 'unknown', until: null, detail: i.error ?? 'no answer' };
}
```

A media-only restriction is not "verifying" on its own. Shieldy's "restrict" limits media for 24 h after any join (CB-18 U), and Join Captcha Bot's image and video modes block media only (CB-22 U). A media-only restriction counts as verifying only together with a matched bot message.

#### 3.1.6 Challenge hints (read-only display)

`onBatch(chatId, batch)` is called by the reader for every page it fetches (3.4). It does nothing unless `chatId` has a membership in `joined`, `verifying` or `watching (provisional)` with `now - joinedAt ≤ 15 min`, or is in `verifying`.

For each message, `matchChallenge(m, self, joinedAt)` applies these rules:

1. **Candidate senders.** The sender must be a user with `bot: true`, or the message must have `viaBotId` set. A `viaBotId` message is shown with `suspicious: 'posted by a person through an inline bot, not by a group bot: not a real check'`.
2. **Time window.** Messages with `m.date < joinedAt - 60` are ignored.
3. **"Why" signals**, strongest first. Any one is enough. Each adds an entry to `why`.
   - Inline callback data contains the account id as a whole token. The pattern is `(^|[^0-9])<id>($|[^0-9])` on the ASCII decoding of `data`. This covers Shieldy's `'<chat>~<id>'` and Join Captcha Bot's `'button_captcha <id>'` / `'image_captcha <id>'`. Callback data is read **only** for this test: it is never displayed, stored or compared across buttons (CB-17 C, CB-21 U, CB-35 R).
   - A `MessageEntityMentionName` with `userId === self.id` (`api.d.ts:7279-7282`; CB-38 U, GJ-09 U).
   - `m.mentioned === true` (`tl/custom/message.js:63`; M-18 R).
   - The account's `@username` appears in the text (weak; CB-17 C notes that custom Shieldy templates may carry only names).
   - The message replies to the account's own join service message (CB-38 U says no sourced bot does this; harmless to include).
4. **Output.**
   - `text`: the plain message text, at most 500 chars.
   - `buttons`: labels only. A URL button becomes `link to <host> (not opened here)`, the host taken via `new URL(url).host` and never the full URL. Every button class, callback included, is shown as text. **There are no pressable controls.**
   - `media`: `'[photo]'` or `'[video]'`. Nothing is downloaded.
5. **Storage.** Hints live in a `Map<chatId, ChallengeHint[]>`, capped at 10 per chat, and are cleared when the chat leaves `verifying`.
   - They are never stored in SQLite and never reach MCP or the LLM.
   - `toStored` already drops bot senders from storage (`reader.ts` `toStored`, `if (s.bot) return null`).
6. **State change.** A hint for a chat in provisional `watching` moves it to `verifying`. The macOS notification fires once per chat.

Nothing is ranked or pre-selected. The banner lists every candidate with its sender (id, bot flag, @username) and its `why`.

#### 3.1.7 Chat-list and notice hooks

**`onReconciled({ added, left }, first)`**, called at the end of `reconcileOnce()` (3.4):

- **Linking added chats to pending invites.** Applies to every added chat, even on the first run. If an invite in `requested`, `owner-opened`, `previewed` (with `said`) or `link-dead` has a normalised title (NFKC, case-folded, whitespace collapsed) equal to the added chat's title, schedule that invite's check now on the background lane. Only `ChatInviteAlready.chat` with the **same chat id** links them; then `postJoin`. With no budget, it runs when the budget allows. A title match never links on its own.
- **Health for newly found chats.**
  - Skipped when `first` is true. The first reconcile after start lists the whole backlog of existing chats.
  - Otherwise covers at most 3 added chats per call: `GetParticipant(self)`. If `date` is within the last 30 min, run the `postJoin` membership steps (1-3 and 6-7; the reconcile already made it a source).
  - This brings the verification banner to groups the owner joins in the app without previewing them.
- **Precise classification for left chats.** Covers at most 3 `left` rows per call that were members (invite-linked, or `memberships` row present): one `GetChannels` each, then `classifySelf`. Store the precise state and `readerError`; keep `reader_off_reason` `left` so a rejoin re-enables reading.

**`onNotice({ chatId })`**

- When `chatId` matches a membership in `verifying`, `muted` or provisional `watching`, schedule a `GetChannels` for it after 5 s.
- Debounce: at most one per 60 s per chat, and at most 30 per day per chat.
- Unknown chat ids are ignored; the chat-list check handles them.
- Own-membership changes arrive as `updateChannel` bundled with the new Channel object (M-15 U, `apiTl.js:262`, `api.d.ts:3535-3536`). The bundled object can be `min`, so it is only a trigger and is confirmed by `GetChannels`.

**`onAccessLost(chatId, err)`**, called by the reader loop when a pull fails with `CHANNEL_PRIVATE` or `CHAT_FORBIDDEN`:

1. Debounce to at most once per 10 min per chat.
2. Make one `GetChannels([peer])`, or `GetChats` for a basic group.
3. Classify. If the result is `member`, the error was transient; do nothing else.
4. Otherwise:
   - `updateChat(id, { enabled: false, readerError: <precise text> })` and `setKv('reader_off_reason:'+id, 'left')`. That reason is the one `reconcileOnce` re-enables on a rejoin.
   - Write the `memberships` row and the activity row `removed`.
   - Notify, for invite-linked or member chats.
   - If the account was removed more than 24 h after `joinedAt` with no hint ever seen, add to the note: "looks like an inactivity clean-up or a CAS removal" (SP-01 U, CB-29 U).
5. **Public sources read from outside** (origin `manual`, `@username` ref) with `banned-until`:
   - Schedule one re-check at `until + 60 s`: re-enable reading with `reader_floor` set to `now - 86 400` (the existing key).
   - At most 3 times per chat. A ban also blocks reading from outside (M-33 C, CB-m05 M, **LT**).

#### 3.1.8 Tick loop

`start()` sets a 30 s `setInterval` (`unref`'d). Each tick:

1. Expires stale rows (7 days in `previewed` or `owner-opened`; 14 days in `requested` → `no-answer`).
2. Runs at most **one** due invite check: the background lane, respecting `backgroundGapMs`.
3. Runs at most **one** due membership check.

At start, `joined` and `verifying` rows get a membership check at +30 s. GramJS recovers no update gaps, so nothing that happened while the service was off arrives by push (M-17 U, GJ-11 C, `client/updates.js:65-67`).

### 3.2 `src/notify.ts` (new): macOS notification via `osascript`

```ts
export interface Notice { kind: 'approved' | 'verifying' | 'removed' | 'paused' | 'test'; group: string | null; body: string }
export function clean(s: string, maxCodePoints: number): string;          // pure
export function osascriptArgs(n: Notice, opts: { showTitles: boolean }): string[];   // pure
export interface Notifier { notify(n: Notice): void }
export class MacNotifier implements Notifier {
  constructor(opts: { enabled: boolean; showTitles: boolean; platform?: NodeJS.Platform;
                      exec?: typeof import('node:child_process').execFile; minGapMs?: number;
                      onSent?: (n: Notice) => void; onError?: (e: Error) => void });
}
export const NullNotifier: Notifier;
```

**Invocation**, with no shell:

```ts
execFile('/usr/bin/osascript',
  ['-e', 'on run argv',
   '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"',
   '-e', 'end run',
   '--', title, body],
  { timeout: 5000 }, cb)
```

**Why the `--` is mandatory.** This was checked on this Mac (Darwin 25.6) using `return` in place of `display notification`:
- `osascript … -- 'Title "quoted" \ back' Body` delivered both items literally, and the `--` was consumed (2 items).
- **Without** `--`, an item beginning `-e…` was parsed as an extra `-e` script statement. A group title can start with `-e`, so that is an AppleScript-injection path.
- With `--`, the same item arrived as data.

Group titles and bot text therefore reach `osascript` only as argv after `--`, never inside an `-e` script string.

**Content rules**
- `title` is ours and fixed per kind.
- `body` is `«<clean(group, 60)>»` plus our fixed sentence. With `PULSE_NOTIFY_TITLES=0`, it uses "a group" in place of the title, for lock-screen privacy.
- A notification never contains bot text, button labels, invite hashes, URLs or answers.
- `clean()`:
  - applies NFC;
  - replaces C0/C1 controls (newlines included) with a space;
  - removes zero-width and bidi controls (`U+200B–U+200F`, `U+202A–U+202E`, `U+2060–U+2069`, `U+FEFF`);
  - collapses whitespace;
  - caps by code points, ending with `…`.

| Kind | Title | Body |
|---|---|---|
| `approved` | Join approved | «X»: if a check appears in your Telegram app, answer it there now. |
| `verifying` | Verification waiting | «X»: answer it in your Telegram app. |
| `removed` | Removed from a group | «X»: reading stopped (banned until HH:MM). |
| `paused` | Invite checks paused | Telegram asked the account to slow down; checks resume at HH:MM. |
| `test` | Group Pulse test | Notifications work. Nothing was sent to Telegram. |

**Delivery rules**
- Notifications are sent only when `process.platform === 'darwin'` and `PULSE_NOTIFY` is not `off`.
- At least 15 s apart (queued, not dropped), and at most one per invite per state.
- Each one becomes an activity event: actor `notify`, method the kind, target the cleaned title, detail `macOS notification shown`.
- A spawn failure is logged once.
- The LaunchAgent from `scripts/autostart.ts` runs in the `gui/<uid>` domain, so notifications can show. The permission prompt is part of live test L3.

### 3.3 Store changes (`src/store.ts`)

Add these to `SCHEMA`; `CREATE … IF NOT EXISTS` needs no migration:

```sql
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT,                       -- full hash; needed for checks; never logged (activity shows 4 chars); nulled 30 days after a terminal state
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  origin TEXT NOT NULL,            -- console | mcp
  state TEXT NOT NULL,
  verdict TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'supergroup',
  members INTEGER,
  about TEXT NOT NULL DEFAULT '',
  flags TEXT NOT NULL DEFAULT '',  -- comma list: verified,scam,fake,paid,request
  peek_until INTEGER,
  chat_id INTEGER,                 -- -100… once known (Already, Peek)
  said TEXT,                       -- joined | requested
  said_at INTEGER,
  opened_at INTEGER,
  joined_at INTEGER,
  checks INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_result TEXT NOT NULL DEFAULT '',
  next_check_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS invites_active_hash ON invites (hash)
  WHERE hash IS NOT NULL AND state NOT IN ('dismissed', 'expired', 'no-answer', 'link-dead', 'refused');
CREATE INDEX IF NOT EXISTS invites_due ON invites (state, next_check_at);

CREATE TABLE IF NOT EXISTS memberships (
  chat_id INTEGER PRIMARY KEY,
  state TEXT NOT NULL,             -- member | verifying | muted | removed | banned | banned-until | unknown
  until_date INTEGER,
  detail TEXT NOT NULL DEFAULT '',
  via_request INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER,               -- ChannelParticipantSelf.date
  history_from INTEGER,            -- ChannelFull.available_min_id when > 0
  invite_id INTEGER,
  checked_at INTEGER NOT NULL,
  next_check_at INTEGER,
  checks_day TEXT NOT NULL DEFAULT '',   -- 'YYYY-MM-DD:n' notice-triggered counter
  recheck_count INTEGER NOT NULL DEFAULT 0
);
```

**Methods**
- `addInvite`, `getInvite`, `inviteByHash` (active rows only), `updateInvite(id, patch)` and `invites(states?)`.
- `dueInvites(now)` and `pruneInvites(now)`. Pruning nulls `hash` 30 days after a terminal state and deletes the row after 90 days.
- `setMembership(chatId, patch)`, `membership(chatId)`, `memberships(states?)` and `dueMemberships(now)`.
- Called from `main.ts`'s hourly `purge()`.

The membership state goes in its own table, not in new `chats` columns, because `ChatRow` is under concurrent edit. The **existing** `chats.enabled`, `chats.reader_error`, the kv `reader_off_reason:<id>`, `reader_floor:<id>` and `reader_cursor_date:<id>` carry the reading side, exactly as `reconcileOnce` and `/api/toggle` already use them.

### 3.4 Reader changes (`src/reader.ts`)

1. **`ReaderError.code`.** Use `constructor(message, retryAfter = 0, code = '')`, with `readonly code: string`. `explain()` passes the raw Telegram code (`errorMessage`). The loop needs the code because `pullLocked`'s `fail` turns errors into `ReaderError` before `start()` sees them.
2. **New hooks in `ReaderDeps`:**

   ```ts
   onBatch?: (chatId: number, batch: MtMessage[]) => void;               // every fetched history page, before toStored
   onAccessLost?: (chatId: number, err: ReaderError) => Promise<void>;   // pull failed with CHANNEL_PRIVATE / CHAT_FORBIDDEN
   discovery?: { …existing; onReconciled?: (r: { added: SourceInfo[]; left: ChatRow[] }, first: boolean) => void };
   ```

   - In `pullLocked`, right after each page is fetched (the `client.getMessages(entity, { limit: PAGE, minId: from, reverse: true })` line), call `try { this.deps.onBatch?.(chatId, batch) } catch {}`.
   - In the `start()` loop's `catch`, after `readerError` is written: `if (/^(CHANNEL_PRIVATE|CHAT_FORBIDDEN)$/.test(e.code)) await this.deps.onAccessLost?.(chat.chatId, e).catch(() => undefined)`.
   - At the end of `reconcileOnce()`: `d.onReconciled?.({ added, left }, this.reconcileCount++ === 0)`.
3. **`export function toSourceInfo(e: MtEntity): SourceInfo`**: the pure body of today's private `info()`, including its refusal of platform-`all` restrictions. `info()` then calls it and caches the entity.
4. **`parseRef` additions.** The current code turns `t.me/addlist/<slug>` into the username "addlist" and spends a `contacts.resolveUsername` on it (fact sheet 3.4 #3).
   - `t.me/addlist/<slug>` and `tg://addlist?slug=<slug>` become `{ kind: 'chatlist', slug }`.
   - `t.me/c/<id>/<msg>` and `tg://privatepost?channel=<id>` become `{ kind: 'id', value: -(1e12 + id) }` (members-only links: PG-20 C).
   - `resolve()` and `probe()` answer a chatlist ref with no API call: "This is a folder link. Open it in your Telegram app and add only the group you want; it then appears under Sources by itself." (PG-01..05 U).
5. **`MtMessage` gains optional fields** read by `matchChallenge`:
   - `mentioned?`;
   - `entities?: { className: string; userId?: unknown }[]`;
   - `replyMarkup?: { className: string; rows?: { buttons: { className: string; text?: string; data?: Uint8Array; url?: string }[] }[] }`;
   - `viaBotId?`.

   Production objects are GramJS `Api.Message` instances and already carry them (`apiTl.js:96`).
6. **`probe.ts`:** export `probeChannel` (today's `channel()`). Add `invite.paid` (from `subscriptionPricing`) to the `ChatInvite` branch, for the CLI path.

No change to pacing, cursors or the per-chat lock.

### 3.5 Request supervisor (`src/reader-client.ts`)

1. **Read-only gate.** `superviseRequests(…, opts: { …; readOnly?: boolean })`, default `true`. In `wrap`, before `turn()`:

   ```ts
   if (kind === 'write' && (opts.readOnly ?? true)) {
     activity.record({ actor: 'reader', kind: 'error', method: request.className, target,
       detail: 'blocked write: this build never joins, posts, presses, votes or marks anything read', ok: false, ms: 0 });
     throw Object.assign(new Error(`blocked write ${request.className}`), { errorMessage: 'WRITE_BLOCKED' });
   }
   ```

   - `classify()` treats unknown classes as writes (`activity.ts`).
   - Every class Phase 1 must never send is classified as a write:
     - `messages.ImportChatInvite`, `channels.JoinChannel`, `channels.LeaveChannel`, `messages.DeleteChatUser`, `chatlists.JoinChatlistInvite`;
     - `messages.GetBotCallbackAnswer` (in `READS_THAT_WRITE`), `messages.SendVote`, `messages.SendMessage`, `messages.StartBot`;
     - `messages.RequestWebView`, `messages.RequestSimpleWebView`, `messages.RequestAppWebView`, `messages.RequestMainWebView`, `messages.ProlongWebView`;
     - `messages.RequestUrlAuth`, `messages.AcceptUrlAuth`;
     - `messages.ReadHistory`, `channels.ReadHistory`, `messages.GetMessagesViews{increment}`, and any `payments.*`.
   - Schema lines: `apiTl.js:1620`, `:1861`, `:1862`, `:1601`, `:2049`, `:1639`, `:1678`, `:1590`, `:1624`, `:1742`, `:1744`, `:1766`, `:1794`, `:1743`, `:1688`, `:1689`.
   - No code path in `src/` sends a write today. `scripts/login.ts` is not wrapped and is unaffected.
2. **No automatic retry for invite checks.** Use `const NO_RETRY = new Set(['messages.CheckChatInvite'])`. The short-wait retry becomes `if (wait <= 60 && attempt === 0 && !NO_RETRY.has(request.className)) continue;`.
   - The account-wide hold still applies.
   - The tracker sees the error and freezes invite checks, because resolve-class floods escalate after short waits (AL-08 C, AL-12 C, AL-m05 M).
3. **`ReaderConnection.username: string | null`** comes from `getMe()`, for the hint matcher.
4. **Membership notices carry the chat.**
   - `onMembershipNotice(l: (n: { chatId: number | null }) => void)`.
   - `isMembershipNotice` gains a sibling, `membershipNoticeChat(update)`. It returns `-(1e12 + channelId)` for `UpdateChannel` (`api.d.ts:3536`) and for a service message's `PeerChannel`, `-chatId` for `UpdateChat`, and `null` otherwise.
   - This is additive to the concurrent work.

### 3.6 Activity (`src/activity.ts`)

- **Record the reads Phase 2 will need.** Add `const RECORDED_UPKEEP = new Set(['help.GetAppConfig', 'updates.GetDifference', 'updates.GetChannelDifference'])`, checked first, returning `'read'`.
  - Today the `SYSTEM` regex (`/^(help|updates|langpack)\./…`) makes them unpaced and unrecorded.
  - Phase 1 sends none of them. GramJS never calls `GetDifference` (GJ-11 C), and `updates.GetState` stays system.
  - This closes the critique's "blind activity log" item before Phase 2 needs it.
- **No other change.** `describeTarget` already prints `invite AbCd…` for a `hash` (`activity.ts`, `describeTarget`).

### 3.7 Console server (`src/console/server.ts`)

#### Token split (critique mustFix #2)

Today one token is generated, written to `data/console.json` and injected into the page (`server.ts` `private readonly token`, `writeFileSync(this.deps.handoffFile, …)`, `.replace('__CONSOLE_TOKEN__', …)`, and the POST check `req.headers['x-console-token'] !== this.token`).

- **`pageToken`** is injected into the page only, via the meta tag in `page.html:6`. It is accepted for every POST.
- **`toolToken`** is written to `data/console.json` only. It is accepted **only** for `TOOL_ALLOWED = {'/api/probe', '/api/watch', '/api/pull', '/api/audit', '/api/toggle', '/api/refresh'}`. That is exactly the set `src/mcp.ts` calls today: `check_group`, `watch_source`, `catch_up_now`, `audit_capture`, `set_monitoring` and `refresh_sources`.
- With the tool token, everything else answers 403. That covers the new invite routes, `/api/digest`, `/api/unwatch`, `/api/settings` and `/api/notify-test`.
- Compare tokens with `timingSafeEqual` on equal-length buffers.
- **Residual risk, stated honestly.** Any local process running as the user can `GET /` and read the page token. The split protects against the **model's tool surface** and prompt injection, not against local malware.

#### Routes

All new POSTs are page token only:

| Route | Body | Calls |
|---|---|---|
| `POST /api/probe` (changed) | `{ target }` | Invite refs go to `invites.preview(target, role === 'tool' ? 'mcp' : 'owner')`; everything else goes to `probe()` as today. |
| `POST /api/watch` (changed) | `{ target }` | An invite ref goes to `invites.watchMember(hash)`, which uses the stored chat of an Already result with no call. Otherwise it is unchanged. |
| `POST /api/invite/opened` | `{ id }` | `invites.opened(id)` |
| `POST /api/invite/confirm` | `{ id, said: 'joined' \| 'requested' }` | `invites.confirm(id, said)` |
| `POST /api/invite/recheck` | `{ id }` | `invites.recheck(id)` |
| `POST /api/invite/dismiss` | `{ id }` | `invites.dismiss(id)` |
| `POST /api/membership/check` | `{ chatId }` | `invites.checkMembership(chatId)` |
| `POST /api/notify-test` | `{}` | `notifier.notify({ kind: 'test', … })` |
| `GET /api/state` (changed) | — | Adds `invites: InviteView[]` (with `links`), `memberships: MembershipView[]` (with in-memory hints) and `inviteBudget`. |

`GET` stays host-guarded and token-free, like the existing `/api/messages`, which already serves group content to the page.

`MembershipView`:
```ts
{ chatId, title, state: SelfStateName, until, detail, joinedAt, historyFrom, viaRequest,
  hints: ChallengeHint[], priors: string | null, openLink: string | null }
```
- `openLink` is `tg://privatepost?channel=<bareId>&post=<msgId>`, using the newest matched hint id or the reader cursor. This is the private message-link form in core.telegram.org/api/links.
- `priors` holds the known-bot hint for the banner (section 3.8). It comes from a fixed table keyed by exact bot username, never from bot text.

The CSP needs no change in Phase 1, because no media is served.

### 3.8 Console page (`console.js`, `page.html`, `console.css`): UI and copy

Every string from Telegram is set with `textContent`, as the existing code does. The page carries no button that sends anything to Telegram other than the one invite check and the membership check.

#### 3.8.1 Invite card

`renderProbe` shows this when `r.invite` is present, replacing today's "Joining is a separate, confirmed step (coming next)".

- **Verdict pill:**

  | Verdict | Pill |
  |---|---|
  | member | Already a member |
  | join | Private: join in your Telegram app |
  | request | Private: admin approval needed |
  | peek | Readable without joining until HH:MM |
  | paid | Paid: Stars subscription |
  | refused | Marked SCAM (or FAKE) |
  | dead | Link no longer works |

- **Facts:** Title, Type, Members, About and Telegram flags, each as plain text.
- **Warnings** (3.1.3): a red, amber or grey row each. The evidence ids go in the row's `title` tooltip.
- **Links** (not for refused or dead):
  - `Open in Telegram` (`href = links.tg`);
  - `Open t.me link` (`href = links.tme`, `target=_blank rel="noopener noreferrer"`);
  - `Copy link` (`navigator.clipboard.writeText(links.tme)`; 127.0.0.1 is a secure context).

  Clicking either open link also posts `/api/invite/opened`.
- **Then:** `I've joined`, `I've sent a join request`, `Not now`.
- **Footer** (always): "You join in your Telegram app. This page never joins, never answers a check, and never presses anything in Telegram. When you say you're in, it looks once."
- **Budget line:** "Invite checks today: 6 of 20 (rationed: Telegram limits link lookups the way it limits username lookups)."
- **Member verdict:** `Read it` (posts `/api/watch` with the invite link).

#### 3.8.2 Results of "I've joined" (toasts and notes)

| Outcome | Message |
|---|---|
| Joined | "You're in «X». Reading it from now on." Adds "History before your join is hidden in this group: reading starts at your join." when `historyFrom` is set. |
| Requested | "Request tracked. Telegram never tells the requester about approval or a decline, so this page checks now, then after 1 hour, 6 hours, 1 day, and daily for 14 days. You'll get a notification when you're in." |
| Not yet a member | The note from 3.1.5. |
| Rationed | "Invite checks are rationed; this check runs by itself at HH:MM." |
| Paused | "Invite checks paused until HH:MM: Telegram asked the account to slow down. Reading continues." |

#### 3.8.3 "Private groups (invite links)" list

This sits under Sources. Each row shows:
- the title;
- a state pill;
- the age ("previewed 3 min ago", "request sent 2 h ago", "in since 14:22");
- the next check;
- actions as relevant: `Open in Telegram`, `I've joined`, `I've sent a request`, `Check now`, `Stop tracking`.

For `requested` rows: "Telegram has no way to withdraw a request. If the group's bot wants something first, it messages you in Telegram within a few minutes of the request."

#### 3.8.4 Verification banner

The banner is sticky at the top of `<main>`, with `role="alert"`, one block per membership in `verifying`.

- **Title:** "Verification in progress in «X»: answer it in your Telegram app."
- **Sub-line**, one of:
  - "Telegram shows this account as restricted there (it cannot send messages yet)."
  - "A bot addressed you there right after you joined."
- **Priors**, when the matched bot is known (exact username):

  | Bot | Prior |
  |---|---|
  | `shieldy_bot` | "usually about 60 s after joining (Shieldy's default; admins can change it)" (CB-16 U) |
  | `join_captcha_bot` | "5 minutes by default; 10 s to 10 min possible" (CB-20 C) |
  | `MissRose_bot` | "muted until solved; some groups remove you after 5 min to 1 day" (CB-24 C) |
  | `combot` | "page checks allow 12 hours" (CB-28 U) |

- **Hints:** "From @shieldy_bot (bot) · 14:22:05 · why: a button carries your account id", then the text, then "Buttons (labels only, answer in Telegram): I am not a bot". A `suspicious` line is shown in red.
- **Always:**
  - "This page cannot answer checks and cannot see all of them. Some appear only inside the Telegram app (pages inside Telegram, or messages only you can see)."
  - "Real checks never ask for codes, passwords, your phone number, a wallet, or anything to paste or run."
- **Actions:**
  - `Open the group in Telegram` (`openLink`);
  - `I've answered it — check now`, which posts `/api/membership/check` (one `GetChannels`).

#### 3.8.5 Removed (Sources status pill and title)

- "Removed from «X» at 14:23 (banned until 14:24; then you may rejoin). Reading stopped. Rejoining is your decision, in your Telegram app. Repeated failed joins can lead to a permanent ban."
- "Banned from «X». Reading stopped."
- "No longer a member of «X» (left or removed)."

#### 3.8.6 Other changes

- **`METHODS` labels:**
  - `channels.GetParticipant`: 'read own membership';
  - `invite previewed`, `opened invite link`, `owner says joined`, `owner says requested`;
  - `membership`, `history hidden`, `verification in progress`, `verification over`, `removed`;
  - `invite check deferred`, `invite checks paused`, `notified`;
  - `blocked write`: 'BLOCKED a write (this build is read-only)'.
- **Header:** a `Send test notification` button.

### 3.9 MCP (`src/mcp.ts`)

- **`check_group`** (existing; the description is extended).
  - For an invite link, the service returns the preview with `invite: { id, verdict, warnings[{level,text,evidence}], links{tme,tg}, console: 'http://127.0.0.1:4830/#invite-<id>', next }`.
  - `next` says: "Join in your Telegram app using links.tme or links.tg, then press «I've joined» in the console. Claude cannot join, confirm or answer checks."
  - The owner gave Claude the link, so echoing it is no leak.
  - These previews spend the `mcp` lane (≤ 5 per day).
- **`invite_status`** (new; `readOnlyHint: true`, `openWorldHint: false`). It reads the store directly, with no Telegram call:
  - active invites, plus terminal ones from the last 7 days, each with title, state, age, last and next check, and the 4-char hash tail;
  - memberships, with state, until, `historyFrom` and `viaRequest`;
  - the budget view.

  For `verifying` it prints only: "«X»: a check may be waiting (restricted since HH:MM). Answer it in your Telegram app. I can't see or answer it." It **never** prints bot text, button labels, hints or full hashes (critique mustFix #2(1)).
- **No tool exists** for opened, confirm, recheck, dismiss, membership check or notify-test. The tool token could not reach those routes anyway.

### 3.10 Wiring (`src/main.ts`) and config

- **Config** (`src/config.ts`):
  - `notify: boolean` (`PULSE_NOTIFY` on|off; default on);
  - `notifyTitles: boolean` (`PULSE_NOTIFY_TITLES` 1|0; default 1).

  Document both in `.env.example`.
- **`main.ts`**, after `connection` and `reader`:

  ```ts
  const notifier = config.notify && process.platform === 'darwin'
    ? new MacNotifier({ enabled: true, showTitles: config.notifyTitles,
        onSent: (n) => activity.event('notify', n.kind, n.group ?? '', 'macOS notification shown') })
    : NullNotifier;
  let invites: InviteTracker | null = null;
  // Reader deps gain: onBatch: (id, b) => invites?.onBatch(id, b),
  //                   onAccessLost: (id, e) => invites?.onAccessLost(id, e) ?? Promise.resolve(),
  //                   discovery.onReconciled: (r, first) => invites?.onReconciled(r, first)
  invites = new InviteTracker({ raw: connection.raw, reader, store, activity, config, notify: notifier,
    self: { id: connection.id, username: connection.username }, defaults, now });
  connection.onMembershipNotice((n) => { followed.reconcileSoon(); invites?.onNotice(n); });
  const stopInvites = invites.start();
  ```

- Pass `invites` and `notifier` to `ConsoleServer`.
- Add `store.pruneInvites(now())` to `purge()`.
- Call `stopInvites()` in `stop()`.
- Add `process.on('unhandledRejection', …)`: it logs and writes an activity error. GramJS event builders can throw from `_dispatchUpdate` (`client/updates.js:109-161`, GJ-14 U). Phase 1 uses only the existing raw handler with no chat filter (`events/Raw.js:16-42`), but the guard is cheap.

---

## 4. Challenge-handling table

**Phase 1** is what the console shows; the owner always acts in the official app. **Phase 2** is what may be relayed on a layer-229 stack, and only ever the human's exact choice.

| # | Mechanism | Phase 1 | Phase 2 | Evidence |
|---|---|---|---|---|
| 1 | Public @username group or channel (preview) | Existing probe: "Readable without joining". The invite flow does not apply; a join is never offered. | Never join a chat that can be read from outside. | CB-01 U, M-01 C, M-33 C, CB-m05 M |
| 2 | Private group known only by name | Probe: a name cannot locate a private group. Ask for an invite link, a folder link with only that group, or an admin add. | Same | PG-m06 M, PG-13 U |
| 3 | `chatInvitePeek` | "Readable without joining until HH:MM". A one-off preview, not a monitoring path. | Same | M-07 U, CB-m01 M, AL-29 R |
| 4 | `chatInviteAlready` | "Already a member", then switch on reading. | Same; `USER_ALREADY_PARTICIPANT` counts as success. | M-07 U, M-09 C |
| 5 | Join request (`request_needed`, `join_request`) | Request warnings; the owner requests in the app; `requested` tracking; approval notification. A decline cannot be observed. | Software never sends requests. Request-gated targets always go to the app. | M-10 C, CB-02 U, CB-03 C, M-32 U, GM-m11 M |
| 6 | Guard bot ("AI Guardian") Mini App in the join flow | Pre-join warning; done in the app; the service sees only the membership result. | Never relayed. Never call `requestChatJoinWebView` or `openJoinChatWebview`. The `query_id` is bound to the joining session. | CB-05 U, CB-06 C, CB-m06 M, M-11 U, GM-01 U, GM-04 U, GM-06 C, GM-14 U, GM-15 U |
| 7 | Join-request DM from a bot (Rose, Combot, Group Help approval mode) | Arrives in the owner's app. The service does not read private chats. | Owner's account: the app. Dedicated reader: callbacks only in a DM linked by `peerSettings.request_chat_title`, or from a bot of the target group (**LT** for bot DMs). | CB-04 C, M-32 U, GJ-m11 M, CB-25 C, CB-27 C, CB-30 U |
| 8 | Folder link (`t.me/addlist`) | Recognised; "open it in your Telegram app and add only that group". No call. | `chatlists.checkChatlistInvite` preview. On a dedicated reader only, `joinChatlistInvite` with just that peer (after **LT**). Never on the main account. | PG-01..05 U, PG-07 C, PG-08 C |
| 9 | Admin direct add | Guidance only. The chat-list check finds the join and post-join health runs. Shieldy and Join Captcha Bot skip admin adds. | Same | PG-10 U, PG-13 U, PG-14 C |
| 10 | Community (layer 229) | Invisible at layer 198. Join in the app; the chat-list check finds it. | Read `linked_community_id`; community joins are ordinary gated joins. | CM-12 U, CM-01..09 |
| 11 | Hidden pre-join history | Warned before joining. After joining: `available_min_id` becomes `history_from`, the cursor is seeded, and the first pull carries the caveat. | Same; a leave also warns that rejoining will not recover the messages missed in between. | M-02 U, M-03 C, M-06 C |
| 12 | Personal mute after joining (check pending) | `banned_rights` → `verifying` banner; re-check schedule; unmute → `watching`. | Relay allowed kinds; the outcome comes from rights, never from bot text. | M-14 U, CB-12 U, CB-22 U, CB-24 C |
| 13 | Group-wide limits: default rights, slow mode, join-to-send | Not a verification; ignored. Reading works. | Typed answers show slow mode; never retried. | M-05 U, CB-09 R, CB-11 R |
| 14 | Paid messages (`send_paid_messages_stars`) | n/a (nothing is posted) | Visible at layer 229: refuse typed answers. `ALLOW_PAYMENT_REQUIRED` → stop. | M-m13 M, CB-m07 M |
| 15 | Stars-subscription invite | STOP warning: "never pays". The owner may still choose to pay in the app. | Refuse; never pay. | CB-m07 M, M-09 C |
| 16 | Kick (rejoin allowed) | Pull error or chat-list check → `GetChannels` → `removed`; reading switched off; rejoining is the owner's call. | Same; never rejoin automatically; at most one more attempt, with a fresh confirmation. | SP-21 U, SP-22 U, SP-23 C |
| 17 | Ban, including timed bans | `banned` or `banned-until`. Public sources get one re-check after `until` (reading from outside is probably lost while banned, **LT**). | Same | M-33 C, CB-m05 M, SP-23 C, SP-m02 M |
| 18 | `restriction_reason` with platform `all` | `toSourceInfo` refuses to read the chat and shows the text. | Same | RR-01 U, RR-16 C |
| 19 | `channelForbidden`, `CHANNEL_PUBLIC_GROUP_NA` | Classified as removed or unavailable. | Same | RR-m05 M, RR-10 U |
| 20 | Telegram's aggressive anti-spam | n/a | Typed answers may be deleted; check whether our own message was deleted. | CB-10 R |
| 21 | Ephemeral and welcome messages | Invisible at layer 198. The banner says some checks appear only in the app. A restriction with nothing visible still shows the banner. | Raw listener armed before the join. Press the human's chosen button with `ephemeral.getCallbackAnswer` and the exact data. Persist on arrival. | M-12 C, CB-08 U, CB-m02 M, GJ-26 U, GJ-m05 M, WM-02 C, WM-m09 M, MC-04 R |
| 22 | Membership cap (500 / 1000) | The app enforces it. No `getAppConfig` in Phase 1. | Read the live cap with `help.getAppConfig` (now a recorded read) and refuse at the cap minus 50. | AL-01 U, AL-05 unverifiable |
| 23 | Flood waits | Invite-check budget; freeze on a flood; `CheckChatInvite` never retried; the account-wide hold already exists. | Same, plus deadlines and no retry on writes. | AL-03 U, AL-07 C, AL-08 C, AL-12 C, AL-m05 M |
| 24 | Spam limit (`PEER_FLOOD`) | n/a (no writes) | Stop all joins and answers. The owner checks @SpamBot. | AL-m06 M |
| 25 | Frozen account | `explain()` already maps `FROZEN_*`. The tracker stops every scheduled check. | Stop everything; show the `freeze_*` fields. | AL-14 U |
| 26 | Unofficial-client label | Warning says "not known"; checked from a second account. | Same | UF-01 C, UF-02 C, UF-07 REFUTED, UF-09 C |
| 27 | `AUTH_KEY_DUPLICATED` | Everything runs inside the service; the session lock exists (`acquireSessionLock`). | Hard cutover; one process. | M-28 U, AL-20 U |
| 28 | Shieldy: button, digits, image, simple | Warning (60 s default). After joining there is **no mute**, so the banner is triggered by a bot message whose button data ends in `~<id>`, or one that mentions the account. Outcome: still a member after the window, or `channelForbidden` for about 45 s. | Button: exact data. Typed: only text the human types; strict mode deletes extra text. | CB-16 U, CB-17 C, CB-18 U, CB-19 C, CB-m04 M |
| 29 | Join Captcha Bot: video, image, math (typed); button; quiz poll | Banner from callback data `button_captcha <id>` / `image_captcha <id>`, or name text. Image and video modes restrict media only. | Callback with exact data. Poll: `SendVote` with the exact option, one shot. Typed: exact text. Never retried: 10 failed joins (3 polls) → permanent ban. | CB-20 C, CB-21 U, CB-22 U, CB-m03 M |
| 30 | Rose: button, text, math, text2, join-request PM, anti-raid, federation | Mute → `verifying`. Text and math run in Rose's PM, in the app. Anti-raid → `banned-until`. | Callbacks. `StartBot` only as a separate step the human picks, for the same bot. text2 needs one pick per character. | CB-24 C, CB-25 C, CB-26 R, SP-m03 M, SP-m04 M |
| 31 | Combot: classic button, DM captcha, Mini App (12 h), required memberships, guard mode | Mini App → app, with a 12 h prior. | Classic callback only. Mini App: never. Each required membership is its own confirmed join, never chained. | CB-27 C, CB-28 U, GM-17 C, GM-m07 M, GM-m08 M |
| 32 | Group Help: button, reCAPTCHA page, presentation, approval Regulation/Math/Quiz | App | Callbacks. Presentation: typed by the human, with a public-post warning. reCAPTCHA page: never. | CB-30 U, CB-31 R, PF-08 C, PF-m07 M |
| 33 | Safeguard portal | App, with the scam warning; the bot must be exactly @safeguard. `/switch` is never sent. | Never relayed. | CB-32 U, CB-33 C |
| 34 | Collab.Land token gate | Wallet steps never; the owner's own decision after checking for exactly @collablandbot. | Hard stop. | CB-34 R, CB-m09 M, CB-33 C |
| 35 | CAS | Warning. A removal right after joining with no check → "likely a filter". No CAS lookup in Phase 1 (it sends the id to a third party). | Optional owner-approved lookup. | CB-29 U, PF-17..19 U |
| 36 | Inactivity purges | Removal detected later. "Looks like an inactivity clean-up" when removed more than 1 day after joining with no check. | Same; posting or reacting to stay is never automated. | SP-01 U, SP-04 C, SP-05 U, SP-24 U |
| 37 | Profile filters | Warning; removal classification. | Same | PF-08 C, PF-09 U, PF-24 C |
| 38 | MTProto bots scoring the unofficial flag (LyAdminBot) | n/a | Prefer button answers over typed ones. | UF-11 C, UF-12 U |
| 39 | Fake verification bots and portals | Permanent warning. Hints are plain text with host-only URLs. Inline-bot posts by people are flagged. | Hard-stop rules (section 8.7). | CB-33 C, M-25 U, BN-m10 M |
| 40 | URL, login_url, `?startapp`, `t.me/<bot>/<app>`, web_app, simple web view, `requires_password`, request phone/peer/geo, reply keyboard, switch inline | Labels only, never clickable; "do this in Telegram". | Only `inlineButtonTypeCallback` without `requiresPassword` is relayed. A reply-keyboard label goes only as visible public text, after a warning. Everything else: the app. | GJ-02 U, GJ-03 U, M-22 U, M-23 C, M-24 U, M-m11 M, CB-36 C, GJ-m09 M |
| 41 | Guardy-style two-hop deep link with the answer leaked in callback data | Shown; the data is never shown or used. | `StartBot` as a separate human step (same bot only), then callbacks. The data is never used to choose. | CB-35 R, CB-36 C |

---

## 5. Safety rules and rate budgets (Phase 1)

### 5.1 Rules enforced in code

| # | Rule | Where | Evidence |
|---|---|---|---|
| 1 | Every request classified as a write is refused before GramJS, and logged as `blocked write`. | `superviseRequests` (3.5) | GJ-02 U, M-23 C (click helpers write silently); AL-26 R (views); GJ-28 U (ToS 1.4: no actions without consent, no ghost mode) |
| 2 | No call other than `CheckChatInvite`, `GetChannels`, `GetParticipant`, `GetFullChannel` and `GetChats` is added. No web-view, URL-auth or media download. | `invites.ts` | M-24 U, M-25 U, GM-06 C (a web-view URL is a bearer credential) |
| 3 | The model can preview and read status only. It cannot confirm, dismiss, re-check or answer. | Token split (3.7); MCP (3.9) | critique mustFix #2 |
| 4 | Bot text never reaches SQLite, MCP or the LLM. Hints are in memory, at most 10 per chat, cleared on exit from `verifying`. | `invites.ts`; existing `toStored` bot drop | critique shouldFix (challenge messages out of digests) |
| 5 | Callback data is read only to test whether a message addresses this account. It is never displayed, stored, compared or used to choose. Nothing is ranked or pre-selected. | `matchChallenge` | CB-35 R, critique mustFix (targeting) |
| 6 | URLs from bot messages are shown as the host only, as plain text. Nothing from a bot is a link. | console | CB-33 C, M-25 U, M-m11 M |
| 7 | Notifications hold only our fixed text plus a cleaned group title (optional), passed to `osascript` as argv after `--`. | `notify.ts` | Tested on this Mac (3.2); critique mustFix #6 |
| 8 | No private chat (DM) is read. Only channel and basic-group updates and pulls are used. | `onNotice`, `onBatch` | critique shouldFix (DM privacy on the main account) |
| 9 | Everything runs inside the service that holds the session lock. No CLI is added. | existing `acquireSessionLock` | M-28 U, AL-20 U, M-m01 M |
| 10 | Every Telegram call, owner gesture, state change and notification appears in the activity log. | `superviseRequests`, `activity.event` | lead requirement (f) |
| 11 | No automatic re-join, leave, request or retry of an invite check. | `invites.ts`, `NO_RETRY` | CB-20 C, PF-m07 M, AL-08 C |
| 12 | A public group that can be read from outside is never offered a join. | probe and card | CB-01 U, M-33 C |

### 5.2 Rate budgets and schedules

Telegram publishes no limits, and says they change (AL-03 U, M-20 U). These are policy choices, set well inside the only figures the research found.

| Item | Value | Justification |
|---|---|---|
| `checkChatInvite`, all lanes | at most 20 per rolling 24 h | **About a tenth of the best resolve figure.** That figure is ~200 `resolveUsername` per day (AL-07 C, two sources five years apart). GramJS's own docs say "similar limits apply to invite links" (`client/TelegramClient.d.ts:933-936`; AL-29 R), so invite checks and resolves may draw on one budget. The reader still needs resolves for new public sources, and this is the owner's main account. |
| … background lane (schedule, chat-list matches) | at most 12 per 24 h | Keeps 8 for the owner's own previews and confirmations. |
| … MCP lane | at most 5 per 24 h | Bounds what a prompt-injected model can spend. |
| Spacing | ≥ 30 s between any two; ≥ 120 s for background | The GramJS docs report flood waits "around 50 usernames in a short period" (`TelegramClient.d.ts:933-936`). Short waits come before long ones (AL-12 C, AL-m05 M). |
| Same-hash cache | 10 min | Repeat previews cost nothing. |
| Flood on `checkChatInvite` | No retry. Invite checks freeze for max(2 × wait, 6 h); a second flood within 24 h freezes them for 24 h. | Resolve-class waits of 2,787–77,849 s, often after short ones (AL-08 C). Escalation may be account-wide (AL-m05 M, inference), and a long wait would also stall reading. |
| Pending request schedule | **+0** (on the owner's confirmation), **+1 h, +6 h, +24 h**, then **every 24 h** until day 14 → `no-answer` (at most 17 checks) | The requester gets no approval update. Only membership reveals approval, and tdesktop itself checks once rather than polling (M-10 C). Combot's Mini App decides within 12 h (CB-28 U), so +6 h and +24 h bracket it. The fast path costs no invite checks: a membership notice triggers the chat-list check within about 1 min, and a title match triggers one targeted check. |
| Tracked pending requests | at most 5 | 5 × 1/day after day 1 fits the background lane. |
| `owner-opened` without confirmation | No checks; expires after 7 days. | The lead's rule: one check on the owner's word. |
| Post-join health | `GetChannels`, `GetParticipant(self)`, `GetFullChannel`, once each | M-14 U, M-10 C, M-03 C |
| Verifying re-checks (`GetChannels`) | **+1, +3, +10, +30 min, +1, +3, +8, +24 h**, then every 24 h while muted, up to 7 days | Check windows run from 10 s to 10 min (CB-20 C); Shieldy is 60 s (CB-16 U); Rose removes after 5 min to 1 day, or mutes until solved (CB-24 C); Combot allows 12 h (CB-28 U). About 10 cheap reads in 24 h, against about 720 `getHistory` per chat per day at the 120 s poll (RC-29 C). |
| Notice-triggered membership check | debounce 60 s per chat; at most 30 per day per chat | M-15 U |
| Window for bot hints when there is no mute | 15 min after `joinedAt` | Covers Shieldy's default (60 s) and Join Captcha Bot's (5 min) (CB-16 U, CB-20 C). |
| Removal classification | 1 `GetChannels` per pull-error event; at most once per 10 min per chat | SP-23 C |
| Public source `banned-until` | 1 re-check at `until + 60 s`; at most 3 per chat | SP-23 C, M-33 C |
| New chats from the chat-list check | Skipped on the first reconcile after start; at most 3 per later reconcile, each 1 `GetParticipant(self)` | Keeps the startup backlog free. |
| Notifications | ≥ 15 s apart; at most 1 per invite per state | — |
| Retention | hash nulled 30 days after a terminal state; rows purged after 90 days | — |

All these calls also pass through the existing account-wide pacer: about 1 request per 1.1 s, a burst of 5, and an account-wide hold on any `FLOOD_WAIT` (`superviseRequests`).

### 5.3 Never done in Phase 1

- Join, request, leave or rejoin.
- Answer, press, vote, post or `/start` a bot.
- Open, fetch or relay a web view, URL-auth or bot link.
- Mark read or react.
- Download challenge media.
- Pay.
- Change any account, privacy or profile setting.
- DM anyone.
- Read private chats.
- Send bot text to MCP or the LLM.
- Retry an invite check automatically.
- Join or offer to join a public group that can be read from outside.

---

## 6. Unit tests (node:test, no network)

**Fakes**, in the style of `test/supervise.test.ts` and `test/reader.test.ts`:

- `FakeGram`:
  - `invoke(req)` is scripted by `req.className` and returns a value or throws `{ errorMessage, seconds }`;
  - it records every request;
  - it is wrapped by the **real** `superviseRequests`, so the gate and pacing are tested on the production path.
- **Real GramJS `Api` objects** are constructed offline (`new Api.ChatInvite({…})`, `new Api.Channel({…})`, `new Api.ChannelForbidden({…})`, `new Api.ChannelParticipantSelf({…})`, `new Api.ChatBannedRights({…})`, `new Api.Message({…})` with `ReplyInlineMarkup` and `KeyboardButtonCallback`, `MessageEntityMentionName`). `instanceof` then behaves as in production.
- `FakeReader` records `pullNow`. `memoryStore` and `Clock` come from `test/helpers.ts`. `FakeNotifier` records notices. A fake `execFile` captures argv.

**`test/invite-classify.test.ts`**
1. **`classifyInvite`:**
   - Already with a Channel → `member`, with the chat id and peer;
   - Already with a basic Chat → `member` with a `chat` peer;
   - Peek → `peek` with `expires`;
   - `ChatInvite` with `requestNeeded` → `request`;
   - scam → `refused`; fake → `refused`;
   - `subscriptionPricing` → `paid`;
   - plain → `join`;
   - broadcast, megagroup and basic kinds.
2. **`warningsFor`:**
   - `guard-miniapp` and `request` appear only for `request`;
   - `paid` is a stop;
   - `refused` has no links;
   - `peek` shows its time;
   - every warning has evidence ids;
   - `brand` appears only for Binance-like titles.
3. **`deepLinks`:**
   - exact `https://t.me/+HASH` and `tg://join?invite=HASH`;
   - a hash with `/`, `?`, `"` or a space is rejected;
   - `parseRef` accepts `t.me/+`, `t.me/joinchat/` and `tg://join?invite=`.
4. **`parseRef`:**
   - `t.me/addlist/abc` → chatlist, and **no** `contacts.ResolveUsername` is sent from `probe`;
   - `t.me/c/123/45` → id `-1000000000123`.

**`test/invite-budget.test.ts`**

5. Limits: 20 per 24 h; background 12; MCP 5; 30 s and 120 s spacing; the 10-min cache sends no request.
6. Flood: a flood of 600 s freezes for 6 h, one of 30,000 s freezes for 60,000 s, and a second flood within 24 h freezes for 24 h. `CheckChatInvite` with `FLOOD_WAIT_5` is **not** retried by `superviseRequests` (one request in the log). `GetHistory` with `FLOOD_WAIT_5` still retries once (regression).

**`test/invite-tracker.test.ts`**

7. **Happy path:**
   - preview → `previewed` (1 `CheckChatInvite`);
   - `opened` → `owner-opened` (no request);
   - `confirm('joined')` with Already → the request log is exactly `CheckChatInvite, GetChannels, GetParticipant, GetFullChannel`, then the first pull's `GetHistory`;
   - `watchChat` was called with the saved peer and origin `dialog`;
   - `availableMinId 900` → `readerCursor 900`, with `history_from` set and the `history hidden` activity row;
   - the state is provisional `watching`.
8. **Already a source.** A source added by the chat-list check, switched off by auto-read off, is switched **on** by the confirmation (`reader_off_reason` cleared).
9. **Request:**
   - `confirm('requested')` with `ChatInvite(requestNeeded)` → `requested`, with `next_check_at` at +1 h;
   - advancing the clock runs one check at a time at +1 h, +6 h and +24 h;
   - Already at +6 h → `joined`, with exactly one `approved` notification;
   - 14 days of `ChatInvite` → `no-answer` after 17 checks, and none after that.
10. **No budget.** With the budget exhausted, the confirmation is scheduled at `retryAt` and nothing is sent before then.
11. **Dead link.** `INVITE_HASH_EXPIRED` after "I've joined" → `link-dead`. A later `onReconciled({ added: [chat with the same title] }, false)` runs one check and links only if Already names the same chat id; a different id does not link.
12. **Restart.** A new tracker on the same store re-arms `requested` schedules and schedules a `GetChannels` at +30 s for `verifying` rows.
13. **First reconcile.** `onReconciled(…, first = true)` with 300 added chats sends **zero** requests (backlog skip).

**`test/invite-self.test.ts`** (`classifySelf`)

14. Shapes:
    - Channel with `left: false` and no rights → `member`;
    - personal `sendMessages` with `untilDate` 0 → `verifying`;
    - `sendMessages` also present in `defaultBannedRights` → `member` (group-wide);
    - media only → `member` with the detail "media restricted";
    - `untilDate` in the past → `member`;
    - `left: true` → `removed`;
    - `ChannelForbidden` with `untilDate` now+45 → `banned-until`;
    - no `untilDate` → `banned`; now+400 days → `banned`;
    - `ChannelParticipantSelf{viaRequest, date}` carries both;
    - `ChannelParticipantBanned{left: true}` → `banned`;
    - `USER_NOT_PARTICIPANT` → `removed`;
    - basic `Chat{left}` → `removed`; `Chat{deactivated}` → `removed` ("upgraded").

**`test/invite-hints.test.ts`** (`matchChallenge`)

15. **Matches:**
    - Shieldy data `-1001234~<self>` → match, why "a button carries your account id";
    - `~<other>` → no match;
    - `button_captcha <self>` → match;
    - the id embedded in a longer number → no match;
    - `MessageEntityMentionName(self)` → match;
    - `mentioned: true` → match;
    - `@username` text → match (weak);
    - a non-bot sender → no match;
    - `viaBotId` from a person → match, with `suspicious` set;
    - a message older than `joinedAt - 60` → ignored.
16. **Data hygiene.** `JSON.stringify(hint)` contains no callback bytes, no full URLs (only hosts) and no `data` fields. Hints for a chat are cleared when it leaves `verifying`.
17. **Shieldy without a mute.** A provisional-`watching` chat with a matched hint at +2 min → `verifying` and one `verifying` notification. Without a hint, at +15 min it stays `watching`.

**`test/invite-removal.test.ts`**

18. A pull of a member chat fails with `CHANNEL_PRIVATE`:
    - `onAccessLost` sends exactly one `GetChannels`;
    - `ChannelForbidden(untilDate)` → `banned-until`, the chat switched off with `reader_off_reason: 'left'` and a precise `readerError`;
    - the next loop round sends **no** `GetHistory` for it;
    - one `removed` notification.
19. **Public source.** `banned-until` schedules one re-enable at `until + 60 s`, at most 3 times.
20. **Rejoin path.** After `removed`, `reconcileOnce` finding the chat again re-enables it (the existing `left` reason logic keeps working).

**`test/supervise.test.ts`** (extend)

21. Each write class in 3.5 is refused before the fake invoke sees it, with an `ERROR` activity row `blocked write`. Reads (`CheckChatInvite`, `GetChannels`, `GetParticipant`, `GetFullChannel`, `GetChats`, `GetHistory`) pass.

**`test/console.test.ts`** (extend)

22. **Tokens:**
    - the page HTML holds the page token and not the tool token; `console.json` holds the tool token and not the page token;
    - `/api/invite/confirm`, `/api/invite/recheck`, `/api/membership/check`, `/api/digest` and `/api/settings` answer 403 with the tool token and 200 with the page token;
    - `/api/probe`, `/api/watch`, `/api/pull`, `/api/audit`, `/api/toggle` and `/api/refresh` accept the tool token.
23. `GET /api/state` includes `invites` and `memberships`. The test skips when local listen is refused, as today.

**`test/notify.test.ts`**

24. **argv:**
    - `osascriptArgs` puts `--` before the title and body;
    - a title of `-edo shell script "x"` appears only after `--`, never inside an `-e` item;
    - quotes, backslashes, newlines, `U+202E` and zero-width characters are cleaned;
    - the title is capped at 60 code points.
25. **Delivery:**
    - with `PULSE_NOTIFY_TITLES=0` the body says "a group";
    - on `platform !== 'darwin'` nothing is spawned;
    - notices are spaced at least 15 s apart;
    - no body ever contains an invite hash or `http`.

**`test/activity.test.ts`** (or `console.test.ts`)

26. `classify('help.GetAppConfig')` and `classify('updates.GetChannelDifference')` → `read`; `updates.GetState` → `system`.

**`test/mcp-format.test.ts`**

27. Export the pure `formatInviteStatus(rows, memberships, budget)` from `invites.ts` (MCP calls it). Even when the input carries in-memory hints, the output contains no hint text, no labels and no hash beyond 4 chars, and says "answer it in your Telegram app".

Run with `npm test` and `npm run typecheck`.

---

## 7. Live test plan (Phase 1)

Test groups are created and administered by a **second, existing account**: the owner's own or a trusted teammate's. Nothing creates an account. The main account must not be an admin of the test groups, because bots skip admins. Never test failure paths, poll mode, or repeated joins in real groups.

| # | Test | Risk to the main account | Owner does | Pass criteria |
|---|---|---|---|---|
| L0 | `npm test`, `npm run typecheck` | none | nothing | Green. |
| L1 | Start the service and run 1 h | none | nothing | Activity shows 0 `WRITE` and 0 `blocked write` rows. Any blocked write is a bug. |
| L2 | Read-only previews (fact sheet T7): a link the account is already in; an open link to a test group; a request-needed link; an expiring link | low (reads only; whether admins can see checks is an inference, **LT**) | Supply the links. The second account checks link usage and the admin log. | Correct verdicts. Log whether `ChatInviteAlready.chat` carries a non-min `access_hash` (**LT**). No trace on the admin side. Budget counts move. |
| L3 | Notifications | none | Press `Send test notification`; allow notifications for Script Editor if macOS asks; check Focus mode and the lock screen; set `PULSE_NOTIFY_TITLES`. | Shown within about 1 s; a title with `-e` and quotes shows literally. |
| L4 | Plain join, hidden history on (test group with no bots) | very low: one visible join in a friendly group | Open the deep link, join in the app, press `I've joined`. | One `CheckChatInvite` then 3 reads; source on with peer saved; `history_from` and caveat shown. After a service restart: no `ResolveUsername`, no extra `GetDialogs` beyond the chat-list check. |
| L5 | Join request: "Approve new members" on the test link | low | Request in the app, then press `I've sent a request`. The second account approves after about 10 min. Second run: the second account declines. | Approval is detected through notice → chat-list check → title match → one check, measured against the schedule. Exactly one `Join approved` notification. Decline: nothing observable; the row keeps its schedule. |
| L6 | Verification with a captcha bot (the second account adds Rose in button mode, or Shieldy in button mode at 99 s) | low (confined to the test group) | Join in the app and answer in the app. Once, wait for the banner first, then answer. | Rose: `verifying` from `banned_rights`. Shieldy: from the hint (button data with own id) with no mute. Unmute or window end → `watching`. Hints show labels only. Record whether `message.mentioned` is set (M-18 R, **LT**). |
| L7 | Removal classification (fact sheet T11) | low to medium (a kick and a timed ban recorded against the main account in a friendly group; no Rose federation, no CAS) | The second account removes the main account, then bans it for 1 h, then unbans. | Log the exact `getChannels` and `getParticipant(self)` shapes for a **private** group (**LT**: `left` versus `channelForbidden`). Reading stops; there is no repeated `GetHistory`; there is no automatic rejoin. |
| L8 | Unofficial-client label (fact sheet T3) | none | The second account opens the main account's profile after L4–L7. | Decides how strongly the `unofficial-flag` warning is worded. |
| L9 | First real private group | medium (a visible join on the main account) | One group, with the owner at the Mac and phone in hand. | As L4–L6. Afterwards the reader only reads; removals are watched for 60 days. |

---

## 8. Phase 2 spec (deferred: do not build now)

### 8.1 Goal and gates

**Goal.** Software-initiated joins of **open** (not request-gated) invite links. A human answers every challenge; the service relays only that human's exact choice, within that challenge.

**Gates before any Phase 2 code ships:**
1. Fact sheet T0: the supply chain passes. `npm audit signatures`; provenance; `gitHead` equals the attested commit; install with `--ignore-scripts`.
2. T9: the cold cutover works. `getMe` returns the same user id. `account.getAuthorizations` shows no new device entry; this is an inference until tested (MC-13 R).
3. Phase 1 live tests L0–L8 have passed.
4. The owner has decided on the AI terms (M-29 U, AL-22 C).

The MC facts had **no** skeptic pass. The mtcute behaviours this section relies on were checked directly in the 0.32.4 tarball and are cited.

### 8.2 Stack

- **Packages.** Pin `@mtcute/node` and `@mtcute/core` at exactly 0.32.4. The schema is `LAYER = 229` (`mtcute:core/tl/index.d.ts:3`). Lockfile integrity; `--ignore-scripts`. Use a vendored `node:sqlite` storage driver, so `better-sqlite3`'s native install script is never needed (MC-10/11 R, **LT** T0).
- **Session.** One adapter behind the existing `MtClient` interface (MC-16 R). Convert the GramJS session once with `convertFromGramjsSession` (`mtcute:convert/gramjs/convert.js:5-10`). This is a **hard cutover**: stop every GramJS process first (MC-14 R, M-28 U).
- **Login.** **Never call `start()`.** It calls `logOut` on `SESSION_REVOKED`, `USER_DEACTIVATED` and `USER_DEACTIVATED_BAN`, then enters a login flow (`mtcute:core/highlevel/methods/auth/start.js:30-33`). Use `importSession` plus `getMe`, and stop on any auth error.
- **Middlewares.** Replace the default `basic()` middlewares (`mtcute:core/network/middlewares/default.js:4-9`) with:
  1. **A supervisor middleware.** It ports `superviseRequests`: pacing, recording, the account-wide hold, and the write gate of 8.3. Middlewares see every outgoing request (`network-manager.d.ts:79-84`, `:188-193`).
  2. **`floodWaiter({ maxWait: 0, maxRetries: 0 })`.** The default sleeps and retries waits of 10 s or less, up to 5 times (`flood-waiter.js:13-19`, `:42-73`). It also treats `SLOWMODE_WAIT_` as sleep-and-retry (`:49`), which would re-post a typed answer.
  3. **`internalErrorsHandler({ maxRetries: 2 })`** for reads only. The default is **infinite** retries on server errors (`internal-errors.js:20`, `:25-49`).
- **Per-call options on every write:** `{ floodSleepThreshold: 0, maxRetryCount: 0, throw503: true, timeout: <deadline>, abortSignal }` (`network-manager.d.ts:104-162`).
- **Fallback.** If T9 fails, use tdl/TDLib with a fresh QR login. It needs `databaseEncryptionKey`, and on macOS TDLib applies "ios" restrictions (RR-03 C). teleproto is not used: it has no provenance, and it has a `reCaptchaCallback` that must never be set (ST-01 C, ST-m04/m05).
- **Layer-229 buttons are restructured.** They are `keyboardInlineButton{text, type: InlineButtonType}` (`mtcute:core/tl/index.d.ts:30172-30177`, union at `:32759`, GJ-m09 M). The relay allowlist is re-derived: only `inlineButtonTypeCallback{requiresPassword?, data}` (`:30140-30144`) without `requiresPassword`.

### 8.3 A separate capability for join and answer actions (mustFix #2)

- **Never through MCP.** No MCP tool joins, answers, leaves, confirms or resumes. MCP may report only that a challenge is waiting, in which chat, and its deadline. It never returns the image, question text or options.
- **Human nonce.** Human actions need a **single-use nonce** that the page obtains only after a click:
  1. `POST /api/human/arm` (page token) with `{ action, chatId, msgId, choice }`. The server computes `binding = sha256(action | chatId | msgId | exact data bytes or exact text)` and returns a 128-bit nonce with a **15 s** TTL.
  2. The page shows an inline confirmation ("Press «X» as @you?").
  3. `POST /api/human/do` with `{ nonce, … }` (page token). The server recomputes the binding from the **refetched** message (8.6), consumes the nonce and sends the request.
- **Joins.** A join needs the nonce flow, plus the presence tick "I'm at this console now and will answer within the window", plus a live SSE connection.
- **Write gate.** The supervisor refuses any write that does not carry a grant minted by `/api/human/do` for exactly that request object (method, peer, binding).
- **Residual risk.** A local process running as the user can still scrape the page token and drive both steps. The protection targets the LLM tool surface and prompt injection, not malware. `CLAUDE.md` should forbid agents from calling `/api/human/*`.

### 8.4 Join flow (open links only)

**Preconditions**, all checked at click time:
- No other join or armed challenge (an account-wide **join mutex**). A pending approval does not hold it.
- A fresh `checkChatInvite` returns the same title and member count, and `request_needed` is still false. A request-gated target always takes the Phase 1 app path. Guard bots exist only on request-gated chats (GM-m01 M, M-m02 M), and a software join into a guard chat cannot be finished in the app (GM-04 U).
- Not `subscription_pricing`; not scam or fake.
- Not readable from outside (CB-01 U, M-33 C).
- Membership is below `channels_limit_default` (`help.getAppConfig`, now a recorded read, 3.6) minus 50 (AL-01 U).
- Budget: at least 30 min between joins, at most 3 per rolling 24 h and 10 per 7 days, and 1 per day in the first week.
- No freeze, spam limit or flood ledger block.

**Arm the listener before the call** (mustFix #4):
- A raw update handler buffers `updateNewChannelMessage`, `updateEditChannelMessage`, `updateDeleteChannelMessages`, `updateNewEphemeralMessage` (`mtcute:core/tl/index.d.ts:10889`) and `updateChannel` from unknown channels for 60 s.
- Bot DMs are buffered **only** for bot ids that turn out to be in the target group, or that are linked by `peerSettings.request_chat_title`. Other private chats are never stored, logged or passed on (critique shouldFix).

**The call:**
```ts
tg.call({ _: 'messages.importChatInvite', hash },
        { floodSleepThreshold: 0, maxRetryCount: 0, timeout: 20_000, abortSignal })
```
Use the raw call, **not** `joinChat()`. `joinChat` maps only `INVITE_REQUEST_SENT`; `JOIN_GUARD_TIMEOUT` and `INVITE_REQUEST_DECLINED` are thrown as errors (`mtcute:core/highlevel/methods/chats/join-chat.js:26-31`).

**Results:**

| Result | Handling |
|---|---|
| `messages.chatInviteJoinResultOk` | Pass `res.updates` to `tg.handleClientUpdate` **and** scan it yourself for `chats[]` (id, access hash) and the join service message. This is the pattern `joinChat` uses at `join-chat.js:34-37`. Then bind the buffer to that channel id. |
| `chatInviteJoinResultWebView` (`index.d.ts:36875`) | **Do not open it.** Never call `requestChatJoinWebView` or `openJoinChatWebview` (`index.d.ts:45464`). Record "pending: this group screens joins with a page; check in your Telegram app". The precondition should have prevented this case. |

**Error mapping.** Each error maps to an owner-facing outcome. **Nothing is retried automatically.** After any error or timeout, check membership first: `checkChatInvite` → `chatInviteAlready`, or `getParticipant(self)`.

| Error | Outcome |
|---|---|
| `USER_ALREADY_PARTICIPANT` | success |
| `INVITE_REQUEST_SENT`, `JOIN_GUARD_TIMEOUT` | pending |
| `INVITE_REQUEST_DECLINED` | declined (terminal) |
| `INVITE_HASH_*` | dead link |
| `STARS_PAYMENT_REQUIRED` | stop; never pay |
| `CHANNELS_TOO_MUCH` | Stop all joins until the owner re-enables them. Below the cap, this is labelled a possible anti-spam signal (AL-05 unverifiable). |
| `FLOOD_WAIT_X` | Joins frozen for max(24 h, 2X) |
| `FROZEN_*` | stop everything (AL-14 U) |
| `USER_BANNED_IN_CHANNEL` | possibly an account-wide send ban (M-09 C) |

After a 406 error, capture the `updateServiceNotification` text (M-09 C).

**The challenge window.** It is open for 10 min, extended to the known bot window (up to 12 h for Combot, with slow checks). During it:
- the poll loop is paused, with challenge requests in a **priority lane** ahead of background pulls;
- the watchdog reconnect is suspended; if a reconnect happens anyway, the challenged chat's history is refetched immediately (mustFix #7);
- the chat's history is fetched at once and then every 3–5 s for the first 3 min.

### 8.5 Deadlines and no retry (mustFix #3)

- Every join, answer or leave request carries a hard deadline: the challenge's known or parsed deadline minus 3 s, or 20 s for a join.
- If the supervisor's account-wide hold, or the queue, would delay the send past the deadline, the request is **dropped** and the human is told. It is never sent late.
- Writes are never retried. That includes GramJS-style internal retries: `maxRetryCount: 0` covers both mtcute middlewares.
- `BOT_RESPONSE_TIMEOUT` or -503 means "outcome unknown": re-check state, never resend (M-22 U, GJ-04 U).

### 8.6 Relay rules (mustFix #2(click helpers), #6, #9, #10, #11)

**Never use helpers.**
- GramJS `Message.click` and `MessageButton.click` are never used. A reply-keyboard click sends the label as a message (`tl/custom/messageButton.js:71-76`). A `password` triggers `account.GetPassword` and SRP (`:79-82`). SwitchInline becomes `StartBot` (`:99-105`). Poll indexes vote for the first N options (`tl/custom/message.js:540-545`). Labels match the first button with that text (`:601-604`). The default index is 0 (`:617-618`).
- mtcute's `getCallbackAnswer` and `getEphemeralCallbackAnswer` are not used either. The first computes SRP when a password is passed (`get-callback-answer.js:8-11`). Both call with only `{ timeout, throw503 }` (`:21`; `get-ephemeral-callback-answer.js:12`), so the default middlewares would still retry floods and internal errors.

**Only these four kinds are relayed**, each as a raw call with exact values:

| Kind | Raw call |
|---|---|
| Callback button without `requiresPassword` | `messages.getBotCallbackAnswer{peer, msgId, data}`; never `password` or `game` |
| Poll vote | `messages.sendVote{peer, msgId, options: [exact option bytes]}`; one shot |
| Typed text | `messages.sendMessage{peer, message: exact text, randomId, noWebpage}`. No `reply_to` unless the human picks it. No trimming or prefix (Shieldy strict mode deletes anything else: CB-18 U). |
| Ephemeral callback | `ephemeral.getCallbackAnswer{peer, id, data}` (`index.d.ts:64426`) |

- A reply-keyboard label is relayed only as visible public text, after a warning.
- `StartBot` is relayed only for a `t.me/<bot>?start=` link to the **same** bot that posted the challenge, as a separate step the human picks ("Send /start to @bot").
- Everything else goes to the app: url, urlAuth, webView, simpleWebView, game, buy, switchInline, copy, request phone/peer/geo, every `?startapp=` and `t.me/<bot>/<app>` link.

**Immediately before sending:**
1. Refetch the message.
2. Abort if it was deleted, if `edit_date` changed, or if the chosen data bytes are no longer on it.
3. Confirm the challenge is still open: `Channel.banned_rights` still restricts the account, or the window is still running for a non-muting bot.

If the challenge has changed, mark it **"answered elsewhere"** and send nothing. **One answer per challenge; the first one wins.** On the owner's own account the same challenge is in the owner's app.

**After a relayed press**, if the challenge message does not change within about 10 s, tell the human: "continue in your Telegram app". The follow-up may be an ephemeral overlay shown only to "the exact client that triggered" the press (GJ-26 U, GJ-m07 M).

**Targeting.**
- Show the sender (id, bot flag, @username) and why the message matched.
- Never pre-select or rank options.
- Flag buttons from non-bot senders as suspicious.
- A weak match (name only) needs the human's "this is for me" first.

**Scam hard stops** (CB-33 C, M-25 U, GM-m09 M):
- requests for a phone number, login code, 2FA password, QR scan, seed phrase or private key;
- wallet connect or sign;
- Win+R, PowerShell, Terminal or "paste";
- executable downloads;
- `requires_password` buttons;
- UrlAuth, RequestPhone or RequestPeer;
- look-alike bot usernames;
- a "verification" DM not linked to the request.

URLs are shown as plain text with the real host, never as links. They never appear in notifications, SSE or the activity log.

### 8.7 Timing reality (mustFix #5)

**Software overhead** before the human sees a challenge, at layer 229:
- detection: about 0.3 s by push (including the join result's own updates), or at most 3–5 s by poll;
- notification: under 1 s.

**Human arrival** at the console takes 15–60 s. Windows run from 10 s (Join Captcha Bot) to 60 s (Shieldy) (CB-20 C, CB-16 U).

So on the owner's own account the **primary** path stays "answer in your Telegram app", and the console relay is secondary. The relay mainly serves a future dedicated reader account, or an owner already at the Mac.

The macOS notification only informs: the chat title and the seconds left. It carries no URLs and no options, and the service process sends it. A timeout or failure never leads to an automatic rejoin.

### 8.8 Media, paid content, basic groups, leaving, required memberships (mustFix #13, #16; shouldFix)

- **Video and image challenges.**
  - Download through the supervised client (recorded).
  - Serve on a page-token-guarded route with fixed content types (`image/jpeg`, `image/png`, `video/mp4`), `nosniff` and `no-store`.
  - Add `media-src 'self'` to the CSP (`server.ts` `CSP`).
  - Never serve Telegram documents, SVG or HTML.
  - Delete the files when the challenge ends.
- **Paid content.**
  - Refuse `subscription_pricing` invites.
  - `channel.send_paid_messages_stars` is visible at layer 229 (M-m13 M): refuse typed answers there.
  - `ALLOW_PAYMENT_REQUIRED` → "cannot answer here: use the app; never pay".
  - Never set `allow_paid_floodskip` or `allow_paid_stars`.
- **Basic groups.** Leave with `messages.deleteChatUser(self)`, since `LeaveChannel` does not apply. Join only through an invite import.
- **Leaving.** The leave is confirmed by the owner. It warns that admins see it, that some bots punish leaving and rejoining (PF-m07 M), and that messages missed while out are not recovered in hidden-history groups.
- **Combot's required memberships.** Each one is a separate join with its own confirmation (GM-m08 M). Joins are never chained.
- **Write errors** (`CHAT_WRITE_FORBIDDEN`, slow mode) are reported as-is and never retried.

### 8.9 Limits and breakers (mustFix #12)

- One join at a time.
- At least 30 min between joins, and 10 min between a leave and a join.
- Exponential backoff on any join `FLOOD_WAIT`.
- Stop all joins on:
  - `CHANNELS_TOO_MUCH` below the cap;
  - `PEER_FLOOD` or `USER_RESTRICTED`;
  - `FROZEN_*`;
  - two "request was unsuccessful" errors within an hour.
- After a failure, at most one more attempt per chat, and only with a fresh confirmation.
- Join Captcha Bot bans permanently after 10 failed joins (3 for polls) (CB-20 C, CB-m03 M).
- The confirmation screen repeats the Phase 1 warnings for this join, plus the live membership count against the cap.

### 8.10 Activity (mustFix #14)

- **Writes.** Record joins, answers and leaves as writes, with the human action id (the nonce) and the relayed label or typed text in the detail. Never record a web-view URL.
- **Reads.** `updates.getChannelDifference` and `updates.getDifference` (mtcute gap recovery, MC-05 R) and `help.getAppConfig` are recorded reads, through the carve-out in 3.6 ported to the middleware.
- **Owner gestures.** Log each owner gesture next to the write it allowed.

### 8.11 Phase 2 live tests

These are fact sheet tests, run on test groups administered from a second account:

| Test | Purpose | Risk |
|---|---|---|
| T0 | Supply chain | none |
| T9 | Cutover | low; a mistake means a new QR login |
| T12 | Welcome and ephemeral delivery; press the human's choice with `ephemeral.getCallbackAnswer` | low |
| T14 | Guard bot | low. **Only** records what a layer-229 join of a guard chat returns; never relays it. |
| T15 | One captcha bot at a time; the relay of a button, a poll and typed text, each chosen by the owner; one answer given in the app, to check the dedupe | low |

Never run against real groups:
- failure paths;
- poll-mode failures;
- repeated joins;
- any guard-bot software join;
- deliberate timeouts.

### 8.12 Critique coverage matrix

| Critique item | Resolution |
|---|---|
| mustFix 0: no spec | This document |
| mustFix 1: shared token; MCP could join or answer | Phase 1: token split (3.7), no MCP writes (3.9). Phase 2: human nonce capability (8.3), with the residual risk stated. |
| mustFix 2: GramJS click helpers unsafe | Phase 1: no writes at all, gate (3.5). Phase 2: raw calls only, refetch-and-verify (8.6). |
| mustFix 3: late joins and answers (FLOOD_WAIT hold, retries) | Phase 1: no writes; `CheckChatInvite` in `NO_RETRY`. Phase 2: deadlines, drop-not-delay, `maxRetryCount: 0`, priority lane (8.4, 8.5). |
| mustFix 4: challenge arrives before the listener, or is lost | Phase 1: the owner's app sees it; reader pages feed hints. Phase 2: listener before the call, result scan, poll cadence (8.4). |
| mustFix 5: timers shorter than human reach | App-first on the owner's account (8.7); presence plus armed window. |
| mustFix 6: two answers race | One answer per challenge, first wins; "answered elsewhere" check (8.6). |
| mustFix 7: per-chat lock and watchdog cannot protect a window | Join mutex; poll pause; watchdog suspended; refetch after a reconnect (8.4). |
| mustFix 8: guard bots, request-gated chats, layer 198 | Phase 1: never joins. Phase 2: request-gated targets always use the app; never request web views (8.4, 8.6). |
| mustFix 9: invisible challenges (ephemeral) | Phase 1: the banner says so; "restricted with nothing visible" still shows it. Phase 2: layer 229 listener plus `ephemeral.getCallbackAnswer`; GramJS is never hand-patched (WM-m09 M). |
| mustFix 10: web-app and scam portals beyond the web_app class | Phase 1: host-only plain text, warnings. Phase 2: URL, `startapp` and `t.me/<bot>/<app>` → app; hard stops (8.6). |
| mustFix 11: which challenge is ours | Sender plus why-matched; no ranking; non-bot flagged; weak matches need confirmation (3.1.6, 8.6). |
| mustFix 12: main-account risk | Phase 1 warnings (3.1.3). Phase 2 limits, cap and breakers (8.9). |
| mustFix 13: paid joins and paid messages | Phase 1: stop warning, never pays. Phase 2: refuse; never set paid flags (8.8). |
| mustFix 14: blind activity log (`updates.*`, `help.*`) | Phase 1 carve-out (3.6); Phase 2 middleware (8.10). |
| mustFix 15: pending request becomes a membership hours later | Persistent `requested`, startup re-arm, schedule, chat-list fast path, notification (3.1.5, 3.1.7, 5.2). |
| mustFix 16: video captchas under the CSP | Phase 2 media route and `media-src 'self'` (8.8). Phase 1 shows no media. |
| shouldFix: hidden-history gap | `history_from` plus the caveat (3.1.5). Phase 2 leave warning (8.8). |
| shouldFix: polling after a kick; kick vs ban | `onAccessLost` → `GetChannels` classification; reading switched off; re-check after `until` for public sources (3.1.7). |
| shouldFix: peek and already-a-member | Verdicts `peek` and `member` (3.1.2). |
| shouldFix: basic groups | `GetChats` classification (3.1.5). `deleteChatUser` leave in Phase 2 (8.8). |
| shouldFix: DM listener on the main account | Phase 1 reads no DMs. Phase 2 uses a strict bot-id filter (8.4). |
| shouldFix: Combot required memberships | Separate confirmed joins, never chained (8.8). |
| shouldFix: Shieldy strict mode; write forbidden | Exact text; errors reported as-is, never retried (8.6, 8.8). |
| shouldFix: challenge text reaching digests or the LLM | In-memory hints; the `toStored` bot drop (3.1.6). |
| shouldFix: second connection from a CLI | All actions inside the service; session lock (5.1 #9). |
| shouldFix: stack migration | Phase 2 only, gated on T0 and T9 (8.1, 8.2). |
| shouldFix: unofficial-client flag unverifiable | The warning says "unknown"; live test L8 (7). |

---

## 9. Open risks

1. **Dialog-list load from the concurrent chat-list discovery.**
   - The working tree's `Reader.membership()` calls `getDialogs({ limit: 1000 })`. GramJS pages that at 100 per request (`client/dialogs.js:15`, `:68`), so up to 10 `messages.getDialogs` requests per run.
   - It runs at startup, every 10 min, and within about 1 min of any membership notice. `isMembershipNotice` fires on **every** `updateChannel` and `updateChat`, including routine info changes. That is up to about 1,440 `getDialogs` requests a day.
   - Repeated dialog loads are the one call pattern the research ties to the longest floods: 53 of 60 floods in one account came from dialog-cache warming before a 53,123 s wait (AL-30 R, AL-m05 M).
   - Suggestions:
     - run the periodic reconcile hourly rather than every 10 min;
     - on a notice, read the bundled Channel from `update._entities` first (`client/updates.js:84-90`, `:101`; zero requests), and reconcile only when the notice concerns a chat the store does not know;
     - record `GetDialogs` floods separately.

   This spec's fast path depends on that reconcile, so its cadence matters here too.
2. **Layer-198 blind spots.** Ephemeral challenges, guard results and Communities are invisible. One unknown constructor makes GramJS drop the whole decrypted message (`network/MTProtoSender.js:394-403`; WM-m09 M), so a push hint can vanish. Scheduled checks and pulls remain the record. "No visible check" never means "no check".
3. **Classifying a private group after a kick** (`left` versus `channelForbidden`) is unconfirmed. `CHANNEL_PRIVATE` cannot distinguish them (M-01 C, SP-23 C). This is **LT** in L7. The UI falls back to "removed (left, kicked or banned)".
4. **`ChatInviteAlready.chat` may lack a usable access hash** (min) (**LT** L2). In that case the source falls back to the existing `byId` path, which costs one `getDialogs` after restarts.
5. **Checking a consumed single-use link.** After the owner's join consumes a single-use link, `checkChatInvite` may answer `INVITE_HASH_EXPIRED` rather than `chatInviteAlready` (**LT**). The chat-list match (3.1.7) covers this case.
6. **Title-match linking** can meet a different group with the same title. A link is made only when `ChatInviteAlready` names the same chat id. If the budget is exhausted, linking waits.
7. **The human may be away.** Phase 1 relies on the owner seeing the challenge in their own app. A request approved at 3 a.m. followed by a 60 s Shieldy window will likely be missed. The result is a kick, and recovery is the owner's own rejoin (CB-18 U).
8. **Notification delivery.** macOS permission (Script Editor), Focus modes or a missing GUI session can silence notifications (L3).
9. **Main-account exposure.** Joins are visible and recorded in the admin log. CAS and federation bans spread. The unofficial-client label is unknown (UF-02 C). Silent purges can remove the account weeks later (SP-01 U).
10. **AI terms.** Digesting private groups with Claude sits squarely inside the terms' AI restriction. Only the owner can accept that (M-29 U, AL-22 C).
11. **Local trust boundary.** The page token is readable by any local process (3.7).
12. **Policy numbers.** The budget figures are policy, not published limits (AL-03 U). A flood can still happen within them. The breakers then freeze invite checks, and a long wait also pauses reading account-wide.
13. **Concurrent edits.** The chat-list discovery work is uncommitted and may change (`onMembershipNotice` payload, `reconcileOnce` return value, `reader_off_reason` values). Sections 3.4, 3.5 and 3.10 name the exact hooks to keep in step.
14. **Phase 2 stack.**
    - mtcute is pre-1.0 and changes fast (MC-16 R).
    - It has one maintainer (MC-09 R).
    - It is published with a long-lived token rather than OIDC (MC-08 R).
    - No skeptic reviewed the MC facts.
    - The middleware and retry behaviour cited here was read from the tarball; the session import is still **LT** (T9).

---

## Appendix A. Decisions for the lead to review

1. **Own state read through `channels.getChannels` first.** `getParticipant(self)` runs once after a join, for `via_request` and the join date. Research M-14 (U) says own restrictions are authoritative on `Channel.banned_rights`, and tdesktop distrusts `getParticipant(self)` for them. This deviates from "through GetParticipant on self".
2. **Phase 1 is read-only in code.** `superviseRequests` refuses every write class. No current code path writes, so nothing should break; L1 verifies this.
3. **The token split ships in Phase 1.** `/api/digest`, `/api/unwatch` and `/api/settings` become page-only. MCP keeps exactly the routes it uses today.
4. **An invite-confirmed chat is switched on even when auto-read is off.** It gets origin `dialog`, so the chat-list check's leave and rejoin logic applies.
5. **Budget figures:**
   - `checkChatInvite` at most 20/day (12 background, 5 MCP), at least 30 s apart, no automatic retry;
   - flood freeze of max(2×, 6 h);
   - pending schedule +0, +1 h, +6 h, +24 h, then daily to day 14, with at most 5 tracked requests.
6. **The membership state lives in a new `memberships` table.** Removal reuses `enabled = false` with `reader_off_reason` `left`, so the existing rejoin logic keeps working.
7. **Post-join health also covers chats the chat-list check newly finds.** The first reconcile after start is skipped, at most 3 per reconcile, and only chats joined within 30 min.
8. **`help.GetAppConfig` and `updates.Get(Channel)Difference` become recorded reads now**, ahead of Phase 2.
9. **`parseRef` stops treating `t.me/addlist/…` as the username "addlist"**, which wastes a resolve.
10. **Phase 2 joins only open links.** Request-gated targets keep the Phase 1 app path permanently, because a software join of a guard chat cannot be finished in the app (GM-04 U).
11. **Phase 2 must override mtcute's default retries.** Flood waits of 10 s or less are retried 5 times, and server errors infinitely. `SLOWMODE_WAIT_` is retried too.
12. **Open risk 1 sits outside this feature.** The 10-minute `getDialogs(1000)` reconcile cadence in the concurrent work is worth reconsidering.

## Appendix B. GramJS evidence index (`node_modules/telegram`, 2.26.22)

| Item | Location |
|---|---|
| Layer 198 | `tl/AllTLObjects.js:4` |
| `messages.checkChatInvite`; `chatInviteAlready`, `chatInvite`, `chatInvitePeek` | `tl/apiTl.js:1619`; `:525-527`. Types `tl/api.d.ts:23799`; `:6581-6639` |
| `channels.getParticipant`; participant kinds | `apiTl.js:1852`, `:599-603`, `:614`. `api.d.ts:27086`, `:7491-7578`, `:19666` |
| `channels.getChannels`; `channel`, `channelForbidden` | `apiTl.js:1853`, `:84-85`. `api.d.ts:27098`, `:1043-1080`, `:1141-1148` |
| `channels.getFullChannel`; `channelFull.available_min_id` | `apiTl.js:1854`, `:87`. `api.d.ts:27108`, `:1213-1267` |
| `messages.getChats`; `chat`, `chatForbidden` | `apiTl.js:1596`, `:82-83`. `api.d.ts:23489` |
| `chatBannedRights` | `apiTl.js:956`; `api.d.ts:11423-11445` |
| `updateChannel`, `updateNewChannelMessage`; join actions | `apiTl.js:262-263`, `:120-122`, `:144`. `api.d.ts:3535`, `:3545`, `:1818-1838`, `:2114` |
| `messageEntityMentionName`; `message.mentioned` | `apiTl.js:578`; `api.d.ts:7279`; `tl/custom/message.js:63` |
| Write classes refused by the gate | `apiTl.js:1590`, `:1601`, `:1620`, `:1624`, `:1639`, `:1678`, `:1688-1689`, `:1742-1744`, `:1766`, `:1794`, `:1861-1862`, `:2049` |
| `help.getAppConfig`, `updates.getChannelDifference` | `apiTl.js:1833`, `:1808` |
| `invoke`: resolve, result not dispatched, retries, flood sleep | `client/users.js:28-111` (`:46`, `:53-57`, `:60-65`, `:66-76`, `:110`) |
| `getInputEntity` short-circuit; `getInputPeer`; `getInputChannel` | `client/users.js:227-234`; `Utils.js:131-185`; `Utils.js:273-302`; `tl/api.js:454-482` |
| getEntity on invites (no Peek branch) | `client/users.js:374-386`, `:414` |
| Invite parsing lacks `t.me/+` | `Utils.js:100-104` |
| Invite-link limits docstring | `client/TelegramClient.d.ts:933-936` |
| Event handlers; no gap recovery; dispatch | `client/updates.js:45-59`, `:65-67`, `:69-107`, `:109-161`, `:219` |
| Raw builder (no chat filter) | `events/Raw.js:16-42` |
| Chat filters resolve names (hazard) | `events/common.js:16-58`, `:75-84` |
| Unknown constructor drops the message | `network/MTProtoSender.js:394-403` |
| Pushed update path | `network/MTProtoSender.js:605-615` |
| `floodSleepThreshold` default and setter | `client/telegramBaseClient.js:39`, `:135-140` |
| `FloodWaitError`, `SlowModeWaitError` | `errors/RPCErrorList.js:109-110`, `:113` |
| `getDialogs` page size | `client/dialogs.js:15`, `:68` |
| Click hazards (Phase 2 rationale) | `tl/custom/messageButton.js:70-110`; `tl/custom/message.js:518-625` |
