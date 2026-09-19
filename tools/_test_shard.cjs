/* 分片并行 / 合并 专项回归（2026-09-19）

  背景（用户要求）：
    「我不仅是要这 19 个新游戏的数据，我还要确保以后不会再出现任何这种问题，
      哪怕是我加了一千款一万款这种游戏」

  为了做到这一点，除了修 429（见 _test_retry.cjs），还必须解决**第二道墙**：
    实测 219 款耗时 11.2 分钟（平均 3.07 秒/款）。
    线性外推 1000 款 ≈ 51 分钟 → **超过 GitHub Actions 45 分钟上限被强杀**。
    只修 429 不够，规模本身就会把任务打死。

  方案：CI 拆成「plan（算分片数）→ refresh（matrix 并行刷各片）→ finalize（合并+补全局+发信）」。

  本测试锁死的判据：
    S. 切片是**并行化**，不是**砍数量**：
       · 所有款必须被恰好一片覆盖（并集 = 全量）
       · 任何两款不能出现在同一片以上（无重叠）
       · 各片长度最多差 1（均衡）
       · 任意 N、任意片数都成立（穷举验证）
    T. 分片数随规模自动伸缩：小清单不分片（保持原行为），大清单自动扩
    U. 合并是无损的：分片覆盖基底、基底独有的款原样保留、款数不会变少
    V. 合并会**自检**：分片数不符 / 跨片重复 / 款数变少 → 一律报错退出（绝不静默）
    W. workflow 结构正确：plan/matrix/finalize 三段齐全，且分片数真的来自 plan
    X. 汇总阶段不重复刷价格（避免白费一半配额），且变化比对改走快照

  跑法： node tools/_test_shard.cjs
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CI = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');
const WF = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'daily-refresh.yml'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  -> ' + x : '')); } }

/* ---- 从源码抠纯函数 ---- */
function extractFn(src, name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'g');
  const m = src.match(re);
  return m ? m[0] : null;
}
console.log('=== S. 源码结构 ===');
const fnShard = extractFn(CI, 'shardSlice');
const fnAuto = extractFn(CI, 'autoShardCount');
check('S-1 抠出 shardSlice', !!fnShard);
check('S-2 抠出 autoShardCount', !!fnAuto);

const sb = vm.createContext({ console, Math, Number, Array, JSON });
vm.runInContext(fnShard + '\n' + fnAuto + '\n__export({ shardSlice, autoShardCount });',
  Object.assign(sb, { __export: o => { sb.M = o; } }), { filename: 'shard.js' });
const { shardSlice, autoShardCount } = sb.M;

/* ==================================================================
 * T. 切片正确性（穷举：各种 N × 各种片数）
 * ================================================================== */
console.log('=== T. 切片：全覆盖 / 无重叠 / 均衡 ===');
let allOk = true, overlapBad = 0, gapBad = 0, balanceBad = 0;
const cases = [
  [0, 1], [1, 1], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [10, 3],
  [219, 1], [219, 2], [219, 3], [219, 12], [400, 1], [401, 2], [1000, 3],
  [1000, 12], [9999, 12], [10000, 12], [10000, 25], [7, 7], [7, 10]
];
for (const [n, t] of cases) {
  const arr = Array.from({ length: n }, (_, i) => i);
  const parts = [];
  for (let i = 0; i < t; i++) parts.push(shardSlice(arr, i, t));
  const flat = parts.flat();
  const uniq = new Set(flat);
  /* 并集 = 全量（无遗漏） */
  if (flat.length !== n || uniq.size !== n) { gapBad++; allOk = false; continue; }
  /* 无重叠：每个元素出现且仅出现一次 */
  if (flat.length !== uniq.size) { overlapBad++; allOk = false; continue; }
  /* 均衡：长度最多差 1 */
  const lens = parts.map(p => p.length);
  if (Math.max(...lens) - Math.min(...lens) > 1) { balanceBad++; allOk = false; }
}
check('T-1 全部 ' + cases.length + ' 组（N×片数）都满足「并集=全量」（无款被漏掉）', gapBad === 0, '失败 ' + gapBad + ' 组');
check('T-2 全部组合满足「无重叠」（没有款被两片同时刷新）', overlapBad === 0, '失败 ' + overlapBad + ' 组');
check('T-3 全部组合满足「均衡」（各片长度差 ≤ 1）', balanceBad === 0, '失败 ' + balanceBad + ' 组');
check('T-4 10 款分 3 片 → 4/3/3（余数正确分摊）',
  JSON.stringify([0, 1, 2].map(i => shardSlice([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], i, 3).length)) === '[4,3,3]',
  JSON.stringify([0, 1, 2].map(i => shardSlice([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], i, 3).length)));
