/**
 * scan.js  v1.0.0 — ASIN 站外推广侦察 · 一体化命令行版
 *
 * 把原本需要「Claude Code + 多步对话」才能完成的 7 步流程，压缩成一条 cmd 命令：
 *   node scan.js B0H6Q7VFK9
 * 自动完成：亚马逊解析 → Facebook(复用 facebook_search.js) → Pinterest → Instagram → Google
 *           → 聚合 JSON + Markdown 报告 + CSV 明细
 *
 * 同事使用前提（只需一次）：
 *   1. 安装 Node.js (https://nodejs.org, LTS 版)
 *   2. 在 scripts/ 目录执行： npm install
 *   3. 运行 start_chrome_debug.bat（Windows）/ start_chrome_debug.sh（Mac/Linux），
 *      在弹出的 Chrome 里登录 Facebook / Pinterest / Instagram（Google 用已登录态更稳）。
 *   4. 另开终端： node scan.js <ASIN>
 *
 * 用法:
 *   node scan.js B0H6Q7VFK9
 *   node scan.js B0H6Q7VFK9 --brand=Boytond --product="AI Translation Earbuds"
 *   node scan.js B0H6Q7VFK9 --skip-pinterest --skip-instagram      # 只跑 FB + Google
 *   node scan.js B0H6Q7VFK9 --site=amazon.co.uk                    # 英国站
 *   node scan.js B0H6Q7VFK9 --no-report                           # 只出 JSON，不出报告/CSV
 *
 * 依赖: 本文件与 facebook_search.js 同目录；会调用 facebook_search.js 跑 FB 段（复用已验证逻辑）。
 * 输出: ../offsite-output/scan_<品牌>.json / report_<品牌>.md / findings_<品牌>.csv
 */

