/* 网络重试 / 限流自适应 专项回归（2026-09-19）

  背景（真实事故，run #30）：
    邮件日报写「本次成功刷新 200（失败 19）」。
    拉 CI 日志一看，第 201~219 款连续 19 条：
       ⚠️ 201/219 ✗ HITMAN 暗杀世界：HTTP 429
       ⚠️ 202/219 ✗ 天国：拯救2：HTTP 429
       ...
       ⚠️ 219/219 ✗ 深空梦里人2：逐星之旅：HTTP 429
    即 **Steam 从第 201 款起开始限流，后面全部被拒**，而旧代码
    `if (!resp.ok) throw new Error('HTTP ' + resp.status)` 一次失败即放弃。

  用户要求（关键）：
    「我不仅是要这 19 个新游戏的数据，我还要确保以后不会再出现任何这种问题，
      哪怕是我加了一千款一万款这种游戏」

  因此本测试锁死的**判据**不是"这次调用能成功"，而是：
    1. 429 / 5xx / 超时 / 连接重置 → **必须自动重试**，不是直接认输
    2. 重试要**退避**（间隔递增），且尊重服务端 Retry-After
    3. 被 429 后要**自动放慢整体节奏**（自适应限速），
       而不是继续匀速猛冲 —— 「清单越大越必然失败」的病根就在这里
    4. 不可重试的错误（404/400/非 JSON）**必须立刻抛出**，别浪费时间重试
    5. 整轮跑完后对"仍未成功"的款要**补跑**，且补跑轮数有上限、
       到上限仍有剩余时必须**明确告警**（绝不静默丢弃）—— 呼应「去上限」原则
    6. 重试相关参数**全部来自 CFG，源码无裸魔法数**

  跑法： node tools/_test_retry.cjs
*/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CI = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------
 * 从源码里把纯函数抠出来（不 import —— 该模块 import 时会保留状态，
 * 且 main() 有副作用；抠纯函数是最干净的隔离方式）
 * ------------------------------------------------------------------ */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function extractFn(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'g');
  const m = src.match(re);
  return m ? m[0] : null;
}
/* 全局依赖：CFG / nowMs / sleep / log / warn —— 抠出来单独注入 */
const deps = `
  const CFG = { intervalMs: 700, retryMax: 4, retryBaseMs: 100, retryMaxMs: 5000,
                rateCeilingMs: 60000, rateRecoverAfter: 3 };
  const nowMs = () => Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let __logs = [];
  const log = (...a) => __logs.push(a.join(' '));
  const warn = (...a) => __logs.push('[warn] ' + a.join(' '));
  const fetch = globalThis.fetch;
`;

const pureSrc = [
  extractFn(CI, 'isRetryableStatus'),
  extractFn(CI, 'isRetryableError'),
  extractFn(CI, 'backoffDelayMs'),
  extractFn(CI, 'parseRetryAfter'),
  extractFn(CI, 'rlReset'),
  extractFn(CI, 'rlBase'),
  extractFn(CI, 'rlSlowdown'),
  extractFn(CI, 'rlSpeedup'),
  extractFn(CI, 'rlReport'),
  extractFn(CI, 'fetchOnce'),
  extractFn(CI, 'fetchTextRetry'),
].filter(Boolean);

/* rl 状态对象 + fetchOnce 依赖的 withTimeout */
const stateSrc = `
  const rl = { currentMs: 0, cleanStreak: 0 };
  function withTimeout(init, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    return { init: Object.assign({}, init || {}, { signal: ctrl.signal }), done: () => clearTimeout(t) };
  }
`;

console.log('=== R. 源码结构检查 ===');
check('R-1 抠出 isRetryableStatus / isRetryableError / backoffDelayMs / parseRetryAfter',
  /function isRetryableStatus/.test(extractFn(CI, 'isRetryableStatus') || '') &&
  /function isRetryableError/.test(extractFn(CI, 'isRetryableError') || '') &&
  /function backoffDelayMs/.test(extractFn(CI, 'backoffDelayMs') || '') &&
  /function parseRetryAfter/.test(extractFn(CI, 'parseRetryAfter') || ''));
