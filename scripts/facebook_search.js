/**
 * facebook_search.js  v4.4.5 — FB l.php解码提ASIN + 展开开关精确匹配 + 正文完整采集保真 + 查询冷却降限流版
 *
 * 解决旧版两大问题：
 *   1) 旧版只按「品牌 + 泛品类(earbuds/headphones)」搜，会把同品牌其他型号
 *      （不同 ASIN）的帖子全捞回来 → 用户点击发现 ASIN 对不上。
 *      v4 改为「品牌 + 精确产品词」查询（如 Boytond AI Translation Earbuds），
 *      不自动拼泛品类，从根上大幅收窄召回。
 *   2) 旧版提取到 Amazon 链接就直接进报告，从不校验链接里的 ASIN 是否等于目标。
 *      v4 对每条帖子提取 Amazon 链接里的 ASIN，与目标 ASIN 比对：
 *        - exact  ：链接 ASIN == 目标 ASIN → 高相关，进主结果
 *        - other  ：链接 ASIN 存在但 != 目标 → 疑似同品牌其他型号，单独标注分流
 *        - unknown：无 Amazon 链接 → 用产品词命中与否判断
 *      并对「群组帖且无产品词/无 ASIN」降为低相关（疑似噪音），不进主结果。
 *
 * 用法:
 *   node facebook_search.js "Boytond" "AI Translation Earbuds" --asin=B0H6Q7VFK9
 *   node facebook_search.js "Boytond" "AI Translation Earbuds"   # 无 ASIN 也行（只靠产品词打分）
 *   node facebook_search.js "Boytond"                            # 仅品牌降级模式
 *   node facebook_search.js "Boytond" "AI Translation Earbuds" --asin=B0H6Q7VFK9 --refresh
 *
 * 前置准备（只需一次，详见 README.md / SKILL.md）：
 *   1. 本机已安装 Google Chrome，且你已经登录 Facebook
 *   2. 在 scripts/ 目录执行： npm install   （或用 setup.bat / setup.sh）
 *   3. 让本机 Chrome 带 --remote-debugging-port=9222 启动（最省事：先跑
 *      start_chrome_debug.bat [Windows] 或 start_chrome_debug.sh [Mac/Linux]，
 *      在弹出的 Chrome 里登录 Facebook，再跑本脚本）
 *
 * 工作原理（三级容错，避免“一报错就崩”）：
 *   1) 先尝试连接已在 9222 监听的调试 Chrome（你手动起 / 脚本起均可），复用登录态；
 *   2) 连不上时，把默认 profile（含 FB cookies）复制到 _fbscan 临时目录，
 *      用该目录自启带调试端口的 Chrome 并连接（已内置 --remote-allow-origins=*
 *      与 --proxy-bypass-list，规避新版 Chrome 与系统代理的坑）；
 *   3) 若默认 profile 被占用无法复制，则打印清晰指引，让你运行 start_chrome_debug
 *      后重跑本脚本——而不是抛 FATAL 退出。
 *
 * 输出:
 *   ../offsite-output/facebook_<品牌>.json    (结构化明细，含 ASIN 比对与相关性打分)
 *   ../offsite-output/facebook_<品牌>.png      (主查询截图备查)
 */

const { chromium } = require('playwright');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 入参 ──
// 位置参数（过滤掉 -- 开头的 flag）：argv[2]=品牌, argv[3]=可选精确产品词
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
// 品牌可不传：有 --asin 时会从亚马逊商品页自动解析（见 scan()）。
// 【不再硬编码默认品牌】—— 之前默认 'Boytond' 会让别人不传参时莫名其妙去搜别的品牌。
let BRAND = positionalArgs[0] || '';
// 第 2 个位置参数 = 精确产品词（如 "AI Translation Earbuds"），不传则留空，由 ASIN 自动提取兜底
const CATEGORY = positionalArgs[1] || '';
const FORCE_REFRESH = process.argv.includes('--refresh');

// 目标 ASIN：--asin=B0H6Q7VFK9 或 --asin B0H6Q7VFK9
let TARGET_ASIN = '';
const asinEq = process.argv.find(a => a.startsWith('--asin='));
if (asinEq) TARGET_ASIN = asinEq.split('=')[1].toUpperCase().trim();
const asinIdx = process.argv.indexOf('--asin');
if (asinIdx > -1 && process.argv[asinIdx + 1]) TARGET_ASIN = process.argv[asinIdx + 1].toUpperCase().trim();

// ── 配置（均可用环境变量覆盖，方便不同系统/路径） ──
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR
  || path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SCAN_PROFILE_DIR = USER_DATA_DIR + '_fbscan';
