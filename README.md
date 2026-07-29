# ASIN 站外推广侦察技能（asin-offsite-promo-scanner）

给一个亚马逊 ASIN，自动/半自动侦查它在站外（**Google / Facebook / Pinterest / Instagram / 亚马逊站内**）的推广痕迹——折扣码、促销链接、红人测评、affiliate 链接，并产出 **Markdown 报告 + 结构化 CSV**。

> 核心洞察：站外不流通 ASIN，**品牌词 + 产品名才是站外流通的语言**。流程铁律是
> `ASIN → 亚马逊商品页 → 提取品牌/产品名 → 多渠道搜这些词 → 采集推广痕迹`。

---

## 一、目录结构

```
asin-offsite-promo-scanner/
├── SKILL.md                      # 技能主说明（WorkBuddy / Claude Code 共用）
├── README.md                     # 本文
├── LICENSE                       # MIT
├── .gitignore
├── references/
│   ├── facebook_manual_sop.md    # Facebook 手动采集 SOP（推广员登录态）
│   └── queries_and_channels.md   # 搜索词推导模板 + 渠道扩展 + 多站点适配
├── assets/
│   ├── report_template.md        # 报告模板
│   └── findings_template.csv     # CSV 明细模板
└── scripts/
    ├── facebook_search.js        # FB 实时采集（本机 Chrome 登录态，Playwright CDP）
    ├── package.json
    ├── start_chrome_debug.bat    # Windows 一键启动调试 Chrome（含 FB 登录态）
    ├── start_chrome_debug.sh     # Mac/Linux 一键启动调试 Chrome
    ├── setup.bat / setup.sh      # 一键 npm install（跳过下载浏览器）
    └── README.md                 # 脚本专属说明
```

---

## 二、安装

### 方式 A：WorkBuddy
把整个目录放到 `~/.workbuddy/skills/asin-offsite-promo-scanner/`，然后进 `scripts/` 跑 `npm install`。

### 方式 B：Claude Code（推荐给同事分发）
1. 克隆本仓库，把整目录放到 Claude Code 的 skills 目录之一：
   - 用户级：`~/.claude/skills/asin-offsite-promo-scanner/`
   - 项目级：`<项目>/.claude/skills/asin-offsite-promo-scanner/`
2. 进 `scripts/` 跑 `npm install`（或 `bash setup.sh` / `setup.bat`）。
3. 对 Claude Code 说："查一下 ASIN B0H6Q7VFK9 的站外推广"，即会自动触发。
4. （仅 FB 实时采集需要）按第三节让本机 Chrome 带调试端口并登录 Facebook。

> 前置依赖：Node.js ≥ 18、本机已装 Google Chrome、可联网。

---

## 三、本地 Chrome 登录态（Facebook 实时采集专用）—— 重点

Facebook 的公开搜索对**匿名/干净浏览器基本失效**，必须用你本机已登录 Chrome 的会话。
本仓库提供了**一键启动脚本**，把实测踩过的所有坑都固化进去了，正常情况照做就不会再出问题。

### 3.1 一键启动（推荐）
- **Windows**：双击或终端运行 `scripts/start_chrome_debug.bat`
- **Mac / Linux**：终端运行 `bash scripts/start_chrome_debug.sh`

脚本会自动：
1. 杀掉后台残留 Chrome 进程（否则 profile 被占用）；
2. 删除残留的 `SingletonLock`（见 3.3 坑②）；
3. 用默认用户目录启动带 `--remote-debugging-port=9222` 的 Chrome（已加 `--remote-allow-origins=*` 与 `--proxy-bypass-list`，见 3.3 坑③④）；
4. 你只需在弹窗里**登录 Facebook**，并保持窗口开着。

### 3.2 运行采集
另开一个终端：
```powershell
cd scripts
node facebook_search.js "Boytond"           # 品牌名，推荐
node facebook_search.js "Boytond" "earbuds" # 品牌 + 品类
node facebook_search.js "B0H6Q7VFK9"        # 也支持直接传 ASIN
```
产物：`../offsite-output/facebook_<品牌>.json` + `.png`。脚本三级容错，连不上调试 Chrome 会打印清晰指引后优雅退出，不会崩溃。