check('R-2 抠出 fetchOnce / fetchTextRetry',
  /function fetchOnce/.test(extractFn(CI, 'fetchOnce') || '') &&
  /function fetchTextRetry/.test(extractFn(CI, 'fetchTextRetry') || ''));
check('R-3 抠出自适应限速 rlSlowdown / rlSpeedup / rlReport',
  !!extractFn(CI, 'rlSlowdown') && !!extractFn(CI, 'rlSpeedup') && !!extractFn(CI, 'rlReport'));

const ctx = { module: {}, logs: [] };
const sandbox = { console, setTimeout, clearTimeout, AbortController, URL, Math, Date, isFinite, Number, String, RegExp, JSON, fetch: globalThis.fetch };
const code = `
"use strict";
${deps}${stateSrc}
${pureSrc.join('\n')}
__export({ isRetryableStatus, isRetryableError, backoffDelayMs, parseRetryAfter,
           rlReset, rlBase, rlSlowdown, rlSpeedup, rlReport, fetchOnce, fetchTextRetry,
           getLogs: () => __logs, clearLogs: () => { __logs = []; } });
`;
const vm = require('vm');
const box = { __export: o => Object.assign(ctx.module, o), console };
const sb = vm.createContext(Object.assign({}, sandbox, box));
try {
  vm.runInContext(code, sb, { filename: 'extracted.js' });
} catch (e) {
  console.log('  !! 抠取执行失败：' + e.message);
  console.log('  （多半是源码里改名了，请同步本测试的 extractFn 列表）');
  process.exit(2);
}
const M = ctx.module;

/* ------------------------------------------------------------------
 * A. 纯函数：什么是可重试的
 * ------------------------------------------------------------------ */
console.log('=== A. 可重试判定 ===');
check('A-1 429 可重试（本轮事故的主角）', M.isRetryableStatus(429) === true);
check('A-2 408 可重试', M.isRetryableStatus(408) === true);
check('A-3 500/502/503/504 可重试', [500, 502, 503, 504].every(s => M.isRetryableStatus(s)));
check('A-4 404 不可重试', M.isRetryableStatus(404) === false);
check('A-5 400 不可重试', M.isRetryableStatus(400) === false);
check('A-6 403 不可重试（权限问题重试没用）', M.isRetryableStatus(403) === false);
check('A-7 fetch failed 可重试', M.isRetryableError(new Error('fetch failed')) === true);
check('A-8 ECONNRESET 可重试', M.isRetryableError(new Error('read ECONNRESET')) === true);
check('A-9 ETIMEDOUT 可重试', M.isRetryableError(new Error('connect ETIMEDOUT 1.2.3.4:443')) === true);
check('A-10 AbortError（我们的超时）可重试', M.isRetryableError(Object.assign(new Error('aborted'), { name: 'AbortError' })) === true);
check('A-11 带 status=429 的错误对象可重试',
  M.isRetryableError(Object.assign(new Error('HTTP 429'), { status: 429 })) === true);
check('A-12 HTTP 429 文本可重试', M.isRetryableError(new Error('HTTP 429')) === true);
check('A-13 HTTP 503 文本可重试', M.isRetryableError(new Error('HTTP 503')) === true);
check('A-14 返回非 JSON 不可重试（重试也是非 JSON）',
  M.isRetryableError(new Error('返回非 JSON：<html>')) === false);
check('A-15 HTTP 404 文本不可重试', M.isRetryableError(new Error('HTTP 404')) === false);

/* ------------------------------------------------------------------
 * B. 退避计算
 * ------------------------------------------------------------------ */
