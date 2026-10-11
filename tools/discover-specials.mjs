#!/usr/bin/env node
/**
 * tools/discover-specials.mjs
 * ---------------------------------------------------------------
 * 【新增 2026-10-11】每日特价雷达 —— 后端采集器
 *
 * 职责：每天抓一次 Steam 正在打折的游戏，产出 data/specials.json，
 *      供页面「今日特价雷达」区块展示、并供邮件「全站好价 TOP 20」使用。
 *
 * 为什么用「商店搜索接口」而不是特惠日历：
 *   api/featuredcategories 的 specials 分类实测只有 10 条 —— 远远不够看。
 *   search/results?specials=1&cc=cn 实测 total_count 9566，且每条都带
 *   折扣百分比 / 原价 / 现价 / 好评率 / 评测数 / 发售日 / 平台，是最完整的信息源。
 *   featuredcategories 只作为「补充」并入（它带 discount_expiration，是
 *   搜索接口没有的字段）。
 *
 * 【铁律】
 *   1. 绝不编造数据：解析不到的字段一律留空/不写，不猜。
 *   2. 失败绝不拖垮主线：任何异常都只 warn + 写空结果，**退出码保持 0**。
 *      （沿用 daily-refresh 的自愈原则：宁可发一封没有雷达的邮件，
 *        也不要让整个刷新任务红掉、当天没邮件。）
 *   3. 复用 daily-refresh 的重试/ 自适应限速，不新造轮子、不并发。
 *
 * 运行：node tools/discover-specials.mjs
 *
 * 可选环境变量（括号内为默认值）：
 *   SPECIALS_MIN_DISCOUNT(0)   最低折扣百分比，低于此值丢弃。**默认 0 = 不限**（2026-10-11 起）
 *   SPECIALS_MIN_REVIEWS(300)  质量门槛：有好评等级但评测总数少于它 → 丢弃
 *   SPECIALS_PER_PAGE(50)      每页拉多少条
 *   SPECIALS_MAX_PAGES(10)     最多翻几页（10×50 = 500 条候选）
 *   SPECIALS_RECENT_DAYS(0)    只保留最近 N 天内发售的（0 = 不限制）
 *   SPECIALS_ENABLED(true)     总开关，false 时只读旧文件不动网络
 *   STEAM_CC(cn) STEAM_LANG(schinese)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPECIALS_FILE = path.join(ROOT, 'data', 'specials.json');
const DATA_FILE = path.join(ROOT, 'data', 'wishlist.json');
/* 【2026-10-12 新增】已购库。fetch-owned.mjs 产出，字段极简（appid + playtimeForever）。
   它和上面 wishlist.json 是**两个完全不同的东西**，别再混用 —— 见 readExclusionSets。 */
const OWNED_FILE = path.join(ROOT, 'data', 'owned.json');

/* Steam 好评等级一共 7 档。前 3 档算好评，后 4 档（mixed / mostly_negative /
   negative / overwhelmingly_negative）就是「差评或褒贬不一」—— 直接判为烂游戏挡掉。
   注意 mixed 是「褒贬不一」：销量往往还很高，但用户骂声一片，正是最该挡的一档。 */
const GOOD_REVIEW_SUMMARIES = new Set(['overwhelmingly_positive', 'very_positive', 'mostly_positive']);
const BAD_REVIEW_SUMMARIES = new Set(['mixed', 'mostly_negative', 'negative', 'overwhelmingly_negative']);

