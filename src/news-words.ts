// Word lists for the news radar (news-rules.ts): which words say nothing on their own, and the
// names the groups use for the things the news is about. Chinese groups rarely write "Bitcoin" or
// "Jerome Powell": they write 大饼 and 鲍威尔. A keyword from Bloomberg only finds them through
// these aliases.
//
// CONCEPTS, one per line: key | label | aliases (comma-separated). Latin aliases match whole words,
// case-insensitively; one written "=NEAR" matches only in exactly that form (or as a cashtag),
// because "near", "link" and "op" are ordinary words. CJK aliases match as substrings.

const CONCEPT_TABLE = `
btc|Bitcoin|btc,bitcoin,bitcoins,xbt,比特币,大饼,比特幣
eth|Ethereum|eth,ethereum,ether,以太坊,以太,姨太,二饼,以太幣
bnb|BNB|bnb,币安币,bnb chain,bsc
sol|Solana|sol,solana,索拉纳
xrp|XRP|xrp,瑞波,瑞波币
doge|Dogecoin|doge,dogecoin,狗狗币,狗币
ada|Cardano|=ADA,cardano,艾达币
trx|TRON|trx,tron,波场
ton|Toncoin|=TON,toncoin
link|Chainlink|=LINK,chainlink
avax|Avalanche|avax
dot|Polkadot|=DOT,polkadot,波卡
ltc|Litecoin|ltc,litecoin,莱特币
bch|Bitcoin Cash|bch,bitcoin cash,比特现金
etc|Ethereum Classic|=ETC,ethereum classic,以太经典
xmr|Monero|xmr,monero,门罗币
zec|Zcash|zec,zcash,大零币,零币
xlm|Stellar|xlm,stellar lumens
hype|Hyperliquid|=HYPE,hyperliquid
sui|Sui|=SUI,=Sui
apt|Aptos|=APT,aptos
arb|Arbitrum|=ARB,arbitrum
op|Optimism|=OP,optimism network,op mainnet
pol|Polygon|=POL,polygon network,polygon labs,matic
near|NEAR|=NEAR,near protocol
atom|Cosmos|=ATOM,cosmos hub
inj|Injective|inj,injective
tia|Celestia|=TIA,celestia
ena|Ethena|=ENA,ethena,usde
pendle|Pendle|pendle
jup|Jupiter|=JUP,jupiter exchange
tao|Bittensor|=TAO,bittensor
kas|Kaspa|=KAS,kaspa
wld|Worldcoin|wld,worldcoin
ondo|Ondo|ondo
aave|Aave|aave
uni|Uniswap|=UNI,uniswap
ldo|Lido|ldo,lido finance
pepe|Pepe|pepe
shib|Shiba Inu|shib,shiba inu,柴犬币
wif|dogwifhat|=WIF,dogwifhat
bonk|Bonk|=BONK
aster|Aster|aster
pump|Pump.fun|pump.fun,pumpfun
usdt|Tether|usdt,tether,泰达币
usdc|USDC|usdc
fdusd|FDUSD|fdusd
pyusd|PYUSD|pyusd
rlusd|RLUSD|rlusd
usd1|USD1|usd1
binance|Binance|binance,币安
okx|OKX|okx,欧易,okb
bybit|Bybit|bybit
bitget|Bitget|bitget
coinbase|Coinbase|coinbase,=COIN
kraken|Kraken|=Kraken
htx|HTX|htx,火币,huobi
mexc|MEXC|mexc
robinhood|Robinhood|robinhood,=HOOD,罗宾汉
polymarket|Polymarket|polymarket
kalshi|Kalshi|kalshi
metamask|MetaMask|metamask
circle|Circle|=Circle,crcl
strategy|Strategy (MicroStrategy)|microstrategy,mstr,微策略
blackrock|BlackRock|blackrock,ibit,贝莱德
grayscale|Grayscale|grayscale,灰度
fidelity|Fidelity|=Fidelity,富达
jpmorgan|JPMorgan|jpmorgan,jp morgan,jpm,摩根大通,小摩
goldman|Goldman Sachs|goldman,goldman sachs,高盛
morganstanley|Morgan Stanley|morgan stanley,摩根士丹利,大摩
citi|Citigroup|citigroup,citi,花旗
stanchart|Standard Chartered|standard chartered,stanchart,渣打
hsbc|HSBC|hsbc,汇丰
visa|Visa|=Visa,=VISA
mastercard|Mastercard|mastercard,万事达
paypal|PayPal|paypal
stripe|Stripe|=Stripe
nvidia|Nvidia|nvidia,nvda,英伟达
tesla|Tesla|tesla,tsla,特斯拉
apple|Apple|=Apple,aapl,苹果公司
microsoft|Microsoft|microsoft,msft,微软
google|Google|google,alphabet,googl,谷歌
amazon|Amazon|amazon,amzn,亚马逊
meta|Meta|=Meta,=META,facebook
openai|OpenAI|openai,chatgpt
anthropic|Anthropic|anthropic
xai|xAI|=xAI,grok
spacex|SpaceX|spacex,spcx,starlink
oracle|Oracle|=Oracle,orcl,甲骨文
marvell|Marvell|marvell,mrvl
tsmc|TSMC|tsmc,台积电
amd|AMD|=AMD
intel|Intel|=Intel,intc,英特尔
broadcom|Broadcom|broadcom,avgo,博通
samsung|Samsung|samsung,三星
alibaba|Alibaba|alibaba,=BABA,阿里巴巴
tencent|Tencent|tencent,腾讯
bytedance|ByteDance|bytedance,tiktok,字节跳动
huawei|Huawei|huawei,华为
xiaomi|Xiaomi|xiaomi,小米
byd|BYD|=BYD,比亚迪
palantir|Palantir|palantir,pltr
gamestop|GameStop|gamestop,=GME
berkshire|Berkshire Hathaway|berkshire,伯克希尔
nasdaq|Nasdaq|nasdaq,纳斯达克,纳指
nyse|NYSE|nyse,new york stock exchange,纽交所
sp500|S&P 500|s&p 500,s&p,spx,标普
dow|Dow Jones|dow jones,=Dow,道指,道琼斯
cme|CME|=CME,cme group,芝商所,芝加哥商品交易所
p:trump|Trump|trump,donald trump,特朗普,川普,懂王
p:musk|Elon Musk|musk,elon musk,=Elon,马斯克
p:powell|Jerome Powell|powell,jerome powell,鲍威尔
p:bessent|Scott Bessent|bessent,贝森特
p:yellen|Janet Yellen|yellen,耶伦
p:vance|JD Vance|=Vance,jd vance,万斯
p:xi|Xi Jinping|xi jinping,习近平
p:putin|Vladimir Putin|putin,普京
p:zelensky|Volodymyr Zelensky|zelensky,zelenskyy,泽连斯基
p:netanyahu|Benjamin Netanyahu|netanyahu,内塔尼亚胡
p:cz|Changpeng Zhao (CZ)|=CZ,changpeng zhao,赵长鹏
p:heyi|He Yi|he yi,何一
p:sun|Justin Sun|justin sun,孙宇晨,孙哥
p:vitalik|Vitalik Buterin|vitalik,buterin,v神
p:saylor|Michael Saylor|saylor,塞勒
p:cathie|Cathie Wood|cathie wood,=Cathie,木头姐
p:buffett|Warren Buffett|buffett,巴菲特
p:burry|Michael Burry|burry,大空头
p:dalio|Ray Dalio|dalio,达利欧
p:fink|Larry Fink|larry fink,=Fink,芬克
p:jensen|Jensen Huang|jensen huang,=Jensen,黄仁勋,老黄
p:altman|Sam Altman|altman,奥特曼
p:zuckerberg|Mark Zuckerberg|zuckerberg,扎克伯格
p:bezos|Jeff Bezos|bezos,贝索斯
p:dimon|Jamie Dimon|dimon,戴蒙
p:atkins|Paul Atkins|paul atkins,=Atkins
p:lutnick|Howard Lutnick|lutnick,卢特尼克
p:winklevoss|Winklevoss|winklevoss
p:armstrong|Brian Armstrong|brian armstrong
p:sbf|Sam Bankman-Fried|=SBF,bankman-fried
p:hayes|Arthur Hayes|arthur hayes
p:lagarde|Christine Lagarde|lagarde,拉加德
p:hassett|Kevin Hassett|hassett,哈塞特
p:warsh|Kevin Warsh|warsh,沃什
p:waller|Christopher Waller|=Waller,沃勒
fed|Fed|=Fed,federal reserve,fomc,美联储,联储
sec|SEC|=SEC,美国证监会,证监会
cftc|CFTC|cftc
treasury|US Treasury|=Treasury,美国财政部,财政部
whitehouse|White House|white house,白宫
congress|Congress|=Congress,=Senate,国会,参议院,众议院
ecb|ECB|ecb,欧洲央行
boj|Bank of Japan|=BOJ,bank of japan,日本央行,日银
pboc|PBOC|pboc,中国人民银行,人民银行
imf|IMF|imf,国际货币基金组织
tariffs|Tariffs|tariff,tariffs,关税
ratecut|Rate cut|rate cut,rate cuts,cut rates,降息
ratehike|Rate hike|rate hike,rate hikes,加息
inflation|Inflation|inflation,通胀,通货膨胀
cpi|CPI|=CPI
ppi|PPI|=PPI
pce|PCE|=PCE
payrolls|Payrolls|nonfarm,non-farm,payrolls,非农
recession|Recession|recession,经济衰退
shutdown|Shutdown|government shutdown,shutdown,政府停摆,政府关门
gdp|GDP|=GDP
oil|Oil|crude,oil price,oil prices,brent,=WTI,原油,油价,布伦特
gold|Gold|=Gold,gold price,gold prices,黄金,金价
silver|Silver|=Silver,白银
etf|ETF|etf,etfs
ipo|IPO|ipo,ipos,上市
stablecoin|Stablecoins|stablecoin,stablecoins,稳定币
genius|GENIUS Act|genius act,天才法案
clarity|CLARITY Act|clarity act
rwa|Tokenization (RWA)|=RWA,tokenization,tokenized,代币化
ai|AI|=AI,artificial intelligence,人工智能
hack|Hack|hack,hacked,hacker,hackers,exploit,exploited,黑客,被盗
iran|Iran|iran,伊朗
israel|Israel|israel,以色列
russia|Russia|russia,俄罗斯
ukraine|Ukraine|ukraine,乌克兰
venezuela|Venezuela|venezuela,委内瑞拉
taiwan|Taiwan|taiwan,台湾
northkorea|North Korea|north korea,朝鲜
`;

