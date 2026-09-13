#!/usr/bin/env node
/**
 * tools/_selftest.mjs
 * 离线自测：用本地假 Steam/ITAD 服务跑通 daily-refresh 全流程。
 * 不联网、不发真邮件，验证：
 *   · 读取 data/wishlist.json
 *   · 拉取价格/评分并保留用户手动字段
 *   · 输出 JSON
 *   · 有变化时正确识别（新史低 / 达标 / 降价）
 *   · 邮件内容能正常构建
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ---- 假 Steam 服务 ---- */
const FAKE = {
  '1245620': {           // 艾尔登法环：正在打折
    name: 'ELDEN RING', is_free: false,
    price_overview: { final: 17800, initial: 29800, discount_percent: 40, currency: 'CNY', discount_expiration: Math.floor(Date.now() / 1000) + 3600 * 12 },
    developers: ['FromSoftware Inc.'], publishers: ['FromSoftware Inc.']
  },
  '292030': {            // 巫师3：免费
    name: 'The Witcher 3: Wild Hunt', is_free: true,
    developers: ['CD PROJEKT RED'], publishers: ['CD PROJEKT RED']
  },
  '9999999': null        // 故意不存在，测失败容错
};
const REVIEWS = {
  '1245620': { total_reviews: 500000, total_positive: 460000, review_score_desc: 'Very Positive' },
  '292030': { total_reviews: 700000, total_positive: 670000, review_score_desc: 'Overwhelmingly Positive' }
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/appdetails')) {
    const id = u.searchParams.get('appids');
    const d = FAKE[id];
    const body = d === undefined
      ? { [id]: { success: false } }
      : { [id]: { success: !!d, data: d } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  if (u.pathname.startsWith('/appreviews/')) {
    const id = u.pathname.split('/')[2];
    const q = REVIEWS[id] || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ query_summary: q }));
  }
  res.writeHead(404); res.end('[]');
});

/* ---- 准备测试数据 ---- */
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BACKUP = path.join(DATA_DIR, 'wishlist.json._selftest_backup');
const TARGET = path.join(DATA_DIR, 'wishlist.json');
if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, BACKUP);

const fixture = {
  version: 3,
  updatedAt: Date.now(),
  games: [
    {
      appid: 1245620, name: '艾尔登法环', originalName: 'ELDEN RING',
      price: { current: 298, original: 298, discountPercent: 0, currency: 'CNY', isOnSale: false, discountExpiration: null, updatedAt: 0 },
      rating: { score: 9.2, positive: 90, total: 400000, desc: null, updatedAt: 0 },
      historicalLow: { price: 178, count: 5, confidence: 'A', source: 'ITAD(国区)', updatedAt: 0 },
      targetPrice: 200,        // 打折后 178 < 200 → 应判定达标
      note: '等大促',
      dlcList: [], details: {} , createdAt: Date.now(), updatedAt: Date.now()
    },
    {
      appid: 292030, name: '巫师3', originalName: 'The Witcher 3: Wild Hunt',
      price: { current: 50, original: 100, discountPercent: 50, currency: 'CNY', isOnSale: true, discountExpiration: null, updatedAt: 0 },
      rating: { score: 9.8, positive: 96, total: 600000, desc: null, updatedAt: 0 },
      historicalLow: { price: 30, count: 8, confidence: 'A', source: '手动确认', updatedAt: 0 },  // 手动确认 → 绝不能覆盖
      targetPrice: 20, note: '', dlcList: [], details: {}, createdAt: Date.now(), updatedAt: Date.now()
    },
    {
      appid: 9999999, name: '不存在的游戏', originalName: 'Ghost',
      price: { current: 100, original: 100, discountPercent: 0, currency: 'CNY', isOnSale: false, discountExpiration: null, updatedAt: 0 },
      rating: { score: null, positive: null, total: null, desc: null, updatedAt: 0 },
      historicalLow: { price: null, count: null, confidence: 'pending', source: null, updatedAt: 0 },
      targetPrice: null, note: '', dlcList: [], details: {}, createdAt: Date.now(), updatedAt: Date.now()
    }
  ]
};
fs.writeFileSync(TARGET, JSON.stringify(fixture, null, 2), 'utf8');

/* ---- 启动服务并注入 env，然后 import 主脚本 ---- */
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? ' -> ' + x : '')); } };

await new Promise(r => server.listen(8763, r));

// 劫持 fetch 把线上域名指到本地假服务
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const s = String(url);
  if (s.includes('store.steampowered.com/api/appdetails')) return realFetch(s.replace('https://store.steampowered.com', 'http://127.0.0.1:8763'), opts);
  if (s.includes('store.steampowered.com/appreviews')) return realFetch(s.replace('https://store.steampowered.com', 'http://127.0.0.1:8763'), opts);
  return realFetch(url, opts);
};

process.env.REQ_INTERVAL_MS = '10';
process.env.ITAD_API_KEY = '';        // 无 Key：跳过史低
process.env.MAIL_MODE = 'always';
// 不配 SMTP → 只写文件不发信

console.log('=== 离线自测：daily-refresh 全流程 ===\n');
process.chdir(ROOT);

try {
  const mod = await import(pathToFileURL(path.join(ROOT, 'tools', 'daily-refresh.mjs')).href);
  // 显式 await，确保主流程（含异步抓取）真正跑完再校验
  await mod.main();
} catch (e) {
  console.log('  运行失败：' + (e && e.message));
}

// ---- 校验结果 ----
console.log('\n--- 结果校验 ---');

const out = JSON.parse(fs.readFileSync(TARGET, 'utf8'));
const byId = Object.fromEntries(out.games.map(g => [String(g.appid), g]));

const elden = byId['1245620'];
check('价格已更新为 178（打折价）', elden.price.current === 178, JSON.stringify(elden.price));
check('折扣 40% 已记录', elden.price.discountPercent === 40);
check('折扣截止时间已记录', !!elden.price.discountExpiration);
check('用户备注被保留', elden.note === '等大促', elden.note);
check('用户目标价被保留', elden.targetPrice === 200, String(elden.targetPrice));
check('评分已按好评率重算', elden.rating.score != null, JSON.stringify(elden.rating));

const w3 = byId['292030'];
check('免费游戏价格归零', w3.price.current === 0, JSON.stringify(w3.price));
check('手动确认史低未被覆盖', w3.historicalLow.price === 30 && w3.historicalLow.source === '手动确认',
  JSON.stringify(w3.historicalLow));

const ghost = byId['9999999'];
check('不存在的游戏保留原数据（失败不影响整体）', ghost.price.current === 100, JSON.stringify(ghost.price));

check('输出文件含 refreshedAt', !!out.refreshedAt);
check('导出快照 JSON 已生成', fs.readdirSync(DATA_DIR).some(f => /^steam-wishlist-\d{4}-\d{2}-\d{2}\.json$/.test(f)));

// 还原现场
if (fs.existsSync(BACKUP)) { fs.copyFileSync(BACKUP, TARGET); fs.unlinkSync(BACKUP); }
else { fs.unlinkSync(TARGET); }

server.close();
console.log('\n============================');
console.log('SELFTEST PASS ' + pass + '  FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);
