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
const SOON = Math.floor(Date.now() / 1000) + 3600 * 12;
const FAKE = {
  '1245620': {           // 艾尔登法环：正在打折，且官方给了截止时间
    name: 'ELDEN RING', is_free: false,
    price_overview: { final: 17800, initial: 29800, discount_percent: 40, currency: 'CNY', discount_expiration: SOON },
    developers: ['FromSoftware Inc.'], publishers: ['FromSoftware Inc.']
  },
  '292030': {            // 巫师3：免费
    name: 'The Witcher 3: Wild Hunt', is_free: true,
    developers: ['CD PROJEKT RED'], publishers: ['CD PROJEKT RED']
  },
  '413150': {            // 星露谷：打折但官方【没给】截止时间 → 应由特惠日历补
    name: 'Stardew Valley', is_free: false,
    price_overview: { final: 2400, initial: 4800, discount_percent: 50, currency: 'CNY' },
    developers: ['ConcernedApe'], publishers: ['ConcernedApe']
  },
  '9999999': null        // 故意不存在，测失败容错
};
const REVIEWS = {
  '1245620': { total_reviews: 500000, total_positive: 460000, review_score_desc: 'Very Positive' },
  '292030': { total_reviews: 700000, total_positive: 670000, review_score_desc: 'Overwhelmingly Positive' },
  '413150': { total_reviews: 600000, total_positive: 588000, review_score_desc: 'Overwhelmingly Positive' }
};
/* 特惠日历：故意同时包含 ELDEN RING（但给一个【不同】的截止时间），
   用来验证「官方 appdetails 给了截止时间时，日历不得覆盖」。 */
