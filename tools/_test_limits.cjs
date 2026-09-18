/* 「款数 / 数量限制」专项回归（2026-09-19）
   用户指令：「你再看看其他功能有没有这种款数限制，全都给我改了」

   背景：之前发现 CI 的商店页抓取配额（MAX_TAG_FETCH）小于清单规模，
   导致排在配额之外的游戏永远轮不到。用户要求把【所有】功能里的同类
   「静默截断」都找出来修掉 —— 判据是：宁可给提示，也不要无声丢数据。

   本测试锁死以下修复点（前端 + CI）：
     A. 候选弹窗不再只渲染 20 个（搜索候选被静默丢弃）
     B. 单游戏 DLC 抓取上限从 15 提到 60，且超出时有提示
     C. OCR 行数从 6 提到 30，且超出时有提示
     D. 标签云支持「显示全部」（默认 40 可展开）
     E. 简介不再钳到 160 字后就把原文丢掉
     F. 表格「全部显示」不会被排序/筛选悄悄收回
     G. CI：用户标签解析上限从 20 提到 60
     H. CI：购买区切片从 20000 提到 60000
     I. CI：maxTagFetch 默认改为 0（不限），杜绝配额饥饿
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
  check('A-2 有 CAND_MAX_RENDER 常量且 >= 100', /CAND_MAX_RENDER\s*=\s*(\d+)/.test(HTML) && Number(HTML.match(/CAND_MAX_RENDER\s*=\s*(\d+)/)[1]) >= 100);
  check('A-3 两个渲染循环都用 shownItems', (HTML.match(/shownItems/g) || []).length >= 3);
  check('A-4 被截断时会给出提示文案', /共搜索到 .* 个候选，已显示前/.test(HTML));

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
  check('A-5 45 个候选 → DOM 里真实渲染 45 个（旧版只有 20）', cand.count === 45, 'got ' + cand.count);

  /* ============ B. DLC 上限 ============ */
  console.log('\n=== B. 单游戏 DLC 数量上限 ===');
  const mDlc = HTML.match(/MAX_DLC:\s*(\d+)/);
  check('B-1 MAX_DLC 已提到 >= 60', mDlc && Number(mDlc[1]) >= 60, mDlc ? mDlc[1] : 'missing');
  check('B-2 超出上限时有 omitted 提示', /const omitted = all\.length - ids\.length/.test(HTML) && /未抓/.test(HTML));
  check('B-3 不再用旧的 slice(0, CONFIG.MAX_DLC) 裸写法', !/\(Array\.isArray\(dlcIds\) \? dlcIds : \[\]\)\.slice\(0, CONFIG\.MAX_DLC\)/.test(HTML_CODE));

  /* ============ C. OCR 行数上限 ============ */
  console.log('\n=== C. OCR 识别行数上限 ===');
  check('C-1 源码不再有 lines.slice(0, 6)', !/lines\.slice\(0,\s*6\)/.test(HTML_CODE));
  check('C-2 有 OCR_MAX_LINES 且 >= 20', /OCR_MAX_LINES\s*=\s*(\d+)/.test(HTML) && Number(HTML.match(/OCR_MAX_LINES\s*=\s*(\d+)/)[1]) >= 20);
  check('C-3 超出时有提示', /识别到 .* 行，已显示前/.test(HTML));

  /* ============ D. 标签云「显示全部」 ============ */
  console.log('\n=== D. 标签云截断 ===');
  check('D-1 有 showAllTags 状态', /showAllTags:\s*false/.test(HTML));
  check('D-2 有 tcToggleAll 切换按钮', /tcToggleAll/.test(HTML) && /显示全部 /.test(HTML));
  check('D-3 偏好写入 localStorage', /sw_tagcloud_all_v1/.test(HTML));
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
  check('D-4 默认只显示 40 个', tagR.a === 40, 'got ' + tagR.a);
  check('D-5 有「显示全部」按钮', tagR.hasToggle === true);
  check('D-6 展开后 60 个全显示', tagR.b === 60, 'got ' + tagR.b);

  /* ============ E. 简介不再丢原文 ============ */
  console.log('\n=== E. 简介 / 描述截断 ===');
  check('E-1 DLC description 不再 clamp 到 160', !/description:\s*clampText\(description,\s*160\)/.test(HTML_CODE));
  check('E-2 DLC description 直接保留全文', /description:\s*description,/.test(HTML));
  check('E-3 DLC 卡片显示时用 clampText(…,300)', /clampText\(d2\.description \|\| '暂无简介', 300\)/.test(HTML));
  check('E-4 主游戏 descriptionOriginal 上限已放宽（>=1000）',
    /clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/.test(HTML) &&
    Number(HTML.match(/clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/)[1]) >= 1000,
    (HTML.match(/clampText\(stripHtml\(data\.about_the_game \|\| ''\),\s*(\d+)\)/) || [])[1]);

  /* ============ F. 表格「全部显示」不被悄悄收回 ============ */
  console.log('\n=== F. 表格分页（renderLimit）===');
  check('F-1 有 __showAllPinned 标记', /__showAllPinned/.test(HTML));
  check('F-2 排序里尊重 showAllPinned', /if \(!STATE\.__showAllPinned\) STATE\.renderLimit = 300;/.test(HTML));
  check('F-3 筛选里尊重 showAllPinned', (HTML.match(/if \(!STATE\.__showAllPinned\) STATE\.renderLimit = 300;/g) || []).length >= 2);
  check('F-4 「全部显示」按钮设置 pinned',
    /STATE\.renderLimit = Infinity; STATE\.__showAllPinned = true;/.test(HTML));
  check('F-5 「显示更多」按钮清除 pinned',
    /STATE\.__showAllPinned = false;\s*renderTable\(\)/.test(HTML));

  /* ============ G/H/I. CI 侧上限 ============ */
  console.log('\n=== G/H/I. CI（daily-refresh.mjs）上限 ===');
  check('G-1 用户标签解析上限 >= 60',
    /if \(tags\.length >= (\d+)\) break;/.test(CI) && Number(CI.match(/if \(tags\.length >= (\d+)\) break;/)[1]) >= 60,
    (CI.match(/if \(tags\.length >= (\d+)\) break;/) || [])[1]);
  check('H-1 购买区切片上限 >= 60000',
    /const CAP = (\d+);/.test(CI) && Number(CI.match(/const CAP = (\d+);/)[1]) >= 60000,
    (CI.match(/const CAP = (\d+);/) || [])[1]);
  check('H-2 不再有硬编码 20000 切片', !/Math\.min\(rest\.length, 20000\)/.test(CI_CODE));
  check('I-1 maxTagFetch 默认 0（不限）', /maxTagFetch:\s*Number\(process\.env\.MAX_TAG_FETCH \|\| 0\)/.test(CI));
  check('I-2 maxGames 仍默认 0（不限）', /maxGames:\s*Number\(process\.env\.MAX_GAMES \|\| 0\)/.test(CI));

  /* ============ 收尾 ============ */
  check('Z-1 页面无运行时错误', errs.length === 0, errs.join(' | '));

  await browser.close();
  server.close();
  console.log('\n============================');
  console.log('LIMITS PASS ' + pass + '  FAIL ' + fail);
  console.log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