/* CFG 导出：测试要直接断言默认值（E3-8），别只能靠正则猜源码。 */
export const CFG = {
  cc: process.env.STEAM_CC || 'cn',
  lang: process.env.STEAM_LANG || 'schinese',
  /* ---- 折扣门槛：2026-10-11 起默认 0 = 不限 ----
     用户原话：「不要限制」「不要什么牛马小游戏烂游戏进来」。
     注意这两句说的不是同一件事：**折扣力度不设限**（-10% 也照样给你看），
     **质量另设门槛**（见下面 minReviewCount / judgeQuality）——
     旧版把「折扣 < 50% 就丢」当成了质量控制，那是偷懒：
     -95% 的烂游戏照样过 50% 门槛，结果烂游戏照样进来，而 -30% 的好游戏反被砍了。 */
  minDiscount: Number(process.env.SPECIALS_MIN_DISCOUNT || 0),
  /* ---- 质量门槛（2026-10-11 新增，判据见 judgeQuality 的注释）---- */
  minReviewCount: Number(process.env.SPECIALS_MIN_REVIEWS || 300),
  perPage: Number(process.env.SPECIALS_PER_PAGE || 50),
  /* 候选页数从 4 → 10：折扣放开后候选变多，得多翻几页才不漏（4×50=200 → 10×50=500） */
  maxPages: Number(process.env.SPECIALS_MAX_PAGES || 10),
  /* 0 = 不按发售时间过滤（Steam 特价常包含老游戏神作，不该一刀切掉） */
  recentDays: Number(process.env.SPECIALS_RECENT_DAYS || 0),
  enabled: String(process.env.SPECIALS_ENABLED || 'true') !== 'false',
  timeoutMs: Number(process.env.REQ_TIMEOUT_MS || 20000),
};

function log(s) { console.log('[specials] ' + s); }
function warn(s) { console.log('[specials] ⚠ ' + s); }

/* ==================================================================
 * 一、HTML 解析（纯函数，无副作用 —— 这些会被 _test_specials.cjs 直接断言）
 * ================================================================== */

/* Steam 的搜索结果里，一个游戏 = 一个 <a class="search_result_row" data-ds-appid="...">…</a>
 * 块。我们按 data-ds-appid 定位块起点，再按下一个块的起点（或字符串末尾）截断，
 * 这样即使 Steam 改了内部 div 结构，只要外层锚点还在就仍能解析。
 *
 * ⚠️ 属性顺序不能写死。真实样本里 class 排在 data-ds-appid 前面，但 Steam 改版
 *    随时可能调换；若正则写成「appid 在前、class 在后」，一改版就会静默解析出 0 条
 *    —— 而且不报错，只会写出一份空 specials.json。所以这里两个属性各自独立断言，
 *    只要求它们出现在同一个 <a …> 标签里，顺序不限。 */
const ROW_SPLIT_RE = /<a\s(?=[^>]*data-ds-appid="(\d+)")(?=[^>]*class="[^"]*\bsearch_result_row\b)[^>]*>/g;

/* HTML 实体解码。
 * 为什么要补数值实体：Steam 的 tooltip 属性里，数字/空格常被写成 &#x20;（十六进制）
 * 或 &#32;（十进制）。只认 &nbsp;/&quot; 的话，一旦 Steam 把中文 tooltip 改成编码形式，
 * 好评率会整片解析成 null —— 而这个字段是排序权重的输入，悄悄失效很难发现。 */
function htmlDecode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
/* 非法码点直接丢弃，绝不让它变成 U+FFFD 混进游戏名 */
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 32 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch (e) { return ''; }
}
function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }
/* 从 "¥279.00" / "1,234.56" 里取数字。
 * ⚠️ 必须支持小数：Steam 的原价几乎都带两位小数（¥279.00），只取整数会把
 * 279.00 变成 279 —— 单价看似无害，但页面上的「省了多少」和排序都会算错。 */
function pickInt(s) {
  const m = String(s || '').match(/(\d[\d,]*)(?:\.(\d+))?/);
  if (!m) return null;
  const intPart = m[1].replace(/,/g, '');
  const frac = m[2] ? '.' + m[2] : '';
  const n = Number(intPart + frac);
  return Number.isFinite(n) ? n : null;
}

