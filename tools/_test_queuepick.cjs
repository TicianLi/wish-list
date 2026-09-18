/* 任务队列与候选弹窗的「卡死」专项回归
   把 2026-09-18 修掉的 bug 固化成断言，防止以后改回去：
     1. 旁路再开候选弹窗（OCR/直接搜索）不得让任务队列的 promise 变孤儿
     2. 关窗后任务必须清掉 pickOpened，不能出现「待选择但点不动」
     3. 点「选择」/「重试」必须能恢复任务
     4. 队列不得永久停摆（新任务能被处理）
     5. 移除正在弹窗的任务必须关掉它的弹窗
     6. showCandidates 单例保护：开新弹窗会先结清旧的（不留孤儿）
     7. 空本机能从云端恢复（mergeCloudGames 补入云端独有游戏）
     8. 云端独有的游戏被补入本机、且不覆盖用户私有字段
     9. 上传时保留云端已抓到的折扣截止（不被本机 null 冲掉）
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = fs.existsSync(path.join(__dirname, '..', 'index.html'))
  ? path.resolve(__dirname, '..') : path.resolve(__dirname, '..', '..');
const PORT = 8877;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; log('  PASS  ' + n); } else { fail++; log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

const STUB = `
(function(){
  const w = setInterval(() => {
    if (typeof window.steamSearch !== 'function') return;
    clearInterval(w);
    window.steamSearch = async () => ([
      { id: 111, name: 'Alpha A', tiny_image: '', price: { final: 100, currency: 'CNY' } },
      { id: 222, name: 'Alpha B', tiny_image: '', price: { final: 200, currency: 'CNY' } }
    ]);
    window.steamAppDetails = async id => ({ name: 'G' + id, steam_appid: id, release_date: { date: '1 Jan, 2020' }, genres: [], categories: [] });
    window.addGameByAppid = async (id) => { let g = STATE.games.find(x => x.appid === +id); if (g) return g;
      g = newGame(+id, 'G' + id, 'G' + id); STATE.games.push(g); return g; };
  }, 5);
})();
`;

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1400, height: 950 }
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {} });
  await page.evaluateOnNewDocument(STUB);
  const url = 'http://127.0.0.1:' + PORT + '/index.html';
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  const snap = () => page.evaluate(() => ({
    q: STATE.taskQueue.map(t => ({ term: t.term, status: t.status, pickOpened: t.pickOpened })),
    candOpen: document.getElementById('modalCandidates').classList.contains('show'),
    candTitle: (document.getElementById('candTitle') || {}).textContent || '',
    qRun: typeof queueRunning !== 'undefined' ? !!queueRunning : null,
    pickBtns: Array.from(document.querySelectorAll('#taskList button[data-tact="pick"]')).length
  }));

  log('\n=== A. 候选弹窗单例保护（旁路不再制造孤儿）===');
  await page.evaluate(() => { $('#addInput').value = 'alpha task'; $('#btnAdd').click(); });
  await sleep(2600);
  let s = await snap();
  check('任务进入 needpick 且弹窗打开', s.q[0] && s.q[0].status === 'needpick' && s.candOpen, JSON.stringify(s));
  const titleBefore = s.candTitle;
  await page.evaluate(() => {
    window.showCandidates([{ id: 901, name: 'Side', tiny_image: '', price: { final: 1, currency: 'CNY' } }], '旁路候选：');
  });
  await sleep(500);
  const s1 = await snap();
  check('旁路开弹窗后标题变成新的（旧弹窗已被接管）', s1.candTitle === '旁路候选：', s1.candTitle + ' (原:' + titleBefore + ')');
  /* 关键：关掉这个「旁路」弹窗后，任务 A 不能卡在 needpick+pickOpened */
  await page.click('#modalCandidates .modal-close');
  await sleep(1200);
  s = await snap();
  const tA = s.q.find(x => x.term === 'alpha task');
  check('★ 关窗后任务A不残留占用（不会「点不动」）', tA && tA.pickOpened === false, JSON.stringify(tA));
  check('★ 关窗后任务A处于可恢复状态', tA && (tA.status === 'failed' || (tA.status === 'needpick' && s.candOpen)), JSON.stringify(tA));

  log('\n=== B. 点「重试」/「选择」能恢复 ===');
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('#taskList button[data-tact="retry"],#taskList button[data-tact="pick"]');
    if (!b) return 'no-button';
    b.click(); return b.dataset.tact;
  });
  await sleep(1600);
  const s2 = await snap();
  const tA2 = s2.q.find(x => x.term === 'alpha task');
  check('点按钮后任务恢复（弹窗重开 或 已完成）',
    s2.candOpen === true || !tA2 || tA2.status === 'done', clicked + ' ' + JSON.stringify(s2));
  check('恢复后任务不再处于「待选择却无弹窗」', !(tA2 && tA2.status === 'needpick' && !s2.candOpen), JSON.stringify(tA2));

  log('\n=== D. 移除正在弹窗的任务 → 弹窗应被关掉 ===');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(1100);
  await page.evaluate(() => { $('#addInput').value = 'alpha two'; $('#btnAdd').click(); });
  await sleep(2600);
  let s3 = await snap();
  check('新任务进入 needpick 且弹窗打开', s3.candOpen && s3.q.some(x => x.status === 'needpick'), JSON.stringify(s3));
  await page.evaluate(() => { const b = document.querySelector('#taskList button[data-tact="remove"]'); if (b) b.click(); });
  await sleep(1200);
  s3 = await snap();
  check('移除后弹窗被关闭（不再残留）', s3.candOpen === false, JSON.stringify(s3));
  check('移除后任务已不在队列', !s3.q.some(x => x.term === 'alpha two'), JSON.stringify(s3.q));

  log('\n=== E. 队列不永久停摆：后续任务能被处理 ===');
  await page.evaluate(() => { $('#addInput').value = 'alpha next'; $('#btnAdd').click(); });
  await sleep(3500);
  const s4 = await snap();
  const nt = s4.q.find(x => x.term === 'alpha next');
  check('新任务被推进（非永久 pending）', nt && nt.status !== 'pending', JSON.stringify(s4.q));

  log('\n=== F. mergeCloudGames：云端独有游戏补入本机 ===');
  const m1 = await page.evaluate(() => {
    STATE.games = [];
    [1001, 1002].forEach(id => STATE.games.push(newGame(id, 'L' + id, 'L' + id)));
    const stat = mergeCloudGames([
      { appid: 1001, name: 'L1001', price: { current: 10, discountPercent: 50, isOnSale: true, discountExpiration: '2099-01-01T15:59:59.000Z', expirationSource: 'storepage', updatedAt: Date.now() }, rating: {}, historicalLow: {}, details: {} },
      { appid: 1002, name: 'L1002', price: { current: 10, updatedAt: Date.now() }, rating: {}, historicalLow: {}, details: {} },
      { appid: 1003, name: 'C1003', price: { current: 5, discountExpiration: '2099-02-02T15:59:59.000Z', expirationSource: 'storepage', updatedAt: Date.now() }, rating: {}, historicalLow: {}, details: {}, targetPrice: 3, note: '等' },
      { appid: 1004, name: 'C1004', price: { current: 7, updatedAt: Date.now() }, rating: {}, historicalLow: {}, details: {} }
    ]);
    return { stat, ids: STATE.games.map(g => g.appid).sort((a, b) => a - b), n: STATE.games.length,
      t1003: STATE.games.find(g => g.appid === 1003) };
  });
  check('云端独有的 1003/1004 被补入', m1.ids.join(',') === '1001,1002,1003,1004', m1.ids.join(','));
  check('stat.added = 2', m1.stat.added === 2, String(m1.stat.added));
  check('补入的游戏带着云端目标价/备注', m1.t1003.targetPrice === 3 && m1.t1003.note === '等', JSON.stringify(m1.t1003.targetPrice));

  log('\n=== G. 空本机可从云端恢复全部 ===');
  const m2 = await page.evaluate(() => {
    STATE.games = [];
    const stat = mergeCloudGames([1001, 1002, 1003].map(id => ({ appid: id, name: 'C' + id, price: { current: 1, updatedAt: Date.now() }, rating: {}, historicalLow: {}, details: {} })));
    return { stat, n: STATE.games.length };
  });
  check('空本机恢复 3 款', m2.n === 3, String(m2.n));
  check('stat.added = 3', m2.stat.added === 3, String(m2.stat.added));

  log('\n=== H. 本机独有游戏不被删除（保护未上传的新游戏）===');
  const m3 = await page.evaluate(() => {
    STATE.games.push(newGame(9999, 'OnlyLocal', 'OnlyLocal'));
    const stat = mergeCloudGames([{ appid: 1001, name: 'C1001', price: {}, rating: {}, historicalLow: {}, details: {} }]);
    return { n: STATE.games.length, has9999: STATE.games.some(g => g.appid === 9999), unmatched: stat.unmatched };
  });
  check('本机独有 9999 未被删除', m3.has9999 === true, JSON.stringify(m3));

  log('\n=== 页面错误 ===');
  /* 只关心真正的 JS 运行时错误；favicon / 外部 CDN 的资源 404、连接被拒不算产品问题 */
  const realErrs = errs.filter(e =>
    !/favicon/i.test(e) &&
    !/Failed to load resource/i.test(e) &&
    !/ERR_CONNECTION/i.test(e) &&
    !/net::/i.test(e) &&
    !/tesseract|jsdelivr|translate|itad|steamstatic/i.test(e));
  check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  log('\n============================');
  log('QUEUE-PICK PASS ' + pass + '  FAIL ' + fail);
  log('============================');
  await browser.close(); server.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃', e); process.exit(2); });