export interface Concept {
  key: string;
  label: string;
  /** Lowercase forms matched as whole words, case-insensitively. */
  loose: string[];
  /** Forms matched only exactly like this (or as a $cashtag). */
  strict: string[];
  /** CJK forms, matched as substrings. */
  cjk: string[];
}

const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export const CONCEPTS: Concept[] = CONCEPT_TABLE.trim()
  .split('\n')
  .map((line) => {
    const [key, label, aliases] = line.split('|');
    const c: Concept = { key, label, loose: [], strict: [], cjk: [] };
    for (const a of aliases.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (a.startsWith('=')) c.strict.push(a.slice(1));
      else if (HAS_CJK.test(a)) c.cjk.push(a);
      else c.loose.push(a.toLowerCase());
    }
    return c;
  });

// Words that are capitalized in a headline without naming anything: the most common English words,
// headline verbs, and first names (a first name alone matches far too much).
export const COMMON_EN = new Set(
  `
a about above across act action actually add added adds after again against age ago agree ahead aid aim aims air all allow allowed allows almost alone along already also although always am amid among amount an analysis analyst analysts and announce announced announces annual another answer any anyone anything app apps are area areas around art article as ask asked asks at attack attacks available away back backed backs bad ban bank banks base based be bear bears became because become becomes been before began begin begins behind being believe below best better between beyond big bigger biggest bill bills billion billions bit black block board body book boost boosts both bottom box break breaking bring brings broke build building builds built bull bulls business but buy buyer buyers buys by call called calls came campaign can cannot capital car card care case cases cash cause center central chain chance change changes chart charts check chief choice city claim claims clear close closed closes club co code coin coins come comes coming community companies company could council country course court cover crash create created credit crisis cross crypto cuts cut daily data date day days deal deals death debt decade decide decision deep deficit delay demand despite did die digital direct do does doing dollar dollars done door double down drop drops due during each early earn earnings easy economic economy edge effect effort eight either else end ends energy enough enter entire era even event events ever every everyone everything evidence exactly example exchange exchanges executive expect expected expects experts eye eyes face faces fact fails fall falls family far fast fear fears feature federal feel few field fight figure file filed files final finally finance financial find finds fine fire firm firms first five fix flat floor flow focus follow food for force forces form former forward found four free friday from front fuel full fund funding funds future gain gains game games gas gave general get gets getting give given gives global go goes going gone good got government great green ground group groups grow growing growth guide had half hand hands happen hard has have having he head heads health hear heart heavy held help helps her here high higher highs hike him his history hit hits hold holds home hope hot hour hours house how however huge human hundred idea if ii iii image impact important in include includes including income increase index industry info inside instead interest internal international into investment investor investors is issue issues it its itself job jobs join joins jump jumps just keep keeps key kind know known labor land large largest last late later latest launch launches law laws lead leader leaders leads least leave left legal less let level levels life like likely limit line lines link list live loan loans local long look looks lose loss losses lost lot low lower made main major make makes making man many march market markets may maybe me mean means media meet meeting members men might mid million millions mind minister minute minutes miss mobile model money month months more morning most move moves much must my name nation national near need needs net network never new news next night nine no none nor not note nothing now number of off offer offers office official officials often oil old on once one ones online only open opens or order orders other others our out outlook over own owner page paid part parties party pass past pay pays peace people per percent period person place plan plans platform play player plays plus point points policy political poll pool poor post power prepare president press pressure price prices prime private pro probably problem process product products profit program project projects proposal protect prove provide public pull pulls push puts put quarter question quick quickly race raise raised raises rally rate rates rather reach reaches read ready real really reason record records red report reports research reserve response rest result results return returns reveal reveals review rich right rights rise rises rising risk risks road role room round rule rules run running runs safe said sale sales same save say says school season second secret security see seek seeks seen sees sell seller sells send sense series serve service services set sets seven several share shares she shift ship short shot should show shows side sign signal signals signs since single six size slow small so social some someone something soon source south space speak special spend spending spot staff stage stake stand standard star start starts state states statement stay step still stock stocks stop store story strategy street strong study style success such summer support sure surge surges system systems table take takes taking talk talks target tax team tech technology tell tells ten term terms test than that the their them then there these they thing things think third this those though thought thousand threat three through time times to today together told too took top total toward towns trade trader traders trades trading trial true trust truth try turn turns two type under union unit until up update upon us use used user users uses value vote vs wait walk wall want wants war warn warns was watch water way ways we wealth week weekly weeks well went were what when where whether which while white who whole why will win wins with within without woman women word words work worker workers works world worse worst worth would write year years yes yet you young your zero
monday tuesday wednesday thursday friday saturday sunday january february april june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec
america american americans asia asian europe european china chinese japan japanese india korea korean uk britain british germany german france french canada canadian australia mexico brazil africa african world global
north south east west new york london paris tokyo beijing shanghai hong kong singapore dubai washington california texas florida
inc corp corporation ltd llc plc co group holdings capital partners ventures labs foundation protocol network finance financial bank exchange fund trust asset assets management global international
ceo cfo cto chair chairman chairwoman founder cofounder co-founder director head chief officer analyst economist investor trader billionaire lawmakers lawmaker regulators regulator judge senator governor minister
says said say tells told adds added warns warned sees saw seeks sought eyes plans planned wants wanted files filed hits hit rises rose falls fell jumps jumped slides slid gains gained drops dropped surges surged plunges plunged soars soared sinks sank climbs climbed tops topped nears neared passes passed breaks broke reaches reached hits sets set posts posted reports reported shows showed
why how what who when where which this that these those here there now then today tonight yesterday tomorrow week weekend month year
more most less least many much few several every each all any some no not only just also even still again ever never
show ask tell launch hn yc
blockchain token tokens web3 defi nft nfts dao onchain on-chain altcoin altcoins memecoin memecoins wallet wallets mining miners staking yield yields treasury treasuries reserve reserves
michael john david james robert william richard joseph thomas charles christopher daniel matthew anthony mark donald steven paul andrew joshua kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel frank gregory raymond alexander patrick jack dennis jerry tyler aaron jose adam henry nathan douglas zachary peter kyle walter ethan jeremy harold keith christian roger noah gerald carl terry sean austin arthur lawrence jesse dylan bryan joe jordan billy bruce albert willie gabriel logan alan juan wayne roy ralph randy eugene vincent russell elijah louis bobby philip johnny mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa betty margaret sandra ashley kimberly emily donna michelle dorothy carol amanda melissa deborah stephanie rebecca sharon laura cynthia kathleen amy shirley angela helen anna brenda pamela nicole emma samantha katherine christine debra rachel catherine carolyn janet ruth maria heather diane virginia julie joyce victoria olivia kelly christina lauren joan evelyn judith megan cheryl andrea hannah martha jacqueline frances gloria ann teresa kathryn sara janice jean alice madison doris abigail julia judy grace denise amber marilyn beverly danielle theresa sophia marie diana brittany natalie isabella charlotte rose alexis kayla sam tom ben dan max alex chris nick tim jim bob bill ray ted
`
    .split(/\s+/)
    .filter(Boolean),
);

