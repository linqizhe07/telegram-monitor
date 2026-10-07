# Telegram Monitor

**English** · [中文](README.zh-CN.md)

Follow the Telegram groups that matter to you, including big public groups you don't run (Binance, OKX…), through your own account. Every message is matched against the day's first-tier news the moment it arrives, the noise is stripped out, and Claude writes a daily digest: topics, pain points, ideas, opportunities and open questions.

## Features

- **A reader that only writes on your click.** Your Telegram account, over the official MTProto API. Public groups and channels are read without joining. Writes happen only when you press them in the console, one request per press: joining, answering a group's check for new members, and the controller's moves. Every other write is refused in code, and Claude can never do any of them. Groups that approve members one by one, and checks that are a page inside Telegram, are done in the Telegram app.
- **A controller for Telegram.** A full-screen mode driven by the keyboard, the mouse or a real game controller (Xbox, PlayStation, Switch Pro): your groups across the top (LB/RB), the group's messages in the middle (▲▼), what you can do on the side and along the bottom. A replies, START writes, X reacts, Y saves to Saved Messages, LT marks read, RT mutes; the menu opens it in Telegram, copies a link, presses a bot's button, joins or leaves. It shows what each chat allows right now (posting, slow mode, reactions). Anything other people see goes out on the second press, after letting go, at a person's pace.
- **Seconds, not minutes.** The chats you are in are checked every 10 seconds with a single request. Anything missed while the computer slept is caught up in order.
- **News radar.** Keywords of the day from Bloomberg, The New York Times, a16z, Y Combinator, The Block, CoinDesk, Odaily and your news channels, matched against every message, group slang included (大饼 = BTC). When a group reacts to a story, or talks about it before the first report, you get a notification.
- **Denoiser.** Stickers, one-word chatter, bot commands, repeats and scams are removed before anything is read.
- **Short-term high-frequency terms.** No keywords to set: when many people in a group suddenly say the same thing ("can't withdraw", a ticker), the monitor finds it in the messages, joins the pieces back into what was said, and raises it for Claude to judge.
- **Find groups and channels.** One click searches Telegram for groups and channels on Hyperliquid, crypto, RWA or stocks (or your own words): Telegram's search, channels' discussion groups, and what your groups and the groups found link to, private invite links included (their cover only). It takes a read-only look at as many as its budget allows, marks what is new since the last search, and sets likely scams apart: Telegram's SCAM/FAKE flags, names claiming to be official or support, look-alike spellings, feeds of selling and soliciting, "verify you are human" portals. Channels are judged by how dense their posts are (figures, tickers, links, real paragraphs). Join one from the list, and answer its check on the same page.
- **Live console** at `127.0.0.1:4830`. Each group is a nebula, placed by what it talks about that day: groups whose topics overlap sit close, joined by a route that names the shared topics, and form galaxies; a day bar replays the past days, and the map zooms. The reader is a crawler whose two hands are a keyword detector and a denoiser. Live instruments below, and every request the account sends.
- **Digests by Claude.** Claude Desktop writes them through MCP, no API key needed. With an API key and a bot, the service writes and sends them itself, and the digest's playbook improves itself from blind tests and your votes.
- **Built for agents.** The MCP server gives Claude (or any MCP client) 26 tools: health in one call, everything new since its last look, search across groups, messages with their thread, alerts, past digests, and a way to flag something for you. It also has prompts for the daily jobs and resources a client can subscribe to. What Claude reads and changes shows in the console as Claude's.
- **Local.** Messages are kept in a local SQLite file for 7 days.

## Quick start

Requires Node ≥ 22.18.

```bash
npm install
```

```bash
cp .env.example .env
```

In `.env`, set `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (from my.telegram.org) and your Telegram id in `PULSE_OWNER_IDS` (after the first start it is shown in the console's status line). Then log in once and start:

```bash
npm run login
```

```bash
npm start
```

Open http://127.0.0.1:4830. Groups your account is in show up on their own; add a public group by its @username, a private one by its invite link.

Claude Desktop, bot mode, commands, running 24/7, settings and troubleshooting: see the [Cookbook](COOKBOOK.md) (in Chinese).

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run replay -- --fake
```

The last one replays a synthetic group chat offline, with no Telegram and no API key.