/* 从一个结果块里抠出全部字段。任何一项抠不到就留 null，绝不用默认值伪造。 */
export function parseSearchRow(block, appid) {
  const out = {
    appid: Number(appid),
    name: null,
    discountPercent: null,
    finalPrice: null,
    originalPrice: null,
    currency: 'CNY',
    reviewSummary: null,   // positive / mostly_positive / mixed …
    reviewPct: null,       // 好评率数字，如 90
    reviewCount: null,     // 评测总数，如 239506
    releaseDate: null,     // 原文，如 "2019 年 12 月 5 日"
    releaseTs: null,       // 解析出的时间戳，解析不了就是 null
    platforms: [],
    tinyImage: null,
  };

  // 名称：<span class="title">…</span>
  const nm = block.match(/<span class="title">([\s\S]*?)<\/span>/);
  if (nm) out.name = htmlDecode(stripTags(nm[1])).trim() || null;

  // 折扣百分比：<div class="discount_pct">-75%</div>
  const dp = block.match(/discount_pct[^>]*>\s*-?\s*(\d+)\s*%/);
  if (dp) out.discountPercent = Number(dp[1]);

  // 现价：data-price-final 是「分」，¥69.75 → 6975
  const pf = block.match(/search_price_discount_combined[^>]*data-price-final="(\d+)"/);
  if (pf) out.finalPrice = Number(pf[1]) / 100;

  // 原价：<div class="discount_original_price">¥279.00</div>
  const op = block.match(/discount_original_price[^>]*>([\s\S]*?)<\/div>/);
  if (op) {
    const txt = stripTags(op[1]).trim();
    const n = pickInt(txt);
    if (n != null) out.originalPrice = n;
  }

  // 好评率与评测数：从 tooltip 里抠「…的 239,506 篇用户评测中有 90% 为好评」
  //   注意 tooltip 是 HTML 实体，必须先 decode 再抠，否则中文和 % 会被切碎。
  const tip = block.match(/data-tooltip-html="([\s\S]*?)"/);
  if (tip) {
    const t = htmlDecode(tip[1]);
    const pct = t.match(/有\s*(\d+(?:\.\d+)?)\s*%\s*为好评/);
    if (pct) out.reviewPct = Number(pct[1]);
    const cnt = t.match(/([\d,]+)\s*篇用户评测/);
    if (cnt) out.reviewCount = Number(cnt[1].replace(/,/g, ''));
  }
  // 好评等级：<span class="search_review_summary positive" …>
  const lv = block.match(/class="search_review_summary\s+([a-z_]+)"/);
  if (lv) out.reviewSummary = lv[1];

  // 发售日
  const rd = block.match(/class="search_released[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  if (rd) {
    const txt = htmlDecode(stripTags(rd[1])).trim();
    if (txt) out.releaseDate = txt;
    out.releaseTs = parseChineseDate(txt);
  }

  // 平台：<span class="platform_img win"></span>
  block.replace(/class="platform_img\s+([a-z]+)"/g, (m, p) => { if (out.platforms.indexOf(p) < 0) out.platforms.push(p); return m; });

  // 头图
  const im = block.match(/<img src="(https:[^"]+)"/);
  if (im) out.tinyImage = im[1];

  return out;
}

/* 「2019 年 12 月 5 日」/「2019年12月5日」/「Dec 5, 2019」→ 时间戳。
 * 解析不了返回 null（绝不返回 0 冒充「1970 年」）。 */
export function parseChineseDate(text) {
  if (!text) return null;
  const s = String(text);
  const cn = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (cn) {
    const y = +cn[1], mo = +cn[2], d = +cn[3];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d);
  }
  const only = s.match(/^(\d{4})\s*年\s*(\d{1,2})\s*月$/);
  if (only) {
    const y = +only[1], mo = +only[2];
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12) return null;
    return Date.UTC(y, mo - 1, 1);
  }
  const en = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (en) {
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mo = MON[en[1].slice(0, 3).toLowerCase()];
    if (mo == null) return null;
    return Date.UTC(+en[3], mo, +en[2]);
  }
  return null;
}

/* 把 results_html 切成一个个游戏块并解析。 */
export function parseSearchResults(resultsHtml) {
  const html = String(resultsHtml || '');
  const hits = [];
  const re = new RegExp(ROW_SPLIT_RE.source, 'g');
  let m;
  while ((m = re.exec(html)) !== null) hits.push({ appid: m[1], idx: m.index, headLen: m[0].length });
  const rows = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].idx;
    // 块的结束 = 下一个 data-ds-appid 出现处；注意下一个匹配可能更早（页头也有 appid），
    // 所以要用「下一个 search_result_row 的起点」而不是任意 data-ds-appid。
    const end = (i + 1 < hits.length) ? hits[i + 1].idx : html.length;
    if (end <= start) continue;
    rows.push(parseSearchRow(html.slice(start, end), hits[i].appid));
  }
  return rows;
}

