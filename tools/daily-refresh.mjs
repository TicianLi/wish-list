#!/usr/bin/env node
/**
 * tools/daily-refresh.mjs
 * ---------------------------------------------------------------
 * 问题 #3：每天凌晨 2 点自动刷新 + 导出 JSON + 邮件发送
 *
 * 由 .github/workflows/daily-refresh.yml 定时调用（cron 为 UTC，
 * 北京时间 02:00 = UTC 18:00 前一天）。
 *
 * 职责：
 *   1. 读取 data/wishlist.json（你从页面同步上来的数据，即"云端副本"）
 *   2. 逐个 AppID 重新拉取 Steam 最新价格 / 评分 / 名称，并可选查 ITAD 史低
 *   3. 把刷新后的完整 JSON 写回 data/wishlist.json（保留你手填的
 *      目标价 / 备注 / 手动史低，绝不覆盖）
 *   4. 生成对比摘要（新史低、达到目标价、促销将要结束等）并邮件发送
 *      · 只要配置了 SMTP 就发；没配就只写文件、不发信，不会报错退出
 *
 * 设计原则（与页面完全一致）：
 *   · 只用官方返回的字段，缺数据就留空，绝不编造价格
 *   · 用户手动数据（targetPrice / note / 手动确认史低）永不覆盖
 *   · 单个游戏失败不影响整体；全程退出码保持 0（除非数据文件损坏）
 *
 * 运行：node tools/daily-refresh.mjs
 *
 * 【本轮新增】2026-09-16
 *   A. 折扣截止时间数据源（原 appdetails 不返回该字段，导致页面上永远是"未知"）
 *      → 改用官方 featuredcategories 的 specials / dailydeal 分类，一次请求覆盖
 *        全部正在促销的游戏。已有关闭字段一律保留，只填空缺。
 *   B. Steam 用户标签（商店页 app_tag）+ 捆绑包标记，供页面做标签体系
 *   A. 折扣截止时间：appdetails 绝大多数情况下不返回该字段。
 *      改为三级来源：商店页倒计时（逐款，最准）→ 官方特惠日历 → appdetails；
 *      优先级 appdetails / 手动 > 商店页 > 特惠日历，只填空缺、绝不编造。
 *   B. Steam 用户标签 + 捆绑包：从商店页抓（l=schinese 直接是中文），带 30 天缓存。
 *   C. 无中文名的游戏由 CI 机翻补齐（CI 网络可达翻译接口，浏览器侧不可达）
 *   D. 【修复】saveDataFile 曾丢掉页面写入的 provenance 字段
 *      （source / syncedAt / gameCount / fingerprint / syncedFrom）
 *   E. 全流程诊断输出：把 Steam 真实返回的字段名打进日志，便于事后核对
 *
 * 可选环境变量（全部可不填，括号内为默认值）：
 *   STEAM_CC(cn) STEAM_LANG(schinese) ITAD_API_KEY() MAIL_MODE(always)
 *   REQ_INTERVAL_MS(700) REQ_TIMEOUT_MS(20000) MAX_GAMES(0=不限)
 *   SMTP_HOST SMTP_PORT(465) SMTP_SECURE(true) SMTP_USER SMTP_PASS MAIL_FROM MAIL_TO
 *   TAG_INTERVAL_MS(1100)  商店页请求间隔（比接口慢，避免被 Steam 挡）
 *   MAX_TAG_FETCH(150)     单次运行最多抓几款游戏的商店页（0=不限）
 *   TAG_TTL_DAYS(30)       标签缓存有效期，未过期不重抓
 *   TRANSLATE_ENABLED(true) 是否用 CI 机翻补齐缺失的中文名
 *   TRANSLATE_INTERVAL_MS(1200)  翻译请求间隔
 *   TRANSLATE_RETRIES(3)   翻译被限流（HTTP 429）时的重试次数
 *   DIAG(true)             是否输出诊断日志
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* nodemailer 用「动态导入」而不是顶层 import：
   这样即使依赖没装（或 CI 里 npm install 失败），脚本依然能正常完成
   「刷新 + 导出 JSON」，只是跳过发信，而不是整个任务崩掉。 */
let nodemailer = null;
async function getMailer() {
  if (nodemailer) return nodemailer;
  try {
    const mod = await import('nodemailer');
    nodemailer = mod.default || mod;
  } catch (e) {
    nodemailer = false;
  }
  return nodemailer;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'wishlist.json');
const TZ_LABEL = 'Asia/Shanghai';

/* ============================ 配置 ============================ */
const CFG = {
  cc: process.env.STEAM_CC || 'cn',
  lang: process.env.STEAM_LANG || 'schinese',
  itadKey: process.env.ITAD_API_KEY || '',
  // 每个请求之间的间隔，避免把 Steam 打急眼（毫秒）
  intervalMs: Number(process.env.REQ_INTERVAL_MS || 700),
  // 单个请求超时
  timeoutMs: Number(process.env.REQ_TIMEOUT_MS || 20000),
  // 每次运行最多刷新多少个（防止清单过大跑超时；0 = 不限）
  maxGames: Number(process.env.MAX_GAMES || 0),
  // 商店页（抓用户标签 / 捆绑包）的间隔更保守
  tagIntervalMs: Number(process.env.TAG_INTERVAL_MS || 1100),
  // 单次运行最多抓几款游戏的标签（0 = 不限）；标签变化很慢，靠缓存分摊到多天
  // 【防饿死】默认值必须 ≥ 清单规模，否则排在配额外的游戏要等到下一轮才轮到。
  // 取 0 = 不限：由 TAG_TTL_DAYS(30 天) 缓存自然分摊日常开销，新游戏永远当轮就抓。
  maxTagFetch: Number(process.env.MAX_TAG_FETCH || 0),
  // 标签缓存有效期（天）
  tagTtlDays: Number(process.env.TAG_TTL_DAYS || 30),
  // 是否用 CI 机翻补齐缺失的中文名（CI 网络可达翻译接口，浏览器侧常常不可达）
  translate: String(process.env.TRANSLATE_ENABLED ?? 'true') === 'true',
  translateIntervalMs: Number(process.env.TRANSLATE_INTERVAL_MS || 1200),
  // 翻译接口在被限流（HTTP 429）时重试几次；每次退避递增（实测 400ms 间隔会大量 429）
  translateRetries: Number(process.env.TRANSLATE_RETRIES || 3),
  // 诊断输出（把 Steam 真实返回的字段名打进日志，方便核对）
  diag: String(process.env.DIAG ?? 'true') === 'true',
  // 邮件相关
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE ?? 'true') === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || process.env.SMTP_USER || '',
    to: process.env.MAIL_TO || ''
  },
  // 只在这些"事件"发生时才发信？默认都发（每天一封日报）
  mailMode: process.env.MAIL_MODE || 'always'   // always | changes
};

/* ============================ 工具 ============================ */
const nowMs = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[' + new Date().toLocaleString('zh-CN', { timeZone: TZ_LABEL, hour12: false }) + ']', ...a);
const warn = (...a) => console.warn('[' + new Date().toLocaleString('zh-CN', { timeZone: TZ_LABEL, hour12: false }) + '] ⚠️', ...a);

function todayStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: TZ_LABEL }));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtPrice(v, cur) {
  if (v == null || isNaN(v)) return '—';
  return (cur === 'CNY' || !cur ? '¥' : cur + ' ') + (Math.round(v * 100) / 100);
}
function fmtCount(n) {
  n = Number(n);
  if (!isFinite(n)) return '—';
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + ' 亿';
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
function hasChinese(s) { return /[\u4e00-\u9fff]/.test(s || ''); }

/* 带超时的 fetch（Node 18+ 自带 fetch） */
const UA = 'Mozilla/5.0 (compatible; wishlist-daily-refresh/1.1)';

function withTimeout(init, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || CFG.timeoutMs);
  return { init: Object.assign({}, init || {}, { signal: ctrl.signal }), done: () => clearTimeout(t) };
}

