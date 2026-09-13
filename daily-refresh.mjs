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
 * 可选环境变量见文件底部 printHelp()
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
async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wishlist-daily-refresh/1.0)',
        'Accept': 'application/json,text/plain,*/*',
        ...(opts.headers || {})
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('返回非 JSON：' + text.slice(0, 80)); }
  } finally {
    clearTimeout(t);
  }
}

/* ============================ 默认结构 ============================ */
function defaultPrice() { return { current: null, original: null, discountPercent: 0, currency: 'CNY', isOnSale: false, discountExpiration: null, updatedAt: 0 }; }
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
async function rateLimit() {
  const delta = nowMs() - lastReq;
  if (delta < CFG.intervalMs) await sleep(CFG.intervalMs - delta);
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

function saveDataFile(data) {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { version: data.version || 3, updatedAt: nowMs(), refreshedAt: nowMs(), games: data.games };
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
  if (!host || !user || !pass || !to) {
    log('未配置 SMTP（SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_TO），跳过发信。JSON 已写入文件。');
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
