# Telegram Monitor Cookbook

从零到每天收到一份「群里在聊什么、痛点、新想法、机会」的速览，以及它怎么越用越准。按顺序做，每一步都有检查点。

---

## 0. 先回答三个问题

### 你要看的是谁的群？

| 场景 | 能不能做 | 用什么 | 摘要发到哪 |
|---|---|---|---|
| **别人的公开群 / 频道**（例：Binance、OKX 的官方中文群，有 `@用户名`） | 能，**不用进群** | 读者账号（第 4 步） | 你的私聊或团队私密群 |
| **别人的私密群**（只有邀请链接） | 能，前提是有人能进去 | 读者账号先在手机上**手动加入** | 同上 |
| **你自己管的群**，或群主同意加 bot | 能 | bot 模式（第 8 步） | 群里 |
| 别人的群，想让 bot 进去在群里发摘要 | **基本不行** | — | — |

为什么最后一种不行：Telegram 的 bot 只能由群管理员拉进群，bot 不能自己凭链接加群。就算进去了，还要关隐私模式或给管理员权限才能读到消息。官方大群不会同意，而且在别人群里发摘要等于刷屏，也会暴露你在监控。

所以监控别人的群用**读者账号**：一个普通的 Telegram 用户账号，通过 Telegram 官方的 MTProto 协议读消息，和手机 App 用的是同一套接口。

- **公开群和频道**：不加入也能读，跟手机上点「加入」之前能先预览一样。群成员列表里看不到你。
- **私密群**：读者账号要先像普通人一样加入。

### 需要哪些账号和密钥？

| 东西 | 什么时候需要 | 从哪来 | 第几步 |
|---|---|---|---|
| Node ≥ 22.18 | 总是 | nodejs.org 或 `brew install node` | 1 |
| **Bot token** | 总是：bot 负责发摘要、收投票 | Telegram 里的 @BotFather | 2 |
| **Anthropic API key** | 总是：负责读和写摘要 | console.anthropic.com | 3 |
| 你的 Telegram user id | 建议总是填；监控模式必填 | 私聊 bot 发 `/start` | 2、6 |
| **一个专用 Telegram 账号**（另一个手机号） | 只在监控别人的群时 | 新手机号 / eSIM | 4.1 |
| `api_id` + `api_hash` | 只在监控别人的群时 | my.telegram.org，用专用账号登录 | 4.2 |

**要不要新开 Telegram 账号？** 技术上用你自己的号也能跑，但强烈建议另开一个，原因有三：

1. 登录后保存的会话文件，等于这个账号的全部权限，而它要放在服务器上。
2. 自动读取有被 Telegram 限制或封号的风险，别拿主号冒险。
3. 和你的身份隔离。

### 要花多少钱？

全部花在 Claude API 上，Telegram 免费。以下按 Claude Opus 5.5 标价估算（$4 / $20 每百万 token）：

| 群的活跃度 | 每日摘要 | 一轮自我进化（RSI） |
|---|---|---|
| 一天 200 条左右 | ≈ $0.15–0.3 | ≈ $1.5–2.5 |
| 一天几千条（官方大群） | ≈ $0.4–1 | ≈ $3–6 |

RSI 默认每个群每天跑一轮。监控的群多的话：

- `PULSE_RSI_EVERY_HOURS=72`：三天一轮。
- `PULSE_RSI_CANDIDATES=1`：每轮只试一个变异。
- `PULSE_MODEL=claude-sonnet-5-5`：价格减半。

每次调用花了多少都会记下来，群里发 `/rsi` 能看到近 7 天的花费。

---

## 1. 装好代码

```bash
git clone https://github.com/linqizhe07/telegram-monitor.git
```

```bash
cd telegram-monitor
```

```bash
npm install
```

```bash
cp .env.example .env
```

检查点：`npm test` 显示 55 个测试全部通过。

---

## 2. 创建 bot（两种模式都要）