async function fetchJSON(url, opts = {}) {
  const w = withTimeout({
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json,text/plain,*/*',
      ...(opts.headers || {})
    }
  }, opts.timeoutMs);
  try {
    const resp = await fetch(url, w.init);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('返回非 JSON：' + text.slice(0, 80)); }
  } finally {
    w.done();
  }
}

/* 抓 HTML（商店页标签 / 捆绑包用） */
async function fetchHTML(url, opts = {}) {
  const w = withTimeout({
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(opts.headers || {})
    }
  }, opts.timeoutMs);
  try {
    const resp = await fetch(url, w.init);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    w.done();
  }
}

/* ============================ 默认结构 ============================ */
function defaultPrice() { return { current: null, original: null, discountPercent: 0, currency: 'CNY', isOnSale: false, discountExpiration: null, expirationSource: null, saleEvent: null, updatedAt: 0 }; }
function defaultRating() { return { score: null, positive: null, desc: null, total: null, updatedAt: 0 }; }
function defaultLow() { return { price: null, count: null, confidence: 'pending', source: null, updatedAt: 0 }; }

function scoreFromPositive(pct) {
  if (pct == null || isNaN(pct)) return null;
  if (pct >= 97) return 9.9; if (pct >= 95) return 9.8; if (pct >= 92) return 9.6;
  if (pct >= 88) return 9.2; if (pct >= 85) return 8.9; if (pct >= 80) return 8.4;
  if (pct >= 70) return 7.5; if (pct >= 60) return 6.5; if (pct >= 50) return 5.5;
  return 4.0;
}
function extractPrice(data, priceObj) {
  const out = defaultPrice();
  if (data && data.is_free) {
    out.current = 0; out.original = 0; out.discountPercent = 0; out.isOnSale = false; out.discountExpiration = null;
  } else if (priceObj) {
    out.current = priceObj.final / 100;
    out.original = priceObj.initial / 100;
    out.discountPercent = Number(priceObj.discount_percent) || 0;
    out.currency = priceObj.currency || 'CNY';
    out.isOnSale = out.discountPercent > 0;
    const exp = Number(priceObj.discount_expiration);
    out.discountExpiration = (out.isOnSale && exp > 0) ? exp * 1000 : null;
    // 记录来源：官方字段给了就用 official，没给则留空由特惠日历补
    if (out.discountExpiration) out.expirationSource = 'appdetails';
  }
  out.updatedAt = nowMs();
  return out;
}
function isTargetReached(g) {
  return g.targetPrice != null && g.price && g.price.current != null && g.price.current <= g.targetPrice;
}
function isAtHistoricalLow(g) {
  const cur = g.price && g.price.current, low = g.historicalLow && g.historicalLow.price;
  if (cur == null || low == null || low <= 0) return false;
  return cur <= low * 1.005;
}
function saleRemainMs(g) {
  const exp = g.price && g.price.discountExpiration;
  if (!exp) return null;
  return Number(exp) - nowMs();
}

/* ============================ Steam / ITAD ============================ */
let lastReq = 0;
async function rateLimit(overrideMs) {
  const gap = (Number(overrideMs) > 0) ? Number(overrideMs) : CFG.intervalMs;
  const delta = nowMs() - lastReq;
  if (delta < gap) await sleep(gap - delta);
  lastReq = nowMs();
}

async function steamAppDetails(appid) {
  await rateLimit();
  const url = `https://store.steampowered.com/api/appdetails/?appids=${appid}&cc=${CFG.cc}&l=${CFG.lang}`;
  const data = await fetchJSON(url);
  const node = data && data[String(appid)];
  if (!node) throw new Error('Steam 未返回 AppID ' + appid);
  if (!node.success) throw new Error('Steam 查询失败（AppID ' + appid + '）');
  return node.data || null;
}

async function steamReviews(appid) {
  await rateLimit();
  const url = `https://store.steampowered.com/appreviews/${appid}?json=1&language=${CFG.lang}&purchase_type=all&num_per_page=0&filter=summary`;
  const data = await fetchJSON(url);
  return (data && data.query_summary) || null;
}

/* ITAD 国区史低：无 Key 直接跳过 */
async function itadHistoryLow(appid) {
  if (!CFG.itadKey) return { skipped: true };
  await rateLimit();
  const look = await fetchJSON(`https://api.isthereanydeal.com/games/lookup/v1?key=${encodeURIComponent(CFG.itadKey)}&appid=${appid}`);
  if (!look || !look.found || !look.game || !look.game.id) return { skipped: true };
  await rateLimit();
  const hist = await fetchJSON(`https://api.isthereanydeal.com/games/history/v2?key=${encodeURIComponent(CFG.itadKey)}&id=${encodeURIComponent(look.game.id)}&country=CN&shops=61&since=2000-01-01T00:00:00Z`);
  const rows = [];
  const entries = Array.isArray(hist) ? hist : (hist && Array.isArray(hist.prices) ? hist.prices : []);
  entries.forEach(it => {
    if (it && Array.isArray(it.lows)) it.lows.forEach(l => rows.push(l));
    else rows.push(it);
  });
  let low = Infinity, cur = null;
  rows.forEach(it => {
    const p = it && it.deal && it.deal.price;
    const amt = (p && typeof p.amount === 'number') ? p.amount
      : (p && typeof p.amountInt === 'number') ? p.amountInt / 100
      : (typeof it === 'number' ? it : null);
    if (amt == null || !isFinite(amt)) return;
    if (amt < low) { low = amt; cur = (p && p.currency) || 'CNY'; }
  });
  if (!isFinite(low)) return { skipped: true };
  return { price: low, currency: cur || 'CNY', confidence: 'A', source: 'ITAD(国区)', updatedAt: nowMs() };
}

/* ==================================================================
 * 新增数据源 A：Steam 特惠日历（折扣截止时间）
 * ------------------------------------------------------------------
 * 背景：store.steampowered.com/api/appdetails 的 price_overview
 *       并不稳定返回 discount_expiration，导致页面上「促销 / 截止」
 *       这一列对全部在促销的游戏都显示“未知”。
 * 方案：改用官方 featuredcategories 的 specials / dailydeal 分类，
 *       每项都带 discount_expiration。一次请求即可覆盖全部在促销的
 *       游戏，且无需 API Key。
 * 原则：只补「截止时间 + 活动名」，绝不改写价格 —— 价格仍以
 *       appdetails 为准，避免引入不确定数据。
 * ================================================================== */
const SALE_CATEGORIES = [
  { key: 'dailydeal', label: '今日特惠' },
  { key: 'specials',  label: '特惠' },
  { key: 'spotlight', label: '精选推荐' }
];

function pickFirst() {
  for (let i = 0; i < arguments.length; i++) {
    const v = arguments[i];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/* 把 Steam 各种可能的字段写法归一成内部结构。
   只需截止时间，所以只解析 id / expiration / 折扣%。 */
function normalizeSaleItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appid = Number(pickFirst(raw.id, raw.appid, raw.appId, raw.steam_appid));
  if (!appid || !isFinite(appid) || appid <= 0 || appid > 5000000) return null;
  const expRaw = pickFirst(raw.discount_expiration, raw.discountExpiration, raw.sale_end, raw.saleEnd, raw.discount_end);
  const exp = Number(expRaw);
  if (!isFinite(exp) || exp <= 0) return null;
  // Unix 秒 → 毫秒（若已经是毫秒就不动）
  const expiration = exp < 1e12 ? exp * 1000 : exp;
  const pct = Number(pickFirst(raw.discount_percent, raw.discounted_percent, raw.discountPercent, 0)) || 0;
  const name = typeof raw.name === 'string' ? raw.name : null;
  return { appid, expiration, pct, name };
}

async function fetchSaleCalendar() {
  const map = new Map();
  const diag = { ok: false, keys: [], perCategory: [], sampleKeys: null, sample: null, error: null };
  let data = null;
  try {
    await rateLimit();
    data = await fetchJSON(`https://store.steampowered.com/api/featuredcategories?cc=${CFG.cc}&l=${CFG.lang}`);
    diag.ok = true;
  } catch (e) {
    diag.error = e.message;
    warn('特惠日历获取失败（折扣截止时间保持原值，不影响其它数据）：' + e.message);
    return { map, diag };
  }
  if (!data || typeof data !== 'object') {
    diag.error = '返回不是对象';
    return { map, diag };
  }
  diag.keys = Object.keys(data);

  const bump = (item, label) => {
    const n = normalizeSaleItem(item);
    if (!n) return false;
    const prev = map.get(n.appid);
    if (!prev) map.set(n.appid, { expiration: n.expiration, pct: n.pct, name: n.name, event: label });
    else {
      if (n.expiration < prev.expiration) prev.expiration = n.expiration;  // 取最早结束的那个
      if (!prev.event) prev.event = label;
    }
    return true;
  };

  for (const c of SALE_CATEGORIES) {
    const cat = data[c.key];
    let items = [];
    if (Array.isArray(cat)) items = cat;
    else if (cat && Array.isArray(cat.items)) items = cat.items;
    let hit = 0;
    items.forEach(it => { if (bump(it, c.label)) hit++; });
    diag.perCategory.push({ key: c.key, raw: items.length, withExpiration: hit });
    if (!diag.sampleKeys && items.length) {
      diag.sampleKeys = Object.keys(items[0] || {});
      diag.sample = JSON.stringify(items[0]).slice(0, 700);
    }
  }
  return { map, diag };
}

/* 把日历里的截止时间补进 games（只填空缺，不覆盖更可信的来源） */
function applySaleCalendar(games, map) {
  let matched = 0, filled = 0, kept = 0, stillUnknown = 0;
  games.forEach(g => {
    if (!g) return;
    const hit = map.get(Number(g.appid));
    const onSale = !!(g.price && g.price.isOnSale);
    if (!hit) {
      if (onSale && !g.price.discountExpiration) stillUnknown++;
      return;
    }
    matched++;
    if (!g.price) g.price = defaultPrice();
    const existing = Number(g.price.discountExpiration) > 0 ? Number(g.price.discountExpiration) : null;
    const src = g.price.expirationSource;
    // 官方 appdetails / 用户手动确认 的来源更可信 → 只补活动名，不动时间
    if (existing && (src === 'manual' || src === 'appdetails')) {
      kept++;
      if (!g.price.saleEvent) g.price.saleEvent = hit.event;
      g.price.expirationCheckedAt = nowMs();
      return;
    }
    if (existing !== hit.expiration) filled++;
    g.price.discountExpiration = hit.expiration;
    g.price.expirationSource = 'featuredcategories';
    g.price.expirationCheckedAt = nowMs();
    g.price.saleEvent = hit.event;
  });
  return { matched, filled, kept, stillUnknown };
}

function printSaleDiag(diag) {
  if (!CFG.diag) return;
  if (!diag.ok) {
    log('[诊断·特惠日历] 获取失败：' + (diag.error || '未知'));
    return;
  }
  log('[诊断·特惠日历] 顶层分类：' + diag.keys.join(','));
  diag.perCategory.forEach(c => {
    log(`[诊断·特惠日历]   ${c.key}: 共 ${c.raw} 项，其中带 discount_expiration 的 ${c.withExpiration} 项`);
  });
  if (diag.sampleKeys) log('[诊断·特惠日历] 首项字段名：' + diag.sampleKeys.join(','));
  if (diag.sample) log('[诊断·特惠日历] 首项原文：' + diag.sample);
}

/* ==================================================================
 * 新增数据源 B：商店页（Steam 用户标签 + 捆绑包）
 * ------------------------------------------------------------------
 * appdetails 不提供「用户标签」。Steam 真实用户标签只在商店页里，
 * 形如 <a class="app_tag" ...>类魂</a>，且 l=schinese 下直接是中文，
 * 不需要翻译。
 * 标签变化很慢 → 带缓存（默认 30 天），并按次限流分摊到多天。
 * ================================================================== */
const TAG_BLOCK_RE = /<a\b[^>]*class="[^"]*\bapp_tag\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
const BUNDLE_ID_RE = /data-ds-bundleid="(\d+)"|data-bundleid="(\d+)"|bundleid="(\d+)"/gi;

function parseUserTags(html) {
  /* 【架构改动·彻底去掉款数上限】
     旧实现 `if (tags.length >= 20) break;` —— 又是一次"猜个够大的数"。
     实际上商店页的 app_tag 区块本身就是有限的（Steam 自己决定显示多少），
     index 到"页面没有更多 app_tag"自然就停了。
     所以直接去掉数量上限：**页面有多少就解析多少**，不再人为砍掉尾巴。 */
  const tags = [], seen = new Set();
  let m;
  TAG_BLOCK_RE.lastIndex = 0;
  while ((m = TAG_BLOCK_RE.exec(html))) {
    const t = stripHtml(m[1]).replace(/^\+/, '').trim();
    if (!t || t === '+' || seen.has(t)) continue;
    seen.add(t);
    tags.push(t);
  }
  return tags;
}

function parseBundleIds(html) {
  const ids = [], seen = new Set();
  let m;
  BUNDLE_ID_RE.lastIndex = 0;
  while ((m = BUNDLE_ID_RE.exec(html))) {
    const id = m[1] || m[2] || m[3];
    if (id && !seen.has(id)) { seen.add(id); ids.push(Number(id)); }
  }
  return ids;
}

/* ------------------------------------------------------------------
 * 折扣截止时间（真实来源 #3：商店页倒计时）
 *   featuredcategories 只在「特惠轮播」里给十来条，覆盖率极低
 *   （实测 197 款里 54 款促销，只补上 3 款）。
 *   真正逐款带倒计时的是商店页：限时促销会在购买区渲染 countdown 节点，
 *   带 data-timestamp（Unix 秒）。这里按「由具体到宽泛」依次尝试多条模式，
 *   命中即止；每条都必须通过「将来 400 天内」的合理性校验，否则视为解析错误丢弃。
 *   命中与否、以及命中位置附近的原文，都会打进诊断日志，便于事后核对真实字段名。
 * ------------------------------------------------------------------ */
function toMs(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;        // 秒 → 毫秒
}
const DEADLINE_PATTERNS = [
  /class="[^"]*discount[^"]*countdown[^"]*"[\s\S]{0,400}?data-timestamp="(\d{9,13})"/i,
  /class="[^"]*countdown[^"]*"[\s\S]{0,400}?data-timestamp="(\d{9,13})"/i,
  /data-timestamp="(\d{9,13})"[\s\S]{0,300}?class="[^"]*countdown[^"]*"/i,
  /InitDailyDealTimer\s*\(\s*[^,)]*,\s*(\d{9,13})/i,
  /"discount_expiration"\s*:\s*"?(\d{9,13})"?/i,
  /data-discount-expiration="(\d{9,13})"/i
];
/* 只在「购买区」里找倒计时。
   整页里还散布着推荐位 / 特惠栏 / 系列合集 的倒计时，
   直接取整页第一个会张冠李戴 —— 把别的游戏的截止时间记到本款头上。
   购买区起点：game_area_purchase；终点：whatever 先出现的描述区/标签区。 */
function purchaseZoneOf(html) {
  const pi = html.search(/id="game_area_purchase"|class="[^"]*game_area_purchase/);
  if (pi === -1) return null;
  const rest = html.slice(pi);
  const b = rest.search(/id="game_meta_data"|id="game_area_description"|class="app_tag"/);
  /* 【修复·款数限制】旧上限 20000 字符：购买区里若列了较多版本 / 套餐 /
     DLC 组合，倒计时节点可能被切到窗口外，表现为"促销中却读不到截止时间"。
     提到 60000 基本覆盖整段购买区，同时仍防止把整页塞进正则。 */
  const CAP = 60000;
  const end = b === -1 ? Math.min(rest.length, CAP) : Math.min(b, CAP);
  return rest.slice(0, end);
}
/* 变体 B：本地化「文字日期」。
   用户截图证实：像「周间特惠」这类促销，Steam 在购买区只渲染一行本地化文字，
   **整页没有任何 data-timestamp**（run #12 实测 Lies of P：countdown=true 但 data-timestamp=false）。
   例如：<p class="game_purchase_discount_countdown">周间特惠！9月22日截止</p>
   于是上面所有「要数字」的模式全部落空。这里补一个文字日期的兜底解析。 */