/* ==================================================================
 * 二、筛选与分档（纯函数）
 * ================================================================== */

/* 折扣百分比 → 折扣档。用于页面上「只看 X 折以上」的筛选器。 */
export function discountTier(pct) {
  if (pct == null) return null;
  if (pct >= 90) return 'S';
  if (pct >= 75) return 'A';
  if (pct >= 60) return 'B';
  return 'C';
}

/* 综合分档：折扣力度是大头，好评率是加权，评价数太少要打折。
 * 目的是让「-80% 且好评率 95% 的 3 万篇评测」排在前面，
 * 而不是「-95% 但好评率 60% 的 12 篇评测」。
 *
 * ⚠️ 权重是调出来的，不是拍脑袋定的。判据（见 _test_specials.cjs D 组）：
 *   · 折扣仍是最大权重        → 同好评率下 -95% 必须高于 -50%
 *   · 好评率能翻盘            → -70%/97%/12 万评测 要压过 -95%/60%/12 篇评测
 *   · 评测数加成封顶（+8）    → 刷量不能把垃圾游戏顶上榜
 *   · 无评价数据降权 -10      → 「没数据」不等于「好评」
 * 早期版本折扣权重 1.0、好评权重 0.35，实测结果是「-95%/60% 以 97.2 分压过
 * -70%/97% 的 88.9 分」，正好和上面这句意图相反，所以调成了下面这组。 */
export function computeScore(it) {
  const d = Number(it.discountPercent) || 0;
  const pct = Number(it.reviewPct);
  const cnt = Number(it.reviewCount) || 0;
  let s = d * 0.7;                                    // 折扣 0~95，仍是最大头
  if (pct != null && !isNaN(pct)) s += (pct - 60) * 0.6; // 好评率加权：40 分差 ≈ 24 分，能翻盘
  else s -= 10;                                       // 没有评价数据 → 降权，不奖不罚到虚高
  // 样本太小的评价不可信，用对数温和加成，最多 +8
  if (cnt > 0) s += Math.min(8, Math.log10(cnt + 1) * 2.2);
  return Math.round(s * 10) / 10;
}

/* ★ 质量门槛（2026-10-11 新增）——「不要牛马小游戏烂游戏进来」的落点。
   判据（按这个顺序，命中即挡）：
     ① 好评等级落在 mixed / mostly_negative / negative / overwhelmingly_negative
        → 挡。mixed（褒贬不一）最该挡：这种游戏销量往往很高，但骂声一片。
     ② 有好评等级、但评测总数 < minReviewCount（默认 300）
        → 挡。样本太小说明不了质量：可能是刚上架的独立小游戏，也可能是刷出来的分。
     ③ **评分或评测数根本没抓到** → **放行**。
        这一条是故意的：我们抓不到数据不等于游戏不好，凭「没数据」把一款好游戏藏起来
        就是静默砍数据。放行后由 computeScore 降权 -10 排在后面，你自己一眼能看出来它没数据。

   返回 { ok, why }：why 为空串表示通过，非空表示被挡的原因（写进日志，便于排查）。 */
export function judgeQuality(it, cfg) {
  const c = cfg || CFG;
  const sum = String((it && it.reviewSummary) || '');
  const cnt = Number(it && it.reviewCount) || 0;
  if (BAD_REVIEW_SUMMARIES.has(sum)) return { ok: false, why: '评分「' + sum + '」' };
  if (sum && cnt > 0 && cnt < c.minReviewCount) return { ok: false, why: '评测仅 ' + cnt + ' 条（< ' + c.minReviewCount + '）' };
  return { ok: true, why: '' };
}

