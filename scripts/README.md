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
# 推荐：只传 ASIN，脚本自动抓亚马逊标题提取精确产品词（如 AI Translation Earbuds Real Time）
node facebook_search.js "Boytond" --asin=B0H6Q7VFK9
# 也支持手动指定产品词覆盖自动提取：
node facebook_search.js "Boytond" "AI Translation Earbuds" --asin=B0H6Q7VFK9
```

> ⚠️ **务必传精确产品词和目标 ASIN**。只传品牌会从根上召回同品牌所有型号（不同 ASIN）的帖子，
> 造成"点进去 ASIN 对不上"的噪音。脚本会对每条带 Amazon 链接的帖提取 ASIN，与 `--asin` 比对，
> 在 JSON 里给出 `asin_match`（exact/other/unknown）与 `relevance`（高/中/低）字段。

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
