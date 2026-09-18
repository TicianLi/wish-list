/* 云端同步 409 冲突的自愈回归
   把 2026-09-19 用户报的「远端文件冲突（HTTP 409）」固化成断言：
     1. 首次 PUT 返回 409 → 必须重新取 sha 再试，最终成功（而不是直接失败）
     2. 重试用尽仍是 409 → 必须给出可操作的中文提示（提到 CI / 每日刷新）
     3. 连点两次「同步到云端」→ 第二次不得真的再发一次 PUT（并发锁生效）
     4. 非 409 错误（如 401）→ 不得重试，立即失败
     5. 401 的提示必须仍然准确（不能被 409 的文案覆盖）
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8893;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

/* 页面里注入一个"假 GitHub API"：可编排 GET/PUT 的返回序列 */
const STUB = `
window.__gh = { gets: 0, puts: 0, seq: [], putResults: [] };
(function(){
  const realFetch = window.fetch;
  window.fetch = function(url, opts){
    url = String(url);
    if (url.indexOf('api.github.com') < 0) return realFetch.apply(window, arguments);
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const mk = (status, obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json' } }));
    if (method === 'GET') {
      window.__gh.gets++;
      return mk(200, { sha: 'sha-' + window.__gh.gets, content: '', size: 100 });
    }
    // PUT
    window.__gh.puts++;
    const next = window.__gh.putResults.shift();
    if (next === undefined) return mk(200, { commit: { sha: 'okcommit' } });
    return mk(next, next === 200 ? { commit: { sha: 'okcommit' } } : { message: 'sha does not match' });
  };
})();
`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1400, height: 950 }
  });
  const url = 'http://127.0.0.1:' + PORT + '/index.html';

  async function fresh(setup) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(e.message));
    await page.evaluateOnNewDocument(() => {
      try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {}
    });
    await page.evaluateOnNewDocument(STUB);
    await page.evaluateOnNewDocument(setup || function () {});
    // 预置 Token + 一个游戏，让同步有内容可传
    await page.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem('sw_cloud_cfg_v1', JSON.stringify({
          owner: 'TicianLi', repo: 'wish-list', branch: 'main',
          path: 'data/wishlist.json', token: 'github_pat_TESTTOKEN'
        }));
      } catch (e) {}
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(1000);
    await page.evaluate(() => {
      STATE.games = [newGame(111, 'TestA', 'TestA')];
    });
    return { page, errs };
  }

  console.log('\n=== 1. 首次 PUT 409 → 自动重试后成功 ===');
  {
    const { page, errs } = await fresh(function () {
      window.__gh.putResults = [409];   // 第一次冲突，第二次默认 200
    });
    const r = await page.evaluate(() => cloudSync({ silentDup: true }).then(x => ({
      ok: x.ok, tries: x.tries, gets: window.__gh.gets, puts: window.__gh.puts
    })));
    check('1-1 最终同步成功（不是直接失败）', r.ok === true, JSON.stringify(r));
    check('1-2 失败后重新取了 sha（GET 次数 > 1）', r.gets >= 2, JSON.stringify(r));
    check('1-3 PUT 确实发了两次（重试生效）', r.puts === 2, JSON.stringify(r));
    check('1-4 tries 字段反映重试次数', r.tries === 2, JSON.stringify(r));
    check('1-5 无 JS 运行时错误', errs.length === 0, errs.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n=== 2. 连续 409（模拟 CI 一直在写）→ 重试用尽 + 可操作提示 ===');
  {
    const { page } = await fresh(function () {
      window.__gh.putResults = [409, 409, 409, 409, 409];
    });
    const r = await page.evaluate(() => cloudSync({ silentDup: true }).then(x => ({
      ok: x.ok, reason: x.reason, status: x.error && x.error.status
    })));
    check('2-1 重试用尽后判定为失败', r.ok === false, JSON.stringify(r));
    check('2-2 错误状态是 409', r.status === 409, JSON.stringify(r));
    const toastTxt = await page.evaluate(() => {
      const t = document.querySelector('#toasts');
      return t ? t.textContent : '';
    });
    check('2-3 提示里说明"已自动重试"', /自动重试/.test(toastTxt), toastTxt.slice(0, 120));
    check('2-4 提示指向 CI / 每日刷新这个最常见原因',
      /每日刷新|Actions|凌晨 2 点/.test(toastTxt), toastTxt.slice(0, 200));
    await page.close();
  }

  console.log('\n=== 3. 并发锁：连点两次只发一次 PUT ===');
  {
    const { page } = await fresh(function () { window.__gh.putResults = []; });
    const r = await page.evaluate(async () => {
      const a = cloudSync({ silentDup: true });
      const b = cloudSync({});          // 第二次（模拟用户又点了一下）
      const [ra, rb] = await Promise.all([a, b]);
      return { puts: window.__gh.puts, okA: ra.ok, okB: rb.ok, sameResult: ra === rb };
    });
    check('3-1 两次调用只发了一次 PUT', r.puts === 1, JSON.stringify(r));
    check('3-2 两个调用都拿到成功结果', r.okA === true && r.okB === true, JSON.stringify(r));
    check('3-3 第二次复用第一次的 promise（同一结果对象）', r.sameResult === true, JSON.stringify(r));
    await page.close();
  }

  console.log('\n=== 4. 非 409 错误（401）→ 不得重试 ===');
  {
    const { page } = await fresh(function () { window.__gh.putResults = [401, 200, 200]; });
    const r = await page.evaluate(() => cloudSync({ silentDup: true }).then(x => ({
      ok: x.ok, status: x.error && x.error.status, puts: window.__gh.puts
    })));
    check('4-1 401 立即失败', r.ok === false, JSON.stringify(r));
    check('4-2 401 只发了一次 PUT（没有无意义重试）', r.puts === 1, JSON.stringify(r));
    const toastTxt = await page.evaluate(() => (document.querySelector('#toasts') || {}).textContent || '');
    check('4-3 401 提示仍指向 Token 无效（未被 409 文案污染）',
      /Token 无效|重新生成/.test(toastTxt), toastTxt.slice(0, 150));
    await page.close();
  }

  await browser.close(); server.close();
  console.log('\n============================');
  console.log('CLOUD-409 PASS ' + pass + '  FAIL ' + fail);
  console.log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃', e); process.exit(2); });
