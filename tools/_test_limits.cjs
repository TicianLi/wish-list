/* 「款数 / 数量限制」专项回归（2026-09-19，同日重构为「去上限」版）

   用户指令（第 9 条，关键转折）：
     「只提升到60个那我以后要是又要拉取新数据又超了怎么办」

   ——用户说得对。把 15 改成 60、20 改成 60，本质上只是把同一个坑往后挪一格，
   迟早还会撞上。因此测试的判据从「数字够不够大」改为「还有没有靠猜数字的截断」：

     判据 1：凡"能全部拿到"的地方，一律不限（或总量预算 + 明确告知）。
     判据 2：凡"技术上必须封顶"的地方（DOM 行数、内存日志、localStorage 容量），
             必须①可配置常量 ②超出时给用户可见提示，绝不静默砍。

   本测试锁死的修复点（前端 + CI）：
     A. 候选弹窗不再只渲染 20 个（搜索候选被静默丢弃）
     B. DLC 抓取：MAX_DLC 默认 0 = 不限 + onBatch 分批落盘 + 可取消不丢数据
     C. OCR 行数从 6 提到 30，且超出时有提示
     D. 标签云支持「显示全部」（默认 40 可展开）
     E. 简介不再钳到 160 字后就把原文丢掉
     F. 表格「全部显示」不会被排序/筛选悄悄收回
     G. CI：用户标签解析完全去掉数量上限（页面有多少解析多少）
     H. CI：购买区切片从 20000 提到 60000
     I. CI：maxTagFetch 默认改为 0（不限），杜绝配额饥饿
     J. 全站散落的硬编码数字统一收敛到 CONFIG 常量（可自查、可调）
     K. 调试面板 / 翻译缓存不再因固定数字造成观感上的"少了几款"
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
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

  const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const CI = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');
  /* 去掉注释后再做「代码文本」断言：否则"旧实现写死 items.slice(0,20)"这类
     说明性注释会被误判成仍然存在的老代码（上一版就踩了这个坑）。 */
  const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const HTML_CODE = stripComments(HTML);
  const CI_CODE = stripComments(CI);

  /* ============ A. 候选弹窗不再只渲染 20 个 ============ */
  console.log('\n=== A. 候选弹窗（搜索候选截断）===');
  check('A-1 源码不再有 items.slice(0, 20) 的老写法', !/items\.slice\(0,\s*20\)/.test(HTML_CODE));
  check('A-2 有 CAND_MAX_RENDER 常量且 >= 100',
    /CAND_MAX_RENDER:\s*(\d+)/.test(HTML) && Number(HTML.match(/CAND_MAX_RENDER:\s*(\d+)/)[1]) >= 100,
    (HTML.match(/CAND_MAX_RENDER:\s*(\d+)/) || [])[1]);
  check('A-3 两个渲染循环都用 shownItems', (HTML.match(/shownItems/g) || []).length >= 3);
  check('A-4 被截断时会给出提示文案', /共搜索到 .* 个候选，已显示前/.test(HTML));
  check('A-5 使用 CONFIG.CAND_MAX_RENDER（不再是函数内局部魔法数）',
    /items\.slice\(0,\s*CONFIG\.CAND_MAX_RENDER\)/.test(HTML_CODE));

  const cand = await page.evaluate(async () => {
    const items = [];
    for (let i = 1; i <= 45; i++) items.push({ id: 10000 + i, name: 'Game' + i, price: { final: 1000, currency: 'CNY' } });
    // 打开候选弹窗
    showCandidates(items, '测试：45 个候选');
    await new Promise(r => setTimeout(r, 250));
    const box = document.querySelector('#candList');
    const count = box.querySelectorAll('.cand-item').length;
    // 关掉弹窗（结清挂起的 promise）
    closeModal('modalCandidates');
    return { count };
  });
  check('A-6 45 个候选 → DOM 里真实渲染 45 个（旧版只有 20）', cand.count === 45, 'got ' + cand.count);

  /* ============ B. DLC：去上限 + 分批落盘 ============ */
  console.log('\n=== B. 单游戏 DLC 抓取（去上限架构）===');
  const mDlc = HTML.match(/MAX_DLC:\s*(\d+)/);
  check('B-1 MAX_DLC 默认 0 = 不限（不再靠猜一个大数字）', mDlc && Number(mDlc[1]) === 0, mDlc ? mDlc[1] : 'missing');
  check('B-2 有 DLC_BATCH 分批常量',
    /DLC_BATCH:\s*(\d+)/.test(HTML) && Number(HTML.match(/DLC_BATCH:\s*(\d+)/)[1]) >= 1,
    (HTML.match(/DLC_BATCH:\s*(\d+)/) || [])[1]);
  check('B-3 cap 计算尊重 MAX_DLC=0 时全抓',
    /const cap = \(CONFIG\.MAX_DLC > 0\) \? Math\.min\(CONFIG\.MAX_DLC, all\.length\) : all\.length;/.test(HTML));
  check('B-4 超出上限时有 omitted 提示（若用户手动设了安全阀）',
    /const omitted = all\.length - ids\.length/.test(HTML) && /未抓/.test(HTML));
  check('B-5 fetchDlcList 支持 onBatch 回调（分批落盘的关键）',
    /typeof opts\.onBatch === 'function'/.test(HTML) && /onBatch\(out\.slice\(\), i \+ 1, ids\.length\)/.test(HTML));
  check('B-6 scheduleDlcFetch 增量写盘（onBatch 里 saveData + renderAll）',
    /cur0\.dlcList = partial;[\s\S]{0,300}?saveData\(\)[\s\S]{0,200}?renderAll\(\)/.test(HTML));
  check('B-7 取消任务不会丢已抓到的部分（toast 有说明）',
    /已取消，但已抓到的不丢/.test(HTML));
  check('B-8 不再用旧的 slice(0, CONFIG.MAX_DLC) 裸写法',
    !/\(Array\.isArray\(dlcIds\) \? dlcIds : \[\]\)\.slice\(0, CONFIG\.MAX_DLC\)/.test(HTML_CODE));

  /* ============ C. OCR 行数上限 ============ */
  console.log('\n=== C. OCR 识别行数上限 ===');
  check('C-1 源码不再有 lines.slice(0, 6)', !/lines\.slice\(0,\s*6\)/.test(HTML_CODE));
  check('C-2 有 OCR_MAX_LINES 常量且 >= 20',
    /OCR_MAX_LINES:\s*(\d+)/.test(HTML) && Number(HTML.match(/OCR_MAX_LINES:\s*(\d+)/)[1]) >= 20,
    (HTML.match(/OCR_MAX_LINES:\s*(\d+)/) || [])[1]);
  check('C-3 超出时有提示', /识别到 .* 行，已显示前/.test(HTML));
  check('C-4 使用 CONFIG.OCR_MAX_LINES', /lines\.slice\(0, CONFIG\.OCR_MAX_LINES\)/.test(HTML_CODE));

  /* ============ D. 标签云「显示全部」 ============ */
  console.log('\n=== D. 标签云截断 ===');
  check('D-1 有 showAllTags 状态', /showAllTags:\s*false/.test(HTML));
  check('D-2 有 tcToggleAll 切换按钮', /tcToggleAll/.test(HTML) && /显示全部 /.test(HTML));
  check('D-3 偏好写入 localStorage', /sw_tagcloud_all_v1/.test(HTML));
  check('D-4 TAG_PREVIEW 收敛到 CONFIG',
    /TAG_PREVIEW:\s*(\d+)/.test(HTML) && /sorted\.slice\(0, CONFIG\.TAG_PREVIEW\)/.test(HTML_CODE));
  const tagR = await page.evaluate(() => {
    STATE.games = [];
    // 造 60 个不同标签，每个出现 1 次
    for (let i = 0; i < 60; i++) STATE.games.push({ appid: 90000 + i, name: 'g' + i, price: {}, rating: {}, historicalLow: {},
      details: { userTags: ['tag' + String(i).padStart(2, '0')] } });
    STATE.showAllTags = false;
    renderTagCloud();
    const a = document.querySelectorAll('#tagCloud .tc[data-tag]').length;
    const hasToggle = !!document.querySelector('#tcToggleAll');
    STATE.showAllTags = true;
    renderTagCloud();
    const b = document.querySelectorAll('#tagCloud .tc[data-tag]').length;
    STATE.showAllTags = false; renderTagCloud();
    return { a, b, hasToggle };
  });
  check('D-5 默认只显示 40 个', tagR.a === 40, 'got ' + tagR.a);
  check('D-6 有「显示全部」按钮', tagR.hasToggle === true);
  check('D-7 展开后 60 个全显示', tagR.b === 60, 'got ' + tagR.b);

  /* ============ E. 简介不再丢原文 ============ */
  console.log('\n=== E. 简介 / 描述截断 ===');
  check('E-1 DLC description 不再 clamp 到 160', !/description:\s*clampText\(description,\s*160\)/.test(HTML_CODE));
  check('E-2 DLC description 直接保留全文', /description:\s*description,/.test(HTML));
  check('E-3 DLC 卡片显示时用 clampText(…,300)', /clampText\(d2\.description \|\| '暂无简介', 300\)/.test(HTML));
  check('E-4 主游戏 descriptionOriginal 上限已放宽（>=1000）',
    /clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/.test(HTML) &&
    Number(HTML.match(/clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/)[1]) >= 1000,
    (HTML.match(/clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/) || [])[1]);
  check('E-5 details.tags 兜底字段不再 slice(0, 8)（genres 为空时不会只显示前 8 个类别）',
    !/details\.tags = (merged\.)?details\.genres\.slice\(0, 8\)/.test(HTML_CODE) &&
    !/g\.details\.tags = g\.details\.genres\.slice\(0, 8\)/.test(HTML_CODE));

  /* ============ F. 表格「全部显示」不被悄悄收回 ============ */
  console.log('\n=== F. 表格分页（renderLimit）===');
  check('F-1 有 __showAllPinned 标记', /__showAllPinned/.test(HTML));
  check('F-2 排序里尊重 showAllPinned', /if \(!STATE\.__showAllPinned\) STATE\.renderLimit = 300;/.test(HTML));
  check('F-3 筛选里尊重 showAllPinned', (HTML.match(/if \(!STATE\.__showAllPinned\) STATE\.renderLimit = 300;/g) || []).length >= 2);
  check('F-4 「全部显示」按钮设置 pinned',
    /STATE\.renderLimit = Infinity; STATE\.__showAllPinned = true;/.test(HTML));
  check('F-5 「显示更多」按钮清除 pinned',
    /STATE\.__showAllPinned = false;\s*renderTable\(\)/.test(HTML));
  check('F-6 单次渲染行数用 CONFIG.RENDER_PAGE', /const PAGE = CONFIG\.RENDER_PAGE;/.test(HTML));

  /* ============ G/H/I. CI 侧上限 ============ */
  console.log('\n=== G/H/I. CI（daily-refresh.mjs）上限 ===');
  check('G-1 用户标签解析已彻底去掉数量上限（不再有 length >= N break）',
    !/if \(tags\.length >= \d+\) break;/.test(CI_CODE), '源码里仍有 tags.length >= N break');
  check('G-2 解析循环改为遍历到底（while + TAG_BLOCK_RE.exec）',
    /while \(\(m = TAG_BLOCK_RE\.exec\(html\)\)\)/.test(CI_CODE));
  check('G-3 原有的 >= 20 上限已消失',
    !/if \(tags\.length >= 20\) break;/.test(CI_CODE));
  check('H-1 购买区切片上限 >= 60000',
    /const CAP = (\d+);/.test(CI) && Number(CI.match(/const CAP = (\d+);/)[1]) >= 60000,
    (CI.match(/const CAP = (\d+);/) || [])[1]);
  check('H-2 不再有硬编码 20000 切片', !/Math\.min\(rest\.length, 20000\)/.test(CI_CODE));
  check('I-1 maxTagFetch 默认 0（不限）', /maxTagFetch:\s*Number\(process\.env\.MAX_TAG_FETCH \|\| 0\)/.test(CI));
  check('I-2 maxGames 仍默认 0（不限）', /maxGames:\s*Number\(process\.env\.MAX_GAMES \|\| 0\)/.test(CI));
  /* I-3：配额为 0 时不得被 slice 切成空数组（否则"不限"变成"一款都不抓"） */
  check('I-3 配额切片有 maxTagFetch > 0 前置判断',
    /if \(CFG\.maxTagFetch > 0 && todo\.length > CFG\.maxTagFetch\)/.test(CI));
  /* I-4：上限哨兵 —— 把"页面原始 app_tag 节点数 vs 解析数"打进日志，
     任何新的静默截断都会立刻在 CI 日志里显形。 */
  check('I-4 有 app_tag 原始节点计数（上限哨兵）',
    /stat\.rawTagNodes = \(stat\.rawTagNodes \|\| 0\) \+/.test(CI) && /stat\.maxRawTags = Math\.max/.test(CI));
  check('I-5 哨兵会把"原始多于解析"标为疑似截断',
    /stat\.tagTruncated = \(stat\.tagTruncated \|\| 0\) \+ 1;/.test(CI));
  check('I-6 哨兵结论写进日志（无截断时也明确说明）',
    /\[上限哨兵\] app_tag 原始节点/.test(CI) && /无截断（两者一致）。/.test(CI));

  /* ============ J. 硬编码数字收敛到 CONFIG ============ */
  console.log('\n=== J. CONFIG 常量收敛（可自查 / 可调）===');
  ['MAX_DLC', 'DLC_BATCH', 'DEBUG_LOG_MAX', 'TRANS_CACHE_MAX', 'CAND_MAX_RENDER', 'TAG_PREVIEW', 'RENDER_PAGE', 'OCR_MAX_LINES']
    .forEach(k => check('J-1 CONFIG 含 ' + k, new RegExp('\\b' + k + ':').test(HTML)));
  check('J-2 调试日志上限用 CONFIG.DEBUG_LOG_MAX', /STATE\.debugLog\.length > CONFIG\.DEBUG_LOG_MAX/.test(HTML_CODE));
  check('J-3 翻译缓存上限用 CONFIG.TRANS_CACHE_MAX', /const cap = CONFIG\.TRANS_CACHE_MAX \|\| 3000;/.test(HTML_CODE));
  /* J-4 是本轮血泪教训：把局部魔法数改成 CONFIG 常量时，漏改了引用点 →
     运行时直接 ReferenceError（TAG_PREVIEW is not defined），整个标签云白屏。
     这里静态扫描：除了 CONFIG 定义处和确有的模块级 const，任何裸用这些名字都算错。 */
  const BARE_NAMES = ['MAX_DLC', 'DLC_BATCH', 'DEBUG_LOG_MAX', 'TRANS_CACHE_MAX', 'CAND_MAX_RENDER', 'TAG_PREVIEW', 'RENDER_PAGE', 'OCR_MAX_LINES'];
  const ALLOWED_BARE = new Set(['DLC_BATCH']);   // DLC_BATCH 有模块级 const 别名
  BARE_NAMES.forEach(name => {
    if (ALLOWED_BARE.has(name)) return;
    /* 匹配"裸标识符"：前面不是 . 也不是字母数字下划线（排除 CONFIG.X），
       且后面不是 : 或 :（排除 CONFIG 对象里的键名定义 `MAX_DLC: 0,`）。 */
    const re = new RegExp('(?<![.\\w$])' + name + '\\b(?!\\s*:)', 'g');
    const hits = (HTML_CODE.match(re) || []).length;
    check('J-4 ' + name + ' 全部走 CONFIG.' + name + '（无裸引用）', hits === 0, '裸引用 ' + hits + ' 处');
  });

  /* ============ K. 调试面板 / 翻译缓存不再"少几款" ============ */
  console.log('\n=== K. 调试面板 / 翻译缓存 ===');
  check('K-1 调试面板不再 STATE.games.slice(0, 200)', !/STATE\.games\.slice\(0,\s*200\)/.test(HTML_CODE));
  check('K-2 调试面板全量列出（STATE.games.map）', /const cacheInfo = STATE\.games\.map\(/.test(HTML_CODE));
  check('K-3 调试面板标签写明总数', /全部 ' \+ STATE\.games\.length \+ ' 款/.test(HTML));
  const dbgR = await page.evaluate(() => {
    STATE.games = [];
    for (let i = 0; i < 250; i++) STATE.games.push({ appid: 70000 + i, name: 'd' + i, price: {}, rating: {}, historicalLow: {} });
    renderDebug();
    const entries = document.querySelectorAll('#debugBody .dbg-entry').length;
    const txt = document.querySelector('#debugBody').textContent;
    return { entries, txt };
  });
  check('K-4 250 款时调试面板列出全部 250 条缓存行', dbgR.entries >= 250, 'got ' + dbgR.entries);
  check('K-5 面板文案标注「全部 250 款」', /全部 250 款/.test(dbgR.txt));
  check('K-6 调试日志保留条数 >= 200（旧 80 会丢早期关键记录）',
    /DEBUG_LOG_MAX:\s*(\d+)/.test(HTML) && Number(HTML.match(/DEBUG_LOG_MAX:\s*(\d+)/)[1]) >= 200);

  /* ============ 收尾 ============ */
  check('Z-1 页面无运行时错误', errs.length === 0, errs.join(' | '));

  await browser.close();
  server.close();
  console.log('\n============================');
  console.log('LIMITS PASS ' + pass + '  FAIL ' + fail);
  console.log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