const EN_MONTH = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/* 「关键词 + 日期」的兜底：购买区里写着「…截止 / …结束 / Offer ends …」时把日期抠出来 */
const KEYWORD_DATE = [
  /(?:截止|结束|ends?|until|through)[^\d]{0,24}(\d{4}\s*[年\-\/.]\s*\d{1,2}\s*[月\-\/.]\s*\d{1,2}\s*日?)/i,
  /(?:截止|结束|ends?|until|through)[^\d]{0,24}(\d{1,2}\s*月\s*\d{1,2}\s*日)/i,
  /(?:截止|结束|ends?|until|through)[^\d]{0,24}((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2})/i
];
/* 取出「折扣倒计时」那个节点的纯文字 + 原始 HTML（原始 HTML 进诊断，便于核对 Steam 到底怎么写的） */
function countdownTextOf(zone) {
  if (!zone) return { text: '', html: '' };
  const i = zone.search(/class="[^"]*game_purchase_discount_countdown[^"]*"/);
  if (i === -1) return { text: '', html: '' };
  const seg = zone.slice(i, i + 600);
  const html = seg.slice(0, 400);
  const gt = seg.indexOf('>');
  if (gt === -1) return { text: '', html };
  const text = seg.slice(gt + 1, gt + 320)
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, html };
}
/* 从「周间特惠！9月22日截止」「Offer ends September 22」这类文字里抠出日期。
   Steam 不给时间点，所以按「当天 23:59:59（北京时间）结束」处理 —— 只会略微保守，不会早报。 */