const CHROME_EXE = process.env.CHROME_EXE
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_URL = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
const DEBUG_PORT = process.env.CHROME_DEBUG_PORT || '9222';

const OUT_DIR = process.env.FBSCAN_OUT_DIR
  ? path.resolve(process.env.FBSCAN_OUT_DIR)
  : path.resolve(__dirname, '..', 'offsite-output');
// 品牌可能待自动解析，文件名先用 ASIN 兜底，解析出品牌后由 setSafeName() 更新。
// 被 scan.js 作为子进程调用时，父进程用 FBSCAN_SAFE_NAME 锁定文件名以保证两边一致。
const SAFE_NAME_LOCK = process.env.FBSCAN_SAFE_NAME || '';
let safe = SAFE_NAME_LOCK
  || (BRAND || TARGET_ASIN || 'scan').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60);
function setSafeName(brand) {
  if (SAFE_NAME_LOCK) return;   // 父进程已锁定，不覆盖
  const s = (brand || TARGET_ASIN || 'scan').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  safe = s || 'scan';
}

// ── 静默模式：把调试 Chrome 窗口挪出可视区，避免抓取时弹到最前面干扰工作 ──
// 由 scan.js 通过环境变量 FBSCAN_QUIET=1 打开；单独运行本脚本时加 --quiet 亦可。
const QUIET = process.env.FBSCAN_QUIET === '1' || process.argv.includes('--quiet');
async function hideWindow(page) {
  if (!QUIET || !page) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: -32000, top: -32000, width: 1440, height: 900 } });
    } finally { await cdp.detach().catch(() => {}); }
  } catch (e) { /* 控制失败则降级为可见模式，不影响抓取 */ }
}

// 产品词拆 token（用于相关性判断；运行时根据最终产品词填充，见 scan()）
// 仅通用虚词。v4.5 移除了 earbuds/headphones/wireless/bluetooth ——
// 那是耳机品类专用词，硬编码在这里会让其他品类的 token 过滤行为不一致。
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'your', 'this', 'that', 'from', 'into', 'over']);
let PRODUCT_TOKENS = [];

// ── 多查询变体生成（v4.3：动态多粒度，修复“Real Time 强制拼接导致召回丢失”） ──
// 复盘：v4.2 把每个查询都拼上完整提取词（如 "AI Translation Earbuds Real Time"），
// 但真实站外帖子常只写 "Boytond AI Translation Earbuds"（不带 Real Time），
// Facebook 关键词匹配搜不到 → 漏掉 ASIN 完全匹配的优质帖。
// 修复：同一产品构造「完整词 / 核心词」多档粒度，最大化召回；精度由 ASIN 校验兜底。
// v4.5：删除了 deriveCoreKeyword() —— 它是死代码（定义后从未调用），且硬编码了
//       real time/pro/plus 等耳机场景描述符。核心词现由 extractProductPhrases() 通用产出。