1. Telegram 搜 **@BotFather** → 发 `/newbot` → 起名字和用户名（必须以 `bot` 结尾）→ 它会给你一串 token，填进 `.env` 的 `TELEGRAM_BOT_TOKEN`。
2. **只监控别人的群**：隐私模式不用动，保持默认（开）。报告台只需要收命令和对 bot 消息的回复，隐私模式下这些都能收到。
3. **还要用在自己管的群里**：`/setprivacy` → 选你的 bot → **Disable**。然后把 bot 移出群再重新拉进来（这个设置只对之后的进群生效），或者直接给 bot 管理员权限。
4. 可选：不想让陌生人把 bot 拉进他们的群，等你自己的群都加完以后，`/setjoingroups` → **Disable**。

检查点：bot 能搜到，私聊它发 `/start` 有回复（要先完成第 6 步启动程序）。

---

## 3. Claude API key

在 console.anthropic.com 创建 API key，填进 `.env` 的 `ANTHROPIC_API_KEY`。

- 默认模型是 `claude-opus-5-5`，可以用 `PULSE_MODEL` 改。
- 运行环境要能连上 `api.anthropic.com`，而且要在 Anthropic 支持的国家或地区。中国大陆不在其中；服务器放在美国、新加坡、日本等地都可以。

---

## 4. 读者账号（只在监控别人的群时需要）

### 4.1 准备一个专用账号

- 换一个手机号，用**官方 Telegram App** 注册：第二张 SIM 卡或 eSIM 都行。Telegram 也在 Fragment 上卖 +888 的匿名号码。很多虚拟号（VoIP）会被 Telegram 拒收。
- **先养几天号再接程序**：设好名字和头像，手动加一两个群，像正常人一样用两三天。刚注册的号马上接第三方程序高频读取，最容易被风控。
- 开启**两步验证**（Settings → Privacy and Security → Two-Step Verification），万一会话泄露还多一道门。

### 4.2 申请 api_id / api_hash

