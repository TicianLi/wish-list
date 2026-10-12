/* autoCleanOwned 安全阀的**行为**验证（不是读源码找字符串）。
 *
 * 为什么必须真跑：本组守卫的全部价值在于「owned 数据不可用时绝不删」。
 * 那种情况只在运行时才暴露 —— 光靠 /function autoCleanOwned/ 这种正则断言，
 * 就算把函数体整个改空了也照样 PASS。所以这里用 vm 把三个纯逻辑依赖抠出来，
 * 注入假的 STATE/OWNED/localStorage，实际调用 autoCleanOwned()，看它到底删没删。
 *
 * 纯 ASCII 注释 + 无第三方依赖；不读真实数据文件，绝不碰 data/wishlist.json。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
}

/* 把某个函数（及其依赖）从 index.html 里抠出来，在沙箱里求值。
   抠不干净就返回 null —— 那说明源码结构变了，宁可测不了也不能假装通过。

   ⚠️ 连 const 一起抠：pruneOwnedBackupHistory 用了 OWNED_BACKUP_HIST_MAX。
   只抠函数的话那个常量不在作用域里 → ReferenceError → 被 backupBeforeCleanup
   的 catch 吞掉 → 备份"失败" → 安全阀正确地拒绝删除。
   看起来像"该删的没删"，实际是测试环境缺依赖。（页面里 const 都在函数之前，顺序是对的。） */
function extract(src, names) {
  const parts = [];
  for (const name of names) {
    const re = new RegExp('function\\s+' + name + '\\s*\\([\\s\\S]*?\\n\\}', 'g');
    const m = src.match(re);
    if (!m || !m.length) return null;
    parts.push(m[0]);
  }
  /* 抠相关的 const（备份前缀 / 数量上限 / 横幅天数） */
  const consts = src.match(/const OWNED_BACKUP_[A-Z_]+\s*=\s*[^;]+;/g) || [];
  const days = src.match(/const OWNED_AUTO_BANNER_DAYS\s*=\s*\d+;/g) || [];
  return consts.join('\n') + '\n' + days.join('\n') + '\n' + parts.join('\n');
}

/* 一个最小可用的假 localStorage。
   length / key(i) 必须是真的 —— readOwnedBackup 与 pruneOwnedBackupHistory
   都靠遍历 key() 来找历史备份。之前偷懒写死 length:0，结果 prune 抛错、
   被 backupBeforeCleanup 的 catch 吞掉 → 备份失败 → 安全阀**正确地**拒绝删除，
   看起来像"该删的没删"，其实是替身太假。（这反倒是好事：安全阀确实在起作用。） */
function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    map,
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i]; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    /* 用来模拟「存储已满 / 隐私模式」：setItem 一律抛 */
    breakWrites: false
  };
}

const DEPS = [
  'ownedDataReady', 'ownedIdSet', 'classifyOwned', 'readOwnedBackup',
  'backupBeforeCleanup', 'pruneOwnedBackupHistory', 'doDelete', 'autoCleanOwned'
];

/* 构造沙箱：STATE / OWNED / localStorage 都是可注入的替身 */
function makeWorld(opts) {
  const o = opts || {};
  const store = makeStore(o.store);
  const noop = () => {};
  const ctx = {
    console: { log: noop, warn: noop, error: noop },
    JSON, Math, Number, Array, Set, Map, Object, String, Date, isFinite, parseInt, RegExp,
    nowMs: () => (o.now || 1000000),
    esc: s => String(s),
    fmtWhen: t => ('t' + t),
    toast: noop,
    renderAll: noop, renderOwned: noop, renderOwnedAutoBanner: noop, renderRadar: noop,
    classifyAndRenderOwned: noop,
    /* doDelete 会调它。真页面里它是同步写 localStorage，这里只记录被调过。 */
    saveDataNow: () => { ctx.__saved = (ctx.__saved || 0) + 1; },
    /* autoCleanOwned 里取名字用的 findGame。不注入会直接抛 ReferenceError，
       而抛错发生在安全阀之后 —— 于是「安全阀全过」会被误读成「删成功了」。
       真实页面里它是 findGame：在 STATE.games 里按 appid 找。 */
    findGame: id => ctx.STATE.games.find(x => Number(x.appid) === Number(id)) || null,
    localStorage: store,
    STATE: { games: (o.games || []).map(g => Object.assign({}, g)) },
    OWNED: { games: (o.owned || []).map(g => Object.assign({}, g)), error: o.ownedError || null,
             main: [], dlc: [], sel: new Set(), loadedAt: 0 }
  };
  /* 让 setItem 能模拟失败 */
  const realSet = store.setItem.bind(store);
  store.setItem = (k, v) => { if (store.breakWrites) throw new Error('QuotaExceeded'); realSet(k, v); };
  vm.createContext(ctx);
  const code = extract(SRC, DEPS);
  if (!code) return null;
  vm.runInContext(code + '\n__x={ownedDataReady,autoCleanOwned,classifyOwned};',
    Object.assign(ctx, { __x: null }));
  ctx.__api = vm.runInContext('__x', ctx);
  return { ctx, store, api: ctx.__api };
}

