# Facebook 站外搜索脚本（本地 Chrome 登录态版）

配套 `asin-offsite-promo-scanner` 技能使用。解决一个核心痛点：**Facebook 匿名/干净浏览器搜不到公开帖子**，必须复用你本机已登录 Chrome 的会话。

## 原理
Playwright 不直接用自带的无头浏览器，而是：
- **连接你本机已用 `--remote-debugging-port=9222` 启动的 Chrome（通过 CDP）**，继承登录态，且不干扰你已开的标签页；
- 若没有现成的调试 Chrome，脚本会把你的 Chrome 用户目录复制到临时目录（`...User Data_fbscan`）并自启一个带调试端口的 Chrome。

两种路径都会加载你本地 Chrome 里的 cookies，因此 Facebook 是登录状态。

## 一次性准备
1. 安装依赖（脚本目录内，二选一）：
   ```powershell
   # Windows
   .\setup.bat
   # 或 Mac/Linux
   bash setup.sh
   ```
   > 已设 `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`，复用本机 Chrome，不下载额外浏览器。

## 运行（两步）

### 第 1 步：让本机 Chrome 带调试端口 + 登录 Facebook
最省事的方式——直接跑启动脚本（已内置杀残留进程、清 SingletonLock、代理绕过等坑）：
```powershell
# Windows
.\start_chrome_debug.bat
# Mac/Linux
bash start_chrome_debug.sh
```
弹出的 Chrome 窗口里**登录 Facebook**，并保持它开着。

### 第 2 步：跑采集脚本
另开一个终端：
```powershell
# 推荐：只传 --asin，脚本自动抓亚马逊标题、解析品牌 + 提取精确产品词（无需手传任何词）
node facebook_search.js --asin=B0H6Q7VFK9
# 少数自动解析不准时，才手动覆盖品牌/产品词：
node facebook_search.js "Boytond" "AI Translation Earbuds" --asin=B0H6Q7VFK9
```

> ⚠️ **目标 ASIN 必传（`--asin`），品牌与精确产品词脚本会自动从亚马逊商品页解析**（v4.5 起不再硬编码默认品牌）。
> 只传品牌会召回同品牌所有型号（不同 ASIN）的帖子，造成"点进去 ASIN 对不上"的噪音——而自动解析正是为了拿到精确产品词。
> 脚本会对每条带 Amazon 链接的帖提取 ASIN，与 `--asin` 比对，在 JSON 里给出 `asin_match`（exact/other/unknown）与 `relevance`（高/中/低）字段。

脚本会自动：
1. 先连已在 9222 的调试 Chrome（连上就复用登录态）；
2. 连不上才复制 profile 自启一个；
3. 若 profile 被占用无法复制，会打印清晰指引后**优雅退出**（不再 FATAL 崩溃），你按提示重跑 `start_chrome_debug` 即可。

## 实现要点（v4.4 起，踩坑后定型）

- **FB 跳转包裹解码**：帖里 amazon 链接实际是 `l.facebook.com/l.php?u=<URL编码>`。解码必须在 **Node 侧**做——`page.$$eval` 注入浏览器的函数拿不到 Node 作用域里的函数，放浏览器侧会静默失败；脚本在 Node 端解 `l.php` 还原 `amazon.com/dp/<ASIN>` 并提取 ASIN。
- **展开开关精确匹配**：只点文本**精确等于**「展开 / See more / 更多」且长度 ≤ 12 的短元素，排除会跳亚马逊的外站 `<a>` 与 `l.php` 链接——否则会误点「亚马逊商品卡价格区」（`$32… 展开`）导致跳走、Coupon/Telegram 正文丢失。
- **正文完整采集不截断**：去除零宽字符/软连字符后完整保留（人工所见即所得），不再 `slice(0,600)`。
- **查询冷却降限流**：预热后 8s + 查询间 6s，降低 FB 密集访问触发的 `ERR_CONNECTION_CLOSED`。
- **ASIN 优先查询**：传 `--asin` 时 ASIN 作为最高优先级查询前置（品牌/产品词查询 FB 未必召回本 ASIN 推广帖，直接搜 ASIN 才稳定）。