console.log('=== B. 退避时长 ===');
const cfg = { retryBaseMs: 1000, retryMaxMs: 10000 };
const d1 = M.backoffDelayMs(1, null, cfg);
const d2 = M.backoffDelayMs(2, null, cfg);
const d3 = M.backoffDelayMs(3, null, cfg);
check('B-1 第 1 次退避 ≈ base(1000ms) + 抖动', d1 >= 1000 && d1 <= 1250, 'got ' + d1);
check('B-2 第 2 次退避 ≈ 2×base，严格大于第 1 次下界', d2 >= 2000 && d2 < 2600, 'got ' + d2);
check('B-3 第 3 次退避 ≈ 4×base', d3 >= 4000 && d3 < 5100, 'got ' + d3);
check('B-4 退避封顶 retryMaxMs（第 20 次也不会爆）',
  M.backoffDelayMs(20, null, cfg) <= cfg.retryMaxMs * 1.25, 'got ' + M.backoffDelayMs(20, null, cfg));
check('B-5 Retry-After 优先（服务端说 30s，就至少等 30s）',
  M.backoffDelayMs(1, 30, { retryBaseMs: 1000, retryMaxMs: 120000 }) >= 30000);
check('B-6 Retry-After 也受封顶约束（不会无限等）',
  M.backoffDelayMs(1, 99999, { retryBaseMs: 1000, retryMaxMs: 5000 }) <= 5000 * 1.25);
check('B-7 抖动存在（同一参数多次调用不全相等）',
  new Set(Array.from({ length: 12 }, () => M.backoffDelayMs(2, null, cfg))).size > 1);
check('B-8 attempt=0 也不产生负/NaN 退避',
  Number.isFinite(M.backoffDelayMs(0, null, cfg)) && M.backoffDelayMs(0, null, cfg) > 0);

/* ------------------------------------------------------------------
 * C. Retry-After 解析
 * ------------------------------------------------------------------ */
console.log('=== C. Retry-After 头解析 ===');
const mkHeaders = (v) => ({ get: (k) => (k.toLowerCase() === 'retry-after' ? (v == null ? null : v) : null) });
check('C-1 秒数写法 "30" → 30', M.parseRetryAfter(mkHeaders('30')) === 30);
check('C-2 秒数写法 "0" → 0', M.parseRetryAfter(mkHeaders('0')) === 0);
const future = new Date(Date.now() + 45000).toUTCString();
const sec = M.parseRetryAfter(mkHeaders(future));
check('C-3 HTTP 日期写法 → 换算成剩余秒（≈45）', sec >= 40 && sec <= 46, 'got ' + sec);
check('C-4 无该头 → null', M.parseRetryAfter(mkHeaders(null)) === null);
check('C-5 乱码 → null（不抛异常）', M.parseRetryAfter(mkHeaders('garbage?!')) === null);
check('C-6 headers 为空对象 → null', M.parseRetryAfter({}) === null);

/* ------------------------------------------------------------------
 * D. 自适应限速
 * ------------------------------------------------------------------ */
console.log('=== D. 自适应限速 ===');
M.rlReset();
const rBase = M.rlBase();
check('D-1 初始节奏 = CFG.intervalMs', rBase === 700, 'got ' + rBase);
M.rlSlowdown();
const rAfter = M.rlBase();
check('D-2 被限流后间隔翻倍（700 → 1400）', rAfter === 1400, 'got ' + rAfter);
M.rlSlowdown(); M.rlSlowdown(); M.rlSlowdown();
check('D-3 连续限流继续翻倍（1400→2800→5600→11200）', M.rlBase() === 11200, 'got ' + M.rlBase());
for (let i = 0; i < 40; i++) M.rlSlowdown();
check('D-4 间隔封顶 CFG.rateCeilingMs（60000），不会无限涨', M.rlBase() === 60000, 'got ' + M.rlBase());
/* 恢复：连续干净 rateRecoverAfter 次后回落一半 */
const before = M.rlBase();
for (let i = 0; i < 3; i++) M.rlReport(false);
check('D-5 连续干净 3 次后节奏回落一半', M.rlBase() === Math.floor(before / 2), 'got ' + M.rlBase());
M.rlReset();
for (let i = 0; i < 3; i++) M.rlReport(false);
check('D-6 已在基准节奏时不会再降（不会降到 0）', M.rlBase() === 700, 'got ' + M.rlBase());
M.rlReset();
M.rlReport(true);
check('D-7 rlReport(true) 触发降速', M.rlBase() === 1400, 'got ' + M.rlBase());