/* 造一个 Steam 库里有的清单条目 */
function g(appid, name) {
  return { appid, name, price: { current: 100 }, details: { type: 'game' } };
}

console.log('=== L. autoCleanOwned 行为验证：已购数据不可用时绝不能删 ===');

/* 🔴 L-1~L-4 头号风险：owned.json 没读到 / 出错 / 空 → 清单必须原封不动 */
const emptyCases = [
  { name: 'owned 为空数组', owned: [] },
  { name: 'owned 为 undefined', owned: undefined },
  { name: 'owned 带 error 标记', owned: [{ appid: 1 }], ownedError: 'PRIVATE_PROFILE' }
];
emptyCases.forEach((c, i) => {
  const games = [g(1, 'a'), g(2, 'b'), g(3, 'c')];
  const w = makeWorld({ games, owned: c.owned || [], ownedError: c.ownedError });
  const r = w.api.autoCleanOwned();
  const left = w.ctx.STATE.games.length;
  check('L-' + (i + 1) + ' ★ ' + c.name + ' → 清单一件都没少',
    r.skipped === true && r.removed === 0 && left === games.length,
    { skipped: r.skipped, removed: r.removed, left });
  check('L-' + (i + 1) + 'b ' + c.name + ' → 有备份也不该出现（没删就不该留备份）',
    w.store.getItem('sw_backup_before_owned_cleanup_current') === null);
});

/* ownedDataReady 的四个条件逐个卡 */
console.log('\n=== L2. ownedDataReady 的判定条件 ===');
[
  { n: '有数据无 error', games: [{ appid: 1 }], error: null, want: true },
  { n: '空数组', games: [], error: null, want: false },
  { n: 'undefined', games: undefined, error: null, want: false },
  { n: '有数据但带 error', games: [{ appid: 1 }], error: 'X', want: false }
].forEach((c, i) => {
  const w = makeWorld({ games: [g(1, 'a')], owned: c.games, ownedError: c.error });
  check('L2-' + (i + 1) + ' ' + c.n + ' → ' + (c.want ? '可用' : '不可用'),
    w.api.ownedDataReady() === c.want);
});

console.log('\n=== L3. 数据可用时：只删交集，且必先备份 ===');
{
  /* Steam 库有 1、2、99；清单有 1、2、3。交集应是 1、2 —— 3 绝不能被删，
     99 根本不在清单里（说明已购数据不全，宁可留着也不能误删）。 */
  const w = makeWorld({
    games: [g(1, 'a'), g(2, 'b'), g(3, 'c')],
    owned: [{ appid: 1, playtimeForever: 10 }, { appid: 2, playtimeForever: 0 },
            { appid: 99, playtimeForever: 5 }]
  });
  const r = w.api.autoCleanOwned();
  const ids = w.ctx.STATE.games.map(x => x.appid);
  check('L3-1 只删了交集里的 1、2，3 保留', ids.length === 1 && ids[0] === 3, ids);
  check('L3-2 removed 数量如实上报', r.removed === 2, r.removed);
  const rawB = w.store.getItem('sw_backup_before_owned_cleanup_current');
  check('L3-3 删之前真的备份了', !!rawB, rawB === null ? 'null' : '有');
  if (!rawB) { console.log('  (后续 L3-4/5 跳过：没有备份可查)'); }
  else {
    const b = JSON.parse(rawB);
    check('L3-4 备份里是删除前的 3 款（可完整还原）', b.games.length === 3 && b.auto === true, b.count);
    check('L3-5 备份里没有被误塞进 99（它不在清单里）',
      !b.games.some(x => Number(x.appid) === 99), b.games.map(x => x.appid));
  }
}