// Uppercase tokens that are not tickers: news-wire tags, units, common abbreviations.
export const UPPER_STOP = new Set(
  `A I AM AN AS AT BE BY DO GO HE IF IN IS IT ME MY NO OF OH OK ON OR SO TO UP US WE AND ARE BUT FOR HAS HOW NEW NOT NOW OUT THE WAS WHO WHY YOU ALL ANY CAN GET HER HIM HIS ITS OUR SHE TOO
JUST LIVE WATCH BREAKING UPDATE UPDATES ALERT LATEST REPORT NEWS FLASH URGENT HUGE BULLISH BEARISH INSIGHT OPINION TODAY INTERESTING NOTE THIS WEEK MORE READ VIDEO PHOTO PHOTOS EXCLUSIVE
USA UK EU UN CEO CFO CTO COO VP PM AM TV PC HN YC Q1 Q2 Q3 Q4 H1 H2 FY YOY MOM QOQ BPS BP PCT K M B T X ID OTC P2P API APP APPS FAQ PR DM AMA RT NFA DYOR LOL OMG FYI TBA TBD ETA ASAP EST PST UTC GMT ET PT CST HK SG JP KR CN RU UA DE FR IN BR
USD EUR JPY GBP CNY CNH RMB HKD SGD KRW AUD CAD CHF INR
`
    .split(/\s+/)
    .filter(Boolean),
);