function buildQueries(brand, productKeyword, targetAsin, productCore) {
  // v4.4：精简查询避免 FB 限流；覆盖 品牌 / 产品词 / 品牌+产品词
  // v4.4.1：指定目标 ASIN 时把「ASIN 本身」作为【最高优先级】查询前置——
  //   实测 FB 对品牌/产品词会返回同品牌其他型号或竞品，不一定召回「本 ASIN 的推广帖」；
  //   而直接搜 ASIN，FB 会精准返回含该 ASIN 的帖子，是精确命中的最可靠信号。
  const queries = [];
  if (targetAsin) queries.push(targetAsin);
  if (brand) queries.push(brand);
  if (productKeyword) queries.push(productKeyword);
  if (brand && productKeyword) queries.push(`${brand} ${productKeyword}`.trim());
  // 核心词档：产品词偏长时用尾部品类短语放宽召回
  if (productCore && productCore.toLowerCase() !== String(productKeyword || '').toLowerCase() && brand) {
    queries.push(`${brand} ${productCore}`.trim());
  }
  return [...new Set(queries.filter(Boolean))];
}
// ── 从文本中提取 Amazon 链接里的 ASIN ──
function extractAsin(text) {
  if (!text) return null;
  const m = text.match(/\/(?:dp|gp\/product|product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = text.match(/B0[A-Z0-9]{8}/i);
  return b ? b[0].toUpperCase() : null;
}

// ── 智能解析：从文本中提取关键情报 ──
function parsePost(text, amazonLink) {
  const info = {};

  // 优先从帖子里的 Amazon 链接（含 FB 跳转 l.php 解码后的真实地址）提取
  let asin = null;
  let amazonUrl = null;
  if (amazonLink && /amazon\./i.test(amazonLink)) {
    amazonUrl = amazonLink;
    asin = extractAsin(amazonLink);
  }
  if (!asin) {
    const amazonUrlMatch = text.match(/https?:\/\/(?:www\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?[^\s)"]*/i);
    if (amazonUrlMatch) {
      amazonUrl = amazonUrlMatch[0];
      asin = extractAsin(amazonUrlMatch[0]) || extractAsin(text);
    } else {
      asin = extractAsin(text);
    }
  } else if (!amazonUrl) {
    const amazonUrlMatch = text.match(/https?:\/\/(?:www\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?[^\s)"]*/i);
    if (amazonUrlMatch) amazonUrl = amazonUrlMatch[0];
  }
  if (amazonUrl) {
    info.amazon_url = amazonUrl;
    const domainMatch = amazonUrl.match(/amazon\.([a-z]{2,3}(?:\.[a-z]{2})?)/i);
    info.amazon_site = domainMatch ? domainMatch[1].toUpperCase() : null;
  }
  info.asin = asin;

  // 折扣码提取（常见格式: CODE - XXXXX / CODE: XXXX / voucher CODE / coupon CODE）
  const codePatterns = [
    /(?:CODE|VOUCHER|COUPON)\s*[-:]\s*([A-Z0-9]{4,12})/i,
    /(?:code|voucher|coupon)[^A-Z0-9]{0,4}([A-Z0-9]{5,12})/i
  ];
  for (const p of codePatterns) {
    const m = text.match(p);
    if (m) { info.discount_code = m[m.length - 1]; break; }
  }
  if (info.discount_code && /^(https?|www)/i.test(info.discount_code)) delete info.discount_code;

  // 折扣百分比提取
  const pctMatch = text.match(/(\d+)\s*%\s*(?:OFF|off|discount|DROP|drop)/i);
  if (pctMatch) info.discount_pct = parseInt(pctMatch[1]);

  // 价格信息
  const priceMatch = text.match(/[\$£€](\d+(?:\.\d{2})?)/g);
  if (priceMatch) info.prices = priceMatch;

  // #AD 标记（付费推广/联盟营销帖）
  info.is_ad = /#AD|#ad|\b(sponsored|affiliate)\b/i.test(text);

  // Deal Group 识别（Facebook deal 分享群组特征）
  info.is_deal_group = /\b(deals?|discounts?|coupons?|clearance|freebies?|promo\s*codes?)\b/i.test(text);

  return info;
}

// ── v4：相关性打分 + ASIN 比对 + 群组降权 ──
function scoreRelevance(post) {
  // 1) ASIN 比对
  let asinMatch = 'unknown'; // exact | other | unknown
  if (post.asin) {
    if (TARGET_ASIN && post.asin === TARGET_ASIN) asinMatch = 'exact';
    else if (TARGET_ASIN) asinMatch = 'other';
    else asinMatch = 'unknown';
  }

  // 2) 产品词命中（品牌已在搜索阶段保证，这里看精确产品词是否出现）
  const textLow = (post.text || '').toLowerCase();
  const kwHit = PRODUCT_TOKENS.some(t => textLow.includes(t));

  // 3) 是否来自群组
  const inGroup = /facebook\.com\/groups\//i.test(post.link || '');

  // 4) 打分（v4.1：群组无 ASIN 直接降权，避免“对不上的群组帖”混入主结果）
  let relevance;
  if (asinMatch === 'exact') relevance = 3;        // 金标准：链接 ASIN 就是目标
  else if (asinMatch === 'other') relevance = 2;   // 有 ASIN 但非目标：带 other 警示，报告单独分流
  else if (inGroup) relevance = 1;                 // 无 ASIN 的群组帖：无法确认对应目标，降为噪音
  else if (kwHit) relevance = 2;                   // 非群组 + 命中精确产品词：疑似本品（红人/评测）
  else relevance = 1;                              // 其余：噪音

  post.asin = post.asin || null;
  post.asin_match = asinMatch;
  post.product_kw_match = kwHit;
  post.in_group = inGroup;
  post.relevance = relevance;
  post.relevance_label = {
    3: '高 · ASIN精确命中',
    2: '中 · 疑似本品(含其他ASIN/产品词命中)',
    1: '低 · 疑似群组/噪音'
  }[relevance];

  return post;
}

// ── 去重：基于文本前 80 字符指纹 ──
function dedupePosts(posts) {
  const seen = new Set();
  return posts.filter(p => {
    const fp = (p.text || '').slice(0, 80).toLowerCase().trim();
    if (!fp || seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Profile 复制（带错误抛出，供上层判断能否自启） ──
function ensureProfileCopy() {
  if (fs.existsSync(SCAN_PROFILE_DIR) && !FORCE_REFRESH) {
    console.log('[+] 复用已存在的扫描 profile:', SCAN_PROFILE_DIR);
    return;
  }
  console.log('[+] 复制默认 profile 到扫描目录（保留 Facebook 登录态）...');
  if (fs.existsSync(SCAN_PROFILE_DIR)) {
    fs.rmSync(SCAN_PROFILE_DIR, { recursive: true, force: true });
  }
  try {
    fs.cpSync(USER_DATA_DIR, SCAN_PROFILE_DIR, {
      recursive: true,
      filter: (src) => !/[/\\](Cache|GPUCache|Code Cache|Service Worker|optimization_guide|pnacl|SwiftShader|Crashpad|GrShaderCache|on-device-model)/.test(src)
    });
    console.log('[+] profile 复制完成');
  } catch (e) {
    throw new Error('无法复制默认 Chrome profile（可能被占用/锁定）：' + e.message.split('\n')[0]);
  }
}

// ── Chrome 启动参数（已内置新版 Chrome 与代理兼容项） ──
function chromeLaunchArgs(extraProfileDir) {
  return [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    '--proxy-bypass-list=127.0.0.1;localhost',
    `--user-data-dir=${extraProfileDir}`,
    'about:blank'
  ];
}

// ── 尝试连接已在 9222 监听的调试 Chrome ──
async function tryConnectExisting(ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const b = await chromium.connectOverCDP(CDP_URL);
      console.log('[+] 已连接到正在运行的调试 Chrome（复用你的登录态）');
      return b;
    } catch (e) { await sleep(800); }
  }
  return null;
}

// ── 自启 Chrome（用扫描 profile）并连接 ──
async function launchSelf() {
  console.log('[!] 未发现带调试端口的 Chrome，脚本用扫描 profile 自行启动一个...');
  const child = execFile(CHROME_EXE, chromeLaunchArgs(SCAN_PROFILE_DIR), { detached: true, stdio: 'ignore' });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try { return await chromium.connectOverCDP(CDP_URL); }
    catch (e) { await sleep(1000); }
  }
  throw new Error('启动 Chrome 后仍无法连接 CDP（9222）');
}

// ── 打印清晰的“如何起调试 Chrome”指引 ──
function printStartHelper() {
  console.log('\n' + '═'.repeat(64));
  console.log('  ✋ 需要本机带调试端口的 Chrome + Facebook 登录态');
  console.log('  请按下面任一步骤操作后，重跑本脚本：');
  console.log('');
  console.log('  【Windows】直接运行（会自动杀残留 Chrome + 清锁）：');
  console.log('    scripts\\start_chrome_debug.bat');
  console.log('  弹窗里登录 Facebook，然后另开终端：');
  console.log('    node facebook_search.js "' + BRAND + '"' + (CATEGORY ? ' "' + CATEGORY + '"' : '') + (TARGET_ASIN ? ' --asin=' + TARGET_ASIN : ''));
  console.log('');
  console.log('  【Mac / Linux】运行：');
  console.log('    bash scripts/start_chrome_debug.sh');
  console.log('  登录 Facebook 后重跑同样的 node 命令。');
  console.log('');
  console.log('  也可手动启动（关键三个 flag 缺一不可）：');
  console.log('    chrome --remote-debugging-port=9222 --remote-allow-origins=* \\');
  console.log('      --proxy-bypass-list="127.0.0.1;localhost" \\');
  console.log('      --user-data-dir="你的默认 User Data 目录"');
  console.log('═'.repeat(64) + '\n');
}

// ── 单次搜索采集 ──
async function searchAndCollect(page, query) {
  const searchUrl = 'https://www.facebook.com/search/posts/?q=' + encodeURIComponent(query);
  console.log(`\n  [→] 查询: "${query}" → ${searchUrl}`);

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`  [!] 查询 "${query}" 导航失败: ${e.message.split('\n')[0]} —— 跳过该查询`);
    return [];
  }
  await page.waitForSelector('[role="article"], div[role="main"]', { timeout: 15000 }).catch(() => {});
  await sleep(4000);

  // 登录态检查
  const loginWall = await page.$('input[name="email"]');
  if (loginWall) {
    console.log(`  [!] 查询 "${query}" 被踢到登录页 —— 登录态可能失效，请重跑 start_chrome_debug 并登录`);
    return [];
  }

  // 滚动加载
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1200);
    await sleep(1200);
  }

  // 三层降级选择器
  let posts = await page.$$eval('[role="article"]', extractFromNodes).catch(() => []);
  if (posts.length === 0) {
    posts = await page.$$eval('[data-testid="fbsearch_result_item"], [data-testid="post"], [role="feed"] [role="article"], div[aria-posinset]', extractFromNodes).catch(() => []);
  }
  if (posts.length === 0) {
    posts = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('div[role="main"] span, div[role="main"] p, div[role="main"] h3, div[role="main"] a').forEach(el => {
        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length < 5) return;
        const href = el.tagName === 'A' ? el.href : '';
        results.push({ text: t, link: href, allLinks: href ? [href] : [] });
      });
      return results;
    }).catch(() => []);
  }

  // 对每条结果附加智能解析：先在 Node 侧用 allLinks 解出 amazon 真实链接（含 l.php 解码），再 parsePost
  posts.forEach(p => {
    const amazon_link = extractAmazonLinkFromHrefs(p.allLinks || []);
    Object.assign(p, parsePost(p.text, amazon_link));
    delete p.allLinks;
  });
  posts.forEach(p => p.query_source = query);

  console.log(`  [✓] "${query}" 采集到 ${posts.length} 条`);
  return posts;
}