function parseLocalizedDate(text) {
  if (!text) return null;
  const now = Date.now();
  let mo = null, d = null, y = null, m = null;
  m = /(\d{4})\s*[年\-\/.]\s*(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*日?/.exec(text);       // 2026年9月22日
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  if (!m) { m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text); if (m) { mo = +m[1]; d = +m[2]; } }   // 9月22日
  if (!m) {                                                                              // September 22 / Sep. 22
    const e = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?/.exec(text);
    if (e) { const k = e[1].slice(0, 3).toLowerCase(); if (EN_MONTH[k]) { mo = EN_MONTH[k]; d = +e[2]; } }
  }
  if (!mo || !d || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const guessed = (y == null);
  if (guessed) y = new Date(now + 8 * 3600000).getUTCFullYear();   // 取北京时间当年
  const dayEnd = (yy) => Date.UTC(yy, mo - 1, d, 15, 59, 59);     // 该日 23:59:59 北京时间 = 15:59:59 UTC
  let ms = dayEnd(y);
  if (guessed && ms < now - 86400000) ms = dayEnd(y + 1);         // 没写年份且已过去 → 顺延到明年
  if (ms <= now || ms > now + 400 * 86400000) return null;
  return { ms: ms, y: y, mo: mo, d: d };
}
function parseSaleDeadline(html) {
  const diag = { matched: null, snippet: '', countdownHtml: '' };
  const zone = purchaseZoneOf(html);
  const scopes = zone ? [['购买区', zone], ['整页', html]] : [['整页', html]];
  for (const [where, text] of scopes) {
    /* 同一区域里可能有多条候选（本体的购买框、合集包、DLC 各带一个倒计时）。
       取「离购买区起点最近」的那条 —— 本体的购买框永远排在最前面。 */
    let best = null;
    for (let i = 0; i < DEADLINE_PATTERNS.length; i++) {
      const m = DEADLINE_PATTERNS[i].exec(text);
      if (!m) continue;
      const ms = toMs(m[1]);
      if (ms == null) continue;
      const now = Date.now();
      if (ms <= now || ms > now + 400 * 86400000) continue;   // 合理性校验：必须是将来的、合理范围内的
      if (!best || m.index < best.index) best = { index: m.index, ms, pat: i + 1 };
    }
    if (best) {
      diag.matched = where + '·模式#' + best.pat;
      diag.snippet = text.slice(Math.max(0, best.index - 100), best.index + 240);
      return { expirationMs: best.ms, diag };
    }
  }
  /* 变体 B 兜底：时间戳全落空时，读「折扣倒计时」节点里的本地化文字日期 */
  const cd = countdownTextOf(zone || html);
  diag.countdownHtml = cd.html;
  const lit = parseLocalizedDate(cd.text);
  if (lit) {
    diag.matched = '文字日期「' + cd.text.slice(0, 46) + '」';
    diag.snippet = cd.html;
    return { expirationMs: lit.ms, diag };
  }
  /* 变体 B2：倒计时节点里没写日期时，退一步在购买区里找「…截止 / Offer ends …」这类文字。
     仍然只在购买区里找，避免抓到推荐位/其它游戏的日期。 */
  const plain = String(zone || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  for (const kw of KEYWORD_DATE) {
    const k = kw.exec(plain);
    if (!k) continue;
    const lit2 = parseLocalizedDate(k[1]);
    if (lit2) {
      diag.matched = '购买区文字「' + k[0].slice(0, 46) + '」';
      diag.snippet = k[0].slice(0, 240);
      return { expirationMs: lit2.ms, diag };
    }
  }
  const pi = html.search(/discount_pct|discount_block|game_area_purchase/);
  diag.snippet = (pi === -1 ? '(整页没有 discount 相关标记)' : html.slice(Math.max(0, pi - 80), pi + 300)) +
    (zone ? '' : ' ｜ 也没有购买区（疑似年龄门 / 地区限制页）');
  return { expirationMs: null, diag };
}
/* 商店页倒计时的优先级：不覆盖 appdetails（官方逐款接口）与手动值；
   可以覆盖 featuredcategories（那只是特惠轮播，不够准）。 */
function fillDeadlineFromStore(g, ms) {
  if (!g.price || !g.price.isOnSale) return false;
  const src = g.price.expirationSource;
  if (g.price.discountExpiration != null && (src === 'appdetails' || src === 'manual')) return false;
  g.price.discountExpiration = ms;
  g.price.expirationSource = 'storepage';
  return true;
}

/* 年龄门（age gate）绕过：
   Steam 对「成人内容」游戏，在没有年龄 Cookie 时会返回「年龄确认页」，
   那一页没有购买区（没有 game_area_purchase / discount_block），
   于是折扣倒计时永远解析不到 —— 这就是 run #11 里「117 款全部成功、
   但补上折扣截止时间 0 款」的原因。
   带上这两条 Cookie 后返回的就是完整商店页。Cookie 只影响「能不能看」，
   不影响价格/地区（地区仍由 cc 参数决定），所以是安全的。 */
const AGE_GATE_COOKIE = 'birthtime=628473601; lastagecheckage=1-January-1990; mature_content=1; wants_mature_content=1';
async function fetchStorePage(appid) {
  await rateLimit(CFG.tagIntervalMs);
  return await fetchHTML(`https://store.steampowered.com/app/${appid}/?cc=${CFG.cc}&l=${CFG.lang}`,
    { headers: { Cookie: AGE_GATE_COOKIE } });
}

function tagsNeedRefresh(g) {
  const d = g.details || {};
  if (!Array.isArray(d.userTags) || !d.userTags.length) return true;
  if (!d.userTagsFetchedAt) return true;
  return (nowMs() - d.userTagsFetchedAt) > CFG.tagTtlDays * 86400000;
}
/* 商店页的价值不只有标签：折扣截止时间也只能从商店页拿到。
   所以「正在促销却没有截止时间（或记录的截止时间已过期）」的游戏，
   即使标签是新的，也要再取一次商店页。 */
function storePageNeedRefresh(g) {
  if (tagsNeedRefresh(g)) return true;
  if (g.price && g.price.isOnSale) {
    const ms = toMs(g.price.discountExpiration);
    if (ms == null) return true;
    if (ms <= nowMs()) return true;
  }
  return false;
}
/* 商店页抓取的排队优先级（数字越小越先抓）。
   必须保证「每次运行都会推进」，不能有游戏永远排不到 —— 这是用户明确要求
   「以后再有新游戏都能正常获取数据」的核心。

   优先级从高到低：
     0. 正在促销但没有折扣截止时间 —— 用户直接看得见的空缺
     1. 从未抓过标签的新游戏（userTagsFetchedAt 为空）
        ★ 必须排在「标签过期」之前：新游戏是用户刚加进来的，
          如果被几十上百款"标签过期"的旧游戏挤在后面，可能连着好几天轮不到。
     2. 标签已过期需要重抓的旧游戏
        ★ 再过期时间升序：越久没抓的越先抓，天然形成轮转（round-robin），
          不会出现"每次都是同一批排前面"的饥饿现象。
*/
function storePagePriority(g) {
  const saleNoDeadline = (g.price && g.price.isOnSale && toMs(g.price.discountExpiration) == null) ? 0 : 1;
  return saleNoDeadline * 100 + tagQueueTier(g);
}
function tagQueueTier(g) {
  const d = g.details || {};
  if (!Array.isArray(d.userTags) || !d.userTags.length) return 0;   // 新游戏 / 从没抓到过
  if (!d.userTagsFetchedAt) return 0;                               // 同上（标记缺失）
  return 1;                                                          // 抓过但已过期
}
/* 同档位内部按「上次抓取时间」升序 —— 最久没抓的排最前，形成轮转 */
function storePageOrder(a, b) {
  const p = storePagePriority(a) - storePagePriority(b);
  if (p !== 0) return p;
  const ta = (a.details && a.details.userTagsFetchedAt) || 0;
  const tb = (b.details && b.details.userTagsFetchedAt) || 0;
  return ta - tb;
}

async function enrichStoreData(games) {
  const stat = {
    tried: 0, ok: 0, failed: 0, tags: 0, withTags: 0, bundles: 0, deadlines: 0, needDeadline: 0,
    byText: 0, byKeyword: 0, newGames: 0, deferred: 0,
    diagTagHtml: null, diagBundleHtml: null, diagDeadline: null, diagDeadlineNoMatch: null,
    diagNoMatchGame: null, diagNoMatchCountdown: null
  };
  const all = games.filter(g => g && g.appid);
  stat.needDeadline = all.filter(g => g.price && g.price.isOnSale && toMs(g.price.discountExpiration) == null).length;
  let todo = all.filter(g => storePageNeedRefresh(g));
  stat.newGames = todo.filter(g => tagQueueTier(g) === 0).length;
  todo.sort(storePageOrder);
  if (CFG.maxTagFetch > 0 && todo.length > CFG.maxTagFetch) {
    stat.deferred = todo.length - CFG.maxTagFetch;
    log(`商店页待补 ${todo.length} 款（促销中缺折扣截止 ${stat.needDeadline} 款、` +
        `从未抓过标签的新游戏 ${stat.newGames} 款），本次配额 ${CFG.maxTagFetch} 款；` +
        `剩余 ${stat.deferred} 款排到下次（新游戏已优先，且按最久未抓排序，不会饿死）。`);
    todo = todo.slice(0, CFG.maxTagFetch);
    /* 兜底提醒：如果配额已经连"新游戏"都装不下，说明该调大 MAX_TAG_FETCH 了 */
    if (stat.newGames > CFG.maxTagFetch) {
      warn(`⚠ 本次有 ${stat.newGames} 款新游戏从未抓过标签，但配额只有 ${CFG.maxTagFetch} 款。` +
           `建议把 MAX_TAG_FETCH 调大到 ${stat.newGames + 50} 左右（仓库 Settings → Variables）。`);
    }
  }
  if (!todo.length) return stat;

  for (let i = 0; i < todo.length; i++) {
    const g = todo[i];
    stat.tried++;
    try {
      const html = await fetchStorePage(g.appid);
      /* 【修复】原来这里调用了未定义的 defaultDetails()，一旦某款游戏缺 details
         就会 ReferenceError 直接崩掉整个刷新。改成内联的完整默认结构。 */
      if (!g.details || typeof g.details !== 'object') {
        g.details = {
          genres: [], categories: [], featureTags: [], platforms: [],
          developers: [], publishers: [], tags: [],
          userTags: [], userTagsFetchedAt: null, bundleIds: []
        };
      }
      const tags = parseUserTags(html);
      const bundles = parseBundleIds(html);
      /* 【上限哨兵】数一数页面上「原始 app_tag 节点」到底有多少个，
         和解析出来的标签数比对。若原始数 > 解析数，说明又出现了静默截断
         （历史上就是 `if (tags.length >= 20) break;` 造成的）。
         不报警不代表页面标签就多 —— 是 Steam 商店页 app_tag 区本身只列
         约 20 个（其余同标签仍在，但不在此区块）。哨兵只负责"别丢东西"。 */
      stat.rawTagNodes = (stat.rawTagNodes || 0) + (html.match(/class="[^"]*\bapp_tag\b/g) || []).length;
      stat.maxRawTags = Math.max(stat.maxRawTags || 0, (html.match(/class="[^"]*\bapp_tag\b/g) || []).length);
      if ((html.match(/class="[^"]*\bapp_tag\b/g) || []).length > tags.length) {
        stat.tagTruncated = (stat.tagTruncated || 0) + 1;
        if (!stat.diagTagTrunc) {
          stat.diagTagTrunc = (g.name || g.appid) + '：原始 app_tag 节点 ' +
            (html.match(/class="[^"]*\bapp_tag\b/g) || []).length + ' 个，解析出 ' + tags.length + ' 个';
        }
      }
      /* 诊断样本只在「真的解析出东西」时留一份，
         否则样本会取自恰好没有标签的那一款，看起来像解析坏了 */
      if (!stat.diagTagHtml && tags.length) {
        const idx = html.search(/<a\b[^>]*class="[^"]*\bapp_tag\b/);
        stat.diagTagHtml = idx === -1 ? '(解析出标签但定位不到区块)' : html.slice(idx, idx + 260);
      }
      if (!stat.diagBundleHtml && bundles.length) {
        const bi = html.search(/data-ds-bundleid|data-bundleid|game_area_purchase_game_bundle/);
        stat.diagBundleHtml = bi === -1 ? '(解析出标记但定位不到区块)' : html.slice(bi, bi + 260);
      }
      /* 折扣截止时间：来自商店页的倒计时节点 */
      if (g.price && g.price.isOnSale) {
        const dl = parseSaleDeadline(html);
        if (dl.expirationMs) {
          if (fillDeadlineFromStore(g, dl.expirationMs)) {
            stat.deadlines++;
            const how = String(dl.diag.matched);
            if (how.indexOf('文字日期') === 0) stat.byText++;
            else if (how.indexOf('购买区文字') === 0) stat.byKeyword++;
          }
          if (!stat.diagDeadline) stat.diagDeadline = (dl.diag.matched || '') + ' → ' + dl.diag.snippet;
        } else if (!stat.diagDeadlineNoMatch) {
          stat.diagDeadlineNoMatch = dl.diag.snippet;
          stat.diagNoMatchCountdown = dl.diag.countdownHtml || '(购买区里没有 game_purchase_discount_countdown 节点)';
          stat.diagNoMatchGame = (g.name || g.appid) + '（AppID ' + g.appid + '）' +
            ' ｜ 页面 ' + html.length + ' 字符' +
            ' ｜ 购买区：' + /game_area_purchase/.test(html) +
            ' ｜ discount_pct：' + /discount_pct/.test(html) +
            ' ｜ countdown：' + /countdown/i.test(html) +
            ' ｜ data-timestamp：' + /data-timestamp/i.test(html) +
            ' ｜ 年龄门标记(agecheck/mature/birthtime)：' + /agecheck|age_check|age-gate|mature_content|birthtime/i.test(html) +
            ' ｜ app_tag：' + /app_tag/.test(html);
        }
      }
      g.details.userTags = tags;
      g.details.userTagsFetchedAt = nowMs();
      if (bundles.length) g.details.bundleIds = bundles;
      stat.ok++;
      stat.tags += tags.length;
      if (tags.length) stat.withTags++;
      stat.bundles += bundles.length;
      if (i % 20 === 19) log(`  商店页进度 ${i + 1}/${todo.length}…`);
    } catch (e) {
      stat.failed++;
      // 单款失败不影响整体
      if (stat.failed <= 3) warn(`  商店页抓取失败 ${g.name || g.appid}：${e.message}`);
    }
  }
  return stat;
}