check('T-5 片数=1 时原样返回（不分片的路径）',
  shardSlice([1, 2, 3], 0, 1).length === 3);
check('T-6 片数 > 元素数时，空片返回空数组（不报错、不重复）',
  shardSlice([1, 2], 5, 10).length === 0);
check('T-7 越界 index 被夹住（不会 undefined）', Array.isArray(shardSlice([1, 2, 3], 99, 3)));
check('T-8 越界 total 被夹住（total=0 视为 1）', shardSlice([1, 2, 3], 0, 0).length === 3);
check('T-9 空数组不崩', shardSlice([], 0, 3).length === 0);

/* ==================================================================
 * U. 分片数自动伸缩
 * ================================================================== */
console.log('=== U. 分片数自动伸缩 ===');
const PER = 400, MAXS = 256;      // 与 workflow 默认值一致
check('U-1 219 款（当前规模）→ 1 片（行为与改造前一致）', autoShardCount(219, PER, MAXS) === 1, 'got ' + autoShardCount(219, PER, MAXS));
check('U-2 400 款 → 1 片', autoShardCount(400, PER, MAXS) === 1);
check('U-3 401 款 → 2 片', autoShardCount(401, PER, MAXS) === 2);
check('U-4 1000 款 → 3 片（1000/400=2.5→3）', autoShardCount(1000, PER, MAXS) === 3);
check('U-5 10000 款 → 25 片（每片 400，规模线性可控）', autoShardCount(10000, PER, MAXS) === 25, 'got ' + autoShardCount(10000, PER, MAXS));
check('U-6 0 款 → 仍返回 1（不会 0 片导致不跑）', autoShardCount(0, PER, MAXS) === 1);
/* 核心设计目标：**每片规模恒定**（≈PER_SHARD），所以单 job 时长与总规模解耦。
   只要每片 < 45 分钟，无论清单多大都能跑完（分片排队即可）。 */
for (const n of [219, 500, 1000, 5000, 10000, 50000, 200000]) {
  const s = autoShardCount(n, PER, MAXS);
  const per = Math.ceil(n / s);
  const mins = per * 3.07 / 60;
  check('U-7 ' + n + ' 款 → ' + s + ' 片，每片约 ' + per + ' 款 ≈ ' + mins.toFixed(1) + ' 分钟（必须 < 45）',
    mins < 45, mins.toFixed(1) + ' 分钟');
}
/* 只有超过「PER_SHARD × MAX_SHARDS」这个物理上限，每片才会变大 */
const PHYS_LIMIT = PER * MAXS;
check('U-8 物理上限 = ' + PHYS_LIMIT + ' 款（400×256）；该规模内单 job 时长恒定',
  autoShardCount(PHYS_LIMIT - 1, PER, MAXS) <= MAXS);
check('U-9 workflow 的 MAX_SHARDS 默认值 == 本测试假设的 ' + MAXS,
  new RegExp('MAX_SHARDS:-' + MAXS).test(WF), 'workflow 里没找到 MAX_SHARDS:-' + MAXS);
check('U-10 workflow 限制了同时运行的分数（max-parallel，避免拉爆并发）',
  /max-parallel:\s*\d+/.test(WF));

/* ==================================================================
 * V. 合并无损性（真跑 merge-shards.mjs）
 * ================================================================== */
console.log('=== V. 合并：无损 + 自检 ===');
const TMP = path.join(ROOT, 'data', '.shard_test_' + process.pid);
const SDIR = path.join(ROOT, 'data', '.shard');
const DATA = path.join(ROOT, 'data', 'wishlist.json');
const BACKUP = path.join(ROOT, 'data', '.wishlist.test-backup.json');
let hadData = false;
let originalData = null;

