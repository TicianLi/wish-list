/* 商店页抓取队列的「防饿死」专项回归
   用户的要求：「不仅是要这 17 个新游戏的数据，我还要确保以后再有新游戏都能正常获取数据。」

   背景：CI 单次运行的商店页配额是 MAX_TAG_FETCH（默认 150），而清单已经 219 款。
   如果排序不稳定，排在配额之外的游戏可能【永远】轮不到 —— 这就是饥饿。
   这里用真实的 tools/daily-refresh.mjs 里的排序函数做单元验证。

   锁死三条不变量：
     A. 从未抓过标签的新游戏，必须排在「标签过期需重抓」的旧游戏之前
     B. 同档位内部按「上次抓取时间」升序 → 最久没抓的排最前（轮转，不饿死）
     C. 促销却缺折扣截止时间的，优先级最高（用户直接看得见）
     D. 模拟连续多轮运行，所有游戏都必须能在有限轮次内被抓到
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'daily-refresh.mjs');

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
};

const src = fs.readFileSync(SRC, 'utf8');

/* ---- 1. 源码形态检查（函数必须存在且命名如此） ---- */
console.log('\n=== 1. 排序函数存在性 ===');
check('1-1 有 storePagePriority', /function storePagePriority\(/.test(src));
check('1-2 有 tagQueueTier', /function tagQueueTier\(/.test(src));
check('1-3 有 storePageOrder（稳定排序）', /function storePageOrder\(/.test(src));
check('1-4 enrichStoreData 用 storePageOrder 排序', /todo\.sort\(storePageOrder\)/.test(src));
check('1-5 不再用旧的裸优先级排序', !/todo\.sort\(\(a, b\) => storePagePriority\(a\) - storePagePriority\(b\)\)/.test(src));
check('1-6 有「新游戏从未抓过标签」的统计字段', /stat\.newGames/.test(src));
check('1-7 有「顺延到下次」的提示', /顺延到下次运行/.test(src));

/* ---- 2. 把排序函数从源码里抠出来，在内存里跑真实逻辑 ---- */
console.log('\n=== 2. 排序行为（真实函数）===');
function extractFn(name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  return null;
}
// 需要 helper：toMs（真实脚本里已有）
const toMsSrc = extractFn('toMs') || 'function toMs(v){ if(v==null) return null; const n=Number(v); if(!isFinite(n)||n<=0) return null; return n<1e12? n*1000 : n; }';
const code = [toMsSrc, extractFn('storePagePriority'), extractFn('tagQueueTier'), extractFn('storePageOrder')].join('\n');
const mod = new Function(code + '\nreturn { storePagePriority, tagQueueTier, storePageOrder };')();
const { storePagePriority, tagQueueTier, storePageOrder } = mod;

const NOW = Date.now();
const DAY = 86400000;
const mkNew = (appid) => ({ appid, price: { isOnSale: false }, details: { userTags: [], userTagsFetchedAt: null } });
const mkOld = (appid, daysAgo) => ({ appid, price: { isOnSale: false },
  details: { userTags: ['x'], userTagsFetchedAt: NOW - daysAgo * DAY } });
const mkSaleNoDeadline = (appid) => ({ appid, price: { isOnSale: true, discountExpiration: null },
  details: { userTags: [], userTagsFetchedAt: null } });

check('2-1 新游戏 tier = 0', tagQueueTier(mkNew(1)) === 0, String(tagQueueTier(mkNew(1))));
check('2-2 旧游戏 tier = 1', tagQueueTier(mkOld(1, 5)) === 1, String(tagQueueTier(mkOld(1, 5))));
check('2-3 新游戏优先级 高于 旧游戏',
  storePagePriority(mkNew(1)) < storePagePriority(mkOld(2, 30)),
  storePagePriority(mkNew(1)) + ' vs ' + storePagePriority(mkOld(2, 30)));
check('2-4 促销缺截止 优先级最高',
  storePagePriority(mkSaleNoDeadline(1)) < storePagePriority(mkNew(2)),
  storePagePriority(mkSaleNoDeadline(1)) + ' vs ' + storePagePriority(mkNew(2)));

/* B：同档位内按「最久未抓」升序 */
const arr = [mkOld(10, 1), mkOld(11, 40), mkOld(12, 7)];
arr.sort(storePageOrder);
check('2-5 同档位内：最久未抓的排最前（轮转）',
  arr.map(g => g.appid).join(',') === '11,12,10', arr.map(g => g.appid).join(','));

/* ---- 3. 饥饿模拟：多轮运行，每轮配额有限，验证不会有人永远轮不到 ---- */
console.log('\n=== 3. 饥饿模拟（配额小于总数）===');
{
  const TOTAL = 219, QUOTA = 150;
  let games = [];
  for (let i = 0; i < 22; i++) games.push(mkNew(90000 + i));      // 22 款新游戏
  for (let i = 0; i < TOTAL - 22; i++) games.push(mkOld(1000 + i, 31));  // 197 款刚过期

  const seen = new Set();
  let rounds = 0;
  const MAXROUNDS = 8;
  while (seen.size < TOTAL && rounds < MAXROUNDS) {
    rounds++;
    // 每轮重算待抓队列（= CI 里 storePageNeedRefresh + 排序 + 切片）
    const todo = games.filter(g => {
      const d = g.details || {};
      if (!Array.isArray(d.userTags) || !d.userTags.length) return true;
      if (!d.userTagsFetchedAt) return true;
      return (Date.now() - d.userTagsFetchedAt) > 30 * DAY;
    });
    todo.sort(storePageOrder);
    const batch = todo.slice(0, QUOTA);
    /* 模拟"抓过了"：写入标签与抓取时间 */
    batch.forEach(g => {
      g.details.userTags = ['tag'];                       // 有标签了
      g.details.userTagsFetchedAt = Date.now() - rounds * 1000;  // 记为刚刚抓过
      seen.add(g.appid);
    });
  }
  check('3-1 新游戏在【第 1 轮】就被全部抓到（不等轮转）',
    seen.has(90000) && seen.has(90021), 'rounds=' + rounds + ' seen=' + seen.size);
  check('3-2 所有 ' + TOTAL + ' 款都能被覆盖（无饥饿）',
    seen.size === TOTAL, 'seen=' + seen.size + ' rounds=' + rounds);
  check('3-3 轮次不超过 ' + MAXROUNDS + ' 轮', rounds <= MAXROUNDS, 'rounds=' + rounds);

  /* 反向验证：如果用旧的裸优先级排序（同档位不稳定），新游戏是否可能被挤掉？ */
  const sortedNew = Array.from({ length: TOTAL }, (_, i) => (i < 22 ? mkNew(90000 + i) : mkOld(1000 + i, 31)));
  sortedNew.sort((a, b) => storePagePriority(a) - storePagePriority(b));
  const firstBatch = sortedNew.slice(0, QUOTA).filter(g => g.details.userTags.length === 0).length;
  check('3-4 本次排序下，首轮配额里包含全部 22 款新游戏', firstBatch === 22, String(firstBatch));
}

/* ---- 4. 配额不够时的告警 ---- */
console.log('\n=== 4. 配额预警 ===');
check('4-1 新游戏数超过配额时会 warn 并建议调大',
  /newGames > CFG\.maxTagFetch/.test(src) && /MAX_TAG_FETCH 调大到/.test(src));

console.log('\n============================');
console.log('QUEUE-STARVE PASS ' + pass + '  FAIL ' + fail);
console.log('============================');
process.exit(fail ? 1 : 0);