1. 浏览器打开 https://my.telegram.org ，用**专用账号**的手机号登录。验证码会发到这个账号的 Telegram App 里，不走短信。
2. 进 **API development tools**，App title 和 Short name 随便填（例如 `monitor`），Platform 选 Desktop，点 Create application。
3. 把 **App api_id** 和 **App api_hash** 填进 `.env` 的 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH`。

如果创建时一直报 `ERROR`：换个浏览器、关掉广告拦截插件、换个网络再试。这是 my.telegram.org 的老毛病。

### 4.3 登录（只做一次）

在你自己的终端运行：

```bash
npm run login
```

默认是**扫码登录**，不用输手机号和登录码：

1. 终端里会出现一个二维码（同时存一份 `data/login-qr.png`，终端里扫不出来就打开这张图）。二维码大约 30 秒换一次，窗口别关。
2. 在**登录着专用账号的手机**上：Telegram → Settings → Devices → **Link Desktop Device**，扫这个码。
3. 如果专用账号开了**两步验证**，回到终端输入密码，输入时不显示。

不方便扫码时用手机号登录：

```bash
npm run login -- --phone
```

依次输入手机号（国际格式，例如 `+8613812345678`）、Telegram 发到专用账号 App 里的登录码，以及两步验证密码。这个号码如果还没有 Telegram 账号，程序会直接停下，**不会替你注册**。账号请先在官方 App 里注册好。

成功后会话保存到 `data/reader.session`，文件权限是 600，二维码图片随即删除。

### 4.4 会话文件的安全

- `data/reader.session` 等于这个账号的完整登录：**不要提交到 git**（`data/` 已在 `.gitignore` 里），不要发给任何人。
- 要作废它：用专用账号在 Telegram → Settings → Devices 里，找到 **Telegram Monitor**（或你在 my.telegram.org 填的应用名）→ Terminate。
- 作废或过期以后，程序日志会提示重新运行 `npm run login`。

---

## 5. 选一个「报告台」

被监控的群，摘要发到你的报告台，不会发回原群。报告台有两种：

| | A. 私聊 bot（最简单） | B. 团队私密群 |
|---|---|---|
| 怎么建 | 私聊 bot 发 `/start` | 建一个私密群 → 拉进 bot 和队友 → 在群里发 `/watch @某群` |
| 谁能看、谁能投票 | 只有你 | 全队，投票和回复都算反馈 |
| 要求 | 你的 id 在 `PULSE_OWNER_IDS` 里 | 拉 bot 的人在 `PULSE_OWNER_IDS` 里 |

- Telegram 规定 bot 不能主动私聊没跟它说过话的人，所以 A 方案一定要先 `/start`。
- B 方案里，在一个普通群发 `/watch` 后，这个群就变成报告群：它自己的聊天不再被记录，也不出摘要。
- 群里不止一个 bot 时，命令要写成 `/watch@你的bot用户名 …`（从命令菜单里选会自动带上）；隐私模式下 bot 只收得到点名给它的命令。

---

## 6. 启动

`.env` 至少要有这些：

```
TELEGRAM_BOT_TOKEN=…
ANTHROPIC_API_KEY=…
PULSE_OWNER_IDS=你的 user id
TELEGRAM_API_ID=…（监控模式）
TELEGRAM_API_HASH=…（监控模式）
```

不知道自己的 user id：先只填前两项，启动后私聊 bot 发 `/start`，它会告诉你；填进去再重启。

```bash
npm start
```

日志里应该看到：

```
signed in as @your_bot · model claude-opus-5-5 · …
reader account: @your_reader_account        ← 监控模式才有
```

---

## 6A. 不配 bot、不配 API key：控制台 + Claude 桌面端

只要读者账号登录好（第 4 步），`npm start` 就能跑。`TELEGRAM_BOT_TOKEN` 和 `ANTHROPIC_API_KEY` 都可以空着：

- 没有 bot：摘要不发 Telegram，留在本地控制台里。
- 没有 API key：服务只负责收消息，摘要由 Claude 桌面端来写，用你自己的 Claude 订阅。

### 控制台：它到底干了什么

浏览器打开 http://127.0.0.1:4830 。只有本机能访问，页面的每个操作都要带一个随机令牌，别的网站伪造不了请求。

| 区块 | 看什么 |
|---|---|
| Reader account | 登录的是哪个号；随时可以在 Telegram → 设置 → 设备里终止 |
| Account actions | 24 小时内账号发给 Telegram 的请求：读几次、**写几次**（加群、发言、按按钮、标已读都算写）。正常是 0 次写 |
| Sources | 每个群：从外面读，还是已是成员；过去 24 小时存了多少条；群的日均量；门口的守卫（入群审批、隐藏历史、群里的机器人）；是否已追平 |
| Activity | 账号发出的**每一个**请求，实时滚动。GramJS 所有请求都经过同一个被记录的入口，只有建连接的握手和心跳不记（它们不涉及任何群） |
| Captured messages | `Signal` = 去噪后 Claude 实际读到的内容；`All` = 原始消息 |
| Digests | Claude 写好的摘要 |

每个群有两个按钮：**Catch up**（立刻追平）和 **Audit 1h**（拿 Telegram 那边最近一小时的消息逐条对账：要么已存，要么写明为什么跳过，比如机器人或系统消息；其余都会报「缺失」）。

### 离线期间的消息

游标是「已经拿到的最后一条消息的 id」。服务重新跑起来时（电脑睡醒、重启、断网恢复），会从游标开始**按时间从旧到新**一页一页拉，每拉完一页就提交一次游标，直到追平。所以：

- 离线期间发的消息全部补进来，用的是消息本身的发送时间。
- 中途断网或进程被杀，下次从断点继续，不会跳过任何一段。
- 写摘要之前会先追平，摘要不会漏掉刚补回来的那部分。
- 离线超过保留期（`PULSE_RETENTION_DAYS`，默认 7 天），只补保留期内的，更早的到了也会被删掉。

2026-10-05 用真实群验证过：离线两次、共约 7 分钟，补回后对账结果是「476 条中 468 条已存，8 条是机器人，缺失 0」。

### 去噪

大群一天几千条，大部分是贴纸、「哈哈」、碎句、刷屏和拉人私聊的骗子。读之前先用代码过一遍（`src/denoise.ts`，规则固定，不靠模型）：

1. **去掉**：纯贴纸和表情、单字闲聊（早、哈哈、666、gm…）、发给机器人的命令、诈骗和推广（私聊带单、进群领空投、t.me 邀请链接）。有人回复或点了反应的消息一律保留。
2. **合并**：同一个人 90 秒内的连续碎句合成一行；同一句话被很多人刷，折叠成一行，并标上「×次数 by 人数」。很多人同时喊「提现不了」，本身就是信号。
3. **按对话分组**：用回复关系把消息串成一段段对话。整段都和加密、交易、交易所、钱无关的（学历、相亲、闲聊）**折叠**成一段说明，需要时可以展开。

币安官方中文群 2026-10-05 的实测：5,174 条 → 去掉 1,100 多条噪音 → 合并后 3,187 行 → 相关对话 505 段、872 行，约 4 万字；折叠掉的无关闲聊约 10 万字。Claude 读 3 页，而不是 12 页。

### 接入 Claude 桌面端

`src/mcp.ts` 是一个 MCP 服务，Claude 通过它读数据、写摘要。注册一次：

```bash
claude mcp add --scope user telegram-monitor -- /opt/homebrew/bin/node --no-experimental-webstorage --env-file-if-exists=/path/to/tg-pulse/.env /path/to/tg-pulse/src/mcp.ts
```

这条命令是给 Claude Code 和定时任务用的。桌面端的聊天要在 `~/Library/Application Support/Claude/claude_desktop_config.json` 的 `mcpServers` 里加同样的 command 和 args，然后重启 Claude。

工具：`list_sources`、`read_messages`（默认是去噪后的信号，可切 `off-topic` 或 `all`，分页）、`overview`、`search_messages`、`get_playbook`、`save_digest`、`account_activity`、`catch_up_now`、`audit_capture`、`check_group`（只读查看一个群）、`watch_source`（开始读，从不加群）。

需要动用 Telegram 的工具，会通过正在运行的服务去请求，**不会**另开一个连接：同一个会话在两处同时使用，可能被 Telegram 判定冲突而作废（AUTH_KEY_DUPLICATED）。

每天的摘要用 Claude 桌面端的定时任务跑（侧边栏 Scheduled → 「Telegram 群每日摘要（去噪）」，每天 9:03）：先追平，读完所有去噪后的信号页，按 话题 / 痛点 / 新想法 / 机会 / 待解问题 写成摘要，每条都标上引用的消息 #id，最后存进控制台和 `data/digests/`。第一次请在侧边栏点 **Run now**，把它要用的工具批准一次，之后自动运行。注意定时任务只在桌面端开着时运行；错过的会在下次打开时补跑。

---

## 7. 开始监控

在报告台（私聊 bot，或团队私密群）里发：

```
/watch @某个公开群
```

也可以发 `t.me/某个公开群` 链接。bot 会回复群名、人数，并立刻读入最近 24 小时的消息；接着发 `/digest`，马上就能看到第一份摘要。

- **公开频道**也能监控，比如交易所的公告频道。它的摘要更像「本周公告要点」。
- **私密群**：先用专用账号在手机上点邀请链接加入。入群验证（「点按钮证明不是机器人」之类）由你本人手动完成，程序不会也不应该替你过验证。加入后在报告台发 `/watch 群名`：在读者账号自己的聊天列表里按名字找，写一部分也行；重名时 bot 会列出来让你写得更具体。
- **批量配置**：`.env` 里写 `PULSE_WATCH=@群A,@群B` 和 `PULSE_REPORT_TO=报告台 id`（不填就是第一个 owner 的私聊），启动时自动登记。
- 读取频率：每 120 秒（±15%）轮询一遍所有被监控的群，可以用 `PULSE_READER_POLL_SECONDS` 调整。群太多（几十个）就适当调大，别让读者账号显得像在刷接口。

检查点：`/sources` 列出每个群「近 24 小时 N 条」。⚠️ 后面跟着的是读取出的问题，以及该怎么处理。

---

## 8. 你自己管的群：bot 模式

1. 第 2 步的隐私模式要关掉，或者给 bot 管理员权限。
2. 用 `PULSE_OWNER_IDS` 里的账号把 bot 拉进群。它会发一条自我介绍，说明记录什么、保留多久、怎么退出。
3. 每天到点（默认 09:00，可用 `/settings hour 21` 改）在群里发摘要，群成员直接投票和回复。
4. 成员可以 `/optout`：不收录自己的消息，并删除已经存的。

---

## 9. 命令速查

报告台里，命令后面写上是哪个群：`@群名` 或 `#序号`（序号看 `/sources`）。只监控了一个群时可以省略。