// 从帖子节点提取 Amazon 链接；兼容 FB 把 amazon 包成 l.php?u=<encoded> 跳转链接的情况
// ── 从一组 href 中提取 Amazon 真实链接（Node 侧执行）；兼容 FB 把 amazon 包成 l.php?u=<encoded> 跳转链接 ──
function extractAmazonLinkFromHrefs(hrefs) {
  if (!Array.isArray(hrefs)) return '';
  for (const h of hrefs) {
    // 顺序关键：先判 FB 跳转链接（l.php 字符串里也含 amazon.com，必须先于直连判断）
    if (/l\.facebook\.com\/l\.php/i.test(h)) {               // FB 跳转包裹
      try {
        let real = new URL(h).searchParams.get('u');
        if (real) {
          if (/%2F|%3A|%3F/i.test(real)) real = decodeURIComponent(real);
          if (/amazon\./i.test(real)) return real;
        }
      } catch (e) {}
    } else if (/amazon\./i.test(h)) {                        // 直连 amazon
      return h;
    }
  }
  return '';
}

// 浏览器侧：从帖子节点采集【完整正文 + 全部链接】。
// 关键修复（v4.4.3 — 内容采集保真）：
//  1) 自包含函数，不引用任何 Node 侧函数。page.$$eval 仅把本函数序列化注入浏览器，
//     v4.4.2 之前在此调用 collectHrefs 会因闭包丢失而在浏览器里 undefined → 整段静默失败。
//  2) 长帖有 "See more" / 更多 / 展开 按钮，必须点击展开后再读 innerText，否则只拿到截断摘要。
//  3) 正文不再 slice(0,600) 截断，完整保留（仅压缩多余空白、去零宽/软连字符），忠实还原人工所见。
async function extractFromNodes(nodes) {
  const out = [];
  for (const n of Array.from(nodes)) {
    // 展开长帖：最多尝试 3 次，应对多层折叠。
    // 关键教训（v4.4.3 实测）：FB 长帖的“展开”开关是一个【文本精确等于"展开"/See more/更多"】的
    // 短 <span>/<div>；而“亚马逊商品卡”的价格区文本也包含"展开"二字（如"$32… 展开"），
    // 若用“包含”匹配会误点商品卡 → 触发跳亚马逊 → 正文丢失。故必须用【精确匹配 + 长度<=12】。
    for (let attempt = 0; attempt < 3; attempt++) {
      const expander = Array.from(n.querySelectorAll('a, span, div')).find(el => {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (t.length === 0 || t.length > 12) return false;
        if (!/^(see\s*more|更多|展开|…更多|\.\.\.更多|…more|more)$/i.test(t)) return false;
        if (el.tagName === 'A') {
          const href = el.getAttribute('href') || '';
          // 排除外站链接与 FB 跳转服务(l.php)——这些点开会跳亚马逊，不是正文展开
          if (/^https?:\/\/(?!(www\.|m\.|mobile\.|business\.)?facebook\.com)/i.test(href)) return false;
          if (/^https?:\/\/l\.facebook\.com/i.test(href)) return false;
        }
        return true;
      });
      if (!expander) break;
      try { expander.click(); } catch (e) {}
      await new Promise(r => setTimeout(r, 400));
    }

    const text = (n.innerText || '')
      .replace(/[\u200b\u200e\u200f\u00ad\u2060\ufeff]/g, '')   // 去零宽空格/LRM/RLM/软连字符/word-joiner/BOM
      .replace(/[ \t]+/g, ' ')                                  // 压缩水平空白
      .replace(/\n{3,}/g, '\n\n')                              // 段落间最多留一个空行
      .trim();

    let link = '';
    const a = n.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/videos/"], a[href*="/groups/"]');
    if (a) link = a.href;

    const allLinks = Array.from(n.querySelectorAll('a')).map(x => x.href).filter(Boolean);
    if (text.length > 0) out.push({ text, link, allLinks });
  }
  return out;
}

