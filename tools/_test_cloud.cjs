/* 云端同步设置 UI 验证（用户反馈：403 之后「设置里没有能改的地方」）
   · 设置面板里必须有 Token 输入框和仓库配置
   · 必须能保存 / 清除 Token
   · 没 Token 时点「同步到云端」应引导去设置，而不是只弹一个无法挽回的 prompt
   · 403 错误必须给出可操作的排查提示（而不是一句"Resource not accessible"） */
const http = require('http'), fs = require('fs'), path = require('path');
const puppeteer = require('puppeteer-core');
const ROOT = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.resolve(__dirname, '..');
const PORT = 8785;
const server = http.createServer((rq, rs) => {
  let p = rq.url.split('?')[0]; if (p === '/') p = '/index.html';
  fs.readFile(path.join(ROOT, p), 'utf8', (e, t) => {
    if (e) { rs.writeHead(404); rs.end(); return; }
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(t);
  });
});
const log = (...a) => console.log(...a);
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; log('  PASS  ' + n); } else { fail++; log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const br = await puppeteer.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 950 }
  });
  const url = 'http://127.0.0.1:' + PORT + '/index.html';
  const pg = await br.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  // 注意：本测试会用假 Token 真的打一次 GitHub API，必然返回 401 并在控制台留下
  // "Failed to load resource ... 401" —— 这是被测功能正常工作的证据，不是 JS 错误。
  pg.on('console', m => {
    const txt = m.text();
    if (m.type() !== 'error') return;
    if (/favicon|404/.test(txt)) return;
    if (/Failed to load resource/.test(txt)) return;   // 预期内的 API 拒绝
    errs.push(txt);
  });
  pg.on('dialog', async d => { await d.dismiss(); });
  // 走站主豁免，绕开密钥门
  await pg.evaluateOnNewDocument(() => { localStorage.setItem('sw_gate_owner_v1', '1'); });
  await pg.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(800);

  log('\n=== 1. 设置面板里必须能找到「云端同步」入口 ===');
  await pg.evaluate(() => openSettings());
  await sleep(500);
  let s = await pg.evaluate(() => {
    const q = id => document.getElementById(id);
    const modal = q('modalSettings');
    return {
      modalOpen: !!(modal && modal.classList.contains('show')),
      tokenInput: !!q('setGhToken'),
      tokenIsPwd: q('setGhToken') && q('setGhToken').type === 'password',
      owner: !!q('setGhOwner'),
      repo: !!q('setGhRepo'),
      branch: !!q('setGhBranch'),
      filePath: !!q('setGhPath'),
      hint: q('cloudStateHint') ? q('cloudStateHint').textContent : '',
      testBtn: !!q('btnCloudTest'),
      saveBtn: !!q('btnCloudSave'),
      clearBtn: !!q('btnCloudClear'),
      testMsg: !!q('cloudTestMsg')
    };
  });
  check('设置面板能打开', s.modalOpen);
  check('★ 有 Token 输入框', s.tokenInput);
  check('Token 默认隐藏为密码框', s.tokenIsPwd);
  check('有仓库所有者输入框', s.owner);
  check('有仓库名输入框', s.repo);
  check('有分支输入框', s.branch);
  check('有文件路径输入框', s.filePath);
  check('有「测试连接」按钮', s.testBtn);
  check('有「保存并同步」按钮', s.saveBtn);
  check('有「清除 Token」按钮', s.clearBtn);
  check('有测试结果提示区', s.testMsg);
  check('未配置时提示"未配置"', /未配置/.test(s.hint), s.hint);

  log('\n=== 2. 保存 Token 后状态提示应更新 ===');
  await pg.evaluate(() => {
    document.getElementById('setGhToken').value = 'github_pat_TESTTOKEN1234567890abcdef';
    document.getElementById('setGhOwner').value = 'TicianLi';
    document.getElementById('setGhRepo').value = 'wish-list';
    document.getElementById('setGhBranch').value = 'main';
    document.getElementById('setGhPath').value = 'data/wishlist.json';
    document.getElementById('btnCloudSave').click();
  });
  await sleep(900);
  s = await pg.evaluate(() => ({
    cfg: JSON.parse(localStorage.getItem('sw_cloud_cfg_v1') || '{}'),
    hint: document.getElementById('cloudStateHint').textContent
  }));
  check('Token 已存进本机 localStorage', /TESTTOKEN/.test(s.cfg.token || ''), JSON.stringify(s.cfg).slice(0, 80));
  check('仓库信息已保存', s.cfg.owner === 'TicianLi' && s.cfg.repo === 'wish-list');
  check('状态提示显示"已配置"', /已配置/.test(s.hint), s.hint);
  check('状态提示里 Token 是打码的', /…/.test(s.hint) && !/TESTTOKEN1234567890/.test(s.hint), s.hint);

  log('\n=== 3. 重新打开设置应回填已保存的值 ===');
  await pg.evaluate(() => { closeModal('modalSettings'); });
  await sleep(200);
  await pg.evaluate(() => openSettings());
  await sleep(400);
  s = await pg.evaluate(() => ({
    token: document.getElementById('setGhToken').value,
    owner: document.getElementById('setGhOwner').value,
    branch: document.getElementById('setGhBranch').value
  }));
  check('Token 回填正确', /TESTTOKEN/.test(s.token));
  check('仓库所有者回填正确', s.owner === 'TicianLi');
  check('分支回填正确', s.branch === 'main');

  log('\n=== 4. 清除 Token ===');
  await pg.evaluate(() => { document.getElementById('btnCloudClear').click(); });
  await sleep(300);
  await pg.evaluate(() => { const b = document.getElementById('btnConfirmOk'); if (b) b.click(); });
  await sleep(500);
  s = await pg.evaluate(() => ({
    cfg: JSON.parse(localStorage.getItem('sw_cloud_cfg_v1') || '{}'),
    tokenField: document.getElementById('setGhToken').value,
    hint: document.getElementById('cloudStateHint').textContent
  }));
  check('Token 已从本机清除', !s.cfg.token, 'token=' + s.cfg.token);
  check('输入框已清空', s.tokenField === '');
  check('状态提示回到"未配置"', /未配置/.test(s.hint), s.hint);
  await pg.evaluate(() => { closeModal('modalSettings'); });
  await sleep(200);

  log('\n=== 5. 没 Token 时点「同步到云端」→ 应引导去设置 ===');
  await pg.evaluate(() => { const b = document.getElementById('btnCloudSync'); if (b) b.click(); });
  await sleep(600);
  s = await pg.evaluate(() => ({
    modalOpen: document.getElementById('modalSettings').classList.contains('show'),
    toastText: Array.from(document.querySelectorAll('#toasts .toast')).map(t => t.textContent).join(' | ')
  }));
  check('★ 自动打开设置面板（而不是无解的死路）', s.modalOpen);
  check('提示要先去设置填 Token', /Token/.test(s.toastText) && /设置/.test(s.toastText), s.toastText);

  log('\n=== 6. 403 错误的提示必须可操作 ===');
  s = await pg.evaluate(() => {
    const cfg = { owner: 'TicianLi', repo: 'wish-list', branch: 'main', path: 'data/wishlist.json' };
    return {
      e403: describeGhError(403, { message: 'Resource not accessible by personal access token' }, cfg),
      e401: describeGhError(401, {}, cfg),
      e404: describeGhError(404, {}, cfg),
      e422: describeGhError(422, { message: 'Branch not found' }, cfg)
    };
  });
  check('403 提到 Contents 权限', /Contents/.test(s.e403), s.e403.slice(0, 60));
  check('403 提到仓库范围', /TicianLi\/wish-list/.test(s.e403));
  check('403 提到"不是只读"', /Read and write/.test(s.e403));
  check('403 提到组织批准（如适用）', /组织/.test(s.e403));
  check('401 提示重新生成 Token', /重新生成/.test(s.e401), s.e401.slice(0, 50));
  check('404 提示检查仓库名/授权', /仓库名/.test(s.e404), s.e404.slice(0, 50));
  check('422 提示检查分支名', /分支名/.test(s.e422), s.e422.slice(0, 50));

  log('\n=== 7. 配置缺字段时回落默认值（防止同步到错地方）===');
  s = await pg.evaluate(() => {
    localStorage.setItem('sw_cloud_cfg_v1', JSON.stringify({ token: 'x' }));   // 故意缺 owner/repo
    const c = loadCloudCfg();
    return { owner: c.owner, repo: c.repo, branch: c.branch, path: c.path };
  });
  check('缺 owner → 回落 TicianLi', s.owner === 'TicianLi', s.owner);
  check('缺 repo → 回落 wish-list', s.repo === 'wish-list', s.repo);
  check('缺 branch → 回落 main', s.branch === 'main', s.branch);
  check('缺 path → 回落 data/wishlist.json', s.path === 'data/wishlist.json', s.path);

  log('\n=== 8. 控制台错误 ===');
  check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' || '));

  await br.close();
  server.close();
  log('\n============================');
  log('CLOUD PASS ' + pass + '  FAIL ' + fail);
  log('============================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