| 命令 | 在哪用 | 作用 |
|---|---|---|
| `/watch @群` · `/unwatch @群` · `/sources` | 报告台（owner） | 开始监控 · 停止监控 · 列表和状态 |
| `/digest [@群] [小时]` | 都可以 | 立即出摘要，默认 24 小时 |
| `/pulse [@群]` | 都可以 | 状态：消息数、下一份摘要的时间、playbook 版本 |
| `/rsi [@群]` | 都可以 | 进化记录：历代版本、胜率、读者票数、改进者的策略笔记 |
| `/rsi [@群] playbook` | 都可以 | 当前完整的摘要规则 |
| `/rsi [@群] evolve` · `rollback [v]` | 管理员 | 立即跑一轮 · 回退版本 |
| `/feedback [@群] 内容` | 都可以 | 告诉摘要哪里该改；直接回复某份摘要也一样 |
| `/settings [@群] …` | 管理员 | `hour 21` · `tz Asia/Shanghai` · `lang auto\|en\|zh` · `rsi auto\|propose\|off` · `here`（摘要改发到当前这个聊天或话题） |
| `/optout` · `/optin` | 只在 bot 模式的群里 | 不收录 / 恢复收录自己的消息 |

---

## 10. 让它越用越准：反馈 → RSI

摘要按一份 **playbook**（写法规则）来写。每发完一份摘要，系统会跑一轮自我改进：