/* 过滤：折扣不再设门槛（默认 0），改由 judgeQuality 控质量；
   名字缺失、appid 不合法的照旧剔除。

   【2026-10-12】ex 传 readExclusionSets() 的返回值 { ownedSet, wishSet }。
   两个标记语义不同、必须分开：
     r.alreadyOwned = 已在 Steam 库（真买了）
     r.inWishlist   = 已在愿望单（还没买）
   老的第三个参数是「愿望单 appid 集合」，现在只当 inWishlist 用。 */
export function filterItems(rows, cfg, ex) {
  const c = cfg || CFG;
  const ownedSet = (ex && ex.ownedSet) || new Set();
  const wishSet = (ex && ex.wishSet) || (ex instanceof Set ? ex : new Set());
  const now = Date.now();
  const out = [];
  const rejected = { discount: 0, quality: 0, recent: 0 };
  for (const r of rows) {
    if (!r.appid || r.appid <= 0) continue;
    if (!r.name) continue;
    const d = Number(r.discountPercent) || 0;
    if (d < c.minDiscount) { rejected.discount++; continue; }
    const q = judgeQuality(r, c);
    if (!q.ok) { rejected.quality++; continue; }
    if (c.recentDays > 0) {
      if (!r.releaseTs) { rejected.recent++; continue; }
      if (now - r.releaseTs > c.recentDays * 86400000) { rejected.recent++; continue; }
    }
    r.tier = discountTier(d);
    r.score = computeScore(r);
    r.alreadyOwned = ownedSet.has(r.appid);
    r.inWishlist = wishSet.has(r.appid);
    out.push(r);
  }
  filterItems.lastRejected = rejected;   // 供调用方写日志（不静默丢弃，要能解释）
  // 去重（同一 appid 可能因分页重叠出现两次）
  const seen = new Set();
  const uniq = [];
  for (const r of out) {
    if (seen.has(r.appid)) continue;
    seen.add(r.appid);
    uniq.push(r);
  }
  uniq.sort((a, b) => (b.score - a.score) || (a.finalPrice || 0) - (b.finalPrice || 0));
  return uniq;
}

/* ==================================================================
 * 三、网络（复用 daily-refresh 的重试/ 限速，不重造轮子）
 * ================================================================== */
let net = null;
async function getNet() {
  if (net) return net;
  // 动态 import：daily-refresh 顶层没有副作用（main 只在被直接执行时调用），安全
  const mod = await import('./daily-refresh.mjs');
  net = { fetchJSON: mod.fetchJSON, fetchTextRetry: mod.fetchTextRetry, log: mod.log, warn: mod.warn };
  return net;
}

function searchUrl(start, count) {
  const q = new URLSearchParams({
    query: '', start: String(start), count: String(count),
    dynamic_data: '', sort_by: '_ASC', specials: '1', infinite: '1',
    cc: CFG.cc, l: CFG.lang, snr: '1_7_7_230_7',
  });
  return 'https://store.steampowered.com/search/results/?' + q.toString();
}

/* 抓一页。失败返回 null（不抛），由上层决定要不要提前收手。 */
async function fetchPage(start) {
  try {
    const n = await getNet();
    const data = await n.fetchJSON(searchUrl(start, CFG.perPage), { retries: 4 });
    if (!data || data.success === false) return null;
    return { html: data.results_html || '', total: Number(data.total_count) || 0 };
  } catch (e) {
    warn('第 ' + start + ' 条起的一页抓取失败：' + (e && e.message));
    return null;
  }
}

/* ==================================================================
 * 四、主流程
 * ================================================================== */
/* 【2026-10-12 重写】把「已购」和「在清单」拆成两个**语义完全不同**的集合。

   ⚠️ 这一段以前是个隐蔽的 bug，务必读懂再改：
   旧函数叫 `readOwnedIds()`、日志打「本机清单 N 款」，看起来像在判「买没买过」，
   但它 DATA_FILE 指向的是 **wishlist.json（愿望单）**，判的其实是「在不在你的愿望单里」。
   函数注释是准确的，只有函数名和日志在误导 —— 于是「已购但已从愿望单移除的游戏」
   会被当成好价推给用户，还带「加入清单」按钮。实测漏网 18 款。

   现在两个数据源各管一件事：
     · owned.json  → alreadyOwned  你**已经买过**（Steam 库里真有）
     · wishlist.json → inWishlist  你**在清单里**（还没买）

   返回 ok 标志而不是静默降级：owned.json 读不到时把 ownedSet 留空但 ok=false，
   由 main() 写进产物顶层，页面据此显示警告条。老实说「没读到」，
   比假装「你什么都没买过」安全得多 —— 后者会让推荐区把 310 条全推出来。 */