function printStoreDiag(stat) {
  if (!CFG.diag) return;
  log(`[诊断·商店页] 尝试 ${stat.tried} 款，成功 ${stat.ok}，失败 ${stat.failed}；` +
      `其中 ${stat.withTags} 款解析出用户标签（共 ${stat.tags} 个）、捆绑包标记 ${stat.bundles} 个、` +
      `补上折扣截止时间 ${stat.deadlines} 款（其中倒计时文字日期 ${stat.byText} 款、` +
      `购买区关键词日期 ${stat.byKeyword} 款；清单里促销却缺截止时间的共 ${stat.needDeadline} 款）`);
  /* 队列健康度：让「新游戏有没有被照顾到」一眼可见 */
  log(`[诊断·商店页] 队列：从未抓过标签的新游戏 ${stat.newGames} 款` +
      (stat.deferred ? `，本次配额用尽，剩余 ${stat.deferred} 款顺延到下次运行` : '，本次全部处理完'));
  if (stat.diagTagHtml) log('[诊断·商店页] 标签区首段 HTML：' + stat.diagTagHtml);
  if (stat.diagBundleHtml) log('[诊断·商店页] 捆绑包标记首段 HTML：' + stat.diagBundleHtml);
  if (stat.diagDeadline) log('[诊断·商店页] 折扣倒计时命中：' + stat.diagDeadline);
  if (stat.diagNoMatchGame) log('[诊断·商店页] 未命中倒计时的样例：' + stat.diagNoMatchGame);
  if (stat.diagNoMatchCountdown) log('[诊断·商店页] 该样例的倒计时节点原文：' + stat.diagNoMatchCountdown);
  if (stat.diagDeadlineNoMatch) log('[诊断·商店页] 该样例的购买区原文：' + stat.diagDeadlineNoMatch);
}