1. **读者反馈 → 评审口味**。👍/👎 和回复会被提炼成 judge notes，供后面的评审做参考。只有读者反馈能改它，系统自己改不了。
2. **编辑批评**：找出漏掉的讨论、放错栏目的条目、空话。
3. **改进者提出变异版 playbook**，同时重写自己的「策略笔记」：哪类修改以前赢过、哪类输过、哪类被读者否决过。这一层就是「递归」：改进的方法本身也在改进。
4. **回放盲测**：新规则在最近几天的同一批消息上重写摘要（不发出来）。评审把它和现任版本对比，正反顺序各比一次。代码再检查两件事：引用的消息是否存在、引文是否原样出现在被引用的消息里；最热的讨论有没有覆盖到。
5. **选择**：评审胜率 ≥ 62.5%，引用核验不下降，覆盖率下降不超过 10 个点，才会采用。
6. **试用期**：新版本的前 3 份摘要里，👎 ≥ 3 且 ≥ 👍 的两倍，就自动退回上一版。这一版记为「被读者否决」，以后也不能再提一次。

你能做的：

- 多投票、多回复，具体说「漏了 X」「Y 不是痛点」「太长」。这些是最强的信号。
- 想先审再上线：`/settings rsi propose`。新版本会以「采用 / 不采用」按钮的形式发到报告台。
- 不想花 RSI 的钱：`/settings rsi off`。
- 觉得变差了：`/rsi rollback`。

不想接 Telegram 也能先看效果：`npm run replay -- --fake` 在仓库自带的合成群聊上离线跑完整流程；`npm run replay`（需要 API key）用真模型跑，约 $5。