function readExclusionSets() {
  const res = { ownedSet: new Set(), wishSet: new Set(), ownedOk: false, ownedNote: '' };

  // ① 已购库：读不到是「异常」，必须报出去
  try {
    if (!fs.existsSync(OWNED_FILE)) {
      res.ownedNote = 'owned.json 不存在（CI 还没跑，或 FETCH_OWNED 没开）';
    } else {
      const d = JSON.parse(fs.readFileSync(OWNED_FILE, 'utf8'));
      if (d && d.error) {
        res.ownedNote = 'owned.json 带错误标记：' + String(d.error);
      } else if (!Array.isArray(d.games) || !d.games.length) {
        res.ownedNote = 'owned.json 里一款游戏都没有';
      } else {
        for (const g of d.games) if (g && g.appid) res.ownedSet.add(Number(g.appid));
        res.ownedOk = true;
      }
    }
  } catch (e) {
    res.ownedNote = '读 owned.json 失败：' + (e && e.message);
  }
  if (!res.ownedOk) warn('⚠ 已购库未就绪（' + res.ownedNote + '）—— 雷达将无法按「已购」过滤，推荐结果可能包含你已买过的游戏');

  // ② 愿望单：读不到只是没法标「已在清单」，不影响推荐本身
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const gs = Array.isArray(d.games) ? d.games : [];
      for (const g of gs) if (g && g.appid) res.wishSet.add(Number(g.appid));
    }
  } catch (e) {
    warn('读 wishlist.json 失败（雷达仍会工作，只是不标「已在清单」）：' + (e && e.message));
  }

  return res;
}

/* 抓 Steam 官方特惠日历，只为了拿 discount_expiration（搜索接口没有这个字段）。 */
async function fetchExpirationMap() {
  try {
    const n = await getNet();
    const url = 'https://store.steampowered.com/api/featuredcategories/?cc=' + CFG.cc + '&l=' + CFG.lang;
    const data = await n.fetchJSON(url, { retries: 3 });
    const map = new Map();
    const lists = [];
    if (data && Array.isArray(data.specials)) lists.push(data.specials);
    // 分类 0/1 里有正在打折的条目，能补则补
    if (Array.isArray(data)) for (const k of [0, 1]) if (Array.isArray(data[k])) lists.push(data[k]);
    for (const arr of lists) {
      for (const it of arr) {
        const id = Number(it && it.id);
        if (!id || !it.discount_expiration) continue;
        map.set(id, Number(it.discount_expiration) * 1000); // 秒 → 毫秒
      }
    }
    return map;
  } catch (e) {
    warn('特惠日历抓取失败（只影响折扣截止时间，其余不受影响）：' + (e && e.message));
    return new Map();
  }
}

function writeOut(payload) {
  try {
    fs.mkdirSync(path.dirname(SPECIALS_FILE), { recursive: true });
    fs.writeFileSync(SPECIALS_FILE, JSON.stringify(payload, null, 1));
    return true;
  } catch (e) {
    warn('写 data/specials.json 失败：' + (e && e.message));
    return false;
  }
}