/* ==================================================================
 * 新增数据源 C：缺失中文名的机翻补齐
 * ------------------------------------------------------------------
 * 浏览器侧访问 translate.googleapis.com 常年不通（实测），
 * 而 GitHub Actions 的出口网络可以正常访问 → 把机翻放到 CI 做。
 * 结果打标记 nameSource='machine-translation'，页面可显示「机翻」角标。
 * 只翻译纯英文名，且已有缓存的直接复用，不重复请求。
 * ================================================================== */
async function translateGoogle(text) {
  const q = encodeURIComponent(String(text).slice(0, 900));
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + q;
  let lastErr = null;
  const tries = Math.max(1, CFG.translateRetries);
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(CFG.translateIntervalMs * i * 2);   // 退避：1.2s → 2.4s …
    await rateLimit(CFG.translateIntervalMs);
    try {
      const arr = await fetchJSON(url);
      if (!Array.isArray(arr) || !Array.isArray(arr[0])) return null;
      const s = arr[0].map(x => (x && x[0]) || '').join('').trim();
      return s || null;
    } catch (e) {
      lastErr = e;
      // 只有「被限流 / 服务端临时故障」才重试；其它错误直接放弃，别浪费时间
      if (!/HTTP (429|500|502|503|504)/.test(String(e.message || ''))) throw e;
    }
  }
  throw lastErr || new Error('translate failed');
}

async function enrichChineseNames(games) {
  const stat = { enabled: CFG.translate, total: 0, reused: 0, translated: 0, failed: 0 };
  if (!CFG.translate) return stat;
  const todo = games.filter(g =>
    g && g.name && !hasChinese(g.name) && /[A-Za-z]/.test(g.name) && g.nameSource !== 'machine-translation'
  );
  stat.total = todo.length;
  if (!todo.length) return stat;
  log(`发现 ${todo.length} 款没有中文名，开始机翻补齐（CI 侧执行）…`);
  for (const g of todo) {
    // 已有缓存译文 → 直接用，避免重复请求
    if (g.nameZh && hasChinese(g.nameZh)) {
      g.originalName = g.originalName || g.name;
      g.name = g.nameZh;
      g.nameSource = 'machine-translation';
      stat.reused++;
      continue;
    }
    try {
      const zh = await translateGoogle(g.name);
      if (zh && hasChinese(zh)) {
        g.nameZh = zh;
        g.originalName = g.originalName || g.name;
        g.name = zh;
        g.nameSource = 'machine-translation';
        g.nameTranslatedAt = nowMs();
        stat.translated++;
        if (stat.translated % 20 === 0) log(`  中文名进度 ${stat.translated}…`);
      } else {
        stat.failed++;
      }
    } catch (e) {
      stat.failed++;
      if (stat.failed <= 3) warn(`  翻译失败 ${g.name}：${e.message}`);
    }
  }
  return stat;
}

/* ============================ 主流程 ============================ */
function loadDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error('找不到数据文件：' + path.relative(ROOT, DATA_FILE) +
      '\n请先在页面里点工具栏「☁️ 同步到云端」把数据上传到仓库，或手动放入 data/wishlist.json。');
  }
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { throw new Error('数据文件不是合法 JSON：' + e.message); }
  if (!data || !Array.isArray(data.games)) throw new Error('数据文件缺少 games 数组。');
  return data;
}

/* 【修复】这里以前只写 {version, updatedAt, refreshedAt, games}，
   会把页面「☁️ 同步到云端」时写入的来源指纹（source / syncedAt /
   gameCount / fingerprint / syncedFrom）整段丢掉 —— 用户点一次同步、
   凌晨 CI 一跑，指纹就没了。现在原样保留，并补记是谁刷的。 */
const PROVENANCE_KEYS = ['source', 'syncedAt', 'gameCount', 'fingerprint', 'syncedFrom'];

