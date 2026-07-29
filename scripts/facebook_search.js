/**
 * facebook_search.js  v4 — 精确产品词查询 + ASIN 校验 + 相关性降权版
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
const BRAND = process.argv[2] || 'Boytond';
// 第 2 个位置参数 = 精确产品词（如 "AI Translation Earbuds"），不再用泛品类
const CATEGORY = process.argv[3] || '';
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

const OUT_DIR = path.resolve(__dirname, '..', 'offsite-output');
const safe = BRAND.replace(/[^a-z0-9]+/gi, '_').slice(0, 60);

// 产品词拆 token（用于相关性判断；过滤掉过短词与通用停用词）
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'your', 'this', 'that', 'earbuds', 'headphones', 'wireless', 'bluetooth']);
const PRODUCT_TOKENS = CATEGORY
  ? CATEGORY.toLowerCase().split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w))
  : [];

// ── 多查询变体生成（v4：精确产品词，不自动拼泛品类） ──
function buildQueries(brand, productKeyword, targetAsin) {
  const kw = (productKeyword || '').trim();
  const base = [];
  if (kw) {
    // 核心：品牌 + 精确产品词，才是站外流通的真实写法
    base.push(`${brand} ${kw}`);
    base.push(`${brand} ${kw} discount`);
    base.push(`${brand} ${kw} coupon`);
    base.push(`${brand} ${kw} deal`);
    base.push(`${brand} ${kw} review`);
  } else {
    // 降级：没有精确产品词时，至少带折扣/券意图，避免纯品牌泛召回
    base.push(`${brand} discount`);
    base.push(`${brand} coupon code`);
    base.push(`${brand} deal`);
  }
  // 顺带用目标 ASIN 原样搜一次（碰运气，部分帖子/短链会带 ASIN）
  if (targetAsin) base.push(targetAsin);
  return [...new Set(base)];
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
function parsePost(text) {
  const info = {};

  // Amazon 链接提取（匹配 amazon.com / co.uk / de / fr / jp 等站点）
  const amazonUrlMatch = text.match(/https?:\/\/(?:www\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?[^\s)"]*/i);
  if (amazonUrlMatch) {
    info.amazon_url = amazonUrlMatch[0];
    const domainMatch = amazonUrlMatch[0].match(/amazon\.([a-z]{2,3}(?:\.[a-z]{2})?)/i);
    info.amazon_site = domainMatch ? domainMatch[1].toUpperCase() : null;
    // v4：提取链接里的 ASIN
    info.asin = extractAsin(amazonUrlMatch[0]) || extractAsin(text);
  } else {
    // 没有完整 URL 时，文本里若直接出现 ASIN 也记录
    info.asin = extractAsin(text);
  }

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

  // 4) 打分
  let relevance;
  if (asinMatch === 'exact') relevance = 3;        // 金标准：链接 ASIN 就是目标
  else if (kwHit) relevance = 2;                   // 命中精确产品词，高度疑似本品
  else if (inGroup) relevance = 1;                 // 群组帖但无产品词/无 ASIN → 疑似噪音
  else relevance = 1;

  post.asin = post.asin || null;
  post.asin_match = asinMatch;
  post.product_kw_match = kwHit;
  post.in_group = inGroup;
  post.relevance = relevance;
  post.relevance_label = {
    3: '高 · ASIN精确命中',
    2: '中 · 精确产品词命中',
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
        results.push({ text: t.slice(0, 400), link: el.tagName === 'A' ? el.href : '' });
      });
      return results;
    }).catch(() => []);
  }

  // 对每条结果附加智能解析
  posts.forEach(p => Object.assign(p, parsePost(p.text)));
  posts.forEach(p => p.query_source = query);

  console.log(`  [✓] "${query}" 采集到 ${posts.length} 条`);
  return posts;
}

function extractFromNodes(nodes) {
  return nodes.map(n => {
    const text = (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    let link = '';
    const a = n.querySelector('a[href*="/posts/"], a[href*="/permalink/"], a[href*="/videos/"], a[href*="/groups/"]');
    if (a) link = a.href;
    return { text, link };
  }).filter(p => p.text.length > 0);
}

// ── 主扫描流程（供“已有 Chrome”或“脚本自启”两种情形复用） ──
async function scan(browser, launchedByScript) {
  const context = browser.contexts()[0] || await browser.newContext();
  const page = await context.newPage();

  // 会话预热：先访问 Facebook 首页确认登录态（首页 200 很快）
  try {
    console.log('[*] 预热会话：访问 facebook.com 首页...');
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);
  } catch (e) {
    console.log('[!] 首页预热失败(继续尝试搜索):', e.message.split('\n')[0]);
  }

  const queries = buildQueries(BRAND, CATEGORY, TARGET_ASIN);
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  ASIN 站外推广侦察 — Facebook 多查询扫描 v4`);
  console.log(`  品牌: ${BRAND} | 精确产品词: ${CATEGORY || '(无，降级为品牌泛搜)'}`);
  console.log(`  目标 ASIN: ${TARGET_ASIN || '(未提供，仅按产品词打分)'}`);
  console.log(`  查询变体 (${queries.length}): ${queries.join(', ')}`);
  console.log(`${'═'.repeat(50)}\n`);

  let allPosts = [];
  for (const q of queries) {
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
    category: CATEGORY || '(auto)',
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