const { chromium } = require('playwright');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 入参解析 ──
const positionalArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ASIN_ARG = (positionalArgs[0] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const TARGET_ASIN = ASIN_ARG.length === 10 ? ASIN_ARG : '';

function getFlag(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  if (idx > -1) return process.argv[idx + 1] || 'true';
  return null;
}
const BRAND_ARG = getFlag('brand');
const PRODUCT_ARG = getFlag('product');
const SITE_ARG = getFlag('site') || 'amazon.com';
const SKIP_FB = process.argv.includes('--skip-fb');
const SKIP_PINTEREST = process.argv.includes('--skip-pinterest');
const SKIP_INSTAGRAM = process.argv.includes('--skip-instagram');
const SKIP_GOOGLE = process.argv.includes('--skip-google');
const NO_REPORT = process.argv.includes('--no-report');
// 静默模式：默认开启（浏览器挪到屏幕外跑，不干扰前台工作）。加 --show 可看见抓取过程。
const SHOW_WINDOW = process.argv.includes('--show');
const KEEP_HIDDEN = process.argv.includes('--keep-hidden');
const OUT_ARG = getFlag('out');

if (!TARGET_ASIN) {
  console.error('用法: node scan.js <ASIN>');
  console.error('');
  console.error('  只需要 ASIN。品牌与产品词会自动从亚马逊商品页解析，再动态拼接搜索词。');
  console.error('');
  console.error('  可选参数（一般不用加）:');
  console.error('    --brand=品牌            手动覆盖自动解析出的品牌（解析不准时才用）');
  console.error('    --product="产品词"      手动覆盖自动提取的产品词');
  console.error('    --site=amazon.co.uk     指定站点，默认 amazon.com');
  console.error('    --out=输出目录          报告输出位置，默认 ../offsite-output');
  console.error('    --show                  显示浏览器抓取过程（默认静默）');
  console.error('    --skip-fb | --skip-pinterest | --skip-instagram | --skip-google');
  console.error('');
  console.error('示例: node scan.js B0H6Q7VFK9');
  process.exit(1);
}

// ── 配置 ──
const CDP_URL = process.env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
const CHROME_EXE = process.env.CHROME_EXE || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = OUT_ARG ? path.resolve(OUT_ARG) : path.resolve(__dirname, '..', 'offsite-output');
const SCRIPTS_DIR = __dirname;
// 输出文件名：先用 ASIN 兜底，解析出品牌后由 setSafeName() 换成品牌名
let safe = TARGET_ASIN;
function setSafeName(brand) {
  const s = (brand || TARGET_ASIN).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  safe = s || TARGET_ASIN;
}
if (BRAND_ARG) setSafeName(BRAND_ARG);

// ── 通用工具 ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 静默窗口控制：把调试 Chrome 挪到屏幕外，避免抓取时窗口弹到最前面 ──
// 说明：仍是「有头」模式（登录态/反爬表现与真人一致），只是窗口坐标在可视区之外。
const OFFSCREEN_BOUNDS = { left: -32000, top: -32000, width: 1440, height: 900 };
let _hiddenOnce = false;

async function setWindowBounds(page, bounds) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    // CDP 要求：窗口处于 minimized/maximized 时不能直接改坐标，须先回 normal
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await cdp.send('Browser.setWindowBounds', { windowId, bounds });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function hideWindow(page) {
  if (SHOW_WINDOW || !page) return;
  try {
    await setWindowBounds(page, OFFSCREEN_BOUNDS);
    if (!_hiddenOnce) {
      console.log('[静默] 浏览器窗口已移出可视区，抓取期间不会干扰你的前台工作（加 --show 可显示）');
      _hiddenOnce = true;
    }
  } catch (e) { /* 控制失败就降级为普通可见模式，不影响主流程 */ }
}

async function restoreWindow(page) {
  if (SHOW_WINDOW || KEEP_HIDDEN || !page) return;
  try {
    // 先移回可视区坐标，再最小化——否则用户从任务栏还原时窗口仍在屏幕外找不到
    await setWindowBounds(page, { left: 80, top: 60, width: 1440, height: 900 });
    const cdp = await page.context().newCDPSession(page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    } finally { await cdp.detach().catch(() => {}); }
  } catch (e) { /* ignore */ }
}

// 统一入口：开新标签页并立刻确保窗口处于静默位置
async function newQuietPage(browser) {
  const ctx = browser.contexts()[0] || await browser.newContext();
  const p = await ctx.newPage();
  await hideWindow(p);
  return p;
}

function extractAsin(text) {
  if (!text) return null;
  const m = text.match(/\/(?:dp|gp\/product|product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const b = text.match(/B0[A-Z0-9]{8}/i);
  return b ? b[0].toUpperCase() : null;
}

// 从一组 href 里还原 Amazon 真实链接（兼容 FB 的 l.php 跳转包裹，Node 侧解码）
function extractAmazonLinkFromHrefs(hrefs) {
  if (!Array.isArray(hrefs)) return '';
  for (const h of hrefs) {
    if (/l\.facebook\.com\/l\.php/i.test(h)) {
      try {
        let real = new URL(h).searchParams.get('u');
        if (real) {
          if (/%2F|%3A|%3F/i.test(real)) real = decodeURIComponent(real);
          if (/amazon\./i.test(real)) return real;
        }
      } catch (e) {}
    } else if (/amazon\./i.test(h)) {
      return h;
    }
  }
  return '';
}

// 从文本/链接里提取推广情报（折扣码、折扣力度、价格、#AD）
function parsePromo(text, amazonLink) {
  const info = { asin: null, amazon_url: null, discount_code: null, discount_pct: null, prices: null, is_ad: false };
  let amazonUrl = null;
  if (amazonLink && /amazon\./i.test(amazonLink)) {
    amazonUrl = amazonLink;
    info.asin = extractAsin(amazonLink);
  }
  if (!amazonUrl) {
    const m = (text || '').match(/https?:\/\/(?:www\.)?amazon\.[a-z]{2,3}(?:\.[a-z]{2})?[^\s)"]*/i);
    if (m) { amazonUrl = m[0]; info.asin = extractAsin(m[0]) || extractAsin(text || ''); }
    else info.asin = extractAsin(text || '');
  }
  if (amazonUrl) info.amazon_url = amazonUrl;
  const codePatterns = [
    /(?:CODE|VOUCHER|COUPON)\s*[-:]\s*([A-Z0-9]{4,12})/i,
    /(?:code|voucher|coupon)[^A-Z0-9]{0,4}([A-Z0-9]{5,12})/i
  ];
  for (const p of codePatterns) {
    const m = (text || '').match(p);
    if (m) { info.discount_code = m[m.length - 1]; break; }
  }
  if (info.discount_code && /^(https?|www)/i.test(info.discount_code)) info.discount_code = null;
  const pct = (text || '').match(/(\d+)\s*%\s*(?:OFF|off|discount|DROP|drop)/i);
  if (pct) info.discount_pct = parseInt(pct[1]);
  const prices = (text || '').match(/[\$£€](\d+(?:\.\d{2})?)/g);
  if (prices) info.prices = prices;
  info.is_ad = /#AD|#ad|\b(sponsored|affiliate)\b/i.test(text || '');
  return info;
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => {
    const k = (keyFn(x) || '').slice(0, 100).toLowerCase().trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── 从亚马逊标题提取核心产品词（通用算法，与 facebook_search.js 同源） ──
// 设计原则：【不得包含任何品类白名单】。旧版硬编码了 /translat|earbud/，
// 导致换品类（猫饮水机/空气炸锅/瑜伽垫…）时直接返回空串，产品词丢失、
// 查询降级成纯品牌泛搜。现改为结构化解析，对任意品类通用。
//
// 依据：亚马逊标题格式高度固定 ——「品牌 + 型号/修饰 + 品类名, 卖点1, 卖点2...」
//   1) 剥离品牌前缀
//   2) 在第一个标点分隔符 或 " with / for " 处截断（其后全是卖点堆砌）
//   3) 过滤规格 token（156 / 5QT / 6mm / Q30 / 9-in-1 / 2024）与通用营销词
//   4) 品类名落在剩余片段尾部 → 取尾部若干实词为 core

// 连接词：只在首尾剔除，夹在实词中间要保留（Robot Vacuum *and* Mop）
const CONNECTORS = new Set(['and', '&', 'with', 'for', 'of', 'in', 'to']);
// 通用噪音词：营销形容词 / 包装量词 / 单位。注意：这里【绝不能】放品类词。
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
  if (/^\d+$/.test(s)) return true;                                    // 156 / 5
  if (/^\d+(\.\d+)?(qt|oz|ml|l|g|kg|lb|lbs|mm|cm|in|inch|ft|w|v|mah|hz|khz|gb|tb|k|p)$/.test(s)) return true; // 5qt/6mm/1080p
  if (/^\d+(-|\s)?in(-|\s)?\d+$/.test(s)) return true;                 // 9-in-1
  if (/^[a-z]{1,3}\d{1,4}[a-z+]?$/.test(s) && s.length <= 5) return true; // Q30 / X8 / S30i / A9+（带 + 型号后缀）
  if (/^\d{1,2}[a-z]{1,2}$/.test(s)) return true;                      // 5G / 4K
  if (/^20\d{2}$/.test(s)) return true;                                // 2024
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

// ── 连接已在 9222 的调试 Chrome ──
async function tryConnectExisting(ms = 6000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const b = await chromium.connectOverCDP(CDP_URL);
      console.log('[+] 已连接到调试 Chrome（复用登录态）');
      return b;
    } catch (e) { await sleep(800); }
  }
  return null;
}

function printStartHelper() {
  console.log('\n' + '═'.repeat(64));
  console.log('  ✋ 需要本机带调试端口的 Chrome（含各平台登录态）');
  console.log('  请运行：');
  console.log('    Windows: scripts\\start_chrome_debug.bat');
  console.log('    Mac/Linux: bash scripts/start_chrome_debug.sh');
  console.log('  在弹窗 Chrome 里登录 Facebook / Pinterest / Instagram，然后重跑：');
  console.log('    node scan.js ' + TARGET_ASIN + (BRAND_ARG ? ' --brand=' + BRAND_ARG : ''));
  console.log('═'.repeat(64) + '\n');
}

// ── 亚马逊商品解析（取标题/品牌/价格/Coupon，供后续查询与报告使用） ──
async function fetchAmazonInfo(browser, asin) {
  const p = await newQuietPage(browser);
  const info = {
    asin, title: null,
    brand: BRAND_ARG || null, brand_source: BRAND_ARG ? 'manual(--brand)' : 'pending',
    product_keyword: PRODUCT_ARG || '', product_core: '', product_source: 'pending',
    price: null, coupon: null, site: SITE_ARG,
  };
  try {
    await p.goto(`https://www.${SITE_ARG}/dp/${asin}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForSelector('#productTitle', { timeout: 10000 }).catch(() => {});
    const title = await p.$eval('#productTitle', el => el.innerText).catch(() => null) || await p.title().catch(() => null);
    if (title) {
      info.title = title.trim();
      if (!BRAND_ARG) {
        // 品牌自动解析：优先 byline（"Visit the XXX Store" / "Brand: XXX"），兜底取标题首词。
        // 注意：不能 split(' ')[0] —— 多词品牌（Anker Soundcore / Amazon Basics）会被截断。
        const byline = await p.$eval('#bylineInfo', el => el.innerText).catch(() => '');
        const cleaned = (byline || '')
          .replace(/^Visit the\s+/i, '')
          .replace(/^Brand:\s*/i, '')
          .replace(/\s+Store$/i, '')
          .trim();
        info.brand = cleaned || title.trim().split(/\s+/)[0];
        info.brand_source = cleaned ? 'byline' : 'title-first-word';
      } else {
        info.brand_source = 'manual(--brand)';
      }
      const phrases = extractProductPhrases(title, info.brand);
      info.product_keyword = PRODUCT_ARG || phrases.full;
      info.product_core = PRODUCT_ARG ? '' : phrases.core;
      info.product_source = PRODUCT_ARG ? 'manual(--product)' : (phrases.full ? 'auto-from-title' : 'none');
    }
    // 价格
    const price = await p.$eval('#price_inside_buybox, .a-price .a-offscreen', el => el.innerText).catch(() => null);
    info.price = price ? price.trim() : null;
    // Coupon：页面含 " coupon" 文案或 "Save X%"
    const pageText = await p.evaluate(() => document.body.innerText).catch(() => '');
    const coup = pageText.match(/(?:coupon|save)\s*[:\-]?\s*(\d+)\s*%/i) || pageText.match(/(\d+)\s*%\s*coupon/i);
    if (coup) info.coupon = coup[0].trim();
  } catch (e) {
    console.log('[!] 解析亚马逊商品页失败（可能触发风控/拦截）: ' + e.message.split('\n')[0]);
  } finally {
    await p.close().catch(() => {});
  }
  return info;
}

// ── Facebook：直接复用已验证的 facebook_search.js（子进程） ──
function runFacebookScan(brand, product, asin) {
  return new Promise((resolve) => {
    const args = [path.join(SCRIPTS_DIR, 'facebook_search.js')];
    // 位置参数顺序固定为 [品牌, 产品词]：品牌为空时【绝不能】单独 push 产品词，
    // 否则产品词会被子进程当成品牌。此时干脆都不传，让子进程自己按 ASIN 解析。
    if (brand) {
      args.push(brand);
      if (product) args.push(product);
    }
    if (asin) args.push(`--asin=${asin}`);
    console.log(`\n[*] 运行 Facebook 扫描: node facebook_search.js ${brand || '(自动解析品牌)'} ${product || ''} ${asin ? '--asin=' + asin : ''}`.trim());
    const childEnv = Object.assign({}, process.env, {
      // 让 facebook_search.js 复用同一套静默策略（新标签页也不弹到最前）
      FBSCAN_QUIET: SHOW_WINDOW ? '0' : '1',
      FBSCAN_OUT_DIR: OUT_DIR,
      // 强制父子进程输出同名文件，否则子进程自动解析出品牌后会写成另一个文件名，父进程读不到
      FBSCAN_SAFE_NAME: safe,
    });
    const child = execFile(process.execPath, args, { cwd: SCRIPTS_DIR, windowsHide: true, env: childEnv }, (err) => {
      if (err) console.log('[!] Facebook 子进程异常: ' + err.message.split('\n')[0]);
      const jsonPath = path.join(OUT_DIR, `facebook_${safe}.json`);
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        resolve(data);
      } catch (e) {
        console.log('[!] 读取 Facebook 结果失败，跳过 FB 段: ' + e.message);
        resolve(null);
      }
    });
    child.stdout.on('data', d => process.stdout.write('' + d));
    child.stderr.on('data', d => process.stderr.write('' + d));
  });
}

// ── 通用「结果页采集」：从 DOM 里抽 href + 文本，还原 amazon 链接 ──
async function collectFromBrowser(page, url, waitSelector, scrollTimes, label) {
  console.log(`\n  [→] ${label}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    console.log(`  [!] 导航失败: ${e.message.split('\n')[0]} —— 跳过`);
    return [];
  }
  await page.waitForSelector(waitSelector, { timeout: 12000 }).catch(() => {});
  await sleep(3500);
  // 登录墙检测
  const loginWall = await page.$('input[name="email"], input[name="username"]');
  if (loginWall) {
    console.log(`  [!] 被踢到登录页（${label}）—— 请在调试 Chrome 里登录后重跑`);
    return [];
  }
  for (let i = 0; i < (scrollTimes || 4); i++) {
    await page.mouse.wheel(0, 1200);
    await sleep(1000);
  }
  const items = await page.evaluate(() => {
    const out = [];
    const blocks = Array.from(document.querySelectorAll('a[href]'));
    for (const a of blocks) {
      const href = a.href || '';
      const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 12) continue;
      out.push({ text, url: href, allLinks: Array.from(a.closest('div,article,li,section') ? a.closest('div,article,li,section').querySelectorAll('a') : []).map(x => x.href).filter(Boolean) });
    }
    // 去重：同一文本只留一条
    const seen = new Set();
    return out.filter(x => { const k = x.text.slice(0, 80).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 60);
  }).catch(() => []);
  items.forEach(it => {
    const amazon = extractAmazonLinkFromHrefs(it.allLinks && it.allLinks.length ? it.allLinks : [it.url]);
    Object.assign(it, parsePromo(it.text, amazon));
    delete it.allLinks;
  });
  console.log(`  [✓] ${label} 采集到 ${items.length} 条`);
  return items;
}

async function scanPinterest(page, queries) {
  if (SKIP_PINTEREST) return [];
  const out = [];
  for (const q of queries) {
    const url = 'https://www.pinterest.com/search/pins/?q=' + encodeURIComponent(q);
    const items = await collectFromBrowser(page, url, 'div[data-test-id], [role="main"] a', 5, 'Pinterest');
    items.forEach(it => { it.channel = 'Pinterest'; it.query_source = q; it.type = '种草图钉'; });
    out.push(...items);
    await sleep(2500);
  }
  return out;
}

async function scanInstagram(page, queries) {
  if (SKIP_INSTAGRAM) return [];
  const out = [];
  for (const q of queries) {
    const tag = q.split(/\s+/)[0];
    const url = 'https://www.instagram.com/explore/tags/' + encodeURIComponent(tag.toLowerCase()) + '/';
    const items = await collectFromBrowser(page, url, 'article, [role="main"] a', 4, 'Instagram');
    items.forEach(it => { it.channel = 'Instagram'; it.query_source = q; it.type = '红人帖'; });
    out.push(...items);
    await sleep(2500);
  }
  return out;
}

async function scanGoogle(page, queries) {
  if (SKIP_GOOGLE) return [];
  const out = [];
  for (const q of queries) {
    const url = 'https://www.google.com/search?num=20&q=' + encodeURIComponent(q);
    const items = await collectFromBrowser(page, url, '#search a, #rso a', 3, 'Google');
    items.forEach(it => { it.channel = 'Google'; it.query_source = q; it.type = '搜索结果'; });
    out.push(...items);
    await sleep(2500);
  }
  return out;
}

// ── 报告生成 ──
function buildQueries(brand, product, asin, core) {
  const q = [];
  if (asin) q.push(asin);                                        // ASIN 精确档：最可靠的命中信号
  if (brand) q.push(brand);                                      // 品牌泛搜档
  if (product) q.push(product);                                  // 完整产品词档
  if (brand && product) q.push(`${brand} ${product}`.trim());     // 品牌+产品词（最常见的帖子写法）
  // 核心词档：产品词偏长时，用尾部品类短语放宽召回
  // （如 full="Life Hybrid Active Noise Cancelling Headphones" → core="Noise Cancelling Headphones"）
  if (core && core.toLowerCase() !== String(product || '').toLowerCase()) {
    if (brand) q.push(`${brand} ${core}`.trim());
  }
  return [...new Set(q.filter(Boolean))];
}

function generateReport(agg) {
  const { amazon, facebook, pinterest, instagram, google } = agg;
  const lines = [];
  lines.push(`# ASIN 站外推广侦察报告 — ${amazon.brand || ''} ${amazon.product_keyword || ''}`.trim());
  lines.push('');
  lines.push(`- **目标 ASIN**: ${TARGET_ASIN}（站点 ${amazon.site}）`);
  lines.push(`- **亚马逊标题**: ${amazon.title || '(未取到)'}`);
  lines.push(`- **价格 / Coupon**: ${amazon.price || '未知'} / ${amazon.coupon || '无明显 Coupon'}`);
  lines.push(`- **生成时间**: ${new Date().toISOString()}`);
  lines.push('');

  const fbExact = (facebook && facebook.posts) ? facebook.posts.filter(p => p.asin_match === 'exact') : [];
  lines.push(`## 一、Facebook（精确命中）`);
  if (fbExact.length) {
    lines.push(`共 ${fbExact.length} 条 ASIN 精确命中帖：`);
    fbExact.forEach((p, i) => {
      lines.push(`${i + 1}. ${p.link || '(无链接)'}`);
      lines.push(`   - 折扣码: ${p.discount_code || '无'} ｜ 折扣力度: ${p.discount_pct ? p.discount_pct + '%' : '无'} ｜ #AD: ${p.is_ad ? '是' : '否'}`);
      lines.push(`   - 正文摘要: ${(p.text || '').slice(0, 200).replace(/\n/g, ' ')}`);
    });
  } else {
    lines.push(`本次 FB 实时采集未命中 ASIN 精确帖（可能登录态失效或未登录）。索引层覆盖见下文 Google 结果。`);
  }
  lines.push('');

  for (const [name, arr, ch] of [['Pinterest', pinterest, 'Pinterest'], ['Instagram', instagram, 'Instagram'], ['Google', google, 'Google']]) {
    lines.push(`## ${name === 'Google' ? '二' : name === 'Pinterest' ? '三' : '四'}、${name} 站外痕迹`);
    if (arr && arr.length) {
      const withAmazon = arr.filter(x => x.amazon_url);
      lines.push(`共采集 ${arr.length} 条；其中含 Amazon 链接 ${withAmazon.length} 条。`);
      arr.slice(0, 20).forEach((x, i) => {
        lines.push(`${i + 1}. ${x.url || '(无链接)'} — ${(x.text || '').slice(0, 160).replace(/\n/g, ' ')}`);
        if (x.amazon_url) lines.push(`   - Amazon: ${x.amazon_url} ｜ ASIN: ${x.asin || '?'} ｜ 折扣: ${x.discount_code || (x.discount_pct ? x.discount_pct + '%' : '无')}`);
      });
    } else {
      lines.push(`未采集到有效结果（可能需登录或遭遇风控）。`);
    }
    lines.push('');
  }

  lines.push('## 综合分析');
  lines.push(`- Facebook 是本品推广的主要站外阵地（需登录态实时采集才全）。`);
  lines.push(`- 若 Google/Pinterest/Instagram 出现含本 ASIN Amazon 链接的帖子，说明站外 affiliate/红人种草已存在，可在 CSV 明细里按「备注」列的 asin 状态甄别。`);
  lines.push(`- 报告与 CSV 仅作竞品/运营情报用途，请勿用于刷单或操纵排名。`);
  lines.push('');
  lines.push('---');
  lines.push(`明细见同目录 findings_${safe}.csv`);

  const md = lines.join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `report_${safe}.md`), md, 'utf8');
  console.log('[+] 已生成报告:', path.join(OUT_DIR, `report_${safe}.md`));
  return md;
}

function generateCSV(agg) {
  const rows = [];
  const pushRow = (r) => rows.push(r);
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\n/g, ' ').slice(0, 500)}"`;

  if (agg.facebook && agg.facebook.posts) {
    agg.facebook.posts.forEach(p => {
      pushRow([TARGET_ASIN, 'Facebook', p.type || '帖子', p.link || '', (p.text || '').slice(0, 200),
        p.discount_code || '', p.discount_pct || '', '', '', '',
        `asin_match=${p.asin_match || 'unknown'}; relevance=${p.relevance_label || ''}`].map(esc).join(','));
    });
  }
  ['pinterest', 'instagram', 'google'].forEach(ch => {
    (agg[ch] || []).forEach(x => {
      pushRow([x.asin || TARGET_ASIN, x.channel, x.type || '', x.url || '', (x.text || '').slice(0, 200),
        x.discount_code || '', x.discount_pct || '', '', '', '',
        `amazon=${x.amazon_url || '无'}`].map(esc).join(','));
    });
  });

  const header = 'ASIN,渠道,类型,URL,标题_摘要,折扣码,折扣力度,账号_红人,日期,截图路径,备注';
  const csv = header + '\n' + rows.join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `findings_${safe}.csv`), '\uFEFF' + csv, 'utf8'); // BOM 便于 Excel 打开中文
  console.log('[+] 已生成 CSV 明细:', path.join(OUT_DIR, `findings_${safe}.csv`), `（${rows.length} 行）`);
}