// ── 主扫描流程（供“已有 Chrome”或“脚本自启”两种情形复用） ──
async function scan(browser, launchedByScript) {
  const context = browser.contexts()[0] || await browser.newContext();
  // 先把已有窗口挪走，再开新标签页，避免新 tab 把窗口带到最前面
  const existing = context.pages()[0];
  if (existing) await hideWindow(existing);
  const page = await context.newPage();
  await hideWindow(page);

  // 会话预热：先访问 Facebook 首页确认登录态（首页 200 很快）
  try {
    console.log('[*] 预热会话：访问 facebook.com 首页...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } catch (e) {
    console.log('[!] 首页预热失败(继续尝试搜索):', e.message.split('\n')[0]);
  }

  // v4.5：若提供了 ASIN，自动从亚马逊商品页解析【品牌 + 产品词】，无需手动传参
  let productKeyword = CATEGORY || '';
  let productCore = '';
  if (TARGET_ASIN) {
    try {
      const { title, brand: autoBrand } = await fetchAmazonTitle(browser, TARGET_ASIN);
      if (!BRAND && autoBrand) {
        BRAND = autoBrand;
        setSafeName(BRAND);
        console.log('[✓] 自动解析品牌: "' + BRAND + '"');
      } else if (!BRAND && title) {
        BRAND = title.trim().split(/\s+/)[0];
        setSafeName(BRAND);
        console.log('[✓] 自动解析品牌(标题首词兜底): "' + BRAND + '"');
      }
      if (!CATEGORY) {
        const ph = extractProductPhrases(title, BRAND);
        if (ph.full) {
          productKeyword = ph.full;
          productCore = ph.core !== ph.full ? ph.core : '';
          console.log('[✓] 自动提取产品词: "' + ph.full + '"' + (productCore ? '  核心词: "' + productCore + '"' : ''));
        } else {
          console.log('[!] 未从标题提取出产品词，降级为品牌泛搜');
        }
      }
    } catch (e) {
      console.log('[!] 抓亚马逊商品页失败，降级为品牌泛搜: ' + e.message.split('\n')[0]);
    }
  }
  if (!BRAND && !productKeyword && !TARGET_ASIN) {
    console.log('\n[x] 需要至少提供一个：ASIN（--asin=B0XXXXXXXX，推荐）或品牌名。');
    console.log('    示例: node facebook_search.js --asin=B0H6Q7VFK9\n');
    process.exit(1);
  }
  // 填充相关性判断用的 token（基于最终产品词）
  PRODUCT_TOKENS = productKeyword.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w));

  const queries = buildQueries(BRAND, productKeyword, TARGET_ASIN, productCore);
  // 预热后额外冷却，降低“刚预热完立刻搜 ASIN”被 FB 瞬时风控断连的概率
  await sleep(8000);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ASIN 站外推广侦察 — Facebook 多查询扫描 v4.4.5`);
  console.log(`  品牌: ${BRAND} | 精确产品词: ${productKeyword || '(无，降级为品牌泛搜)'}`);
  console.log(`  目标 ASIN: ${TARGET_ASIN || '(未提供，仅按产品词打分)'}`);
  console.log(`  查询变体 (${queries.length}): ${queries.join(', ')}`);
  console.log(`${'═'.repeat(50)}\n`);

  let allPosts = [];
  let qi = 0;
  for (const q of queries) {
    if (qi > 0) {
      const cool = 6000;  // 查询间冷却，降低 FB 对密集访问的限流/风控
      console.log(`[*] 查询间冷却 ${cool/1000}s，降低 FB 限流风险...`);
      await sleep(cool);
    }
    qi++;
    const hits = await searchAndCollect(page, q);
    allPosts = allPosts.concat(hits);
  }

  // 全局去重
  let uniquePosts = dedupePosts(allPosts);

  // v4：相关性打分 + ASIN 校验
  uniquePosts = uniquePosts.map(scoreRelevance);

  // 按相关性降序（相同档位保持原顺序）
  uniquePosts.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

  // 统计摘要
  const withAmazon = uniquePosts.filter(p => p.amazon_url).length;
  const withCodes = uniquePosts.filter(p => p.discount_code).length;
  const adPosts = uniquePosts.filter(p => p.is_ad).length;
  const dealGroupPosts = uniquePosts.filter(p => p.is_deal_group).length;
  const exactAsin = uniquePosts.filter(p => p.asin_match === 'exact').length;
  const otherAsin = uniquePosts.filter(p => p.asin_match === 'other').length;
  const rel3 = uniquePosts.filter(p => p.relevance === 3).length;
  const rel2 = uniquePosts.filter(p => p.relevance === 2).length;
  const rel1 = uniquePosts.filter(p => p.relevance === 1).length;

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  扫描完成！`);
  console.log(`  总查询: ${queries.length} | 原始命中: ${allPosts.length} | 去重后: ${uniquePosts.length}`);
  console.log(`  含 Amazon 链接: ${withAmazon} | 含折扣码: ${withCodes} | #AD 标记: ${adPosts} | Deal 群组: ${dealGroupPosts}`);
  console.log(`  ASIN 精确命中(exact): ${exactAsin} | 其他 ASIN(other,疑似非目标): ${otherAsin}`);
  console.log(`  相关性分布 → 高(ASIN精确):${rel3}  中(产品词命中):${rel2}  低(疑似噪音):${rel1}`);
  console.log(`${'═'.repeat(50)}\n`);

  const result = {
    brand: BRAND,
    category: productKeyword || '(auto)',
    target_asin: TARGET_ASIN || null,
    queries_used: queries,
    captured_at: new Date().toISOString(),
    launched_by_script: !!launchedByScript,
    summary: {
      total_raw: allPosts.length,
      total_deduped: uniquePosts.length,
      with_amazon_link: withAmazon,
      with_discount_code: withCodes,
      ad_marked: adPosts,
      from_deal_groups: dealGroupPosts,
      asin_exact: exactAsin,
      asin_other: otherAsin,
      relevance_high: rel3,
      relevance_mid: rel2,
      relevance_low: rel1
    },
    posts: uniquePosts
  };

  // 保存 JSON
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = path.join(OUT_DIR, `facebook_${safe}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), 'utf8');
  console.log('[+] 已保存 JSON:', jsonPath);

  // 截图（用最后查询的页面状态）
  try {
    const shot = path.join(OUT_DIR, `facebook_${safe}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log('[+] 已截图:', shot);
  } catch (e) {
    console.log('[!] 截图失败:', e.message);
  }

  // 关闭浏览器（仅脚本自己启动的才关）
  if (launchedByScript) {
    console.log('[+] 关闭脚本启动的 Chrome...');
    await browser.close();
  } else {
    console.log('[+] 连接的是你已有的 Chrome，脚本退出不关闭它。');
  }
}

