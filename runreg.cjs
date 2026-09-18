/* 回归运行器（重建版）：串行跑所有套件，绝不并发（puppeteer 会抢端口）
   用法：node runreg.cjs all | node runreg.cjs index v2 cloud ... */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;
const NP = 'C:/Users/asus/.workbuddy/binaries/node/workspace/node_modules';

const SUITES = {
  sha7:      'tools/_test_sha.cjs',
  v2:        'tools/_test_v2.cjs',
  vp:        'tools/_test_vp.cjs',
  index:     'tools/_test_index.cjs',
  chk:       'tools/_chk.cjs',
  prov:      'tools/_test_prov.cjs',
  gate:      'tools/_test_gate.cjs',
  gate_open: 'tools/_test_gate_open.cjs',
  gate_sec:  'tools/_test_gate_sec.cjs',
  cloud:     'tools/_test_cloud.cjs',
  ui:        'tools/_test_ui.cjs',
  smtp:      'tools/_test_smtp_msg.mjs',
  selftest:  'tools/_selftest.mjs',
  copypage:  'tools/_test_copypage.cjs',
  queuepick: 'tools/_test_queuepick.cjs',
  cloud409:  'tools/_test_cloud409.cjs',
  mergef:    'tools/_test_mergefields.cjs',
  starve:    'tools/_test_queuestarve.mjs',
  limits:    'tools/_test_limits.cjs',
  sentinel:  'tools/_test_sentinel.cjs'
};

const args = process.argv.slice(2);
let names = args.includes('all') || !args.length ? Object.keys(SUITES) : args;

let pass = 0, fail = 0, skip = 0;
const results = [];
for (const name of names) {
  const rel = SUITES[name];
  if (!rel) { console.log('跳过未知套件：' + name); skip++; continue; }
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log('跳过不存在的文件：' + rel); skip++; continue; }
  console.log('\n================ ' + name + '  (' + rel + ') ================');
  const t0 = Date.now();
  const r = spawnSync(NODE, [file], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { NODE_PATH: NP }),
    encoding: 'utf-8',
    timeout: 300000
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const out = (r.stdout || '') + (r.stderr || '');
  console.log(out.trim().slice(-4000));
  const ok = r.status === 0 && /FAIL\s+0\b/.test(out.replace(/\s+/g, ' ')) || (r.status === 0 && !/FAIL\s+[1-9]/.test(out));
  // 更稳的判定：抓 "FAIL n" 计数
  const m = out.match(/FAIL\s+(\d+)/);
  const failN = m ? Number(m[1]) : (r.status === 0 ? 0 : 1);
  if (failN === 0 && r.status === 0) { pass++; results.push([name, 'PASS', dt]); }
  else { fail++; results.push([name, 'FAIL(status=' + r.status + ',fail=' + failN + ')', dt]); }
  console.log('---- ' + name + ' 用时 ' + dt + 's ----');
}

console.log('\n============ 汇总 ============');
results.forEach(([n, s, t]) => console.log('  ' + (s === 'PASS' ? 'PASS ' : 'FAIL ') + n.padEnd(12) + ' ' + t + 's  ' + (s === 'PASS' ? '' : s)));
console.log('\n套件：PASS ' + pass + ' / FAIL ' + fail + (skip ? ' / 跳过 ' + skip : ''));
process.exit(fail ? 1 : 0);
