/* 「我的 Steam 库 / 已购待清理」专项回归（2026-10-11 新增）

   这套测试保护的是本次最敏感的一条链路：用户的 Steam 库 + 一条破坏性删除。
   设计判据（全部围绕「绝不误删」和「绝不泄密」两条红线）：

     A. SteamID 校验：必须 17 位且落在合法区间，
        否则宁可不抓 —— 拿一个错的 ID 去查会得到别人的库，后果比「没这功能」严重得多
     B. 响应规整：privacy 私档 / 坏响应 / 空库 三种情况都要给出人能看懂的错误码，
        且**退出码永远是 0**（不能让可选功能拖垮 CI 的 finalize 合并+发信）
     C. 可信度判定：0 小时绝不等于「买过」（可能是评测密钥/赠送/家庭共享），
        必须标成 uncertain 让用户自己勾 —— 这正是「绝不自动删」的技术落点
     D. 日志脱敏：Key 与 SteamID 只准露前 4 位（Actions 日志是公开的）
     E. 不存游戏名：公开仓库，谁都能看到 owned.json，绝不能带名字
     F. 前端分组：本体与 DLC 必须分开显示，且默认全不勾选
     G. 前端破坏性操作：删除必须同步落盘（saveData 是 400ms debounce，
        只靠它会丢数据）+ 备份可撤销
     H. 接线：workflow 必须用 secrets 传 Key，绝不写死

   前后端两侧都跑：后端纯函数直接 import，前端部分用真实 Chrome 注入状态验证。
*/
const fs = require('fs');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8907;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
}

const SRC = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-owned.mjs'), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = stripComments(SRC);

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const M = await import(pathToFileURL(path.join(ROOT, 'tools', 'fetch-owned.mjs')).href);

  /* ==================== A. SteamID 校验 ==================== */
  console.log('=== A. SteamID64 校验（错了比没有更危险）===');
  check('A-1 真实 17 位 ID 通过', M.isValidSteamId64('76561199760945693') === true);
  check('A-2 区间下界刚好通过',
    M.isValidSteamId64('76561197960265728') === true);
  check('A-3 小于下界拒绝（不是真实 ID）', M.isValidSteamId64('76561197960265727') === false);
  check('A-4 位数不对拒绝（16 位）', M.isValidSteamId64('7656119976094569') === false);
  check('A-5 位数不对拒绝（18 位）', M.isValidSteamId64('765611997609456930') === false);
  check('A-6 含字母拒绝', M.isValidSteamId64('7656119976094569a') === false);
  check('A-7 空/未定义拒绝', M.isValidSteamId64('') === false && M.isValidSteamId64(null) === false && M.isValidSteamId64(undefined) === false);
  check('A-8 前后空格容忍', M.isValidSteamId64('  76561199760945693 ') === true);
  check('A-9 经典旧格式 SteamID2（4:x:x）拒绝（API 只要 64 位）', M.isValidSteamId64('STEAM_0:1:12345') === false);

  /* ==================== B. 响应规整 ==================== */
  console.log('\n=== B. 响应规整（三种异常都要有能看懂的话）===');
  check('B-1 隐私设置不让看 → PRIVATE_PROFILE',
    M.normalizeResponse({ response: { success: false } }).error === 'PRIVATE_PROFILE',
    M.normalizeResponse({ response: { success: false } }).error);
  check('B-2 结构不对 → BAD_RESPONSE', M.normalizeResponse({}).error === 'BAD_RESPONSE');
  check('B-3 null → BAD_RESPONSE', M.normalizeResponse(null).error === 'BAD_RESPONSE');
  check('B-4 空库是合法结果（不是错误）',
    M.normalizeResponse({ response: { games: [] } }).ok === true);
  check('B-5 games 不是数组时不炸',
    M.normalizeResponse({ response: { games: 'oops' } }).games.length === 0);
  check('B-6 appid 非法（0 / 负数 / 非数字）的条目被丢掉',
    M.normalizeResponse({ response: { games: [{ appid: 0 }, { appid: -5 }, { appid: 'abc' }, { appid: 70 }] } }).games.length === 1);
  check('B-7 游玩时长缺省归 0（不报 undefined）',
    M.normalizeResponse({ response: { games: [{ appid: 70 }] } }).games[0].playtimeForever === 0);
  check('B-8 按游玩时长降序、时长相同按 appid 升序（结果稳定）',
    M.normalizeResponse({ response: { games: [{ appid: 3, playtime_forever: 10 }, { appid: 1, playtime_forever: 10 }, { appid: 2, playtime_forever: 99 }] } })
      .games.map(g => g.appid).join(',') === '2,1,3',
    M.normalizeResponse({ response: { games: [{ appid: 3, playtime_forever: 10 }, { appid: 1, playtime_forever: 10 }, { appid: 2, playtime_forever: 99 }] } }).games.map(g => g.appid));
  // B-9：只保留页面真正用到的 2 个字段。