function setupWorld(baseGames, shardGamesList) {
  /* 保存真实数据 */
  if (fs.existsSync(DATA) && !hadData) { originalData = fs.readFileSync(DATA); hadData = true; }
  /* 写基底 */
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify({ version: 3, games: baseGames }, null, 2), 'utf8');
  /* 写分片 */
  if (fs.existsSync(SDIR)) fs.rmSync(SDIR, { recursive: true, force: true });
  fs.mkdirSync(SDIR, { recursive: true });
  shardGamesList.forEach((gs, i) => {
    fs.writeFileSync(path.join(SDIR, i + '.json'),
      JSON.stringify({ shardIndex: i, shardTotal: shardGamesList.length, games: gs }, null, 2), 'utf8');
  });
}
function runMerge(shardTotal) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'merge-shards.mjs')], {
    encoding: 'utf8', cwd: ROOT,
    env: Object.assign({}, process.env, shardTotal != null ? { SHARD_TOTAL: String(shardTotal) } : {})
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function readData() { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }

try {
  /* V-1 正常合并：3 片覆盖 6 款 */
  const base = [1, 2, 3, 4, 5, 6].map(id => ({ appid: id, name: 'g' + id, price: { current: 10 } }));
  setupWorld(base, [
    [{ appid: 1, name: 'g1', price: { current: 1 } }, { appid: 2, name: 'g2', price: { current: 2 } }],
    [{ appid: 3, name: 'g3', price: { current: 3 } }, { appid: 4, name: 'g4', price: { current: 4 } }],
    [{ appid: 5, name: 'g5', price: { current: 5 } }, { appid: 6, name: 'g6', price: { current: 6 } }]
  ]);
  let r = runMerge(3);
  let d = readData();
  check('V-1 合并成功退出（exit 0）', r.code === 0, 'code=' + r.code + ' ' + r.out.slice(0, 200));
  check('V-2 款数不变（6 → 6）', d.games.length === 6, 'got ' + d.games.length);
  check('V-3 每款都用分片的新价格覆盖了基底', d.games.every(g => g.price.current === g.appid),
    JSON.stringify(d.games.map(g => [g.appid, g.price.current])));

  /* V-4 基底独有款必须原样保留（分片没覆盖到的不能丢） */
  const base2 = [{ appid: 1, name: 'g1', price: { current: 10 } }, { appid: 99, name: 'keepMe', price: { current: 77 } }];
  setupWorld(base2, [[{ appid: 1, name: 'g1', price: { current: 1 } }]]);
  r = runMerge(1);
  d = readData();
  check('V-4 基底独有款（99）被原样保留，未被合并丢掉',
    r.code === 0 && d.games.length === 2 && d.games.some(g => g.appid === 99 && g.price.current === 77),
    'len=' + d.games.length + ' ' + JSON.stringify(d.games));

  /* V-5 分片里有基底没有的新款 → 应被补入（不能丢） */
  setupWorld([{ appid: 1, name: 'g1' }], [[{ appid: 1, name: 'g1' }, { appid: 555, name: 'brandNew' }]]);
  r = runMerge(1);
  d = readData();
  check('V-5 分片里的新款（555）被补入清单', r.code === 0 && d.games.length === 2 && d.games.some(g => g.appid === 555),
    'len=' + d.games.length);

  /* V-6 分片数不符 → 必须报错退出（不能静默少合并） */
  setupWorld([{ appid: 1 }, { appid: 2 }], [[{ appid: 1 }]]);
  r = runMerge(3);
  check('V-6 分片数不符（期望 3 实际 1）→ 报错退出，绝不静默',
    r.code !== 0 && /分片数不符/.test(r.out), 'code=' + r.code + ' ' + r.out.slice(0, 160));

  /* V-7 跨分片重复 → 必须报错退出（切片逻辑出错要立刻暴露） */
  setupWorld([{ appid: 1 }, { appid: 2 }], [[{ appid: 1 }], [{ appid: 1 }]]);
  r = runMerge(2);
  check('V-7 同一 appid 出现在两个分片 → 报错退出',
    r.code !== 0 && /重复刷新/.test(r.out), 'code=' + r.code + ' ' + r.out.slice(0, 160));

  /* V-8 合并后清掉了分片目录（避免下次误合并旧数据） */
  setupWorld([{ appid: 1 }], [[{ appid: 1 }]]);
  r = runMerge(1);
  check('V-8 合并后分片目录被清理', r.code === 0 && !fs.existsSync(SDIR),
    'exists=' + fs.existsSync(SDIR));

  /* V-9 没有分片目录时 → 安静退出（单 job 模式不受影响） */
  if (fs.existsSync(SDIR)) fs.rmSync(SDIR, { recursive: true, force: true });
  fs.writeFileSync(DATA, JSON.stringify({ version: 3, games: [{ appid: 1 }] }, null, 2), 'utf8');
  r = runMerge(null);
  check('V-9 无分片目录时安静退出（单 job 模式零影响）', r.code === 0 && /无需合并/.test(r.out),
    'code=' + r.code + ' ' + r.out.slice(0, 160));

  /* V-10 顺序保持：合并后仍按原清单顺序 */
  setupWorld([{ appid: 3 }, { appid: 1 }, { appid: 2 }], [[{ appid: 2 }], [{ appid: 1 }], [{ appid: 3 }]]);
  r = runMerge(3);
  d = readData();
  check('V-10 合并后保持原清单顺序（3,1,2）',
    r.code === 0 && JSON.stringify(d.games.map(g => g.appid)) === '[3,1,2]',
    JSON.stringify(d.games.map(g => g.appid)));
} finally {
  /* 还原真实数据 */
  try { if (hadData && originalData) fs.writeFileSync(DATA, originalData); } catch (e) { }
  try { if (fs.existsSync(SDIR)) fs.rmSync(SDIR, { recursive: true, force: true }); } catch (e) { }
  try { if (fs.existsSync(TMP)) fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { }
  try { if (fs.existsSync(BACKUP)) fs.unlinkSync(BACKUP); } catch (e) { }
}

/* ==================================================================
 * W. workflow 结构
 * ================================================================== */
console.log('=== W. workflow 分片结构 ===');
check('W-1 有 plan job（算分片数）', /\n  plan:/.test(WF));
check('W-2 有 refresh job 且用 matrix', /\n  refresh:/.test(WF) && /matrix:/.test(WF));
check('W-3 有 finalize job（合并+发信）', /\n  finalize:/.test(WF));
check('W-4 matrix 的分片数组来自 plan 的输出（不是写死的）',
  /shard:\s*\$\{\{\s*fromJSON\(needs\.plan\.outputs\.shard_list\)\s*\}\}/.test(WF));
check('W-5 plan 输出了 shard_list（JSON 数组）', /shard_list=\$LIST/.test(WF) && /echo "shard_list=/.test(WF));
check('W-6 分片数按每片上限自动算（PER_SHARD / MAX_SHARDS 可调）',
  /PER_SHARD/.test(WF) && /MAX_SHARDS/.test(WF));
check('W-7 某一片失败不拖垮其它片（fail-fast: false）', /fail-fast:\s*false/.test(WF));
check('W-8 分片 job 把结果作为 artifact 上传', /name:\s*shard-\$\{\{\s*matrix\.shard\s*\}\}/.test(WF));
check('W-9 finalize 下载所有分片并合并', /pattern:\s*shard-\*/.test(WF) && /merge-shards\.mjs/.test(WF));
check('W-10 finalize 传了 SHARD_TOTAL（用于校验覆盖完整）', /SHARD_TOTAL:\s*\$\{\{\s*needs\.plan\.outputs\.shards\s*\}\}/.test(WF));
check('W-11 finalize 设了 SKIP_PRICE_REFRESH（不重复刷价格）', /SKIP_PRICE_REFRESH:\s*'true'/.test(WF));
check('W-12 邮件只在 finalize 阶段发（分片阶段不发）', (WF.match(/MAIL_MODE/g) || []).length === 1);
check('W-13 提交回仓库只在 finalize 阶段做一次', (WF.match(/git push origin HEAD:main/g) || []).length === 1);

/* ==================================================================
 * X. 汇总阶段的变化比对 + 不重复刷价
 * ================================================================== */
console.log('=== X. 汇总阶段行为 ===');
check('X-1 有 SKIP_PRICE_REFRESH 开关', /skipPriceRefresh/.test(CI) && /SKIP_PRICE_REFRESH/.test(CI));
check('X-2 跳过时不算作失败、也不进补跑循环', /if \(CFG\.skipPriceRefresh\)/.test(CI));
check('X-3 有 diffAgainstSnapshot（分片模式的变化比对）', /function diffAgainstSnapshot/.test(CI));
check('X-4 有 buildSnapshot（为下轮准备基线）', /function buildSnapshot/.test(CI));
check('X-5 快照只含最小字段（price/low/score），不会膨胀', /price:\s*g\.price \? g\.price\.current : null[\s\S]{0,120}low:[\s\S]{0,80}score:/.test(CI));
check('X-6 saveDataFile 会写 _prevSnapshot 供下轮比对', /_prevSnapshot/.test(CI));
check('X-7 跳过价格刷新时，统计里的"成功刷新"用全体款数（不是 0）',
  /refreshed:\s*CFG\.skipPriceRefresh \? data\.games\.length/.test(CI));
check('X-8 无快照时退回 results 比对（单 job 模式不受影响）',
  /changes = diffChanges\(results, data\.games\)/.test(CI));

/* ------------------------------------------------------------------
 * X-9 ~ X-13：run #33 事故的防回归（2026-09-19 补）
 * 事故：判据写成 `shardTotal > 1`，219 款只分 1 片 → isSharded=false
 *       → refresh job 退化成完整单 job 模式：自己发了邮件、且不写 .shard/
 *       → upload-artifact 报 "No files were found" → job 失败 → finalize skip。
 * 正确判据：**SHARD_TOTAL 是否被设置**，与总片数无关（1 片也要走分片路径）。
 * ------------------------------------------------------------------ */
check('X-9 分片判据用 SHARD_TOTAL 是否被设置，而不是「分片数 > 1」',
  /shardEnvSet/.test(CI) && !/const isSharded = shardTotal > 1/.test(CI));
check('X-10 判据实现：SHARD_TOTAL 非 undefined 且非空字符串',
  /shardEnvSet:\s*process\.env\.SHARD_TOTAL !== undefined\s*&&\s*process\.env\.SHARD_TOTAL !== ''/.test(CI));
check('X-11 isSharded 由 shardEnvSet 决定', /const isSharded = !!CFG\.shardEnvSet/.test(CI));
check('X-12 shardTotal 下限为 1（单片不会导致 slice 出错或除以 0）',
  /const shardTotal = Math\.max\(1, Number\(CFG\.shardTotal\) \|\| 1\)/.test(CI));
check('X-13 分片收尾会写出 data/.shard 文件（upload-artifact 依赖它）',
  /path\.join\(ROOT, 'data', '\.shard'\)/.test(CI) && /fs\.writeFileSync\(outPath/.test(CI));
check('X-14 分片收尾在「特惠日历/商店页/发信」之前 return（单片也不重复发信）',
  CI.indexOf('if (isSharded) {') < CI.indexOf('特惠日历（补折扣截止时间）'),
  'isSharded 块必须在全局收尾之前');
check('X-14b 分片模式强制关掉发信（双保险，避免 N 片各发一封）',
  /CFG\.mailMode = 'never'/.test(CI));

/* X-15：复现 #33 的判据计算 —— SHARD_TOTAL=1 时 isSharded 必须为 true。
   注意：不能真跑 daily-refresh.mjs（它要连 Steam，本机/CI 单测都不该发网络请求）。
   这里从源码抠出 CFG 的判定表达式，在本地按不同 SHARD_TOTAL 求值。 */
{
  const m = CI.match(/shardEnvSet:\s*(process\.env\.SHARD_TOTAL[^,\n]*)/);
  if (!m) { check('X-15 能从源码抠出 shardEnvSet 的判定表达式', false, '未匹配到'); }
  else {
    const expr = m[1].replace(/,$/, '');
    const evalWith = (shardTotal) => {
      const env = {};
      if (shardTotal !== undefined) env.SHARD_TOTAL = shardTotal;
      return vm.runInNewContext('(' + expr.replace(/process\.env\.SHARD_TOTAL/g, 'env.SHARD_TOTAL') + ')', { env });
    };
    check('X-15 SHARD_TOTAL=1 时判据为 true（#33 的正确行为）', evalWith('1') === true);
    check('X-16 SHARD_TOTAL=3 时判据为 true', evalWith('3') === true);
    check('X-17 SHARD_TOTAL 未设置时为 false（保持老的单 job 模式）', evalWith(undefined) === false);
    check('X-18 SHARD_TOTAL 为空串时为 false', evalWith('') === false);
  }
}

console.log('\n============================');
console.log('SHARD PASS ' + pass + '  FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);