function saveDataFile(data) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { version: data.version || 3 };
  PROVENANCE_KEYS.forEach(k => { if (data[k] !== null && data[k] !== undefined) payload[k] = data[k]; });
  payload.updatedAt = nowMs();
  payload.refreshedAt = nowMs();
  payload.refreshedBy = 'github-actions';
  payload.refreshCount = (Number(data.refreshCount) || 0) + 1;
  payload.games = data.games;
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function refreshOne(g) {
  const before = {
    price: g.price ? g.price.current : null,
    low: g.historicalLow ? g.historicalLow.price : null,
    score: g.rating ? g.rating.score : null
  };
  const data = await steamAppDetails(g.appid);
  if (!data) return null;
  g.price = extractPrice(data, data.price_overview);
  if (data.name) {
    // 官方中文名优先；无中文名时保留原有名称（不在云端做机翻，避免引入不确定内容）
    if (hasChinese(data.name)) g.name = data.name;
    g.originalName = data.name || g.originalName;
  }
  try {
    const qs = await steamReviews(g.appid);
    if (qs && qs.total_reviews > 0) {
      const positive = Math.round(qs.total_positive / qs.total_reviews * 100);
      g.rating = { score: scoreFromPositive(positive), positive, total: qs.total_reviews, desc: qs.review_score_desc || null, updatedAt: nowMs() };
    }
  } catch (e) { /* 评分失败保留旧值 */ }
  // ITAD 史低：手动确认的永不覆盖
  if (!(g.historicalLow && g.historicalLow.source === '手动确认')) {
    try {
      const low = await itadHistoryLow(g.appid);
      if (low && !low.skipped) g.historicalLow = low;
    } catch (e) { /* 史低失败保留旧值 */ }
  }
  g.updatedAt = nowMs();
  const after = {
    price: g.price ? g.price.current : null,
    low: g.historicalLow ? g.historicalLow.price : null,
    score: g.rating ? g.rating.score : null
  };
  return { before, after, name: g.name, appid: g.appid };
}

function diffChanges(results, games) {
  const newLow = [], reached = [], bigDrop = [], endingSoon = [], priceDrop = [];
  results.forEach(r => {
    if (!r) return;
    const g = games.find(x => Number(x.appid) === Number(r.appid));
    if (!g) return;
    // 史低被刷新（变便宜了）
    if (r.before.low != null && r.after.low != null && r.after.low < r.before.low) {
      newLow.push({ g, from: r.before.low, to: r.after.low });
    }
    // 达到目标价
    if (isTargetReached(g)) reached.push(g);
    // 价格下降
    if (r.before.price != null && r.after.price != null && r.after.price < r.before.price) {
      priceDrop.push({ g, from: r.before.price, to: r.after.price });
    }
    // 折扣 24h 内结束
    const ms = saleRemainMs(g);
    if (ms != null && ms > 0 && ms <= 24 * 3600 * 1000) endingSoon.push(g);
  });
  return { newLow, reached, bigDrop, endingSoon, priceDrop };
}

/* ============================ 邮件 ============================ */
function buildMail(data, results, changes, stats) {
  const d = todayStr();
  const subject = `🎮 Steam 愿望单日报 ${d}｜${stats.total} 款 · 促销 ${stats.onSale} · 史低 ${stats.atLow} · 达标 ${changes.reached.length}`;

  const rowsOf = (list, render) => list.map(render).join('');
  const gRow = (g) => `<tr>
    <td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">${esc(g.name)}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;white-space:nowrap;">${esc(fmtPrice(g.price && g.price.current, g.price && g.price.currency))}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;white-space:nowrap;">${g.price && g.price.discountPercent ? '-' + g.price.discountPercent + '%' : '—'}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;white-space:nowrap;">${esc(fmtPrice(g.historicalLow && g.historicalLow.price, g.historicalLow && g.historicalLow.currency))}</td>
    <td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;white-space:nowrap;">${g.targetPrice != null ? esc(fmtPrice(g.targetPrice)) : '未设'}</td>
  </tr>`;

  const section = (title, list, render) => list.length
    ? `<h3 style="margin:22px 0 8px;font-size:15px;color:#0b5c8a;">${title} <span style="color:#94a3b3;font-weight:400;">(${list.length})</span></h3>
       <table style="width:100%;border-collapse:collapse;font-size:13px;">${list.map(render).join('')}</table>`
    : '';

  const head = `<h3 style="margin:22px 0 8px;font-size:15px;color:#0b5c8a;">概览</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">收录总数</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${stats.total}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">本次成功刷新</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${stats.refreshed}${stats.failed ? '（失败 ' + stats.failed + '）' : ''}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">🔥 正在促销</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${stats.onSale}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">📉 处于史低</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${stats.atLow}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">🎯 已达目标价</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${changes.reached.length}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">当前合计</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${fmtPrice(stats.sumCur, 'CNY')}</td></tr>
      <tr><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;">史低合计</td><td style="padding:6px 8px;border-bottom:1px solid #eef2f6;text-align:right;font-weight:600;">${fmtPrice(stats.sumLow, 'CNY')}</td></tr>
    </table>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:20px;background:#f6f8fa;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2b38;">
  <div style="max-width:760px;margin:0 auto;background:#fff;border-radius:12px;padding:22px 24px;border:1px solid #e3e9ef;">
    <h1 style="margin:0 0 4px;font-size:19px;color:#0b3d5c;">🎮 Steam 愿望单日报</h1>
    <div style="font-size:12px;color:#8296a8;">生成时间：${new Date().toLocaleString('zh-CN', { timeZone: TZ_LABEL, hour12: false })} · 数据源 Steam / ITAD</div>
    ${head}
    ${section('🎯 已达目标价', changes.reached, gRow)}
    ${section('📉 史低被刷新（更便宜了）', changes.newLow, x => gRow(x.g))}
    ${section('⬇️ 价格下降', changes.priceDrop, x => gRow(x.g))}
    ${section('⏰ 24 小时内结束促销', changes.endingSoon, gRow)}
    <h3 style="margin:22px 0 8px;font-size:15px;color:#0b5c8a;">全部清单 <span style="color:#94a3b3;font-weight:400;">(${data.games.length})</span></h3>
    <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
      <tr style="background:#f2f6f9;">
        <th style="padding:6px 8px;text-align:left;color:#5b7288;font-weight:600;">游戏名</th>
        <th style="padding:6px 8px;text-align:right;color:#5b7288;font-weight:600;">当前价</th>
        <th style="padding:6px 8px;text-align:right;color:#5b7288;font-weight:600;">折扣</th>
        <th style="padding:6px 8px;text-align:right;color:#5b7288;font-weight:600;">史低</th>
        <th style="padding:6px 8px;text-align:right;color:#5b7288;font-weight:600;">目标价</th>
      </tr>
      ${data.games.map(gRow).join('')}
    </table>
    <div style="margin-top:20px;padding-top:14px;border-top:1px solid #eef2f6;font-size:11.5px;color:#93a5b6;line-height:1.7;">
      本邮件由 GitHub Actions 于每天北京时间 02:00 自动生成。<br>
      完整 JSON 已随附在本邮件中，文件名 <code>steam-wishlist-${d}.json</code>。<br>
      数据仅使用 Steam / ITAD 官方返回字段，缺失即留空，不做推算。
    </div>
  </div></body></html>`;

  const text = [
    'Steam 愿望单日报 ' + d,
    '收录 ' + stats.total + ' 款 · 促销 ' + stats.onSale + ' · 史低 ' + stats.atLow,
    '已达目标价 ' + changes.reached.length + ' 款' + (changes.reached.length ? '：' + changes.reached.map(g => g.name).join('、') : ''),
    '史低被刷新 ' + changes.newLow.length + ' 款' + (changes.newLow.length ? '：' + changes.newLow.map(x => x.g.name).join('、') : ''),
    '24h 内结束促销 ' + changes.endingSoon.length + ' 款',
    '当前合计 ' + fmtPrice(stats.sumCur, 'CNY') + ' / 史低合计 ' + fmtPrice(stats.sumLow, 'CNY'),
    '',
    '全部清单：',
    ...data.games.map(g => '  · ' + g.name + '｜' + fmtPrice(g.price && g.price.current, g.price && g.price.currency) +
      (g.price && g.price.discountPercent ? ' (-' + g.price.discountPercent + '%)' : '') +
      '｜史低 ' + fmtPrice(g.historicalLow && g.historicalLow.price, g.historicalLow && g.historicalLow.currency) +
      '｜目标 ' + (g.targetPrice != null ? fmtPrice(g.targetPrice) : '未设'))
  ].join('\n');

  return { subject, html, text };
}