// ── v4.3：自动从亚马逊标题提取精确产品词 ──
// 返回 { title, brand }：品牌优先取 byline（"Visit the XXX Store"），兜底标题首词
async function fetchAmazonTitle(browser, asin) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  const p = await ctx.newPage();
  await hideWindow(p);
  try {
    await p.goto('https://www.amazon.com/dp/' + asin, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForSelector('#productTitle', { timeout: 10000 }).catch(() => {});
    const title = await p.$eval('#productTitle', el => el.innerText).catch(() => null)
               || await p.title().catch(() => null);
    const byline = await p.$eval('#bylineInfo', el => el.innerText).catch(() => '');
    const brand = (byline || '')
      .replace(/^Visit the\s+/i, '')
      .replace(/^Brand:\s*/i, '')
      .replace(/\s+Store$/i, '')
      .trim();
    return { title: title ? title.trim() : null, brand: brand || null };
  } finally {
    await p.close().catch(() => {});
  }
}

// ── 从标题提取核心产品短语（通用算法，与 scan.js 同源） ──
// v4.5：旧版硬编码 /translat|earbud/ 品类词，换品类必然返回空串 → 产品词丢失、
//       查询降级为纯品牌泛搜。现改为结构化解析，【不含任何品类白名单】。
// 依据：亚马逊标题格式固定为「品牌 + 型号/修饰 + 品类名, 卖点1, 卖点2...」
const CONNECTORS = new Set(['and', '&', 'with', 'for', 'of', 'in', 'to']);
const NOISE_WORDS = new Set([
  'the', 'your', 'this', 'that', 'new', 'pack', 'set', 'pcs', 'pieces', 'count',
  'upgraded', 'upgrade', 'premium', 'professional', 'portable', 'compact', 'universal', 'multifunctional',
  'best', 'top', 'ultra', 'super', 'advanced', 'smart', 'latest', 'version', 'edition', 'generation',
  'gift', 'gifts', 'men', 'women', 'kids', 'adults', 'home', 'office', 'travel', 'outdoor', 'indoor',
  'black', 'white', 'blue', 'red', 'green', 'pink', 'grey', 'gray', 'silver', 'gold', 'beige',
  'inch', 'inches', 'ft', 'cm', 'mm', 'qt', 'oz', 'lb', 'lbs', 'ml', 'gb', 'tb',
  'pro', 'plus', 'max', 'mini', 'lite',
]);