### 3.3 我们实测踩过的坑（已写入启动脚本，了解即可）
| # | 现象 | 根因 | 本仓库的解法 |
|---|------|------|------|
| ① | Win+R 运行命令后 Chrome 没带调试端口 | Win+R 运行框会"吃掉"复杂命令的参数，debug flag 被丢 | 改用 `start_chrome_debug.bat`（CMD 启动，参数完整保留） |
| ② | 反复强杀 Chrome 后，9222 永远起不来 | `taskkill /F` 留下的陈旧 `SingletonLock` 让 Chrome 误判目录被占、跳过绑定端口 | 启动脚本里 `del ...\SingletonLock` 清锁 |
| ③ | 浏览器/脚本访问 `127.0.0.1:9222` 失败 | 系统代理（Clash/V2Ray 等）把本机回环也走代理 | 启动参数加 `--proxy-bypass-list="127.0.0.1;localhost"` |
| ④ | Playwright 连 CDP 报版本错 | 新版 Chrome 要求 `--remote-allow-origins=*` | 启动参数已加该 flag |
| ⑤ | 一个查询超时整脚本崩 | 单查询 `goto` 失败被当作 FATAL | 脚本已改为单查询 try/catch，失败只跳过该查询 |

### 3.4 不想用本地登录态？
技能也支持 Google `site:facebook.com` 索引抓取（见 SKILL.md Step 4），无需登录即可拿到被搜索引擎收录的公开帖，只是覆盖度低于登录态。

---

## 四、产出

- **Markdown 报告**：套 `assets/report_template.md`，覆盖产品基础信息、各渠道发现、折扣/链接汇总、综合判断。
- **CSV 明细**：套 `assets/findings_template.csv`，列 =
  `ASIN, 渠道, 类型, URL, 标题_摘要, 折扣码, 折扣力度, 账号_红人, 日期, 截图路径, 备注`
- FB 实时结果：`offsite-output/facebook_<品牌>.json`（结构化）+ `.png`（截图备查）。

---

## 五、合规与边界
- 仅采集**公开可见**信息；不爬取登录态私有数据、不绕过反爬、不获取他人订单/客户信息。
- Facebook 手动部分由人工在其自己账号内完成，技能不代持任何凭据。
- 折扣码/链接仅用于**竞品调研与运营决策**，不得用于刷单或操纵排名。

---

## 六、贡献 / 反馈
FB DOM 经常变动，若某次采集为空，先看 `offsite-output/facebook_<品牌>.png` 截图，再人工补；
选择器如需更新，改 `scripts/facebook_search.js` 的 `extractFromNodes` / `searchAndCollect` 即可。

---

## 七、怎么向 Claude Code 提问（使用示例）

技能装好后，对 Claude Code 用自然语言说就行（它会根据 SKILL.md 的触发词自动加载本技能）；
也可以显式输入 `/asin-offsite-promo-scanner` 调用。下面是你和同事平时最常用的一些问法：

| 场景 | 你可以这样问 |
|------|------|
| 查单个 ASIN 的全渠道站外推广 | `查一下 ASIN B0H6Q7VFK9 的站外推广，给我一份报告` |
| 指定站点 | `帮我查 B0H6Q7VFK9 在英国站（amazon.co.uk）的站外推广` |
| 只关心折扣码 | `B0H6Q7VFK9 有没有折扣码或促销链接？把折扣力度找出来` |
| Facebook 实时采集 | `先帮我启动调试 Chrome 并登录 Facebook，再用本机登录态查 Boytond 品牌的站外推广` |
| 多 ASIN 批量 | `这 3 个 ASIN 一起查：B0H6Q7VFK9、B0XXXXXXX、B0YYYYYYY，合并成一份报告` |
| 竞品对比 | `查 B0H6Q7VFK9 的站外推广，顺便看下同品类竞品是怎么推起来的` |
| 指定输出位置 | `查 B0H6Q7VFK9 的站外推广，报告放到 D:\reports\ 目录` |

提示：
- 直接甩 ASIN 即可，品牌名/产品词技能会从亚马逊商品页自己解析，不用你手动提供。
- 想跑 Facebook 实时采集：先照第三节启动调试 Chrome 并登录，再提问；不登录也能跑（走 Google `site:facebook.com` 索引，覆盖度略低）。
