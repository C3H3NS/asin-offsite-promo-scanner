---
name: asin-offsite-promo-scanner
description: >-
  给定亚马逊 ASIN，自动/半自动侦查该产品在站外（Google、Facebook、Pinterest、Instagram、亚马逊站内）的推广痕迹——
  折扣码、促销链接、红人测评、affiliate 链接，并产出 Markdown 调研报告 + 结构化 CSV 明细。
  适用于：运营把 ASIN 交给推广员，让其查清"这个产品是怎么做起来的、有没有折扣/站外引流"。
  触发词/场景：站外推广、off-site promo、折扣码、discount code、influencer、affiliate、红人、测评、deal、
  "这个 ASIN 怎么起来的"、"查一下这个产品的站外推广"、"scan offsite promo for this ASIN"。
---

# ASIN 站外推广侦察（Off-site Promo Intel）

## 一句话定位
运营丢一个 ASIN 过来 → 技能还原"推广员手动翻站外"的全过程 → 产出一份"这个产品怎么被推起来 / 有没有折扣码或推广链接"的情报包。

## 核心思路（最关键，务必理解）
你们推广员手动能找到，不是因为搜 ASIN 本身，而是：
**先用 ASIN 在亚马逊站内拿到商品标题 → 再拿标题里的「品牌 + 产品名」去 Facebook / Google 搜**。

ASIN 在站外几乎搜不到（站外不流通 ASIN），**品牌词 + 产品名才是站外在流通的语言**。
所以流程铁律是：
`ASIN → 亚马逊商品页 → 提取品牌/产品名/核心词 → 多渠道搜这些词 → 采集推广痕迹`

> 示例：ASIN `B0H6Q7VFK9` 的标题是
> `Boytond AI Translation Earbuds Real Time 144 Languages 60H Playtime Translator Ear Buds ... Wireless Earphones Bluetooth Headphones for Travel Business Meeting`
> 推广员拿 `Boytond AI Translation Earbuds Real Time` 去 Facebook 搜 → 命中推广信息。
> 这就是为什么技能第一步一定是"先解析亚马逊标题"，而不是直接拿 ASIN 去 Google。

## 目标站点（默认）
- **美国站 amazon.com**。调用时若需其他站点，请明确指定域名（amazon.co.uk / amazon.de / amazon.co.jp 等），并相应切换折扣站与社媒习惯（见 references/queries_and_channels.md 的"多站点适配"）。

## 采集渠道（默认）
- 基础：Google + Facebook + 亚马逊站内
- 追加：**Pinterest、Instagram**
- 可选扩展（Slickdeals / Reddit / YouTube / TikTok 等）见 references/queries_and_channels.md

---

## 安装（一次性）

### A. WorkBuddy
把整个技能目录放到：`~/.workbuddy/skills/asin-offsite-promo-scanner/`（含本 SKILL.md + scripts/ + references/ + assets/）。
FB 脚本依赖：进入 `scripts/` 执行 `npm install`（或 `setup.bat` / `setup.sh`）。

### B. Claude Code（同事安装即用）
1. 克隆/下载本仓库到本地，把整目录放到 Claude Code 的 skills 目录之一：
   - 用户级：`~/.claude/skills/asin-offsite-promo-scanner/`
   - 项目级：`<你的项目>/.claude/skills/asin-offsite-promo-scanner/`
2. 进入 `scripts/` 执行 `npm install`（或 `setup.sh` / `setup.bat`）。
3. （仅 FB 实时采集需要）让本机 Chrome 带调试端口并登录 Facebook——见下方「本地 Chrome 登录态」。

> **装好后怎么提问（同事直接照抄即可）**：
> - 最常用：`查一下 ASIN B0H6Q7VFK9 的站外推广，给我一份报告`
> - 指定站点：`帮我查 B0H6Q7VFK9 在英国站（amazon.co.uk）的站外推广`
> - 只查折扣：`B0H6Q7VFK9 有没有折扣码？把折扣力度找出来`
> - Facebook 实时：`先帮我启动调试 Chrome 并登录 Facebook，再用本机登录态查 Boytond 品牌的站外推广`
> - 多 ASIN：`这 3 个 ASIN 一起查：B0H6Q7VFK9、B0XXXXXXX、B0YYYYYYY，合并成一份报告`
> - 也可显式输入 `/asin-offsite-promo-scanner` 调用本技能。
> 直接甩 ASIN 即可，品牌/产品名技能会自己从亚马逊商品页解析，不用你手动提供。

---

## 本地 Chrome 登录态（Facebook 实时采集专用）
Facebook 公开搜索对匿名基本失效，必须用**你本机已登录 Chrome 的会话**。`scripts/` 下已提供一键启动脚本，内置了所有常见坑的修复：

- **Windows**：运行 `scripts/start_chrome_debug.bat` → 弹窗里登录 Facebook → 保持窗口开着。
- **Mac/Linux**：运行 `bash scripts/start_chrome_debug.sh` → 登录 Facebook → 保持窗口开着。

然后跑采集：
```powershell
node scripts/facebook_search.js "Boytond"          # 品牌名，推荐
node scripts/facebook_search.js "Boytond" "earbuds" # 品牌 + 品类
node scripts/facebook_search.js "B0H6Q7VFK9"        # 也支持直接传 ASIN
```
脚本三级容错：①先连已在 9222 的调试 Chrome → ②连不上则复制 profile 自启一个（已加 `--remote-allow-origins=*` 与 `--proxy-bypass-list`）→ ③仍不行就打印清晰指引后优雅退出，绝不 FATAL 崩溃。
产物：`offsite-output/facebook_<品牌>.json` + `.png`。详见 `scripts/README.md`。

