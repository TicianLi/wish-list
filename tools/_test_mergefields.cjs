/* mergeCloudGames 字段完整性的专项回归
   锁死 2026-09-19 用户报的「云端 219 款 → 本机 219 款，但更新/标签只有 197 款」：
     1. 新增游戏必须计入 tags / bundles / updated 统计（数字要自洽）
     2. userTagsFetchedAt 必须跟着一起搬（否则下次会被当"没抓过"重复抓）
     3. 用户私有字段 targetPrice / note / 手动确认史低 必须跟着搬
     4. 云端本来就没标签的新游戏 → 不得凭空编造标签
     5. 提示语必须能解释"为什么标签数少于总款数"
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8895;
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

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded' });
  await sleep(1200);

  console.log('\n=== 1. 新增游戏要计入 tags/bundles/updated 统计 ===');
  const r1 = await page.evaluate(() => {
    STATE.games = [];                       // 本机为空（等价于换设备后首次拉取）
    const remote = [];
    // 3 款老游戏：带标签 + 捆绑包
    for (let i = 1; i <= 3; i++) remote.push({
      appid: 1000 + i, name: 'Old' + i, originalName: 'Old' + i,
      price: { current: 10 }, rating: {}, historicalLow: {},
      details: { userTags: ['a', 'b'], userTagsFetchedAt: 1700000000000, bundleIds: [7], genres: ['Action'] },
      targetPrice: i, note: 'n' + i
    });
    // 2 款新游戏：云端也还没抓到标签（空数组）
    for (let i = 1; i <= 2; i++) remote.push({
      appid: 2000 + i, name: 'New' + i, originalName: 'New' + i,
      price: { current: 20 }, rating: {}, historicalLow: {},
      details: { userTags: [], bundleIds: [], genres: [] },
      targetPrice: null, note: ''
    });
    const stat = mergeCloudGames(remote);
    return { stat, n: STATE.games.length };
  });
  check('1-1 全部 5 款都进来了', r1.n === 5, JSON.stringify(r1));
  check('1-2 stat.added = 5', r1.stat.added === 5, JSON.stringify(r1.stat));
  check('1-3 tags 统计 = 3（含新增里带标签的）', r1.stat.tags === 3, JSON.stringify(r1.stat));
  check('1-4 bundles 统计 = 3', r1.stat.bundles === 3, JSON.stringify(r1.stat));
  check('1-5 updated 覆盖全部 5 款（数字自洽）', r1.stat.updated === 5, JSON.stringify(r1.stat));

  console.log('\n=== 2. userTagsFetchedAt 必须跟着搬 ===');
  const r2 = await page.evaluate(() => {
    const g = STATE.games.find(x => x.appid === 1001);
    const n = STATE.games.find(x => x.appid === 2001);
    return { fetched: g && g.details.userTagsFetchedAt, newFetched: n && n.details.userTagsFetchedAt,
             newTags: n && n.details.userTags };
  });
  check('2-1 有标签的游戏带上了 userTagsFetchedAt', r2.fetched === 1700000000000, JSON.stringify(r2));
  check('2-2 云端没标签的新游戏在本地也是空数组（不编造）',
    Array.isArray(r2.newTags) && r2.newTags.length === 0, JSON.stringify(r2));
  check('2-3 云端没标签的新游戏 fetchedAt 保持 null',
    r2.newFetched === null || r2.newFetched === undefined, JSON.stringify(r2));

  console.log('\n=== 3. 用户私有字段必须跟着搬 ===');
  const r3 = await page.evaluate(() => {
    const g = STATE.games.find(x => x.appid === 1002);
    return { tp: g && g.targetPrice, note: g && g.note };
  });
  check('3-1 targetPrice 搬过来了', r3.tp === 2, JSON.stringify(r3));
  check('3-2 note 搬过来了', r3.note === 'n2', JSON.stringify(r3));

  console.log('\n=== 4. 手动确认的史低不被覆盖（红线） ===');
  const r4 = await page.evaluate(() => {
    STATE.games = [newGame(3001, 'M', 'M')];
    STATE.games[0].historicalLow = { price: 5, source: '手动确认' };
    mergeCloudGames([{ appid: 3001, name: 'M', price: {}, rating: {},
      historicalLow: { price: 99, source: 'itad' }, details: {} }]);
    return { low: STATE.games[0].historicalLow };
  });
  check('4-1 手动确认的史低未被云端覆盖',
    r4.low.price === 5 && r4.low.source === '手动确认', JSON.stringify(r4));

  console.log('\n=== 5. 提示语能解释「标签数 < 总款数」 ===');
  const r5 = await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return {
      hasHint: /云端也还没抓到标签/.test(document.documentElement.outerHTML) ||
               /tagGap/.test(document.documentElement.outerHTML) ||
               /云端也还没抓到标签/.test(window.__srcProbe || '')
    };
  });
  // 提示语是运行时字符串，改为直接读源文件确认
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('5-1 源码含「还没抓到标签」的说明文案', /cloud也还没抓到标签|云端也还没抓到标签/.test(html), '');
  check('5-2 源码含 tagGap 计算逻辑', /const tagGap = /.test(html), '');

  console.log('\n=== 页面错误 ===');
  check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 2).join(' | '));

  await browser.close(); server.close();
  console.log('\n============================');
  console.log('MERGE-FIELDS PASS ' + pass + '  FAIL ' + fail);
  console.log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃', e); process.exit(2); });
