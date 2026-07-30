// gen_report.js — 读取 offsite-output/facebook_<brand>.json，生成 Markdown 分析报告
// 用法: node scripts/gen_report.js            (自动取最新 facebook_*.json)
//       node scripts/gen_report.js <brand>   (指定 brand，读取 facebook_<brand>.json)
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'offsite-output');

function pickJson(brandArg) {
  if (brandArg) {
    const p = path.join(OUT_DIR, `facebook_${brandArg}.json`);
    if (fs.existsSync(p)) return p;
    console.error('[!] 未找到', p);
    process.exit(1);
  }
  const files = fs.readdirSync(OUT_DIR)
    .filter(f => f.startsWith('facebook_') && f.endsWith('.json'))
    .map(f => ({ f, m: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!files.length) { console.error('[!] offsite-output 下无 facebook_*.json'); process.exit(1); }
  return path.join(OUT_DIR, files[0].f);
}

const jsonPath = pickJson(process.argv[2]);
const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const s = j.summary || {};
const posts = j.posts || [];

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '-');
const esc = (t) => (t == null ? '' : String(t)).replace(/\|/g, '\\|');
const couponRe = /coupon\s*[:\-]\s*([0-9]{1,3}%|[A-Z0-9]{4,12})/i;

const L = [];
L.push(`# ${esc(j.brand)} — ASIN 站外推广侦察报告`);
L.push('');
L.push(`> 生成时间：${fmtTime(j.captured_at)} ｜ 数据源：${path.basename(jsonPath)} ｜ 工具版本：facebook_search.js v4.4.5`);
L.push('');

// 一、扫描概况
L.push('## 一、扫描概况');
L.push('');
L.push('| 项目 | 内容 |');
L.push('| --- | --- |');
L.push(`| 目标品牌 | ${esc(j.brand)} |`);
L.push(`| 精确产品词 | ${esc(j.category)} |`);
L.push(`| 目标 ASIN | ${esc(j.target_asin || '(未指定)')} |`);
const qcov = (Array.isArray(j.queries_used) && j.queries_used.length) ? j.queries_used.map(esc).join(' / ') : '-';
L.push(`| 查询变体 | ${qcov} |`);
L.push(`| 浏览器启动方式 | ${j.launched_by_script ? '脚本自启' : '复用已登录调试 Chrome'} |`);
L.push('| 长帖展开 | 已启用（自动点击 See more / 展开，精确匹配开关，避免误点商品卡） |');
L.push('');

// 二、核心指标
L.push('## 二、核心指标');
L.push('');
L.push('| 指标 | 数值 |');
L.push('| --- | --- |');
L.push(`| 原始命中帖子 | ${s.total_raw ?? 0} |`);
L.push(`| 去重后帖子 | ${s.total_deduped ?? 0} |`);
L.push(`| 含 Amazon 链接 | ${s.with_amazon_link ?? 0} |`);
L.push(`| 含折扣码/促销 | ${s.with_discount_code ?? 0} |`);
L.push(`| 🎯 ASIN 精确命中 (exact) | **${s.asin_exact ?? 0}** |`);
L.push(`| 其他 ASIN (疑似非目标) | ${s.asin_other ?? 0} |`);
L.push(`| 标记 #AD 推广 | ${s.ad_marked ?? 0} |`);
L.push(`| 来自 Deal 群组 | ${s.from_deal_groups ?? 0} |`);
L.push(`| 相关性 高(3)/中(2)/低(1) | ${s.relevance_high ?? 0} / ${s.relevance_mid ?? 0} / ${s.relevance_low ?? 0} |`);
L.push('');

// 三、目标帖精确命中
const exactPosts = posts.filter(p => p.asin_match === 'exact');
L.push('## 三、🎯 目标帖精确命中详情');
L.push('');
if (exactPosts.length === 0) {
  L.push('⚠️ 本次扫描未精确命中目标 ASIN。可能原因：Facebook 搜索对该帖返回不稳定（风控/排序波动）。详见第七节「已知局限」。');
  L.push('');
} else {
  exactPosts.forEach((p) => {
    L.push('### 命中帖 #1');
    L.push('');
    L.push(`- **相关性**：${p.relevance}（${esc(p.relevance_label)}）`);
    L.push(`- **ASIN 校验**：${esc(p.asin_match)}`);
    L.push(`- **Amazon 链接**：${esc(p.amazon_url || '(无)')}`);
    L.push(`- **站点**：${esc(p.amazon_site || '-')}`);
    L.push(`- **折扣码**：${esc(p.discount_code || '(无)')}`);
    const couponM = (p.text || '').match(couponRe);
    if (couponM) L.push(`- **促销力度**：${esc(couponM[0])}`);
    L.push(`- **是否 #AD**：${p.is_ad ? '是' : '否'} ｜ **Deal 群组**：${p.is_deal_group ? '是' : '否'}`);
    L.push(`- **命中查询来源**：${esc(p.query_source || '-')}`);
    L.push(`- **帖子链接**：${esc(p.link || '(无)')}`);
    L.push('');
    L.push('**完整正文（人工点开 See more 后所见，emoji/国旗忽略）：**');
    L.push('');
    L.push('```');
    L.push((p.text || '').trim());
    L.push('```');
    L.push('');
  });
}

// 四、折扣码 & 促销线索（仅目标 ASIN 命中帖）
const withCodes = exactPosts.filter(p => p.discount_code);
L.push('## 四、折扣码 & 促销线索汇总（目标 ASIN）');
L.push('');
if (withCodes.length === 0) {
  L.push('目标命中帖中未发现明确折扣码（部分帖可能以图片形式展示，文本未捕获）。');
  L.push('');
} else {
  withCodes.forEach((p, i) => {
    const snippet = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    L.push(`${i + 1}. 折扣码 \`${esc(p.discount_code)}\` — ${esc(snippet)}`);
  });
  L.push('');
}

// 五、站外渠道分布（基于目标 ASIN 命中帖）
L.push('## 五、站外渠道分布');
L.push('');
const telegram = exactPosts.filter(p => /t\.me|telegram/i.test(p.text || ''));
const groups = exactPosts.filter(p => p.is_deal_group);
L.push(`- **Telegram 渠道线索**：${telegram.length} 条`);
telegram.slice(0, 5).forEach(p => {
  const m = (p.text || '').match(/https?:\/\/t\.me\/\S+/i);
  if (m) L.push(`  ↳ ${esc(m[0])}`);
});
L.push(`- **Facebook Deal / 优惠群组**：${groups.length} 条`);
L.push(`- **直接 Amazon 链接帖**：${exactPosts.filter(p => p.amazon_url).length} 条`);
L.push('');

// 六、已知局限与方法说明
L.push('## 六、已知局限与方法说明');
L.push('');
L.push('- **Facebook 搜索返回不稳定**：同一 ASIN 不同时间搜索，召回的帖子集合可能不同（受 FB 排序/风控影响）。目标帖仅在特定查询（多为直接搜 ASIN）时稳定召回。');
L.push('- **限流风险**：短时间内多次导航易触发 `ERR_CONNECTION_CLOSED`。脚本已加入「预热后 8s + 查询间 6s」冷却缓解；若仍被限流，被跳过的查询可单独重跑。');
L.push('- **命中逻辑**：FB 会把 amazon 链接包成 `l.facebook.com/l.php?u=<编码地址>`，脚本在 Node 侧解码提取 ASIN；长帖「展开」开关采用文本精确匹配（= 展开 / See more / 更多），避免误点亚马逊商品卡价格区。');
L.push(`- **本次查询覆盖**：${qcov}（若日志显示部分查询被限流跳过，对应渠道数据可能缺失）。`);
L.push('');

// 七、运营建议
L.push('## 七、运营建议（基于本次结果）');
L.push('');
if (exactPosts.length > 0) {
  const t = exactPosts[0];
  const tCoupon = (t.text || '').match(couponRe);
  L.push(`1. **目标 ASIN ${esc(j.target_asin)} 已在站外被推广捕获**，推广形态为「分享 Amazon 链接 + Coupon + 引流 Telegram 群组」。`);
  if (tCoupon) L.push(`2. 该帖投放了促销力度 \`${esc(tCoupon[0])}\`，可用于监控站外价格体系是否被击穿、评估是否需调整 Coupon 力度。`);
  else L.push(`2. 帖文含 Coupon 字样但未提取到明确码/力度，建议人工核对折扣力度。`);
  L.push('3. 主引流阵地为 Telegram（USA_Online_Shopping_Deals 类频道），建议同步监控 Telegram 渠道的曝光与转化。');
  L.push('4. 将该 ASIN 加入周期扫描（建议每周 1-2 次），持续追踪新增推广帖与折扣力度变化。');
} else {
  L.push('1. 本次未精确命中目标 ASIN，建议间隔一段时间后重跑（避开 FB 风控窗口）。');
  L.push('2. 可补充 Telegram / Reddit / 独立站联盟等渠道做交叉验证。');
}
L.push('');

const md = L.join('\n');
const brandSafe = (j.brand || 'report').replace(/[^A-Za-z0-9_-]/g, '_');
const outPath = path.join(OUT_DIR, `report_${brandSafe}.md`);
fs.writeFileSync(outPath, md, 'utf8');
console.log('[+] 报告已生成:', outPath);
console.log('    字节数:', Buffer.byteLength(md, 'utf8'));