console.log('\n=== L4. DLC 也算已购（details.type != game 同样被清理） ===');
{
  const games = [g(1, '本体'), { appid: 2, name: 'DLC', price: {}, details: { type: 'dlc' } }];
  const w = makeWorld({ games, owned: [{ appid: 1, playtimeForever: 1 }, { appid: 2, playtimeForever: 0 }] });
  const r = w.api.autoCleanOwned();
  check('L4-1 本体 + DLC 都被移出', w.ctx.STATE.games.length === 0 && r.removed === 2,
    { left: w.ctx.STATE.games.length, removed: r.removed });
}

console.log('\n=== L5. 备份失败 → 绝不删（本组第二道安全阀） ===');
{
  const w = makeWorld({ games: [g(1, 'a'), g(2, 'b')], owned: [{ appid: 1, playtimeForever: 1 }] });
  w.store.breakWrites = true;   /* 模拟存储已满 / 隐私模式 */
  const r = w.api.autoCleanOwned();
  check('L5-1 ★ 写不进去备份时一件都没删', r.skipped === true && r.removed === 0
    && w.ctx.STATE.games.length === 2, { skipped: r.skipped, left: w.ctx.STATE.games.length });
  check('L5-2 提示语说明了原因', /备份/.test(r.reason || ''), r.reason);
}

console.log('\n=== L6. 清单本来就是空的 → 不动 ===');
{
  const w = makeWorld({ games: [], owned: [{ appid: 1, playtimeForever: 1 }] });
  const r = w.api.autoCleanOwned();
  check('L6-1 空清单时 skipped 且不报错', r.skipped === true && r.removed === 0);
}

console.log('\n=== L7. 没有交集（清单里一款已购都没有）→ 不删 ===');
{
  const w = makeWorld({ games: [g(1, 'a')], owned: [{ appid: 500, playtimeForever: 1 }] });
  const r = w.api.autoCleanOwned();
  check('L7-1 无交集时不删', r.skipped === true && w.ctx.STATE.games.length === 1);
}

console.log('\n=== L8. 备份历史不被连续覆盖 ===');
{
  const w1 = makeWorld({ games: [g(1, 'a'), g(2, 'b')], owned: [{ appid: 1, playtimeForever: 1 }], now: 1000 });
  const r1 = w1.api.autoCleanOwned();
  check('L8-0 第一次自动清理成功（前提条件：确实删了东西）',
    r1.removed === 1 && w1.ctx.STATE.games.length === 1, { removed: r1.removed, left: w1.ctx.STATE.games.length });
  const firstRaw = w1.store.getItem('sw_backup_before_owned_cleanup_current');
  if (!firstRaw) console.log('  (第一次没备份成功，后续检查无从谈起 —— 上面这条应已 FAIL)');
  /* 第二次：清单里再放一款新的已购 */
  w1.ctx.STATE.games = [g(3, 'c'), g(4, 'd')];
  w1.ctx.OWNED.games = [{ appid: 3, playtimeForever: 1 }];
  w1.api.autoCleanOwned();
  const curRaw = w1.store.getItem('sw_backup_before_owned_cleanup_current');
  check('L8-1 第二次清理前的快照是新的（2 款）', !!curRaw && JSON.parse(curRaw).games.length === 2,
    curRaw ? JSON.parse(curRaw).count : 'null');
  const histKeys = [];
  for (let i = 0; i < w1.store.length; i++) {
    const k = w1.store.key(i);
    if (k && k.indexOf('sw_backup_before_owned_cleanup_h_') === 0) histKeys.push(k);
  }
  check('L8-2 ★ 第一份备份被挪进历史，没有被冲掉', histKeys.length === 1, histKeys);
  if (histKeys.length && firstRaw) {
    const h = JSON.parse(w1.store.getItem(histKeys[0]));
    check('L8-3 历史里那份仍是第一次的真实内容（a、b）',
      h.games.length === 2 && h.games.some(x => x.name === 'a'), h.games.map(x => x.name));
  }
}

console.log('\n' + '='.repeat(40));
console.log('AUTOCLEAN PASS ' + pass + '  FAIL ' + fail);
console.log('='.repeat(40));
process.exit(fail ? 1 : 0);