// Chinese words that carry no topic of their own (what the word segmenter returns most often).
export const COMMON_ZH = new Set(
  `
的 了 在 是 和 与 及 或 等 将 已 于 对 为 从 由 被 把 让 向 到 至 也 都 而 但 并 还 又 就 才 只 很 更 最 不 没 无 非 所 其 此 该 这 那 有 个 些 次 位 名 家 年 月 日 时 分 秒
今日 昨日 明日 今天 昨天 明天 目前 当前 近日 本周 上周 下周 本月 上月 今年 去年 明年 小时 分钟 期间 以来 以后 之后 之前 此前 此后 随后 同时 其中 包括 以及 通过 根据 由于 因为 所以 但是 然而 不过 如果 虽然
表示 宣布 称 据悉 消息 报道 发布 推出 显示 指出 透露 认为 预计 预期 可能 或将 将会 已经 正在 开始 继续 进行 实现 完成 达到 达成 获得 提供 支持 计划 准备 考虑 决定 要求 希望 需要 进一步 相关 有关 方面 情况 问题 方式 方面
数据 市场 价格 交易 投资 资金 用户 平台 项目 公司 机构 行业 全球 美国 中国 香港 日本 韩国 欧洲 英国 美元 人民币 亿美元 万美元 亿元 万元 亿 万 千 百 美股 股价 股票 指数 涨幅 跌幅 上涨 下跌 突破 跌破 回落 反弹 走高 走低 涨 跌
现报 报价 行情 一度 短时 小幅 大幅 持续 创下 新高 新低 历史 记录 首次 首个 首份 第一 第二 主席 总统 官员 团队 合作 合作伙伴 发展 生态 系统 网络 产品 服务 功能 技术 研究 报告 分析 文章 社区 活动 公告 官方 信息 内容 时间 地址
感觉 觉得 知道 看看 一下 一个 一波 一些 什么 怎么 为什么 这个 那个 我们 你们 他们 大家 自己 现在 还是 就是 不是 可以 没有 应该 已经 真的 其实 然后 因为 所以 如果 但是 而且 或者 只是 还有 一直 一样 这样 那样 这么 那么 非常 比较 特别
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lead-ins news wires put before the headline, and trailers they put after it. */
export const LEAD_INS = [
  /^\s*(?:🚨|⚡|🔥|🔴|📢|‼️|❗|🇺🇸|🇨🇳|🇪🇺|🇬🇧|🇯🇵|🇰🇷|🇷🇺|🇺🇦|🇮🇳|🇮🇷|🇮🇱|\p{Extended_Pictographic}|\p{Regional_Indicator}|\s)*\[?(?:JUST IN|BREAKING(?: NEWS)?|NEW|HUGE|BULLISH|BEARISH|INSIGHT|OPINION|TODAY|INTERESTING|LATEST|UPDATE|ALERT|FLASH|URGENT|LIVE|EXCLUSIVE|WATCH|REPORT|RUMOR|DEVELOPING)\]?\s*[:：\-–—]\s*/iu,
  /^\s*(?:Show|Ask|Tell|Launch) HN\s*[:：]\s*/i,
  /^\s*Odaily星球日报讯\s*/,
  /^\s*(?:PANews|BlockBeats|律动BlockBeats|金色财经|吴说)\s*(?:消息|报道|快讯)?\s*[,，:：]?\s*/,
];
export const TRAILERS = [/News \| Markets \| YouTube/gi, /@\w{3,32}/g, /\[Brought to you by[^\]]*\]/gi];
/** A post saying this is paid for: never a source of keywords. */
export const SPONSORED = /\[Brought to you by|\bsponsored\b|#ad\b|\bpaid partnership\b|广告|推广/i;