> 若不想用本地登录态，技能也有「Google `site:facebook.com` 索引」的自动方式（见 Step 4），无需登录。

---

## 执行步骤

### Step 1 解析 ASIN → 亚马逊商品信息
- 打开 `https://www.amazon.com/dp/<ASIN>` 或在 amazon.com 搜索该 ASIN。
- 提取：标题原文、品牌（Brand 字段或标题首词）、价格、是否有 Coupon、是否有 Subscribe & Save、核心卖点词、主图。
- **推导搜索词（最关键一步）**，以 Boytond 为例：
  - 品牌词：`Boytond`
  - 产品核心词：`AI Translation Earbuds` / `AI Translation Earbuds Real Time`
  - 组合词：`Boytond AI Translation Earbuds`
  - 推广意图组合：`Boytond coupon` / `Boytond discount code` / `Boytond review` / `Boytond giveaway` / `Boytond affiliate` / `Boytond influencer`

### Step 2 亚马逊站内交叉验证
- 在 amazon.com 搜品牌词（如 `Boytond`），看同品牌是否有其他 ASIN / 变体 / 带 coupon 的链接。
- 搜产品核心词，看本品与竞品排名、图片轮播里是否有 "Videos for this product"（Amazon Influencer 红人视频）。
- 记录：站内是否已有站外引流痕迹（品牌旗舰店、红人视频、关联商品）。

### Step 3 Google 广域搜索
用 WebSearch / WebFetch（或浏览器），依次搜（把 <品牌> <产品核心词> 替换）：
1. `"<品牌> <产品核心词>"` （带引号精确匹配）
2. `<品牌> <产品核心词> review`
3. `<品牌> discount code` / `<品牌> coupon`
4. `<品牌> <产品核心词> amazon` （看测评/blog/deal 站是否带 Amazon 联盟链接）
5. `<品牌> giveaway` / `<品牌> influencer`
采集：URL、站点类型（博客/deal/论坛/视频）、是否含折扣码、摘要。

### Step 4 Facebook（自动 + 实时脚本，混合）
- **自动（无需登录，Google 索引抓取）**：
  - `site:facebook.com "<品牌> <产品核心词>"`
  - `site:facebook.com "<品牌>" "discount"`
  采集被搜索引擎收录的公开帖子 / 主页 / 小组帖。
- **实时（本机登录态脚本）**：按上方「本地 Chrome 登录态」启动后，运行 `facebook_search.js`。
  脚本会产出 `facebook_<品牌>.json`（多查询聚合 + 解析出的 Amazon 链接/折扣码）。把关键命中并入报告与 CSV。
- **手动（推广员登录态）**：Facebook 搜索对匿名失效，给一份 SOP + 记录模板（见 references/facebook_manual_sop.md），让推广员把链接/截图/折扣码贴回。产出里留「待推广员补充」占位。

### Step 5 Pinterest / Instagram
- Pinterest：`site:pinterest.com "<品牌> <产品核心词>"` 或搜品牌词，看有无种草图钉、是否带外链。
- Instagram：`site:instagram.com "<品牌>"` / 搜品牌 hashtag（如 `#boytondearbuds`），看红人 reel/帖子、bio 链接、是否标记赞助。
- 采集：账号、内容类型、是否含 promo 链接、互动量（如可见）。

### Step 6 汇总与判断
对每条发现回答：
- 这是什么渠道的推广？（deal 站 / 红人 / 社群 / 品牌自营）
- 有没有折扣码或专属链接？力度多少？
- 是 affiliate 还是纯品牌曝光？
- 综合判断：这个 ASIN 主要靠什么做起来的（站外 deal？红人？SEO 博客？站内广告？）

### Step 7 产出交付
- **Markdown 调研报告**：套用 `assets/report_template.md`。
- **结构化明细 CSV**：套用 `assets/findings_template.csv`，列 =
  `ASIN, 渠道, 类型, URL, 标题/摘要, 折扣码, 折扣力度, 账号/红人, 日期, 截图路径, 备注`
- 文件放在用户指定目录（默认当前 workspace），最后交给用户查看。

## 合规与边界
- 仅采集**公开可见**信息；不爬取登录态私有数据、不绕过平台反爬、不获取他人订单/客户信息。
- Facebook 匿名抓取受限，手动部分由人工在其自己账号内完成，技能不代持任何凭据。
- 采集到的折扣码/链接仅用于**竞品调研与运营决策**，不得用于刷单或操纵排名。

## 工具使用（平台无关）
- 联网搜索 / 抓取（Google 索引、Pinterest、Instagram、deal 站、博客）：用当前环境可用的 WebSearch / WebFetch / 浏览器工具。
- Facebook 实时采集：运行 `scripts/facebook_search.js`（需本机 Chrome 调试端口 + 登录态，见上文）。
- 生成报告与 CSV：用 Write 工具写出文件。

## 多 ASIN 批处理
若一次给多个 ASIN，逐个跑 Step 1–6，最后合并到同一份报告（每个 ASIN 一节）+ 同一份 CSV（追加行）。