// ── 主流程 ──
async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await tryConnectExisting();
  if (!browser) {
    printStartHelper();
    process.exit(0);
  }

  // 一连上就先把窗口挪走，后续所有新标签页都开在这个「看不见」的窗口里
  const existing = (browser.contexts()[0] && browser.contexts()[0].pages()[0]) || null;
  if (existing) await hideWindow(existing);

  console.log(`\n${'═'.repeat(56)}`);
  console.log(`  ASIN 站外推广侦察 · 一体化 CLI v1.1.0`);
  console.log(`  目标 ASIN: ${TARGET_ASIN} ｜ 站点: ${SITE_ARG}`);
  console.log(`  skip: ${[SKIP_FB ? 'FB' : '', SKIP_PINTEREST ? 'Pinterest' : '', SKIP_INSTAGRAM ? 'Instagram' : '', SKIP_GOOGLE ? 'Google' : ''].filter(Boolean).join(',') || '无'}`);
  console.log(`${'═'.repeat(56)}\n`);

  // Step 1: 亚马逊解析
  console.log('[*] Step 1/5 解析亚马逊商品页...');
  const amazon = await fetchAmazonInfo(browser, TARGET_ASIN);
  if (amazon.title) console.log('    标题: ' + amazon.title);
  console.log('[✓] 品牌: ' + (amazon.brand || '?') + '   [' + (amazon.brand_source || '?') + ']');
  console.log('[✓] 产品词: ' + (amazon.product_keyword || '(未提取到)') + '   [' + (amazon.product_source || '?') + ']');
  if (amazon.product_core && amazon.product_core !== amazon.product_keyword) {
    console.log('    核心词: ' + amazon.product_core + '   (用于放宽召回)');
  }
  console.log('[✓] 价格: ' + (amazon.price || '?') + '   Coupon: ' + (amazon.coupon || '无'));

  const brand = amazon.brand || BRAND_ARG || '';
  const product = amazon.product_keyword || PRODUCT_ARG || '';
  // 解析出品牌后，把输出文件名从 ASIN 换成品牌（未传 --brand 时之前会一直用 ASIN 命名）
  if (!BRAND_ARG && amazon.brand) setSafeName(amazon.brand);
  const queries = buildQueries(brand, product, TARGET_ASIN, amazon.product_core);
  console.log('[✓] 自动拼接查询 (' + queries.length + '): ' + queries.join('  /  '));

  // Step 2: Facebook（复用 facebook_search.js）
  let facebook = null;
  if (!SKIP_FB) {
    console.log('\n[*] Step 2/5 Facebook 实时采集（复用 facebook_search.js）...');
    facebook = await runFacebookScan(brand, product, TARGET_ASIN);
  } else {
    console.log('\n[*] Step 2/5 跳过 Facebook（--skip-fb）');
  }

  const page = await newQuietPage(browser);

  // Step 3: Pinterest
  console.log('\n[*] Step 3/5 Pinterest 采集...');
  const pinterest = await scanPinterest(page, queries);

  // Step 4: Instagram
  console.log('\n[*] Step 4/5 Instagram 采集...');
  const instagram = await scanInstagram(page, queries);

  // Step 5: Google
  console.log('\n[*] Step 5/5 Google 采集...');
  const google = await scanGoogle(page, queries);

  // 聚合
  const agg = { asin: TARGET_ASIN, captured_at: new Date().toISOString(), amazon, facebook, pinterest, instagram, google, queries_used: queries };
  fs.writeFileSync(path.join(OUT_DIR, `scan_${safe}.json`), JSON.stringify(agg, null, 2), 'utf8');
  console.log('\n[+] 已保存聚合 JSON:', path.join(OUT_DIR, `scan_${safe}.json`));

  // 报告 + CSV
  if (!NO_REPORT) {
    generateReport(agg);
    generateCSV(agg);
  }

  // 收尾：把窗口挪回可视区并最小化（避免用户从任务栏还原后窗口还在屏幕外）
  await restoreWindow(page);
  await page.close().catch(() => {});

  console.log(`\n${'═'.repeat(56)}`);
  console.log('  ✅ 全部完成，结果在下面这个文件夹里：');
  console.log(`  📁 ${OUT_DIR}`);
  console.log('');
  if (NO_REPORT) {
    console.log('  └─ ' + `scan_${safe}.json` + '     ← 原始数据（已加 --no-report，未生成报告/CSV）');
  } else {
    console.log('  ├─ ' + `report_${safe}.md` + '     ← 看这个（Markdown 报告，双击可用记事本/VSCode 打开）');
    console.log('  ├─ ' + `findings_${safe}.csv` + '   ← 明细表（带 BOM，双击直接用 Excel 打开，中文不乱码）');
    console.log('  └─ ' + `scan_${safe}.json` + '     ← 原始数据（给程序用）');
  }
  console.log(`${'═'.repeat(56)}`);
  console.log('  调试 Chrome 保持打开（登录态可复用），已最小化到任务栏。');
  console.log('');
  await browser.close().catch(() => {});
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
