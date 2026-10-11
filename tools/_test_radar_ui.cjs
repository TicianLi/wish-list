/* 「今日特价雷达 / 已购检测」界面回归（2026-10-11 新增）

   这套是【浏览器端】测试，与 _test_specials（后端解析）/ _test_owned（后端采集+前端逻辑）
   配套。三者合起来覆盖本次新增的两个功能的完整链路。

   ⚠️ 血泪教训（写这套测试的当天踩到）：
     改造 CSS 时有个脚本把 @keyframes 截断成 `@keyframes tin{from{opacity:0;tr`，
     浏览器从此**静默丢弃该行之后的全部规则** —— 不报错、页面照常显示，
     但门锁（body.gate-locked{visibility:hidden}）、.modal、所有新界面样式全都没了。
     本测试因此加了两组硬断言：
       E 组：门锁必须真的盖住 .wrap 和新模态框（安全红线）
       F2 组：新界面的样式必须真的被解析到（CSS 截断会静默吞掉这些）
     以后谁再动 CSS，破坏会当场被抓住，而不是等上线才发现。

   用法：node tools/_test_radar_ui.cjs   （从仓库根跑，需要 NODE_PATH 指向 puppeteer-core）
*/
const puppeteer = require('puppeteer-core');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve(__dirname, '..');
const PORT = 8908;
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

let pass = 0, fail = 0;
function chk(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra != null ? '  -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(t)) errors.push('console: ' + t);
  });
  page.on('dialog', async d => { await d.dismiss(); });

  // 免密钥（站主豁免），否则整页被门锁遮住，什么都测不了
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 1200));

  console.log('\n=== A. 基础健康 ===');
  chk('无 JS 运行时错误', errors.length === 0, errors.slice(0, 5));

  console.log('\n=== B. 既有硬不变式 ===');
  const stats = await page.evaluate(() => document.querySelectorAll('#stats .stat-card').length);
  chk('统计卡 12 张', stats === 12, stats);
  const cols = await page.evaluate(() => document.querySelectorAll('.table-wrap thead th').length);
  chk('表头 16 列', cols === 16, cols);
  const rows = await page.evaluate(() => {
    // 【2026-10-11 修正】file:// 打开时 localStorage 为空，表格只有 1 行占位。
    // 必须先注入 40 条真实形状的数据再量，否则量到的是「空表」而不是「行高」。
    const mk = i => ({
      appid: 900000 + i, name: '压测游戏' + i, url: '', released: '2024-01-0' + (i % 9 + 1),
      discount: -Math.min(90, 10 + i), price: { final: 100 - i, orig: 400 - i * 4, cur: 'CNY' },
      reviews: { pct: 80 + (i % 20), n: 1000 + i * 37 }, tags: [], added: Date.now() - i * 1e7, source: 'manual-sync',
    });
    STATE.games = Array.from({ length: 40 }, (_, i) => mk(i));
    try { renderTable(); } catch (e) {}
    const tb = document.querySelector('.xscroll-body');
    if (!tb) return -1;
    const r = tb.getBoundingClientRect();
    const trs = [...document.querySelectorAll('#tbody tr')];
    let n = 0;
    for (const t of trs) { const b = t.getBoundingClientRect(); if (b.top < r.bottom && b.bottom > r.top) n++; }
    return n;
  });
  chk('一屏可见行数 ≥ 10（注入 40 行后）', rows >= 10, rows);

  console.log('\n=== C. 新增：特价雷达 ===');
  chk('btnRadar 存在', await page.evaluate(() => !!document.querySelector('#btnRadar')));
  chk('btnOwned 存在', await page.evaluate(() => !!document.querySelector('#btnOwned')));
  chk('modalRadar 存在', await page.evaluate(() => !!document.querySelector('#modalRadar')));
  chk('modalOwned 存在', await page.evaluate(() => !!document.querySelector('#modalOwned')));

  await page.evaluate(() => {
    RADAR.items = [
      { appid: 111, name: '测试游戏甲', discountPercent: 85, finalPrice: 22.5, originalPrice: 150, currency: 'CNY', reviewPct: 92, reviewCount: 12345, tier: 'S', tinyImage: '', alreadyOwned: false, score: 100 },
      { appid: 222, name: '测试游戏乙', discountPercent: 60, finalPrice: 40, originalPrice: 100, currency: 'CNY', reviewPct: 65, reviewCount: 300, tier: 'C', tinyImage: '', alreadyOwned: false, score: 50 },
      { appid: 333, name: '已在清单的游戏', discountPercent: 90, finalPrice: 5, originalPrice: 50, currency: 'CNY', reviewPct: 95, reviewCount: 999, tier: 'S', tinyImage: '', alreadyOwned: true, score: 110 },
    ];
    RADAR.loadedAt = Date.now();
    // 【2026-10-11 修正】筛选控件有默认值(70/80)，不先归零的话
    // 「渲染 3 张」会被默认值过滤掉，属于测试方法错、不是代码 bug。
    document.querySelector('#radarMinDisc').value = '0';
    document.querySelector('#radarMinReview').value = '0';
    document.querySelector('#radarHideOwned').checked = false;
    renderRadar();
  });
  const cardN = await page.evaluate(() => document.querySelectorAll('#radarGrid .radar-card').length);
  chk('雷达渲染 3 张卡片', cardN === 3, cardN);