async function sendMail(mail, attachmentPath) {
  const { host, port, secure, user, pass, from, to } = CFG.smtp;
  // 显式列出每项，方便排查（任一空就跳过）
  const missing = [];
  if (!host) missing.push('SMTP_HOST');
  if (!user) missing.push('SMTP_USER');
  if (!pass) missing.push('SMTP_PASS');
  if (!to)   missing.push('MAIL_TO');
  if (missing.length) {
    log('未配置 SMTP（缺 ' + missing.join('、') + '），跳过发信。JSON 已写入文件。');
    return false;
  }
  const nm = await getMailer();
  if (!nm) {
    warn('未安装 nodemailer（请在仓库根目录执行 npm install），跳过发信。JSON 已正常导出。');
    return false;
  }
  const transporter = nm.createTransport({
    host, port, secure,
    auth: { user, pass },
    // QQ 邮箱用 465/SSL；587 走 STARTTLS
    ...(secure ? {} : { requireTLS: true })
  });
  const attachments = [];
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    attachments.push({ filename: path.basename(attachmentPath), path: attachmentPath });
  }
  const info = await transporter.sendMail({
    from: from || user,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    attachments
  });
  log('邮件已发送：' + (info.messageId || 'ok') + ' → ' + to);
  return true;
}

/* ============================ 入口 ============================ */
async function main() {
  log('=== Steam 愿望单 · 每日自动刷新 开始 ===');
  const started = nowMs();

  const data = loadDataFile();
  let games = data.games.filter(g => g && g.appid);
  log('读取到 ' + games.length + ' 款游戏' + (CFG.itadKey ? '（ITAD 史低已启用）' : '（未配置 ITAD_API_KEY，跳过史低查询）'));

  if (CFG.maxGames > 0 && games.length > CFG.maxGames) {
    log('本次只刷新前 ' + CFG.maxGames + ' 款（MAX_GAMES 限制）。');
    games = games.slice(0, CFG.maxGames);
  }

  const results = [];
  let failed = 0;
  for (let i = 0; i < games.length; i++) {
    const g = games[i];
    try {
      const r = await refreshOne(g);
      results.push(r);
      log(`  ${i + 1}/${games.length} ✓ ${g.name} ${fmtPrice(g.price && g.price.current, g.price && g.price.currency)}` +
        (g.price && g.price.discountPercent ? ' -' + g.price.discountPercent + '%' : ''));
    } catch (e) {
      failed++;
      warn(`  ${i + 1}/${games.length} ✗ ${g.name || g.appid}：${e.message}`);
    }
  }

  /* ---------------- 新增：特惠日历（补折扣截止时间） ---------------- */
  let calStat = { matched: 0, filled: 0, kept: 0, stillUnknown: 0 };
  try {
    const cal = await fetchSaleCalendar();
    printSaleDiag(cal.diag);
    calStat = applySaleCalendar(data.games, cal.map);
    log(`特惠日历：命中清单 ${calStat.matched} 款，补上截止时间 ${calStat.filled} 款，` +
        `保留更可信来源 ${calStat.kept} 款${calStat.stillUnknown ? '，仍未知 ' + calStat.stillUnknown + ' 款' : ''}`);
  } catch (e) {
    warn('特惠日历处理异常（不影响其它数据）：' + e.message);
  }

  /* ---------------- 新增：中文名机翻补齐 ---------------- */
  try {
    const tr = await enrichChineseNames(games);
    if (tr.total) {
      log(`中文名：待补 ${tr.total} 款 → 新译 ${tr.translated} 款，复用缓存 ${tr.reused} 款，失败 ${tr.failed} 款`);
    } else {
      log('中文名：无缺失，跳过。');
    }
  } catch (e) {
    warn('中文名补齐异常（不影响其它数据）：' + e.message);
  }

  /* ---------------- 新增：商店页用户标签 / 捆绑包 ---------------- */
  try {
    const st = await enrichStoreData(games);
    printStoreDiag(st);
    log(`用户标签：本次抓取 ${st.ok}/${st.tried} 款成功，共 ${st.tags} 个标签` +
        (st.failed ? `，失败 ${st.failed} 款（下次运行会重试）` : ''));
    /* 【上限哨兵】明确报告"页面原始节点数 vs 解析数"，让任何新的静默截断
       在日志里一眼可见，而不是等用户发现"怎么只有 20 个标签"。 */
    log(`[上限哨兵] app_tag 原始节点：单页最多 ${st.maxRawTags || 0} 个、合计 ${st.rawTagNodes || 0} 个；` +
        `解析出 ${st.tags} 个标签；` +
        (st.tagTruncated
          ? `⚠ 有 ${st.tagTruncated} 款原始节点多于解析结果，疑似截断！样例：${st.diagTagTrunc}`
          : `无截断（两者一致）。`));
  } catch (e) {
    warn('商店页标签处理异常（不影响其它数据）：' + e.message);
  }

  const payload = saveDataFile(data);
  const jsonPath = path.join(ROOT, 'data', `steam-wishlist-${todayStr()}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  log('已导出 JSON：' + path.relative(ROOT, jsonPath));
  const changes = diffChanges(results, data.games);
  const known = g => g.price && g.price.current != null;
  const lowKnown = g => g.historicalLow && g.historicalLow.price != null;
  const stats = {
    total: data.games.length,
    refreshed: results.filter(Boolean).length,
    failed,
    onSale: data.games.filter(g => g.price && g.price.isOnSale).length,
    atLow: data.games.filter(isAtHistoricalLow).length,
    sumCur: data.games.reduce((a, g) => a + (known(g) ? g.price.current : 0), 0),
    sumLow: data.games.reduce((a, g) => a + (lowKnown(g) ? g.historicalLow.price : 0), 0)
  };

  const hasChanges = changes.newLow.length || changes.reached.length || changes.priceDrop.length;
  const shouldMail = CFG.mailMode === 'always' || (CFG.mailMode === 'changes' && hasChanges);
  if (shouldMail) {
    try {
      const mail = buildMail(data, results, changes, stats);
      await sendMail(mail, jsonPath);
    } catch (e) {
      warn('邮件发送失败：' + e.message + '（JSON 已正常写入，数据不受影响）');
    }
  } else {
    log('MAIL_MODE=changes 且本次无变化，跳过发信。');
  }

  log('=== 完成 ===');
  log(`收录 ${stats.total}｜刷新成功 ${stats.refreshed}｜失败 ${failed}｜促销 ${stats.onSale}｜史低 ${stats.atLow}｜达标 ${changes.reached.length}`);
  log(`当前合计 ${fmtPrice(stats.sumCur, 'CNY')}｜史低合计 ${fmtPrice(stats.sumLow, 'CNY')}`);
  log('耗时 ' + ((nowMs() - started) / 1000).toFixed(1) + ' 秒');
}

/* 直接 `node tools/daily-refresh.mjs` 运行时才自动执行；
   被 import（如离线自测）时只导出 main，由调用方决定何时跑、何时等。 */
export { main };

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch (e) { return false; }
})();

if (isDirectRun) {
  main().catch(e => {
    console.error('❌ 任务失败：' + (e && e.stack || e));
    // 数据文件缺失/损坏属于配置问题，用退出码 1 让 Actions 标记失败，方便你看到
    process.exit(1);
  });
}
