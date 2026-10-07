# Telegram Monitor

[English](README.md) · **中文**

用你自己的 Telegram 账号盯住你关心的群，包括币安、OKX 这类你说了不算的公开大群。每条消息一进来就和当天的一线新闻配对，去掉噪音，再由 Claude 每天写一份速览：话题、痛点、新想法、机会、悬而未决的问题。

## 功能

- **只读的读者账号**：用你的 Telegram 账号，走官方 MTProto 接口。公开群不用加入就能读；私密群由你在官方 App 里加入后再读。加群、发言、按按钮、标已读，在代码里一律拒绝。
- **秒级入库**：你在的群每 10 秒用一个请求查一遍有没有新消息；电脑睡眠期间漏掉的，醒来后按时间顺序补齐。
- **新闻雷达**：从 Bloomberg、纽约时报、a16z、Y Combinator、The Block、CoinDesk、Odaily 和你订阅的新闻频道挖出当天的关键词，和每条消息配对，群里的黑话也认得（大饼 = BTC）。群里在聊刚出的新闻，或者比第一篇报道还早，就弹通知。
- **去噪**：表情包、单字闲聊、机器人命令、刷屏、诈骗广告，读之前先去掉。
- **短期高频词**：不用设关键词。群里很多人突然说同一件事，比如“提现不了”、某个币名，服务会从消息里自己找出来，把片段拼回原话，交给 Claude 判断。
- **实时控制台**（`127.0.0.1:4830`）：每个群是一团星云，读者是一只爬虫，两只手分别是关键词检测器和去噪器。下面一排实时仪表，账号发出的每个请求也都看得到。
- **Claude 写摘要**：Claude 桌面端通过 MCP 来写，不用 API key。配上 API key 和 bot，服务也能自己写、自己发，摘要规则还会根据盲测和你的投票自我改进。
- **为 agent 设计**：MCP 服务给 Claude（或任何 MCP 客户端）25 个工具：一次看完健康状况、上次之后的所有新消息、跨群搜索、带上下文的消息、提醒、以前的摘要，还能给你留言。另有日常任务的 prompts，以及可订阅的 resources。Claude 读了什么、改了什么，控制台里都记在 Claude 名下。
- **数据在本地**：消息存在本机的 SQLite 里，保留 7 天。

## 快速开始

需要 Node ≥ 22.18。

```bash
npm install
```

```bash
cp .env.example .env
```

在 `.env` 里填 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`（在 my.telegram.org 申请），以及你的 Telegram id（`PULSE_OWNER_IDS`，第一次启动后控制台的状态行里就有）。然后登录一次，再启动：

```bash
npm run login
```

```bash
npm start
```

打开 http://127.0.0.1:4830 。账号已经在的群会自动出现；公开群贴 @用户名添加，私密群贴邀请链接。

接 Claude 桌面端、bot 模式、命令、24 小时运行、参数和排错，都在 [COOKBOOK.md](COOKBOOK.md)。

## 开发

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run replay -- --fake
```

最后一条在合成群聊上离线回放，不用 Telegram，也不用 API key。