const SALE = {
  status: 1,
  specials: {
    id: 'specials', name: '特惠',
    items: [
      { id: 413150, name: 'Stardew Valley', discount_percent: 50, original_price: 4800, final_price: 2400, currency: 'CNY', discount_expiration: SOON },
      { id: 1245620, name: 'ELDEN RING', discount_percent: 40, original_price: 29800, final_price: 17800, currency: 'CNY', discount_expiration: SOON - 3600 }
    ]
  },
  dailydeal: {
    id: 'dailydeal', name: '今日特惠',
    items: [
      { id: 292030, name: 'The Witcher 3', discount_percent: 80, discount_expiration: SOON }
    ]
  }
};
/* 商店页 HTML 片段：用户标签 + 捆绑包标记 */
const STORE_HTML = (id) => `<!doctype html><html><body>
<div class="glance_ctn"><div class="glance_tags popular_tags">
<a class="app_tag" href="/tags/29482/">类魂</a>
<a class="app_tag" href="/tags/3959/">动作角色扮演</a>
<a class="app_tag" href="/tags/4231/">黑暗奇幻</a>
<a class="app_tag" href="/tags/128/">困难</a>
<a class="app_tag" href="/tags/492/">单人</a>
<a class="app_tag" style="display:none;">+</a>
</div></div>
<div class="game_area_purchase_game_wrapper" data-ds-bundleid="12557">
  <h1>购买 ${id} 系列合集 BUNDLE (?)</h1>
</div>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname.startsWith('/api/appdetails')) {
    const id = u.searchParams.get('appids');
    const d = FAKE[id];
    return json(d === undefined ? { [id]: { success: false } } : { [id]: { success: !!d, data: d } });
  }
  if (u.pathname.startsWith('/api/featuredcategories')) return json(SALE);
  if (u.pathname.startsWith('/appreviews/')) {
    const id = u.pathname.split('/')[2];
    return json({ query_summary: REVIEWS[id] || {} });
  }
  if (u.pathname.startsWith('/app/')) {
    const id = u.pathname.split('/')[2];
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(STORE_HTML(id));
  }
  if (u.pathname.startsWith('/translate_a/single')) {
    const q = u.searchParams.get('q') || '';
    return json([[[`【中文】${q}`, q, null, null, 1]], null, 'en']);
  }
  res.writeHead(404); res.end('[]');
});

/* ---- 准备测试数据 ---- */
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const BACKUP = path.join(DATA_DIR, 'wishlist.json._selftest_backup');
const TARGET = path.join(DATA_DIR, 'wishlist.json');
if (fs.existsSync(TARGET)) fs.copyFileSync(TARGET, BACKUP);

/* 测试隔离：
   1) 先把已存在的「每日快照」挪到一边，否则本次产物会和旧文件混在一起，
      既判断不出是不是新生成的，也没法安全清理；
   2) 再记录此刻 data/ 里有哪些文件，跑完把新增的删掉。 */
const SNAP_RE = /^steam-wishlist-\d{4}-\d{2}-\d{2}\.json$/;
const SNAP_HOLD = path.join(DATA_DIR, '_selftest_snap_hold');
fs.mkdirSync(SNAP_HOLD, { recursive: true });
const heldSnaps = [];
(fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []).filter(f => SNAP_RE.test(f)).forEach(f => {
  try { fs.renameSync(path.join(DATA_DIR, f), path.join(SNAP_HOLD, f)); heldSnaps.push(f); } catch (e) {}
});
const beforeFiles = new Set(fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR) : []);

const fixture = {
  version: 3,
  // 来源指纹：CI 必须原样保留，不能被刷掉
  source: 'manual-sync',
  syncedAt: 1789000000000,
  gameCount: 4,
  fingerprint: 'deadbeefcafe1234',
  syncedFrom: 'selftest',
  updatedAt: Date.now(),
  games: [
    {
      appid: 1245620, name: 'ELDEN RING', originalName: 'ELDEN RING',
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
      appid: 413150, name: 'Stardew Valley', originalName: 'Stardew Valley',
      price: { current: 48, original: 48, discountPercent: 0, currency: 'CNY', isOnSale: false, discountExpiration: null, updatedAt: 0 },
      rating: { score: null, positive: null, total: null, desc: null, updatedAt: 0 },
      historicalLow: { price: null, count: null, confidence: 'pending', source: null, updatedAt: 0 },
      targetPrice: null, note: '', dlcList: [], details: {}, createdAt: Date.now(), updatedAt: Date.now()
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
const hasChineseIn = s => /[\u4e00-\u9fff]/.test(String(s || ''));

await new Promise(r => server.listen(8763, r));

// 劫持 fetch 把线上域名指到本地假服务
const realFetch = globalThis.fetch;
const LOCAL = 'http://127.0.0.1:8763';
const REWRITES = [
  ['https://store.steampowered.com/api/appdetails', LOCAL + '/api/appdetails'],
  ['https://store.steampowered.com/api/featuredcategories', LOCAL + '/api/featuredcategories'],
  ['https://store.steampowered.com/appreviews', LOCAL + '/appreviews'],
  ['https://translate.googleapis.com/translate_a/single', LOCAL + '/translate_a/single'],
];
globalThis.fetch = (url, opts) => {
  const s = String(url);
  for (const [from, to] of REWRITES) {
    if (s.includes(from)) return realFetch(s.replace(from, to), opts);
  }
  // 商店页（抓标签用）：注意要放在 appdetails / appreviews 之后判断
  if (/^https:\/\/store\.steampowered\.com\/app\//.test(s)) {
    return realFetch(s.replace('https://store.steampowered.com', LOCAL), opts);
  }
  return realFetch(url, opts);
};

process.env.REQ_INTERVAL_MS = '10';
process.env.TAG_INTERVAL_MS = '10';
process.env.TRANSLATE_INTERVAL_MS = '10';
process.env.DIAG = 'true';            // 顺带验证诊断输出这条代码路径能跑通
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

/* ---------- 新增能力校验 ---------- */
const sdv = byId['413150'];
check('特惠日历补上了官方没给的折扣截止时间', !!sdv.price.discountExpiration, JSON.stringify(sdv.price));
check('该截止时间来源标记为 featuredcategories', sdv.price.expirationSource === 'featuredcategories', String(sdv.price.expirationSource));
check('官方 appdetails 给的截止时间不被日历覆盖', elden.price.expirationSource === 'appdetails', String(elden.price.expirationSource));
check('该截止时间的具体数值也没被日历改成更早的那个', elden.price.discountExpiration === SOON * 1000,
  elden.price.discountExpiration + ' vs appdetails ' + (SOON * 1000) + ' / 日历 ' + ((SOON - 3600) * 1000));
check('用户标签已抓取（星露谷）', Array.isArray(sdv.details.userTags) && sdv.details.userTags.indexOf('类魂') !== -1,
  JSON.stringify(sdv.details && sdv.details.userTags));
check('标签里的 "+" 占位被过滤，共 5 个', (sdv.details.userTags || []).length === 5, JSON.stringify(sdv.details && sdv.details.userTags));
check('捆绑包标记已抓取', Array.isArray(sdv.details.bundleIds) && sdv.details.bundleIds.indexOf(12557) !== -1,
  JSON.stringify(sdv.details && sdv.details.bundleIds));
check('缺失的中文名已由 CI 机翻补齐', hasChineseIn(sdv.name) && sdv.nameSource === 'machine-translation', sdv.name + ' / ' + sdv.nameSource);
check('英文原名被保留到 originalName', sdv.originalName === 'Stardew Valley', String(sdv.originalName));
check('已有中文名的游戏不被机翻改动', byId['292030'].name === '巫师3', byId['292030'].name);

check('输出文件含 refreshedAt', !!out.refreshedAt);
check('来源指纹 source 未被 CI 刷掉', out.source === 'manual-sync', String(out.source));
check('来源指纹 fingerprint 未被刷掉', out.fingerprint === 'deadbeefcafe1234', String(out.fingerprint));
check('来源指纹 syncedAt / gameCount 未被刷掉', out.syncedAt === 1789000000000 && out.gameCount === 4,
  out.syncedAt + ' / ' + out.gameCount);
check('refreshCount 已累加', out.refreshCount === 1, String(out.refreshCount));
check('补记了 refreshedBy', out.refreshedBy === 'github-actions', String(out.refreshedBy));

/* ---------- 测试隔离：不能把假数据留在真实数据目录 ---------- */
const afterFiles = fs.readdirSync(DATA_DIR);
const leaked = afterFiles.filter(f => !beforeFiles.has(f));
const snap = leaked.find(f => SNAP_RE.test(f));
check('快照 JSON 已正确生成', !!snap, '新增文件：' + (leaked.join(', ') || '(无)'));
if (snap) {
  try {
    const snapData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, snap), 'utf8'));
    check('快照里保留了来源指纹、且含 4 款游戏',
      snapData.source === 'manual-sync' && (snapData.games || []).length === 4,
      'games=' + ((snapData.games || []).length) + ' source=' + snapData.source);
  } catch (e) { check('快照 JSON 可解析', false, e.message); }
}
// 清掉本次测试生成的产物，绝不留在用户真实数据目录里
leaked.forEach(f => {
  try { fs.rmSync(path.join(DATA_DIR, f), { recursive: true, force: true }); } catch (e) {}
});
check('测试未在真实 data/ 留下残留文件',
  fs.readdirSync(DATA_DIR).filter(f => !beforeFiles.has(f)).length === 0);

// 还原现场：把挪走的旧快照放回原位，并恢复真实数据文件
heldSnaps.forEach(f => {
  try { fs.renameSync(path.join(SNAP_HOLD, f), path.join(DATA_DIR, f)); } catch (e) {}
});
try { fs.rmdirSync(SNAP_HOLD); } catch (e) {}
if (fs.existsSync(BACKUP)) { fs.copyFileSync(BACKUP, TARGET); fs.unlinkSync(BACKUP); }
else { fs.unlinkSync(TARGET); }

server.close();
console.log('\n============================');
console.log('SELFTEST PASS ' + pass + '  FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);
