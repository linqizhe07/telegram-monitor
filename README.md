# Telegram Monitor

**English** · [中文](README.zh-CN.md)

Follow the Telegram groups that matter to you, including big public groups you don't run (Binance, OKX…), through your own account. Every message is matched against the day's first-tier news the moment it arrives, the noise is stripped out, and Claude writes a daily digest: topics, pain points, ideas, opportunities and open questions.

## Features

- **Read-only reader.** Your Telegram account, over the official MTProto API. Public groups are read without joining; private groups once you have joined them in the Telegram app. Joining, sending, button presses and read receipts are refused in code.
- **Seconds, not minutes.** The chats you are in are checked every 10 seconds with a single request. Anything missed while the computer slept is caught up in order.
- **News radar.** Keywords of the day from Bloomberg, The New York Times, a16z, Y Combinator, The Block, CoinDesk, Odaily and your news channels, matched against every message, group slang included (大饼 = BTC). When a group reacts to a story, or talks about it before the first report, you get a notification.
- **Denoiser.** Stickers, one-word chatter, bot commands, repeats and scams are removed before anything is read.
- **Short-term high-frequency terms.** No keywords to set: when many people in a group suddenly say the same thing ("can't withdraw", a ticker), the monitor finds it in the messages, joins the pieces back into what was said, and raises it for Claude to judge.
- **Live console** at `127.0.0.1:4830`. Each group is a nebula; the reader is a crawler whose two hands are a keyword detector and a denoiser. Live instruments below, and every request the account sends.
- **Digests by Claude.** Claude Desktop writes them through MCP, no API key needed. With an API key and a bot, the service writes and sends them itself, and the digest's playbook improves itself from blind tests and your votes.
- **Built for agents.** The MCP server gives Claude (or any MCP client) 25 tools: health in one call, everything new since its last look, search across groups, messages with their thread, alerts, past digests, and a way to flag something for you. It also has prompts for the daily jobs and resources a client can subscribe to. What Claude reads and changes shows in the console as Claude's.
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