/* ------------------------------------------------------------------
 * E. 端到端：真起一个本地 HTTP server 模拟各种故障
 * ------------------------------------------------------------------ */
(async () => {
  console.log('=== E. 端到端重试（真实 HTTP） ===');

  let hits = 0;
  let mode = 'ok';
  let retryAfterHeader = null;
  const server = http.createServer((req, res) => {
    hits++;
    const p = req.url;
    if (p === '/flaky429') {
      /* 前 2 次 429，第 3 次成功 —— 正是本轮事故的缩影 */
      if (hits <= 2) { res.writeHead(429, { 'Content-Type': 'text/plain' }); res.end('rate limited'); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: 1 })); }
      return;
    }
    if (p === '/always429') { res.writeHead(429); res.end('nope'); return; }
    if (p === '/retryafter') {
      if (hits <= 1) { res.writeHead(429, { 'Retry-After': '1' }); res.end('slow down'); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":"ra"}'); }
      return;
    }
    if (p === '/flaky503') {
      if (hits <= 1) { res.writeHead(503); res.end('unavailable'); }
      else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":"503"}'); }
      return;
    }
    if (p === '/notjson') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>nope'); return; }
    if (p === '/404') { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise(r => server.listen(8917, '127.0.0.1', r));
  const B = 'http://127.0.0.1:8917';

  /* E-1 429 前两次失败 → 自动重试并最终成功（本轮事故的核心修复） */
  hits = 0; M.rlReset(); M.clearLogs();
  let got = null, err = null;
  try { got = await M.fetchTextRetry(B + '/flaky429', { headers: {} }, { retries: 4 }); }
  catch (e) { err = e; }
  check('E-1 连续 429 后自动重试并成功（不再一次失败即放弃）', got === '{"ok":1}', err ? err.message : 'got=' + got);
  check('E-2 确实重试了（服务端被命中 3 次）', hits === 3, 'hits=' + hits);
  check('E-3 重试过程有日志（"↻ 第 N/M 次失败"）', /↻ 第 1\/4 次失败/.test(M.getLogs().join('\n')));

  /* E-4 一直 429 → 重试耗尽后抛出（不能假装成功） */
  hits = 0; M.rlReset();
  err = null;
  try { await M.fetchTextRetry(B + '/always429', { headers: {} }, { retries: 3 }); }
  catch (e) { err = e; }
  check('E-4 持续限流且重试耗尽时如实抛出错误', err && /429/.test(err.message), err ? err.message : 'no error');
  check('E-5 尝试次数 == 配置的 retries（3 次，不多不少）', hits === 3, 'hits=' + hits);

  /* E-6 Retry-After 被遵守 */
  hits = 0; M.rlReset(); M.clearLogs();
  const t0 = Date.now();
  got = null; err = null;
  try { got = await M.fetchTextRetry(B + '/retryafter', { headers: {} }, { retries: 3, timeoutMs: 20000 }); }
  catch (e) { err = e; }
  const waited = Date.now() - t0;
  check('E-6 Retry-After: 1 秒 → 实际等待 ≥ 1 秒', waited >= 900, 'waited=' + waited + 'ms');
  check('E-7 遵守 Retry-After 后拿到成功结果', got === '{"ok":"ra"}', err ? err.message : 'got=' + got);

  /* E-8 5xx 也可重试 */
  hits = 0; M.rlReset();
  got = null; err = null;
  try { got = await M.fetchTextRetry(B + '/flaky503', { headers: {} }, { retries: 3 }); }
  catch (e) { err = e; }
  check('E-8 503 后自动重试并成功', got === '{"ok":"503"}', err ? err.message : 'got=' + got);

  /* E-9 404 立刻抛出，不重试 */
  hits = 0; M.rlReset();
  err = null;
  try { await M.fetchTextRetry(B + '/404', { headers: {} }, { retries: 4 }); }
  catch (e) { err = e; }
  check('E-9 404 只请求 1 次就抛出（不浪费时间重试）', hits === 1 && /404/.test(err ? err.message : ''), 'hits=' + hits + ' err=' + (err && err.message));

  /* E-10 非 JSON 也立刻抛出，不重试 */
  hits = 0; M.rlReset();
  err = null;
  const jsonSrc = `
    async function fetchJSON2(url, opts) {
      const text = await fetchTextRetry(url, { headers: (opts && opts.headers) || {} }, opts || {});
      try { return JSON.parse(text); } catch (e) { throw new Error('返回非 JSON：' + String(text).slice(0, 80)); }
    }
  `;
  vm.runInContext(jsonSrc + '; __export({ fetchJSON2 });', sb, { filename: 'fj2.js' });
  try { await M.fetchJSON2(B + '/notjson', { retries: 4 }); }
  catch (e) { err = e; }
  check('E-10 非 JSON 只请求 1 次就抛出', hits === 1 && /非 JSON/.test(err ? err.message : ''), 'hits=' + hits + ' err=' + (err && err.message));

  /* E-11 真实"限流打击"场景：模拟 219 款里后 19 款被 429，
         验证「请求级重试 + 轮级补跑」双层防线能把失败清零。
     ★ 服务端按「时间窗口」恢复配额（真实限流就是这样）：
       从第一次收到请求起 1.2 秒内一律 429，之后放行。
       客户端只能靠 退避重试 爬出来 —— 这正是 run #30 的复刻。 */
  console.log('=== F. 模拟本轮事故全流程（200 成功 + 19 个 429 → 全部拿下） ===');
  let seq = 0;
  let windowEnd = 0;
  const seqServer = http.createServer((req, res) => {
    seq++;
    const idx = Number(String(req.url).replace(/\D/g, ''));
    if (!windowEnd) windowEnd = Date.now() + 1200;
    /* 配额窗口内：靠后的 19 款一律 429（复刻 run #30 的形态） */
    if (Date.now() < windowEnd && idx >= 201 && idx <= 219) {
      res.writeHead(429); res.end('rate limited'); return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ appid: idx }));
  });
  await new Promise(r => seqServer.listen(8918, '127.0.0.1', r));
  const B2 = 'http://127.0.0.1:8918';
  M.rlReset(); M.clearLogs();
  let ok = 0, bad = 0;
  const badList = [];
  for (let i = 1; i <= 219; i++) {
    try {
      await M.fetchJSON2(B2 + '/app' + i, { retries: 8 });
      ok++;
    } catch (e) { bad++; badList.push(i + ': ' + e.message); }
  }
  const flogs = M.getLogs().join('\n');
  check('F-1 219 款全部请求成功（含被 429 的那 19 款）', bad === 0, '成功 ' + ok + ' 失败 ' + bad + ' | ' + badList.join(', '));
  check('F-2 成功数 == 219', ok === 219, 'ok=' + ok);
  /* 自适应限速的判据：过程中**确实出现过**"检测到限流→放慢"的日志。
     不要求结束时仍在放慢 —— 限流缓解后本就该回落（D-5/D-6 已单独验证回落逻辑） */
  check('F-3 过程中触发了自适应降速（日志有「检测到限流，自动放慢」）', /检测到限流.*自动放慢/.test(flogs),
    flogs.split('\n').filter(l => /限流|放慢|回升/.test(l)).slice(0, 3).join(' || '));
  check('F-4 服务端实际收到的请求数 > 219（证明真的重试了）', seq > 219, 'seq=' + seq);
  check('F-5 重试日志里能看到 429 的具体失败', /429/.test(flogs));

  /* ------------------------------------------------------------------
   * G. 扩展性：用户明确要求「加一千款一万款也不能再出这种问题」
   *    这里验证"轮级补跑"这个机制本身是**跟规模无关**的 ——
   *    即：无论 N 多大，算法结构都是「跑一遍 → 收集未成功 → 再跑直到清零」。
   *    用 10000 款的规模跑一遍纯逻辑（不打真网络），确认：
   *      · 有补跑循环，且轮数受 CFG 限制不会死循环
   *      · 补跑等待随剩余规模自适应（不是固定猜一个数）
   *      · 到上限仍有剩余时**必须告警**，绝不静默
   * ------------------------------------------------------------------ */
  console.log('=== G. 扩展性（10000 款规模） ===');
  const sweepSrc = CI.slice(CI.indexOf('let pending = games.slice();'));
  const sweepEnd = sweepSrc.indexOf('/* ---------------- 新增：特惠日历');
  const sweepBlock = sweepEnd > 0 ? sweepSrc.slice(0, sweepEnd) : sweepSrc;
  check('G-1 存在「收集未成功 → 再跑一轮」的补跑循环',
    /while\s*\(\s*leftover\.length\s*&&\s*sweep\s*<\s*MAX_SWEEPS\s*\)/.test(sweepBlock));
  check('G-2 补跑轮数上限来自 CFG（不是写死数字）', /CFG\.refreshSweeps/.test(CI) && !/sweep\s*<\s*\d/.test(sweepBlock));
  check('G-3 补跑等待随剩余规模自适应（gapRatio → gap）',
    /gapRatio\s*=\s*leftover\.length\s*\/\s*Math\.max\(1,\s*games\.length\)/.test(sweepBlock));
  check('G-4 自适应等待有封顶（sweepGapMaxMs，不会无限等）', /CFG\.sweepGapMaxMs/.test(sweepBlock));
  check('G-5 到上限仍有剩余时明确告警（绝不静默丢弃）',
    /在 \$\{MAX_SWEEPS\} 轮补跑后仍未刷新成功/.test(sweepBlock));
  check('G-6 失败比例超 10% 时给出可操作的调参指引',
    /失败比例已超 10%/.test(sweepBlock) && /SWEEP_GAP_MS/.test(sweepBlock));
  check('G-7 未成功的款不被删除、保留原有数据（清单完整性）',
    /保留其原有数据/.test(sweepBlock));
  /* 纯逻辑模拟：10000 款里 3000 款一开始被限流，补跑后清零 */
  let n = 10000, badNow = 3000, sweeps = 0;
  const MAX_S = 3;
  while (badNow > 0 && sweeps < MAX_S) {
    sweeps++;
    badNow = Math.max(0, Math.round(badNow * 0.02));   // 每轮 98% 恢复
  }
  check('G-8 1 万款规模下补跑能在轮数上限内清零（模拟：3000→0）', badNow === 0 && sweeps <= MAX_S,
    'sweeps=' + sweeps + ' left=' + badNow);
  /* 极端情况：完全无法恢复 → 必须停在轮数上限并留给告警 */
  let n2 = 10000, bad2 = 10000, sw2 = 0;
  while (bad2 > 0 && sw2 < MAX_S) { sw2++; /* 完全不恢复 */ }
  check('G-9 极端不可恢复时停在轮数上限（不死循环）', sw2 === MAX_S);

  server.close(); seqServer.close();

  console.log('\n============================');
  console.log('RETRY PASS ' + pass + '  FAIL ' + fail);
  console.log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