function isSpecToken(w) {
  const s = w.toLowerCase();
  if (/^\d+$/.test(s)) return true;
  if (/^\d+(\.\d+)?(qt|oz|ml|l|g|kg|lb|lbs|mm|cm|in|inch|ft|w|v|mah|hz|khz|gb|tb|k|p)$/.test(s)) return true;
  if (/^\d+(-|\s)?in(-|\s)?\d+$/.test(s)) return true;
  if (/^[a-z]{1,3}\d{1,4}[a-z+]?$/.test(s) && s.length <= 5) return true; // Q30 / X8 / S30i / A9+（带 + 型号后缀）
  if (/^\d{1,2}[a-z]{1,2}$/.test(s)) return true;
  if (/^20\d{2}$/.test(s)) return true;
  return false;
}

function stripBrandPrefix(title, brand) {
  if (!brand) return title;
  const b = brand.trim();
  const t = title.trim();
  if (t.toLowerCase().startsWith(b.toLowerCase())) {
    return t.slice(b.length).trim().replace(/^[-–—,:|]+/, '').trim();
  }
  const re = new RegExp('\\b' + b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  return t.replace(re, ' ').replace(/\s+/g, ' ').trim();
}

// 返回 { full, core }：full=清洗后完整品类短语，core=核心词（用于放宽召回）
// 关键分支：亚马逊标题两种写法，品类名位置相反 ——
//   a) 规范型「品牌 品类名, 卖点...」（含逗号）→ 第一段短，品类在【尾部】
//   b) 堆砌型「品牌 品类名 卖点1 卖点2 ...」（无逗号、关键词堆满）→ 品类紧跟品牌在【头部】
// 用第一段实词数量区分：>LONG 判为堆砌型取头部，否则取尾部（尾部=更通用的品类词，利于放宽召回）。
function extractProductPhrases(title, brand, maxCore = 3) {
  if (!title) return { full: '', core: '' };
  let t = stripBrandPrefix(title, brand);
  t = t.split(/[,，(（[【|｜;；]|\s[-–—]\s/)[0].trim();
  t = t.split(/\s+(?:with|for|w\/)\s+/i)[0].trim();
  const words = t.split(/\s+/).map(w => w.replace(/[^\w&+/-]/g, '').trim()).filter(Boolean);
  let kept = words.filter(w => {
    const s = w.toLowerCase();
    if (CONNECTORS.has(s)) return true;
    return !isSpecToken(w) && !NOISE_WORDS.has(s) && w.length > 1;
  });
  while (kept.length && CONNECTORS.has(kept[0].toLowerCase())) kept.shift();
  while (kept.length && CONNECTORS.has(kept[kept.length - 1].toLowerCase())) kept.pop();
  if (!kept.length) return { full: '', core: '' };

  const LONG = 6;
  let fullArr, coreArr;
  if (kept.length > LONG) {            // 堆砌型：只取头部，避免把几十个关键词噪音当产品名
    fullArr = kept.slice(0, maxCore);
    coreArr = fullArr;
  } else {                             // 规范型：保留完整短语，核心取尾部通用品类词
    fullArr = kept;
    coreArr = kept.length <= 4 ? kept : kept.slice(kept.length - maxCore);
  }
  while (coreArr.length && CONNECTORS.has(coreArr[0].toLowerCase())) coreArr = coreArr.slice(1);
  while (fullArr.length && CONNECTORS.has(fullArr[fullArr.length - 1].toLowerCase())) fullArr = fullArr.slice(0, -1);
  return { full: fullArr.join(' '), core: coreArr.join(' ') };
}

function extractProductKeyword(title, brand) {
  return extractProductPhrases(title, brand).full;
}

// ── 入口：三级容错 ──
async function main() {
  // 1) 先连现有调试 Chrome
  const existing = await tryConnectExisting();
  if (existing) {
    await scan(existing, false);
    return;
  }

  // 2) 没有现成的 → 试着复制 profile 自启
  let copied = false;
  try { ensureProfileCopy(); copied = true; }
  catch (e) { console.log('[!] ' + e.message); }

  if (!copied) {
    printStartHelper();
    process.exit(0); // 优雅退出，不崩
  }

  try {
    const b = await launchSelf();
    await scan(b, true);
  } catch (e) {
    console.log('[!] 自启 Chrome 失败: ' + e.message);
    printStartHelper();
    process.exit(0); // 优雅退出，不崩
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