export async function main() {
  const now = new Date();

  if (!CFG.enabled) {
    log('SPECIALS_ENABLED=false —— 跳过抓取，保留既有 data/specials.json');
    return { skipped: true };
  }

  const ex = readExclusionSets();
  log(`已购库 ${ex.ownedSet.size} 款（用于标记「已拥有」）`
    + ` · 你的清单 ${ex.wishSet.size} 款（用于标记「已在清单」）`);

  let rows = [];
  let total = 0;
  let pagesOk = 0;
  for (let p = 0; p < CFG.maxPages; p++) {
    const start = p * CFG.perPage;
    const r = await fetchPage(start);
    if (!r) { warn(`第 ${p + 1} 页失败，提前收手（已有数据照常产出）`); break; }
    const got = parseSearchResults(r.html);
    if (got.length) pagesOk++;
    rows = rows.concat(got);
    total = r.total;
    log(`第 ${p + 1}/${CFG.maxPages} 页：解析到 ${got.length} 条（Steam 报告共 ${r.total} 条在打折）`);
    // 已经翻到最后
    if (got.length === 0 || start + CFG.perPage >= r.total) break;
  }

  if (!rows.length) {
    // 绝不 exit 1：写一个带 error 的空结果，让页面能显示「今天雷达没抓到」而不是空白
    warn('一条都没抓到 —— 写出带 error 的空结果，退出码保持 0');
    writeOut({
      version: 1, generatedAt: now.getTime(), date: isoDate(now),
      source: 'steam-search-specials', total: 0, items: [],
      error: pagesOk === 0 ? 'STEAM_UNREACHABLE' : 'NO_ROWS_PARSED',
      minDiscount: CFG.minDiscount,
      ownedOk: ex.ownedOk, ownedNote: ex.ownedNote || null, ownedCount: ex.ownedSet.size,
    });
    return { count: 0, error: true };
  }

  const expMap = await fetchExpirationMap();
  let merged = 0;
  for (const r of rows) {
    const exp = expMap.get(r.appid);
    if (exp) { r.discountExpiration = exp; merged++; }
  }

  const items = filterItems(rows, CFG, ex);
  const notInList = items.filter(x => !x.inWishlist && !x.alreadyOwned);

  const rej = filterItems.lastRejected || { discount: 0, quality: 0, recent: 0 };
  log(`候选 ${rows.length} 条 → 质量门槛后剩 ${items.length} 条`
    + `（折扣不足挡掉 ${rej.discount}、质量不达标挡掉 ${rej.quality}`
    + `${rej.recent ? '、时间不达标挡掉 ' + rej.recent : ''}）`
    + `；其中 ${notInList.length} 条既没买过、也不在清单里`);
  log(`特惠日历补到 ${merged} 条折扣截止时间`);

  writeOut({
    version: 1,
    generatedAt: now.getTime(),
    date: isoDate(now),
    source: 'steam-search-specials',
    total,
    pagesFetched: pagesOk,
    minDiscount: CFG.minDiscount,
    // 质量门槛也写进产物：页面/日志能看出「今天挡掉的是折扣不够还是质量不行」
    minReviewCount: CFG.minReviewCount,
    rejected: filterItems.lastRejected || null,
    currency: 'CNY',
    /* 【2026-10-12】已购库状态如实带出来。老实现读不到 owned.json 时
       静默降级成「什么都没买过」，页面照常显示全部推荐，用户完全看不出异常 ——
       实测就是这样漏掉了 18 款已购的游戏。现在页面读到 ownedOk:false
       会显示警告条，明说「推荐未按已购过滤」。 */
    ownedOk: ex.ownedOk,
    ownedNote: ex.ownedNote || null,
    ownedCount: ex.ownedSet.size,
    items,
  });

  log(`✅ 已写 data/specials.json（${items.length} 条）`);
  return { count: items.length, notInList: notInList.length };
}

function isoDate(d) {
  // 北京时间日期，跟邮件/数据快照的口径保持一致
  const s = new Date(d.getTime() + 8 * 3600000);
  return s.toISOString().slice(0, 10);
}

/* ================================ 入口 ================================ */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch (e) { return false; }
}
if (isDirectRun()) {
  /* try/catch 到顶：任何未预期异常都只打印，绝不 process.exit(1)。
     这个脚本是「附加功能」，绝不能因为它让整个每日刷新变红。 */
  main().catch(e => {
    warn('未预期异常（已忽略，不影响主流程）：' + (e && e.stack ? e.stack : e));
    try {
      writeOut({
        version: 1, generatedAt: Date.now(), date: isoDate(new Date()),
        source: 'steam-search-specials', total: 0, items: [],
        error: 'EXCEPTION: ' + String(e && e.message || e),
      });
    } catch (_) { /* 连写都失败就算了，绝不抛 */ }
  });
}