---

## 11. 长期运行

**Mac 本机**（合上盖子就停）：

```bash
caffeinate -i npm start
```

**云服务器**（24/7，推荐）：1 核 1G 的 Linux 就够，地区要能连上 Telegram 和 Anthropic API。

```bash
git clone https://github.com/linqizhe07/telegram-monitor.git /opt/telegram-monitor
```

```bash
cd /opt/telegram-monitor
```

```bash
npm ci
```

把 `.env` 拷上去（用 scp 之类，别放进 git）。如果要监控别人的群，在服务器上运行一次 `npm run login`（SSH 里交互输入）。建一个专门跑它的系统用户（`sudo useradd -r monitor`），把 `/opt/telegram-monitor` 的所有权给它（`sudo chown -R monitor /opt/telegram-monitor`），然后写一个 systemd 服务 `/etc/systemd/system/telegram-monitor.service`：

```ini
[Unit]
Description=Telegram Monitor
After=network-online.target

[Service]
WorkingDirectory=/opt/telegram-monitor
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
User=monitor

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now telegram-monitor
```

```bash
journalctl -u telegram-monitor -f
```

注意：

- **同一个 bot token 只能跑一个实例**。Telegram 长轮询只允许一个消费者，开两个会报 409。
- **备份** `data/pulse.db`（消息、摘要、playbook 谱系、投票）和 `data/reader.session`。迁移到别的机器，把这两个文件和 `.env` 一起带走即可。

---

## 12. 参数表（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PULSE_OWNER_IDS` | 空 | 能拉 bot 进群、能用 `/watch` 的人；多个用逗号分隔 |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | 空 | 读者账号；不填就只有 bot 模式 |
| `PULSE_READER_SESSION` | `./data/reader.session` | `npm run login` 保存的会话 |
| `PULSE_READER_POLL_SECONDS` | 120 | 读者账号轮询间隔，30–3600 |
| `PULSE_WATCH` / `PULSE_REPORT_TO` | 空 / 第一个 owner | 启动时自动监控的群，以及摘要发到哪 |
| `PULSE_TIMEZONE` / `PULSE_DIGEST_HOUR` | Asia/Shanghai / 9 | 新群的默认值，之后每个群可用 `/settings` 改 |
| `PULSE_LANGUAGE` | auto | 摘要语言：auto 跟着群走，也可以固定 en 或 zh |
| `PULSE_MODEL` | claude-opus-5-5 | 也可以填 claude-sonnet-5-5（便宜一半） |
| `PULSE_DIGEST_EFFORT` / `PULSE_RSI_EFFORT` | high / high | 思考深度：low / medium / high / xhigh / max |
| `PULSE_RSI_MODE` | auto | auto（赢了就采用）/ propose（管理员批准）/ off |
| `PULSE_RSI_CANDIDATES` | 2 | 每轮提出几个变异 |
| `PULSE_RSI_EVAL_WINDOWS` | 2 | 在最近几天上盲测 |
| `PULSE_RSI_EVERY_HOURS` | 20 | 两轮之间至少间隔多少小时 |
| `PULSE_RSI_MIN_MESSAGES` | 30 | 一天至少多少条消息才拿来评估 |
| `PULSE_RSI_PROMOTE_AT` | 0.625 | 采用所需的评审胜率 |
| `PULSE_RETENTION_DAYS` | 7 | 原始消息保留天数，过期自动删除 |
| `PULSE_MIN_MESSAGES` | 5 | 少于这么多条就不出摘要 |
| `PULSE_DIGEST_COOLDOWN_MIN` | 30 | 非管理员两次 `/digest` 的最短间隔 |

---

## 13. 风险、合规与边界

