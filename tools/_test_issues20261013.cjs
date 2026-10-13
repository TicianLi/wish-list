/* 【2026-10-13】用户报的问题的回归守卫。
 *
 * 四个问题的实测根因（都不是猜的，量出来的）：
 *   ① 「导入 JSON 没用」→ saveData 是 400ms debounce，紧接的 renderAll 同步占满
 *      主线程 1214ms，定时器排不进去 → 内存 346 / 落盘 0。用户在这 1.2 秒里
 *      看到的是「点了没反应」，一刷新就没了。容量不是原因（1338KB < 3782KB）。
 *   ② 筛选全显示 (9) → 本机只剩 9 条数据（同上，丢数据）。
 *   ③ 卡顿 → renderAll 1214ms。
 *   ④ 底部图标点不动 → mCloseDrawer 的 insertBefore 在特定顺序下抛
 *      NotFoundError，遮罩层留在屏幕上，整个页面卡死。
 *
 * 这一套跑**行为**，不跑源码字符串 —— 因为那几个 bug 都不是「函数不在」，
 * 而是「运行时不对」，静态断言全都会 PASS。
 */
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const PORT = 8963;

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); res.end('no'); return; }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

let pass = 0, fail = 0;
const chk = (n, c, x) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
};

/* 复用仓库里的真实数据 —— 造 fixture 会量出与用户手机不同的数字 */
const REAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'wishlist.json'), 'utf8'));

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errs.push('console: ' + m.text());
  });
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
  await page.setUserAgent(IOS_UA);
  await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded' });

  const seed = async (n) => {
    await page.evaluate((g) => {
      localStorage.setItem('sw_gate_owner_v1', '1');
      localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify({ version: 3, games: g }));
    }, REAL.games.slice(0, n));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 1800));
  };

  /* ================= A. 落盘：关键操作必须同步写盘 ================= */
  console.log('=== A. 落盘时机（问题①②的根因） ===');
  await seed(9);
  chk('A-0 前置：本机确实是 9 条', await page.evaluate(() => STATE.games.length) === 9);

  const importRes = await page.evaluate((games) => {
    let added = 0;
    games.forEach(g => { if (!findGame(Number(g.appid))) { STATE.games.push(g); added++; } });
    const memBefore = STATE.games.length;
    saveDataCritical(null);              // 导入路径用的就是它
    const stored = (JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || '{}').games || []).length;
    return { added, memBefore, stored };
  }, REAL.games);
  chk('A-1 ★ 关键操作后立刻落盘，不等 400ms debounce',
    importRes.stored === importRes.memBefore, importRes);
  chk('A-2 落盘款数与内存一致（346）', importRes.stored === REAL.games.length, importRes.stored);

  /* debounce 版仍在，但标记 + 卸载兜底必须能把它救回来 */
  const hideRes = await page.evaluate(() => {
    STATE.games.push({ appid: 999001, name: '兜底测试' });   // 直接改，绕过 saveData
    markDirty();                               // 标记「有未落盘改动」
    const before = (JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || '{}').games || []).length;
    /* 模拟切后台 / 锁屏：真实浏览器里 visibilitychange 会触发 */
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const afterHide = (JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || '{}').games || []).length;
    return { before, afterHide };
  });
  chk('A-3 ★ 切后台（visibilitychange）会立刻落盘',
    hideRes.afterHide === hideRes.before + 1, hideRes);

  const pagehideRes = await page.evaluate(() => {
    STATE.games.push({ appid: 999002, name: 'pagehide 测试' });
    markDirty();
    const before = (JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || '{}').games || []).length;
    window.dispatchEvent(new Event('pagehide'));
    const after = (JSON.parse(localStorage.getItem(CONFIG.STORE_KEY) || '{}').games || []).length;
    return { before, after };
  });
  chk('A-4 ★ 关页面（pagehide）会立刻落盘', pagehideRes.after === pagehideRes.before + 1, pagehideRes);

  /* ⚠️ 不要断言 `window.__pendingSave` —— 它是顶层 let，不挂在 window 上，
     那样断言恒假。A-3 / A-4 已经是行为验证（切后台/关页面后确实落盘了），
     这里只补一句：没待存改动时不该乱写。 */
  const noDirty = await page.evaluate(() => {
    const before = localStorage.getItem(CONFIG.STORE_KEY);
    markDirty();                                   // 先制造待存
    __pendingSave = false;                          // 手动清掉，模拟「已落盘」
    flushOnHide();                                  // 此时不该再写
    return localStorage.getItem(CONFIG.STORE_KEY) === before;
  });
  chk('A-5 没有待存改动时，卸载兜底不乱写', noDirty === true);

  /* ================= B. 性能：renderAll 不能冻结 1.2 秒 ================= */
  console.log('\n=== B. 性能（问题③） ===');
  await seed(REAL.games.length);
  const perf = await page.evaluate(() => {
    const runs = [];
    for (let i = 0; i < 3; i++) { const t = performance.now(); renderAll(); runs.push(Math.round(performance.now() - t)); }
    const t2 = performance.now(); refreshTagFilterOptions(); renderTable();
    const filterMs = Math.round(performance.now() - t2);
    return { runs, filterMs, n: STATE.games.length };
  });
  /* 修复前 1214ms / 1042ms。留足余量但不能放水：
     500ms 以上用户仍会感到「卡了一下」，那是另一个问题该单独查。 */
  chk('B-1 ★ renderAll 首帧 < 250ms（修复前 1214ms）',
    perf.runs[0] < 250, { 首帧: perf.runs[0], 实测: perf.n + '款' });
  chk('B-2 连续重绘也稳定（缓存生效，不是只有第一次快）',
    perf.runs.every(x => x < 250), perf.runs);
  chk('B-3 筛选联动 < 300ms', perf.filterMs < 300, perf.filterMs);

  const facet = await page.evaluate(() => {
    const t = performance.now();
    invalidateFacetCache();
    computeFacetCounts();
    const cold = Math.round(performance.now() - t);
    const t2 = performance.now();
    computeFacetCounts();          // 同键：应命中缓存
    const warm = Math.round(performance.now() - t2);
    return { cold, warm };
  });
  chk('B-4 分面计数有缓存（同键第二次明显更快）', facet.warm < facet.cold, facet);

  const invalid = await page.evaluate(() => {
    invalidateFacetCache();
    const a = computeFacetCounts().rec.all;
    STATE.games.push({ appid: 999003, name: 'x' });
    STATE.gamesRevision++;
    const b = computeFacetCounts().rec.all;
    return { a, b };
  });
  chk('B-5 ★ 数据变了缓存会失效（筛选数字不会停在旧值）',
    invalid.b === invalid.a + 1, invalid);

  /* ================= C. 底部导航：抽屉必须能反复开关 ================= */
  console.log('\n=== C. 底部导航与抽屉（问题④） ===');
  await seed(REAL.games.length);
  await page.evaluate((full) => { window.__FULL__ = full; }, REAL.games);
  const navInit = await page.evaluate(() => {
    const nav = document.querySelector('#mnav');
    if (!nav) return { exists: false };
    const btns = [...nav.querySelectorAll('.mnav-btn')];
    return { exists: true, n: btns.length, labels: btns.map(b => (b.textContent || '').trim()) };
  });
  chk('C-1 底部导航有 5 个入口', navInit.exists && navInit.n === 5, navInit);

  /* ★ 这条是本次的真实 bug：mCloseDrawer 的 insertBefore 在「连点不同入口」时抛
     NotFoundError，遮罩留在屏幕上 → 整个页面点不动。 */
  const drawerRes = await page.evaluate(async () => {
    const errs = [];
    const seq = ['filter', 'add', 'filter', 'add', 'filter'];   // 交替开，故意复现那条路径
    const states = [];
    for (const k of seq) {
      try {
        mOpenDrawer(k);
        await new Promise(r => setTimeout(r, 220));
        const opened = document.getElementById('mdrawer').classList.contains('on');
        const title = (document.getElementById('mdrawerTitle') || {}).textContent || '';
        mCloseDrawer();
        await new Promise(r => setTimeout(r, 220));
        const closed = !document.getElementById('mdrawer').classList.contains('on');
        const backdropGone = !document.getElementById('mdrawerBackdrop').classList.contains('on');
        states.push({ k, opened, closed, backdropGone, title });
      } catch (e) { errs.push(k + ': ' + e.message); }
    }
    return { errs, states, bodyLeft: document.getElementById('mdrawerBody').children.length };
  });
  chk('C-2 ★ 抽屉反复开关不抛异常（原来 insertBefore 会抛）',
    drawerRes.errs.length === 0, drawerRes.errs);
  chk('C-3 ★ 每次都能开、都能关', drawerRes.states.every(s => s.opened && s.closed), drawerRes.states);
  chk('C-4 ★ 遮罩层每次都清掉了（没清掉=整个页面点不动）',
    drawerRes.states.every(s => s.backdropGone), drawerRes.states);
  chk('C-5 抽屉里不残留上一个区块', drawerRes.bodyLeft === 0, drawerRes.bodyLeft);

  /* 关掉之后，其它入口还点得动吗 */
  const stillWorks = await page.evaluate(async () => {
    mOpenDrawer('filter');
    await new Promise(r => setTimeout(r, 200));
    mCloseDrawer();
    await new Promise(r => setTimeout(r, 250));
    /* 模拟点「特价」：应该能开雷达弹窗 */
    mGo('radar');
    await new Promise(r => setTimeout(r, 400));
    const opened = document.getElementById('modalRadar').classList.contains('show');
    document.getElementById('modalRadar').classList.remove('show');
    return { 雷达能开: opened };
  });
  chk('C-6 ★ 抽屉开合之后，其它按钮照样能点', stillWorks.雷达能开 === true, stillWorks);

  /* ================= D. 云端更新提示 ================= */
  console.log('\n=== D. 进页面自动提示云端更新（用户原话「为什么非要我自己刷新」） ===');
  const cloudFn = await page.evaluate(() => typeof autoCheckCloudUpdate === 'function');
  chk('D-1 有 autoCheckCloudUpdate 函数', cloudFn);

  const hintText = await page.evaluate(() => {
    /* 模拟拉过一次之后的提示文案 —— 手机上没有悬停，
       所以云端刷新时间必须写进正文，不能只放在 title 里。 */
    savePullMeta({
      lastPullAt: Date.now() - 86400000,
      refreshedAt: Date.now() - 2 * 86400000,
      via: 'test', syncedAt: Date.now() - 3 * 86400000,
      gameCount: 346, fingerprint: 'x'
    });
    updateCloudPullHint();
    const el = document.getElementById('cloudPullHint');
    return el ? { text: el.textContent, title: el.title } : null;
  });
  chk('D-2 ★ 云端刷新时间显示在正文（不是只在悬停提示里）',
    hintText && /云端数据/.test(hintText.text), hintText);

  const attention = await page.evaluate(() => {
    document.getElementById('cloudPullHint').textContent = '';
    const btn = document.getElementById('btnCloudPull');
    btn.classList.add('btn-attention');
    return { 有高亮类: btn.classList.contains('btn-attention'), 有样式: !!document.querySelector('.btn-attention') };
  });
  chk('D-3 「拉取云端」按钮有可辨识的高亮样式', attention.有高亮类 && attention.有样式, attention);

  /* ★ 本机数量明显少于云端 → 必须当场提示。
     用户当时看到的现象是「安静地只显示 9 条」，没有任何异常说明。

     ⚠️ 三个坑都踩过，逐个记下来免得下次再踩：
       ① 替换 window.toast 捕获不到 —— autoCheckCloudUpdate 里是闭包引用。
       ② 清空 #toasts 再测「没报警」不可靠 —— 上一条的内部 setTimeout(900ms)
          可能还没执行，清空之后它又弹出来，于是 D-5 量到的是 D-4 的文案。
       ③ 所以：等够时间让上一次的 toast 自然退场，再测；并且量的是**完整内容**，
          不是「有没有新增」。 */
  const runCheck = async (localN, waitMs) => page.evaluate(async (args) => {
    const n = args.n, wait = args.wait;
    /* 先等上一轮 toast 完全退场（含 0.3s 淡出），否则后面全是残留 */
    await new Promise(r => setTimeout(r, wait));
    const box = document.getElementById('toasts');
    if (box) box.innerHTML = '';
    /* ★ 每次都从完整 346 条重新灌再截，绝不在上一次的结果上接着切。
         最隐蔽的一个坑：D-4 把 STATE.games 截成 9 条后，D-5 里 slice(0,344)
         切不出 344 条（源数组只剩 9）—— 是测试自己把数据搞坏，
         然后拿「切出来的 9 条」去断言「不该报警」→ 必然 FAIL。 */
    STATE.games = window.__FULL__.slice(0, n);
    renderAll();
    const realFetch = window.fetchCloudJSON;
    window.fetchCloudJSON = async () => ({ data: {
      games: new Array(346).fill({ appid: 1 }), refreshedAt: Date.now(), updatedAt: Date.now()
    }, via: 'test' });
    try { await autoCheckCloudUpdate(); } finally { window.fetchCloudJSON = realFetch; }
    await new Promise(r => setTimeout(r, 1600));   // 等内部 900ms 延迟的 toast 弹出
    return {
      本机款数: STATE.games.length,
      toasts: box ? box.textContent || '' : '(无容器)',
      按钮高亮: !!document.querySelector('#btnCloudPull.btn-attention'),
    };
  }, { n: localN, wait: waitMs });

  const lost = await runCheck(9, 100);
  chk('D-4 ★ 本机 9 条 / 云端 346 条时会警告并给出恢复办法',
    /本机只剩/.test(lost.toasts) && /拉取云端/.test(lost.toasts), lost);
  chk('D-4b 同时给「拉取云端」按钮加上高亮', lost.按钮高亮 === true, lost);

  /* 只少 2 款：属正常删除，不该被当成丢数据。
     wait 给到 14000ms —— D-4 那条的 toast 寿命是 12000ms，必须等它彻底消失。 */
  const notLost = await runCheck(344, 14000);
  chk('D-5 ★ 正常删除少量不会被误报成丢数据',
    notLost.本机款数 === 344 && !/本机只剩/.test(notLost.toasts), notLost);

  chk('无 JS 运行时错误', errs.length === 0, errs.slice(0, 5));

  console.log('\n==============================');
  console.log('ISSUES PASS ' + pass + '  FAIL ' + fail);
  console.log('==============================');
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();