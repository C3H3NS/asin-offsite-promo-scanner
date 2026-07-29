# 查询词库与渠道扩展

本文件是 SKILL.md 的补充说明：给出可复用的搜索词模板，以及如何把渠道从「Google/Facebook/Pinterest/Instagram」扩展到 deal 站、论坛、视频平台。

---

## 一、搜索词推导模板（先解析亚马逊标题）

给定 ASIN → 拿到标题后，按下面 4 类词组合。把 `<品牌>` / `<产品核心词>` 替换成实际值。

| 类型 | 模板 | 用途 |
|------|------|------|
| 品牌词 | `<品牌>` | 广域召回 |
| 产品核心词 | `<产品核心词>` | 精准召回 |
| 组合词 | `<品牌> <产品核心词>` | 站外最常见写法 |
| 折扣意图 | `<品牌> coupon` / `<品牌> discount code` | 找折扣码 |
| 测评意图 | `<品牌> review` / `<品牌> <产品核心词> review` | 找红人/博客测评 |
| 联盟意图 | `<品牌> <产品核心词> amazon` | 找带 Amazon 联盟链接的页面 |
| 活动意图 | `<品牌> giveaway` / `<品牌> influencer` | 找抽奖/红人合作 |

> 提示：站外常用简写/别名。例如 "AI Translation Earbuds" 也可能写作 "translator earbuds" / "traductor audifonos"（西语）。标题里出现的外语词（如 Español / Inglés）也应纳入搜索词，覆盖西语市场。

---

## 二、各渠道搜索式

### Google（广域）
- `"<品牌> <产品核心词>"`
- `<品牌> <产品核心词> review`
- `<品牌> discount code`
- `<品牌> <产品核心词> amazon`

### 亚马逊站内
- 搜 `<品牌>` → 看同品牌矩阵、coupon
- 搜 `<产品核心词>` → 看排名、红人视频（Videos for this product）

### Facebook（自动，Google 索引）
- `site:facebook.com "<品牌> <精确产品词>"`（如 `site:facebook.com "Boytond AI Translation Earbuds"`）
- `site:facebook.com "<品牌> <精确产品词>" "discount"`

> ⚠️ 必须带**精确产品词**，不要只写品牌——只写品牌会召回同品牌其他型号（不同 ASIN）的无关帖。
> 实时脚本（`facebook_search.js`）需传 `--asin=<目标ASIN>`，脚本会比对每条链接的 ASIN：
> - `asin_match=exact` → 确为本产品，进主结果；
> - `asin_match=other` → 同品牌其他型号，单独分流到"其他 ASIN"附录，勿混淆；
> - 无 ASIN 但命中精确产品词 → 可参考，标注"未验证链接"。

### Pinterest
- `site:pinterest.com "<品牌> <产品核心词>"`
- Pinterest 站内搜 `<品牌>` → 看图钉外链

### Instagram
- `site:instagram.com "<品牌>"`
- IG 站内搜 `#<品牌>` / `#<品牌><产品>` → 看 reel / 帖子 / bio 链接

---

## 三、扩展渠道（按需开启）

在 SKILL.md 的「采集渠道」里追加，并套用下方搜索式：

| 渠道 | 搜索式 | 说明 |
|------|--------|------|
| Slickdeals | `site:slickdeals.net "<品牌>"` / `site:slickdeals.net "<产品核心词>"` | 美区头号 deal 站，看折扣力度与热门度 |
| RetailMeNot / CouponBirds | `site:retailmenot.com "<品牌>"` | 折扣码聚合 |
| Reddit | `site:reddit.com "<品牌> <产品核心词>"` | 看真实用户讨论/吐槽（埋点需求） |
| YouTube | `site:youtube.com "<品牌> <产品核心词>"` | 红人视频，看是否含 affiliate 描述 |
| TikTok | `site:tiktok.com "<品牌>"` / 搜 `#<品牌>` | 短视频种草 |
| DealNews / Kinja | `site:dealnews.com "<品牌>"` | 补充 deal 覆盖 |

---

## 四、多站点适配

| 站点 | 域名 | 折扣站/社媒差异 |
|------|------|----------------|
| 美国 | amazon.com | Slickdeals / Pinterest / IG 为主 |
| 英国 | amazon.co.uk | HotUKDeals；社媒偏 X(Twitter)/FB 群组 |
| 德国 | amazon.de | MyDealz；注意需德文关键词 + 德文包装/电气合规(VerpackG) |
| 日本 | amazon.co.jp | 日亚站内 + X(Twitter)/LINE/日本论坛；日亚红人视频生态弱 |
| 法国/意/西 | amazon.fr/.it/.es | 各自 deal 站；关键词用当地语言 |

切换站点时：①改亚马逊域名；②把搜索词翻译成当地语言；③换对应折扣站。