// 好评门槛此时是 0，所以只按折扣过滤：85% 与 90% 两款过线，60% 那款被滤掉 → 2 张
await page.evaluate(() => { document.querySelector('#radarMinDisc').value = '70'; renderRadar(); });
  const filtered = await page.evaluate(() => document.querySelectorAll('#radarGrid .radar-card').length);
  chk('折扣筛选生效（70% 留下 2 张）', filtered === 2, filtered);

  // 好评筛选独立验证：只能用 select 里真实存在的档位（0/70/80/90），
  // 赋不存在的值会被浏览器拒绝并把 value 置空，看起来像「筛选彻底失效」的假象。
  // 测试数据好评率：甲 92 / 乙 65 / 丙 95 → 门槛 90 应滤掉乙，剩 2 张。
  await page.evaluate(() => { document.querySelector('#radarMinDisc').value = '0'; document.querySelector('#radarMinReview').value = '90'; renderRadar(); });
  const byReview = await page.evaluate(() => document.querySelectorAll('#radarGrid .radar-card').length);
  chk('好评筛选生效（90% 滤掉 65% 那款，剩 2 张）', byReview === 2, byReview);

  const rv = await page.evaluate(() => document.querySelector('#radarMinReview').value);
  chk('好评档位赋值真实生效', rv === '90', rv);

  await page.evaluate(() => { document.querySelector('#radarMinDisc').value = '0'; document.querySelector('#radarMinReview').value = '0'; renderRadar(); });
  await page.evaluate(() => { document.querySelector('#radarHideOwned').checked = true; renderRadar(); });
  const hidden = await page.evaluate(() => document.querySelectorAll('#radarGrid .radar-card').length);
  chk('「隐藏已在清单」生效（3→2）', hidden === 2, hidden);
  await page.evaluate(() => { document.querySelector('#radarHideOwned').checked = false; renderRadar(); });

  const tierS = await page.evaluate(() => document.querySelectorAll('#radarGrid .radar-tier.S').length);
  chk('S 级徽章渲染 2 个', tierS === 2, tierS);

  // 已在库的那张必须打「已在清单」灰标，且按钮不可再点（不能重复加入）
  const ownedTag = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#radarGrid .radar-card')];
    const c = cards.find(x => /已在清单的游戏/.test(x.textContent || ''));
    if (!c) return null;
    return {
      hasInlist: !!c.querySelector('.radar-inlist'),
      hasAddBtn: !!c.querySelector('[data-radar-add]'),
      cls: c.className,
    };
  });
  chk('已在清单的卡片打「已在清单」灰标', !!ownedTag && ownedTag.hasInlist === true, ownedTag);
  // 已在清单的绝不能再给「加入」按钮：点了必然抛「已在愿望单中」，是个必然失败的操作
  chk('★ 已在清单的卡片不再显示「加入清单」按钮', !!ownedTag && ownedTag.hasAddBtn === false, ownedTag);

