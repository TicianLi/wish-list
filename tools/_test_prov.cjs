// 验证数据来源追溯与异常检测逻辑
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  PASS  ' + name); } else { fail++; console.log('  FAIL  ' + name); } };

console.log('=== 1. 源码里必须存在这三个新函数 ===');
t('有 gamesFingerprint', html.includes('function gamesFingerprint'));
t('有 withProvenance', html.includes('function withProvenance'));
t('有 detectSuspiciousData', html.includes('function detectSuspiciousData'));

console.log('');
console.log('=== 2. cloudSync 必须给 payload 打来源标记 ===');
t('cloudSync 用了 withProvenance', /(?:const|let|var)?\s*payload\s*=\s*withProvenance\(/.test(html));
t('payload 含 source 字段', html.includes("source: 'manual-sync'"));
t('payload 含 fingerprint 字段', /fingerprint: gamesFingerprint\(games\)/.test(html));
t('payload 含 gameCount 字段', /gameCount: games\.length/.test(html));

console.log('');
console.log('=== 3. 同步成功提示必须回显上传内容 ===');
t('提示里带款数', /本次上传 ' \+ STATE\.games\.length/.test(html));
t('提示里带时间', /payload\.syncedAt/.test(html));
t('提示里带指纹', /payload\.fingerprint/.test(html));

console.log('');
console.log('=== 4. 启动时必须做数据自检 ===');
t('init 里调用了 detectSuspiciousData', /const issues = detectSuspiciousData\(STATE\.games\)/.test(html));
t('有可疑数据时给出警告', /检测到清单里有可疑数据/.test(html));

console.log('');
console.log('=== 5. 把函数抽出来跑单元测试 ===');

// 从 index.html 里抠出这几个函数，在沙箱里执行
const grab = (name) => {
  const start = html.indexOf('function ' + name);
  if (start < 0) return '';
  let depth = 0, i = html.indexOf('{', start);
  const from = i;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
};

const nowMs = () => Date.now();
const location = { origin: 'https://ticianli.github.io' };
const src = [
  grab('gamesFingerprint'),
  grab('withProvenance'),
  grab('detectSuspiciousData')
].join('\n');

const sandbox = new Function('nowMs', 'location', src + '\nreturn { gamesFingerprint, withProvenance, detectSuspiciousData };')(nowMs, location);
const { gamesFingerprint, withProvenance, detectSuspiciousData } = sandbox;

// 5a. 指纹：同内容稳定，异内容不同
const g1 = [{ appid: 100, name: 'A', price: { current: 50 } }];
const g2 = [{ appid: 100, name: 'A', price: { current: 50 } }];
const g3 = [{ appid: 100, name: 'A', price: { current: 60 } }];
t('指纹对相同内容稳定', gamesFingerprint(g1) === gamesFingerprint(g2));
t('指纹对价格变化会改变', gamesFingerprint(g1) !== gamesFingerprint(g3));
t('指纹是 16 位十六进制', /^[0-9a-f]{16}$/.test(gamesFingerprint(g1)));
t('空清单也有指纹', /^[0-9a-f]{16}$/.test(gamesFingerprint([])));

// 5b. withProvenance
const p = withProvenance({ version: 3, updatedAt: 111, games: g1 });
t('withProvenance 保留 version', p.version === 3);
t('withProvenance 保留 updatedAt', p.updatedAt === 111);
t('withProvenance 标记 source=manual-sync', p.source === 'manual-sync');
t('withProvenance 填了 gameCount', p.gameCount === 1);
t('withProvenance 填了 syncedAt', typeof p.syncedAt === 'number' && p.syncedAt > 0);
t('withProvenance 填了 syncedFrom', p.syncedFrom === 'https://ticianli.github.io');

// 5c. detectSuspiciousData —— 正常数据不该报警
const normal = [
  { appid: 1245620, name: '艾尔登法环', createdAt: 1789300000000 },
  { appid: 292030, name: '巫师3', createdAt: 1789300100000 },
  { appid: 413150, name: '星露谷物语', createdAt: 1789300200000 }
];
t('正常数据不报警', detectSuspiciousData(normal).length === 0);

// 5d. 测试数据必须被抓出来（这就是真实发生过的那份）
const fake = [
  { appid: 1245620, name: '艾尔登法环', createdAt: 1789304814871 },
  { appid: 292030, name: '巫师3', createdAt: 1789304814871 },
  { appid: 9999999, name: '不存在的游戏', createdAt: 1789304814871 }
];
const iss = detectSuspiciousData(fake);
t('抓到 createdAt 全相同', iss.some(s => /创建时间完全相同/.test(s)));
t('抓到无效 AppID', iss.some(s => /AppID 是无效值/.test(s)));
t('抓到测试名字', iss.some(s => /名字像测试数据/.test(s)));

// 5e. 单独特征也要能抓
t('只有无效 AppID 时也能抓', detectSuspiciousData([
  { appid: 99999999, name: 'X', createdAt: 1 }
]).some(s => /AppID 是无效值/.test(s)));
t('空清单不报警', detectSuspiciousData([]).length === 0);
t('null 不崩', detectSuspiciousData(null).length === 0);

console.log('');
console.log('============================');
console.log('PROV PASS ' + pass + '  FAIL ' + fail);
console.log('============================');

fs.writeFileSync(path.join(ROOT, '_provres.txt'),
  'PROV PASS ' + pass + ' FAIL ' + fail, 'utf8');