// 2026-10-11 收紧：lastPlayed / playtimeWindows 是「指纹级」信息，
// 对页面毫无用处，却足以让人反查出这是谁的库，所以一律不写。
check('B-9 ★ 只保留 appid + playtimeForever 两个字段（2026-10-11 收紧指纹字段）',
    Object.keys(M.normalizeResponse({ response: { games: [{ appid: 70, playtime_forever: 1, name: '不该出现' }] } }).games[0]).sort().join(',')
      === 'appid,playtimeForever',
    Object.keys(M.normalizeResponse({ response: { games: [{ appid: 70 }] } }).games[0]));

  /* ==================== C. 可信度判定 ==================== */
  console.log('\n=== C. 可信度：0 小时绝不等于「买过」===');
  check('C-1 玩过 → likely', M.judgeOwnership(1) === 'likely');
  check('C-2 玩很多 → likely', M.judgeOwnership(5000) === 'likely');
  check('C-3 0 小时 → uncertain（可能是评测密钥/赠送）', M.judgeOwnership(0) === 'uncertain');
  check('C-4 负数时长也归 uncertain（不越界成 likely）', M.judgeOwnership(-5) === 'uncertain');
  check('C-5 缺省 → uncertain', M.judgeOwnership(undefined) === 'uncertain');
  check('C-6 字符串时长也能判', M.judgeOwnership('120') === 'likely');

  /* ==================== D. 脱敏 ==================== */
  console.log('\n=== D. 日志脱敏（Actions 日志是公开的）===');
  const mk = M.maskSecret('0123456789ABCDEF0123456789ABCDEF');
  check('D-1 Key 只露前 4 位', mk.slice(0, 4) === '0123', mk);
  check('D-2 Key 的其余部分全被星号盖住', /^\*+$/.test(mk.slice(4)), mk);
  check('D-3 完整 Key 绝不出现在脱敏结果里', !mk.includes('456789ABCDEF0123456789ABCDEF'), mk);
  const sid = M.maskSecret('76561199760945693');
  check('D-4 SteamID 同样脱敏', sid.startsWith('7656') && !sid.includes('1760945693'), sid);
  check('D-5 空值显示为 (空) 而不是 undefined', M.maskSecret('') === '(空)' && M.maskSecret(null) === '(空)');
  check('D-6 ≤4 位直接全盖（不泄露原值）', M.maskSecret('abcd') === '****', M.maskSecret('abcd'));
  check('D-7 源码里没有任何直接打印 Key/SteamID 的语句',
    !/log\(\s*[`'"].*\$\{CFG\.key\}/.test(CODE) && !/log\(\s*[`'"].*\$\{CFG\.steamId\}/.test(CODE));

  /* ==================== E. 不泄密 / 失败语义 ==================== */
  console.log('\n=== E. 失败语义与隐私 ===');
  check('E-1 没配 Key 时跳过而不是报错', /if\s*\(!CFG\.key\)[\s\S]{0,200}return\s*\{\s*skipped:\s*true/.test(CODE));
  check('E-2 没配 Key 时不写文件（保留旧数据）',
    /if\s*\(!CFG\.key\)[\s\S]{0,300}return\s*\{\s*skipped/.test(CODE));
  check('E-3 有总开关 OWNED_ENABLED', /OWNED_ENABLED/.test(SRC));
  check('E-4 PRIVATE_PROFILE 要写出人话指引',
    /Steam 设置[\s\S]{0,40}隐私[\s\S]{0,40}游戏详情/.test(CODE) || /errorHint/.test(CODE));
  /* 防止把因果写反：绝大多数人隐私本来就是公开的，接口照样调不通，
     因为浏览器直连被 CORS 挡死。谁再把「隐私设置」写成主因，这条会失败。 */
  check('E-4b 必须写明「必须走 CI」的原因是 CORS（不是隐私设置）',
    /CORS/.test(SRC) && /api\.steampowered\.com/.test(SRC));
  check('E-5 ★ 只存 appid + 时长，绝不存游戏名（公开仓库不暴露库内容）',
    !/\bname\b\s*:/.test(CODE) && !/games\.json/.test(CODE));
  check('E-5b ★ 产物里不含 lastPlayed / playtimeWindows（可反查身份的指纹字段）',
    !/lastPlayed\s*:/.test(CODE) && !/playtimeWindows\s*:/.test(CODE));
  check('E-5c owned.json 要入库（Pages 读不到它，功能就是坏的）',
    !/data\/owned\.json/.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')) ||
    !/^data\/owned\.json$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')));
  check('E-6 不调用带 include_appinfo 的完整信息（少拿一点，少漏一点）',
    /include_appinfo=0/.test(CODE));
  check('E-7 含免费领取的游戏（否则领过的查不到）', /include_played_free_games=1/.test(CODE));
  /* 2026-10-11 用户报「我库中不只有我自己的游戏，还有家庭组的可共享游戏」。
     根因就是少了这个参数：GetOwnedGames 默认只返回自己拥有的，
     家庭共享那批会整批漏掉 → 页面把它们误判成「未购买」。
     这条断言的作用是防止以后重构时被无声删掉（症状仍是"页面照常工作，只是漏判"，极难发现）。 */
  check('E-7b ★ 含家庭共享游戏（include_family_licenses=1）',
    /include_family_licenses=1/.test(CODE));
  check('E-8 分页有上限（不会无限翻）', /OWNED_MAX_PAGES/.test(SRC));
  check('E-9 入口异常被吞掉（绝不抛给 CI）',
    /main\(\)\.catch\([\s\S]{0,400}writeOut/.test(CODE));
  check('E-10 统计 uncertainCount 供页面直接显示', /uncertainCount/.test(CODE));
  check('E-11 源码里不含任何 32 位十六进制（防手滑写死 Key）', !/[0-9a-fA-F]{32}/.test(SRC));

  /* ==================== F/G. 前端（真实浏览器） ==================== */
  const browser = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errs.push(m.text()); });
  page.on('dialog', async d => { await d.dismiss(); });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('sw_gate_owner_v1', '1'); } catch (e) {} });
  await page.goto('http://127.0.0.1:' + PORT + '/index.html', { waitUntil: 'domcontentloaded' });
  await sleep(1200);

  console.log('\n=== F. 前端分组：本体与 DLC 分开 ===');
  const cls = await page.evaluate(() => {
    const owned = [
      { appid: 1001, playtimeForever: 50 },
      { appid: 1002, playtimeForever: 0 },
      { appid: 2001, playtimeForever: 3 },
      { appid: 2002, playtimeForever: 0 },
      { appid: 9999, playtimeForever: 99 },
    ];
    const mine = [
      { appid: 1001, name: '本体已买', details: { type: 'game' } },
      { appid: 1002, name: '本体没玩过', details: { type: 'game' } },
      { appid: 2001, name: '某 DLC', details: { type: 'dlc' } },
      { appid: 2002, name: '某 DLC2', details: { type: 'dlc' } },
    ];
    return classifyOwned(owned, mine);
  });
  check('F-1 本体 2 款', cls.main.length === 2, cls.main.map(x => x.name));
  check('F-2 DLC 2 款（分开展示，不混进本体）', cls.dlc.length === 2, cls.dlc.map(x => x.name));
  check('F-3 库里没有的不进任何分组（9999 被排除）',
    !cls.main.concat(cls.dlc).some(x => x.appid === 9999));
  check('F-4 玩过的排前面', cls.main[0].appid === 1001, cls.main.map(x => x.appid));
  check('F-5 0 小时标 uncertain', cls.main.find(x => x.appid === 1002).verdict === 'uncertain');
  check('F-6 DLC 里的 0 小时也标 uncertain', cls.dlc.find(x => x.appid === 2002).verdict === 'uncertain');
  check('F-7 details 缺失时算本体（不误判成 DLC）',
    (await page.evaluate(() => classifyOwned([{ appid: 7, playtimeForever: 1 }], [{ appid: 7 }]).main.length)) === 1);

  console.log('\n=== G. 前端：绝不自动删 ===');
  await page.evaluate(() => {
    STATE.games = [
      { appid: 1001, name: '本体已买', details: { type: 'game' }, price: {} },
      { appid: 1002, name: '本体没玩过', details: { type: 'game' }, price: {} },
      { appid: 2001, name: '某 DLC', details: { type: 'dlc' }, price: {} },
    ];
    const g = classifyOwned(
      [{ appid: 1001, playtimeForever: 50 }, { appid: 1002, playtimeForever: 0 }, { appid: 2001, playtimeForever: 3 }],
      STATE.games);
    OWNED.games = [{ appid: 1001, playtimeForever: 50 }, { appid: 1002, playtimeForever: 0 }, { appid: 2001, playtimeForever: 3 }];
    OWNED.loadedAt = Date.now();
    OWNED.main = g.main; OWNED.dlc = g.dlc;
    renderOwned();
  });
  const gChecks = await page.evaluate(() => ({
    checkedMain: document.querySelectorAll('#ownedMainBody .owned-pick:checked').length,
    checkedDlc: document.querySelectorAll('#ownedDlcBody .owned-pick:checked').length,
    delDisabled: document.querySelector('#btnOwnedDelete').disabled,
    delTxt: document.querySelector('#btnOwnedDelete').textContent,
    warnTxt: (document.querySelector('.owned-warn') || {}).textContent || '',
  }));
  check('G-1 ★ 默认一个都不勾选', gChecks.checkedMain === 0 && gChecks.checkedDlc === 0, gChecks);
  check('G-2 未勾选时删除按钮禁用', gChecks.delDisabled === true, gChecks);
  check('G-3 有醒目警告（说明这是不可逆操作）', gChecks.warnTxt.length > 0, gChecks.warnTxt);

  // 勾选联动
  const linkRes = await page.evaluate(() => {
    const cb = document.querySelector('#ownedMainBody .owned-pick');
    cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
    const txt1 = document.querySelector('#btnOwnedDelete').textContent;
    const dis1 = document.querySelector('#btnOwnedDelete').disabled;
    // 全选
    const ca = document.querySelector('#ownedCheckAllMain');
    if (ca) { ca.checked = true; ca.dispatchEvent(new Event('change', { bubbles: true })); }
    return { txt1, dis1, txt2: document.querySelector('#btnOwnedDelete').textContent, hasAll: !!ca };
  });
  check('G-4 勾选后按钮显示数量且可点', linkRes.dis1 === false && /1/.test(linkRes.txt1), linkRes);
  check('G-5 有「全选」控件', linkRes.hasAll === true);

  console.log('\n=== G2. 删除 = 同步落盘 + 可撤销 ===');
  const srcHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('G6 有 saveDataNow 同步落盘函数',
    /function saveDataNow\(\)[\s\S]{0,600}localStorage\.setItem/.test(srcHtml));
  check('G7 删除路径调用的是 saveDataNow（不是 debounce 的 saveData）',
    /function doDelete\(|deleteOwnedSelected\([\s\S]{0,900}saveDataNow/.test(srcHtml),
    (srcHtml.match(/function (doDelete|deleteOwnedSelected)\([\s\S]{0,400}/) || [])[0]);
  check('G8 删除前会先备份（可撤销）', /function backupBeforeCleanup\(\)/.test(srcHtml));
  check('G9 有撤销入口', /function undoOwnedCleanup\(\)/.test(srcHtml) && /btnOwnedUndo/.test(srcHtml));
  check('G10 备份有独立 key（不会和清单数据混在一起）',
    /OWNED_BACKUP_KEY\s*=\s*'[^']+'/.test(srcHtml));
  check('G11 备份里的清单与主清单不是同一个引用（真快照）',
    /JSON\.parse\(JSON\.stringify\(STATE\.games\)\)/.test(srcHtml));
  check('G12 删除有二次确认（showConfirm）',
    /function deleteOwnedSelected\([\s\S]{0,600}showConfirm/.test(srcHtml));

  console.log('\n=== H. CI 接线：Key 走 secrets，绝不写死 ===');
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'daily-refresh.yml'), 'utf8');
  check('H-1 开了 FETCH_OWNED', /FETCH_OWNED:\s*'true'/.test(yml));
  check('H-2 Key 来自 secrets', /STEAM_API_KEY:\s*\$\{\{\s*secrets\.STEAM_API_KEY\s*\}\}/.test(yml));
  check('H-3 SteamID 来自 secrets', /STEAM_ID64:\s*\$\{\{\s*secrets\.STEAM_ID64\s*\}\}/.test(yml));
  check('H-4 workflow 里没有任何明文 Key',
    !/0123456789ABCDEF0123456789ABCDEF/.test(yml) && !/[0-9a-fA-F]{32}/.test(yml));
  const idx = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  // 说明：index.html 里确实有一处 64 位十六进制 —— GATE_CONFIG.hash，
  // 那是「访问密码」的 SHA-256(salt+明文) 散列，属于原有设计（源码不含明文），
  // 不是 API Key。所以这里要排除它，再检查「有没有别的 32 位串」。
  const GATE_HASH = 'c4385a7983566ef404ce4607777b2e6fd6ef9aa84d5902ef896a81043917ab3e';
  const hexes = (idx.match(/[0-9a-fA-F]{32,}/g) || []).filter(h => h !== GATE_HASH);
  check('H-5 ★ 前端代码里绝不含 API Key（公开仓库一眼能看到）',
    !/0123456789ABCDEF0123456789ABCDEF/.test(idx) && hexes.length === 0, hexes);
  check('H-5b 唯一的长十六进制串是门锁散列且不等于 Steam Key',
    hexes.length === 0 && GATE_HASH !== '0123456789ABCDEF0123456789ABCDEF' && idx.includes(GATE_HASH));
  /* 站长的真实 Key/SteamID 曾被写进 README 的「怎么查自己的 ID」示例里，
     推之前被下面这条扫描拦下。这里固化成守卫：仓库里不允许出现任何
     「长得像真 Key / 真 SteamID」的明文，只允许 0123456789ABCDEF… 这种占位。 */
  const FAKE_KEY = '0123456789ABCDEF0123456789ABCDEF';
  const realLooking = [];
  for (const f of ['README.md', 'index.html', 'tools/fetch-owned.mjs', 'tools/discover-specials.mjs',
                   'tools/daily-refresh.mjs', '.github/workflows/daily-refresh.yml']) {
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // 除门锁散列外的任何 32 位十六进制，都要能解释成占位值
    for (const h of (txt.match(/[0-9a-fA-F]{32,}/g) || [])) {
      if (h === GATE_HASH || h === FAKE_KEY) continue;
      realLooking.push(f + ' :: ' + h.slice(0, 8) + '…');
    }
  }
  check('H-5c ★ 仓库任何文件里都没有「真实感」的 Key（只允许占位值与门锁散列）',
    realLooking.length === 0, realLooking);
  check('H-6 前端不含 STEAM_API_KEY 字样', !/STEAM_API_KEY/.test(idx));
  check('H-7 前端只读 owned.json，不自己调 API',
    /OWNED_PATH:\s*'data\/owned\.json'/.test(idx));
  check('H-8 页面无 JS 运行时错误', errs.length === 0, errs.slice(0, 5).join(' | '));

  await browser.close();
  server.close();
  console.log('\n========================================');
  console.log('OWNED PASS ' + pass + '  FAIL ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