console.log('\n=== C2. 「加入清单」走既有任务队列（不能绕过限速） ===');
  // 打桩 fetchGameData：本机连不上 Steam，真跑会卡在限速等待里，测不到终态。
  // 打桩后能确定地验两条：①进队列、②成功/失败都被记进可读的 task 状态。
  const stub = async (mode) => await page.evaluate(async (m) => {
    if (m === 'ok') {
      const orig = window.fetchGameData;
      window.fetchGameData = async (appid) => ({
        nameInfo: { name: '打桩游戏' + appid, original: 'Stub ' + appid },
        price: { final: 100, orig: 400, cur: 'CNY', discount: -75 },
        rating: { pct: 90, n: 1000 },
        details: { type: 'game' },
      });
      window.__restoreFetch = () => { window.fetchGameData = orig; };
    }
    const qBefore = STATE.taskQueue.length;
    try { radarAdd(222); } catch (e) { return { err: String(e && e.message) }; }
    const qAfterPush = STATE.taskQueue.length;
    // 任务的标识字段叫 term（不是 appid），且完成后会被队列消费掉，
    // 所以必须在同一 tick 里先把快照抓下来。
    const snap = STATE.taskQueue.find(t => String(t.term) === '222');
    const shot = snap ? { term: String(snap.term), status: snap.status, msg: snap.msg } : null;
    await new Promise(r => setTimeout(r, 500));
    const t2 = STATE.taskQueue.find(t => String(t.term) === '222');
    const n = STATE.games.filter(g => g.appid === 222).length;
    if (window.__restoreFetch) window.__restoreFetch();
    return {
      qBefore, qAfterPush,
      hasTask: !!shot,
      shot,
      stillThere: !!t2,
      finalStatus: t2 && t2.status,
      marked: RADAR.added.has(222),
      inList: n,
    };
  }, mode);

  const okRes = await stub('ok');
  chk('C2-1 ★ 走的是既有任务队列（限速/重试不被绕过）',
    okRes.hasTask === true && okRes.qAfterPush === okRes.qBefore + 1 && okRes.shot.term === '222', okRes);
  chk('C2-2 立刻标记为已加入（防连点）', okRes.marked === true, okRes);
  chk('C2-3 成功后真的进了清单', okRes.inList === 1, okRes);
  // 任务完成后会被队列移除，所以终态要么留在队列里（done），要么已被消费（stillThere=false）
  chk('C2-4 成功/失败都落在任务状态上（done 或已被消费，不静默吞掉）',
    okRes.stillThere === true ? okRes.finalStatus === 'done' : true, okRes);

  // 失败路径：打桩成必失败，必须变成可读状态
  const failRes = await page.evaluate(async () => {
    const orig = window.fetchGameData;
    window.fetchGameData = async () => { throw new Error('打桩：模拟 Steam 不可达'); };
    STATE.games = STATE.games.filter(g => g.appid !== 333);
    RADAR.added.delete(333);
    try { radarAdd(333); } catch (e) { return { err: String(e && e.message) }; }
    const snap = STATE.taskQueue.find(t => String(t.term) === '333');
    await new Promise(r => setTimeout(r, 800));
    const t2 = STATE.taskQueue.find(t => String(t.term) === '333');
    window.fetchGameData = orig;
    return {
      hasTask: !!snap,
      status: t2 && t2.status,
      msg: t2 && t2.msg,
      inList: STATE.games.filter(g => g.appid === 333).length,
    };
  });
  chk('C2-5 ★ 加入失败被记成 failed 且带原因（不静默吞掉）',
    failRes.hasTask === true && failRes.status === 'failed' && /打桩/.test(failRes.msg || ''), failRes);
  chk('C2-6 失败的条目没有混进清单', failRes.inList === 0, failRes);

  // 重复加入要被挡住
  const dupRes = await page.evaluate(() => {
    const n0 = STATE.games.filter(g => g.appid === 222).length;
    radarAdd(222);
    return n0;
  });
  chk('C2-5 重复加入不新增条目', dupRes === 1, dupRes);

  console.log('\n=== D. 新增：已购检测 ===');
  const cls = await page.evaluate(() => {
    const owned = [
      { appid: 1001, playtimeForever: 50 },
      { appid: 1002, playtimeForever: 0 },
      { appid: 2001, playtimeForever: 3 },
      { appid: 9999, playtimeForever: 10 },
    ];
    const mine = [
      { appid: 1001, name: '本体已买', details: { type: 'game' } },
      { appid: 1002, name: '本体没玩过', details: { type: 'game' } },
      { appid: 2001, name: '某 DLC', details: { type: 'dlc' } },
    ];
    return classifyOwned(owned, mine);
  });
  chk('本体分组 2 款', cls.main.length === 2, cls.main.map(x => x.name));
  chk('DLC 分组 1 款', cls.dlc.length === 1, cls.dlc.map(x => x.name));
  chk('库里没有的不进分组（9999 被排除）', !cls.main.concat(cls.dlc).some(x => x.appid === 9999));
  chk('玩过的排前面', cls.main[0].appid === 1001, cls.main[0]);
  chk('0 小时判为 uncertain', cls.main.find(x => x.appid === 1002).verdict === 'uncertain');

  await page.evaluate(() => {
    OWNED.games = [{ appid: 1001, playtimeForever: 50 }, { appid: 1002, playtimeForever: 0 }, { appid: 2001, playtimeForever: 3 }];
    OWNED.loadedAt = Date.now();
    STATE.games = [
      { appid: 1001, name: '本体已买', details: { type: 'game' }, price: {} },
      { appid: 1002, name: '本体没玩过', details: { type: 'game' }, price: {} },
      { appid: 2001, name: '某 DLC', details: { type: 'dlc' }, price: {} },
    ];
    const g = classifyOwned(OWNED.games, STATE.games);
    OWNED.main = g.main; OWNED.dlc = g.dlc;
    renderOwned();
  });
  const noCheck = await page.evaluate(() => document.querySelectorAll('#ownedMainBody .owned-pick:checked').length);
  chk('★ 默认全部不勾选', noCheck === 0, noCheck);
  const uncertainTxt = await page.evaluate(() => (document.querySelector('#ownedMainBody').textContent || '').includes('评测密钥'));
  chk('0 小时标注「评测密钥/赠送」', uncertainTxt);
  const delDisabled = await page.evaluate(() => document.querySelector('#btnOwnedDelete').disabled);
  chk('未勾选时删除按钮禁用', delDisabled === true);

  // 勾选联动
  await page.evaluate(() => {
    const cb = document.querySelector('#ownedMainBody .owned-pick');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const delTxt = await page.evaluate(() => document.querySelector('#btnOwnedDelete').textContent);
  chk('勾选后按钮显示数量', delTxt.includes('1'), delTxt);

  console.log('\n=== E. 安全红线：门锁必须盖住新模态框 ===');
  // 【2026-10-11 修正】之前这里是手动 classList.add('gate-locked') 再读 computedStyle，
  // 但根因排查发现真正的失败场景是「CSS 被截断导致整条规则失效」——
  // 手动加 class 也会一起失效，所以那次断言确实抓到了 bug，只是我误判成测试问题。
  // 现在补两条更硬的：① 未解锁时（页面初始态）主容器必须 hidden
  //                        ② 手动加 class 后新模态框必须 hidden（回归保护）
  const lockPage = await page.evaluate(() => {
    const g = document.getElementById('gate');
    // 本测试设了 sw_gate_owner_v1（站主豁免），initGate 已 gateUnlock() →
    // #gate 带上 gate-hidden，display:none。这是正确行为，不能反过来断言「可见」。
    // 「未解锁时数据不可见」由下方的新访客场景用真实页面状态验证，那条更硬。
    return { gateHiddenByOwner: g.classList.contains('gate-hidden'), gateNow: getComputedStyle(g).display };
  });
  chk('站主豁免下门锁屏已被隐藏（不会挡住已授权的人）',
    lockPage.gateHiddenByOwner === true && lockPage.gateNow === 'none', lockPage);

  // 「gate-locked 时两个新模态框不可见」由下方新访客场景以真实页面状态验证，
  // 这里不再用「手动加 class」（已解锁页面上强制改 class 不产生样式重算，不可靠）。

  // 【2026-10-11 新增】CSS 截断回归守卫：一旦 <style> 内出现括号失衡，
  // 浏览器会静默丢弃后续全部规则，门锁、模态框、新界面样式会一起失效且不报错。
  // 这里直接把「浏览器实际解析出的规则数」和「源码里大括号配对数」都比一遍。
  const cssHealth = await page.evaluate(() => {
    const rules = document.styleSheets[0].cssRules;
    let n = 0;
    const walk = list => { for (const r of list) { n++; if (r.cssRules) walk(r.cssRules); } };
    walk(rules);
    const sel = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
    let depth = 0, bad = false;
    for (const ch of sel) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth < 0) { bad = true; depth = 0; } } }
    return { parsed: n, srcDepth: depth, negative: bad, hasKeyframes: /@keyframes tin\{[^}]*transform:translateX/.test(sel) };
  });
  chk('CSS 源码括号平衡（depth=0 且无多余 }）', cssHealth.srcDepth === 0 && !cssHealth.negative, cssHealth);
  chk('@keyframes tin 未被截断', cssHealth.hasKeyframes, cssHealth);
  chk('浏览器解析规则数 ≥ 340（截断前基线）', cssHealth.parsed >= 340, cssHealth);

  // ★ 真正的「新访客」场景：清掉本机凭证重载，确认数据一个像素都看不到。
  // 这条不能用「手动加 class」代替 —— 那只测了 CSS，没测 initGate 的判定链。
  await page.evaluateOnNewDocument(() => {
    try { localStorage.removeItem('sw_gate_owner_v1'); localStorage.removeItem('sw_gate_pass_v1'); } catch (e) {}
  });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 1200));
  const fresh = await page.evaluate(() => {
    const vis = el => { const e = document.querySelector(el); return e ? getComputedStyle(e).visibility : '(无此元素)'; };
    return {
      bodyLocked: document.body.classList.contains('gate-locked'),
      wrap: vis('.wrap'),
      gate: getComputedStyle(document.getElementById('gate')).display,
      modalRadar: vis('#modalRadar'),
      modalOwned: vis('#modalOwned'),
      tables: vis('.xscroll-body'),
    };
  });
  chk('新访客：body 带 gate-locked', fresh.bodyLocked === true, fresh);
  chk('新访客：主内容 visibility=hidden', fresh.wrap === 'hidden', fresh);
  chk('新访客：表格区也看不到', fresh.tables === 'hidden', fresh);
  chk('新访客：门锁屏显示出来', fresh.gate !== 'none', fresh);
  chk('新访客：两个新模态框都看不到', fresh.modalRadar === 'hidden' && fresh.modalOwned === 'hidden', fresh);

  console.log('\n=== F. 响应式（移动端）===');
  // 恢复站主豁免（E 组为了验「新访客」把凭证清了），下面的响应式与样式断言需要已解锁页面
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'networkidle0', timeout: 40000 });
  await new Promise(r => setTimeout(r, 1000));
  await page.evaluate(() => {
    const mk = i => ({
      appid: 900000 + i, name: '压测游戏' + i, url: '', released: '2024-01-0' + (i % 9 + 1),
      discount: -Math.min(90, 10 + i), price: { final: 100 - i, orig: 400 - i * 4, cur: 'CNY' },
      reviews: { pct: 80 + (i % 20), n: 1000 + i * 37 }, tags: [], added: Date.now() - i * 1e7, source: 'manual-sync',
    });
    STATE.games = Array.from({ length: 40 }, (_, i) => mk(i));
    try { renderTable(); } catch (e) {}
    RADAR.items = [
      { appid: 111, name: '测试游戏甲', discountPercent: 85, finalPrice: 22.5, originalPrice: 150, currency: 'CNY', reviewPct: 92, reviewCount: 12345, tier: 'S', tinyImage: '', alreadyOwned: false, score: 100 },
    ];
    RADAR.loadedAt = Date.now();
    renderRadar();
  });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise(r => setTimeout(r, 500));
  const mRows = await page.evaluate(() => {
    const tb = document.querySelector('.xscroll-body');
    if (!tb) return -1;
    const r = tb.getBoundingClientRect();
    let n = 0;
    for (const t of document.querySelectorAll('#tbody tr')) {
      const b = t.getBoundingClientRect();
      if (b.top < r.bottom && b.bottom > r.top) n++;
    }
    return n;
  });
  chk('移动端一屏仍 ≥ 10 行', mRows >= 10, mRows);
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  chk('移动端无横向溢出', noHScroll);

  console.log('\n=== F2. 新界面样式真实生效（CSS 截断会静默吞掉这些） ===');
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise(r => setTimeout(r, 300));
  const styleOK = await page.evaluate(() => {
    const g = getComputedStyle(document.querySelector('#radarGrid'));
    const card = document.querySelector('#radarGrid .radar-card');
    const cs = card ? getComputedStyle(card) : null;
    const tier = document.querySelector('#radarGrid .radar-tier');
    return {
      gridDisplay: g.display,
      cardBorder: cs ? cs.borderRadius : null,
      cardBg: cs ? cs.backgroundColor : null,
      tierWeight: tier ? getComputedStyle(tier).fontWeight : null,
      ownedTableExists: !!document.querySelector('#ownedMainBody'),
    };
  });
  chk('#radarGrid 是 grid 布局', styleOK.gridDisplay === 'grid', styleOK);
  chk('.radar-card 有圆角（token 生效）', !!styleOK.cardBorder && styleOK.cardBorder !== '0px', styleOK);
  chk('.radar-tier 有加粗（等级徽章样式生效）', styleOK.tierWeight === '700' || styleOK.tierWeight === '600', styleOK);
  chk('#ownedMainBody 存在', styleOK.ownedTableExists);

  console.log('\n=== F3. 今日概览条（Steam 风格首屏数字带） ===');
  const bar = await page.evaluate(() => {
    const el = document.querySelector('#todayBar');
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      height: el.getBoundingClientRect().height,
      items: el.querySelectorAll('.t-i').length,
      seps: el.querySelectorAll('.t-sep').length,
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      numeric: [...el.querySelectorAll('.t-i b')].map(b => getComputedStyle(b).fontVariantNumeric),
    };
  });
  chk('F3-1 #todayBar 存在且已渲染', !bar.missing && bar.display === 'flex' && bar.items > 0, bar);
  chk('F3-2 数字用等宽（tabular-nums）', bar.numeric && bar.numeric.every(v => /tabular-nums/.test(v)), bar.numeric);
  chk('F3-3 高度克制（≤40px，绝不侵占列表行数预算）', bar.height > 0 && bar.height <= 40, bar.height);
  chk('F3-4 有分隔线（横条观感）', bar.seps === Math.max(0, bar.items - 1), bar);
  chk('F3-5 内容有真实数字', /\d/.test(bar.text || ''), bar.text);

  // 空清单时必须整条隐藏：显示一排 0 会让人误以为「一款都没打折」
  const emptyBar = await page.evaluate(() => {
    const save = STATE.games;
    STATE.games = [];
    renderStats();
    const h = document.querySelector('#todayBar').getBoundingClientRect().height;
    STATE.games = save; renderStats();
    return h;
  });
  chk('F3-6 清单为空时整条隐藏（不显示一排 0）', emptyBar === 0, emptyBar);

  // 概览条与 12 张卡的数字必须一致（同一套变量算出来的，绝不能打架）
  const consistency = await page.evaluate(() => {
    renderStats();
    const barTxt = document.querySelector('#todayBar').textContent || '';
    const cards = [...document.querySelectorAll('#stats .stat-card')].map(c => ({
      l: (c.querySelector('.s-label') || {}).textContent || '',
      v: (c.querySelector('.s-value') || {}).textContent || '',
    }));
    const total = cards.find(c => /收录总数/.test(c.l));
    return { barTxt, total: total && total.v, n: STATE.games.length };
  });
  chk('F3-7 概览条「款」数与统计卡「收录总数」一致',
    consistency.barTxt.indexOf(String(consistency.n)) >= 0 && String(consistency.total) === String(consistency.n),
    consistency);

  console.log('\n=== G. 无新增运行时错误 ===');
  chk('全流程无 JS 错误', errors.length === 0, errors.slice(0, 8));

  await browser.close();
  server.close();
  console.log('\n==============================');
  console.log('RADAR_UI PASS ' + pass + '   FAIL ' + fail);
  console.log('==============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('致命错误：', e); process.exit(1); });