- **Telegram 条款**：Telegram 允许第三方客户端通过官方 API 使用账号，但禁止刷屏、滥用，以及用来骚扰或冒充。读者账号**只读**：不发言、不点赞、不自动进群，而且轮询频率很低，这样的行为接近正常用户。即便如此，Telegram 仍可能对它认为异常的账号限流或封号，所以要用专用账号。被限流时日志会出现「slow down for N s」，程序会自动等待。
- **群规**：有的群明确禁止机器人或记录聊天。监控之前先看群规，尊重别人的社区。
- **个人信息**：群消息里有别人的名字和言论，在有的地区（例如欧盟）受数据保护法约束。程序的做法是：
  - 发给模型分析前把名字换成代号；
  - 摘要只写「说了什么」，不给个人画像、不评价人；
  - 不复制电话、地址、联系人卡片、位置坐标；
  - 原始消息默认 7 天后删除。

  别把含个人信息的摘要公开转发，也别用它针对具体的人。
- **入群验证码**由你本人在手机上完成。程序不会、也不应该自动通过任何人机验证。
- **数据去向**：消息内容会发给 Anthropic 的 Claude API 处理；其他数据都存在本机或你的服务器上。

---

## 14. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报 `TELEGRAM_BOT_TOKEN is not set` | `.env` 没填，或不在项目目录里运行 | 第 2、6 步 |
| 在自己的群里 bot 只回命令，摘要说「消息太少」 | 隐私模式开着 | 第 2 步关掉后重新拉 bot，或给 bot 管理员权限 |
| 日志 `409 Conflict` | 同一个 token 开了两个实例 | 关掉另一个 |
| `/watch` 回复「需要读者账号」 | 没填 `TELEGRAM_API_ID/HASH`，或没登录 | 第 4 步，然后重启 |
| 「no public group or channel has that username」 | 用户名写错，或者那是私密群 | 核对 `t.me/` 链接；私密群先加入再用 id |
| 「the reader account cannot see it: join it first」 | 私密群，或群关闭了预览 | 用专用账号在手机上加入，再 `/watch 群名` |
| 「has joined no group or channel with that name」 | 读者账号还没加入，或名字写得不对 | 先加入；名字写一部分即可，按读者账号聊天列表里显示的名字 |
| 群里发命令 bot 没反应 | 群里有别的 bot，命令没点名 | 写成 `/命令@你的bot用户名` |
| 「slow down for N s」 | Telegram 限流 | 程序会自动等。经常出现就调大 `PULSE_READER_POLL_SECONDS`，少监控几个群 |
| 「session is no longer valid」 | 会话被终止、账号退出或被封 | 重新 `npm run login`；被封就换一个专用账号 |
| 私聊收不到摘要 | 没先给 bot 发过 `/start` | 私聊 bot 发 `/start` |
| `/digest` 回复「⚠️ 没能写出摘要」 | API key 无效、余额不足或地区不支持 | 看日志里的具体报错 |
| 摘要太长或抓不住重点 | playbook 还在早期 | 投 👎 并具体回复；几轮 RSI 后会改善。也可以 `/rsi playbook` 看规则 |

---

## 15. 存了什么、怎么删

数据都在 `data/pulse.db`（SQLite）里：

| 表 | 内容 | 保留 |
|---|---|---|
| `messages` | 原始消息：文本、媒体标记、回复关系、表情数 | `PULSE_RETENTION_DAYS` 天后自动删除 |
| `users` | 每个群里的代号 ↔ 显示名 | 长期，用来渲染旧摘要 |
| `digests` | 发出的摘要；RSI 用的影子摘要 | 影子摘要随保留期删除，发出的长期保留 |
| `genomes` / `generations` | playbook 历代版本、每一轮的报告 | 长期 |
| `votes` / `feedback` | 👍/👎 和文字反馈 | 长期 |
| `usage` | 每次调用的 token 数和估算花费 | 长期 |

- 停止监控某个群：`/unwatch @群`。它的消息到期后自然删除。
- 立刻全部删除：停掉程序，删除 `data/` 目录。
- 读者账号的会话：除了删 `data/reader.session`，还要在 Telegram 的 Devices 里 Terminate。