## 输出
- `../offsite-output/facebook_<查询词>.json` —— 结构化明细（每条帖子的**完整正文**（不截断）+ 解码后的 Amazon 链接 + 折扣码 + 采集时间 + `asin_match` / `relevance` 等字段）
- `../offsite-output/facebook_<查询词>.png` —— 搜索结果截图，方便人工核对

把 JSON 里的命中条目整理进技能的 `findings_template.csv` / 报告，就完成了 Facebook 这块的采集。

## 注意事项
- Facebook DOM 经常变动，帖子选择器 `[role="article"]` 是「尽力而为」的粗略采集；若某次结果为空，可人工在浏览器里看一眼截图。
- 登录态失效时脚本会提示检测到登录页，按上面的方式重跑 `start_chrome_debug` 并登录即可。
- 不要对同一个账号高频自动化搜索，避免触发风控；采集完记得关掉脚本开的浏览器（脚本自启的会在结束时自动关闭）。
- 系统开了科学上网/公司代理时，务必用 `start_chrome_debug` 启动（已加 `--proxy-bypass-list`），否则 9222 回环会被代理拦截、连不上。

---

## 一体化 CLI：scan.js（推荐给同事 · 纯 cmd 一条命令跑完全流程）

把原本「Claude Code + 多步对话」才能完成的 7 步流程，压缩成一条命令。**同事只要装了 Node.js，无需 Claude Code、无需任何 API key**，在 cmd/终端里直接跑：

```powershell
# 最常用：只传 ASIN，脚本自动抓亚马逊标题、解析品牌+产品词、动态拼查询（全自动，无需手传任何词）
node scan.js B0H6Q7VFK9

# 极少数自动解析不准时，才用手动覆盖（一般不用加）
node scan.js B0H6Q7VFK9 --brand=Boytond --product="AI Translation Earbuds"

# 跳过某些渠道（FB 实时采集需要登录态；Pinterest/Instagram 同理）
node scan.js B0H6Q7VFK9 --skip-pinterest --skip-instagram     # 只跑 FB + Google
node scan.js B0H6Q7VFK9 --skip-fb                            # 跳过 Facebook

# 指定站点 / 只出 JSON
node scan.js B0H6Q7VFK9 --site=amazon.co.uk
node scan.js B0H6Q7VFK9 --no-report

# 自定义报告输出目录（默认 ../offsite-output）
node scan.js B0H6Q7VFK9 --out=D:\站外报告
node scan.js B0H6Q7VFK9 --out=%USERPROFILE%\Desktop\站外报告

# 想亲眼看抓取过程（默认是静默的，见下节）
node scan.js B0H6Q7VFK9 --show
```

### 静默模式（默认开启 · 不打断你的工作）

抓取需要真实浏览器，但默认**不会把 Chrome 窗口弹到你面前**：

- 脚本一连上调试 Chrome，就通过 CDP `Browser.setWindowBounds` 把窗口挪到屏幕外坐标（`-32000,-32000`）；
- 之后所有新标签页都开在这个「看不见」的窗口里，不会抢占前台、不会遮挡你正在做的事；
- **仍是有头（headed）模式**——登录态、Cookie、反爬表现和真人浏览完全一致，不像 headless 那样容易触发 Facebook 风控；
- 跑完自动把窗口移回可视区坐标并**最小化到任务栏**（先移回再最小化，否则你从任务栏还原时窗口还在屏幕外找不到）；
- FB 子进程（`facebook_search.js`）通过环境变量 `FBSCAN_QUIET=1` 同步启用，单独运行它时加 `--quiet` 也可以。

| 参数 | 作用 |
|------|------|
| 默认（不加参数） | 静默：窗口移出屏幕，跑完最小化 |
| `--show` | 显示窗口，肉眼观察抓取过程（调试用） |
| `--keep-hidden` | 跑完保持窗口在屏幕外，不移回（连续跑多个 ASIN 时用） |

> ⚠️ 依赖 `start_chrome_debug` 启动的 Chrome 带 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`（脚本已内置）。
> 缺这两个参数时，Chrome 会把「看不见的窗口」降频渲染，导致页面加载不全、抓取结果变少。

### 它自动做什么
1. **解析亚马逊商品页**：抓标题/品牌/价格/Coupon，作为后续查询与报告的基础；
2. **Facebook**：作为子进程复用已验证的 `facebook_search.js`（ASIN 优先查询 + `l.php` 解码 + 展开精确匹配 + 正文保真），产出精确命中帖；
3. **Pinterest / Instagram / Google**：用同一个调试 Chrome 走浏览器采集（无 API key），抽 href + 文本，还原 amazon 链接，识别折扣码/力度/`#AD`；
4. **聚合**：生成 `../offsite-output/` 下的三件套——`scan_<品牌>.json`（原始聚合）、`report_<品牌>.md`（人读报告）、`findings_<品牌>.csv`（明细，带 BOM，Excel 直接打开中文不乱码）。

### 前置（一次性）
1. 安装 Node.js（LTS 版，https://nodejs.org ）；
2. `scripts/` 目录执行 `npm install`（或 `setup.bat` / `setup.sh`）；
3. 运行 `start_chrome_debug.bat`（Win）/ `start_chrome_debug.sh`（Mac/Linux），在弹窗 Chrome 里登录 Facebook / Pinterest / Instagram（Google 用已登录态更稳）；
4. 另开终端执行上面的 `node scan.js <ASIN>` 即可。

### 实现要点
- **全部走浏览器**：基于 Playwright `connectOverCDP` 复用 9222 调试 Chrome 的登录态，无任何外部 API key；
- **FB 段复用 `facebook_search.js`**：逻辑已在 FB 采集里定型（ASIN 优先、跳转解码、展开精确匹配、正文保真），scan.js 通过子进程调用并读取其 JSON，不重复造轮子；
- **登录墙检测**：各渠道采集前检测是否跳到登录页，跳了就返回空并提示去调试 Chrome 登录后重跑；
- **优雅退出**：连不上调试 Chrome 时打印清晰指引后 `exit(0)`，不崩溃；
- **中文 CSV**：写文件时加 `\uFEFF` BOM，Excel 打开中文不乱码。

### 报告输出在哪？

默认落在**仓库目录下的 `offsite-output/` 文件夹**（和 `scripts/` 同级）：

```
asin-offsite-promo-scanner/
├─ scripts/            ← 你在这里跑命令
└─ offsite-output/     ← 报告都在这里 ✅
   ├─ report_<品牌>.md      ← 主要看这个（人读报告）
   ├─ findings_<品牌>.csv   ← 明细表，双击用 Excel 打开（带 BOM，中文不乱码）
   ├─ scan_<品牌>.json      ← 原始聚合数据（给程序用）
   └─ facebook_<品牌>.json/.png  ← FB 段原始结果 + 搜索结果截图
```

文件名里的 `<品牌>` 取自 `--brand`（没传就用 ASIN），例如 `--brand=Boytond` → `report_Boytond.md`。
**脚本跑完会把这个文件夹的绝对路径直接打印在终端最后一屏**，复制粘贴到资源管理器即可打开。

想换地方存：`--out=D:\站外报告`（目录不存在会自动创建）。

### 输出示例（以 B0H6Q7VFK9 为例）
- `offsite-output/scan_Boytond.json`：含 `amazon` / `facebook` / `pinterest` / `instagram` / `google` / `queries_used`；
- `offsite-output/report_Boytond.md`：人读报告，按渠道列出含 Amazon 链接的站外痕迹与折扣情报；
- `offsite-output/findings_Boytond.csv`：逐条明细（ASIN / 渠道 / 类型 / URL / 标题摘要 / 折扣码 / 折扣力度 / 备注）。

> ⚠️ `scan.js` 拿到 ASIN 后会**自动解析品牌 + 提取精确产品词**再拼查询，一般只需传 ASIN。
> `--brand` / `--product` 仅在自动解析不准时作手动覆盖用。精确产品词能避免召回同品牌其他型号（不同 ASIN）造成 ASIN 对不上的噪音。
