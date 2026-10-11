/* 「今日特价雷达」后端采集器专项回归（2026-10-11 新增）

   这个采集器是本次新加的第一个数据源（tools/discover-specials.mjs），
   它踩的坑有共性，所以判据不是「函数返回了什么」而是「绝不编造、绝不静默丢」：

     A. 解析器：字段零容忍 —— 名字/折扣/现价/原价缺一不可，
        好评率必须从 HTML 实体 tooltip 里正确解出来（不解就会拿到乱码）
     B. 日期解析：中文/紧凑/英文三种格式都要对；
        解析不了必须返回 null，绝不返回 0 冒充「1970 年」
     C. 分档与排序：折扣力度是主权重，好评率加权、评测数对数加成；
        「-70% 好评 97% 的大厂游戏」必须排在「-95% 好评 60% 的三流游戏」前面
     D. 过滤：低于门槛的、没名字的、非法 appid 的必须剔除；
        已在库里的必须打 alreadyOwned 标记（前端靠它显示「已在清单」）
     E. 去重：分页重叠会让同一 appid 出现两次，只能留一条
     F. 失败语义：抓不到数据也必须 exit 0 并写出带 error 的空结果，
        绝不能让 CI 的 finalize（合并 + 发信）被一个可选数据源拖垮

   同时锁死「不泄密」：这个文件绝不能出现 API Key 相关的东西。
*/
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x !== undefined ? '  -> ' + JSON.stringify(x) : '')); }
}

const SRC = fs.readFileSync(path.join(ROOT, 'tools', 'discover-specials.mjs'), 'utf8');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const CODE = stripComments(SRC);

/* ---------- 一份真实结构的 HTML 样本（照抄 Steam search/results 的形状） ---------- */
function row(appid, name, pct, final, orig, tipHtml, released, plats, img) {
  return '<a class="search_result_row" data-ds-appid="' + appid + '">' +
    '<span class="title">' + name + '</span>' +
    '<div class="discount_pct">-' + pct + '%</div>' +
    '<div class="search_price_discount_combined" data-price-final="' + Math.round(final * 100) + '">¥' + final.toFixed(2) + '</div>' +
    '<div class="discount_original_price">¥' + orig.toFixed(2) + '</div>' +
    '<span class="search_review_summary positive" data-tooltip-html="' + tipHtml + '"></span>' +
    '<div class="search_released">' + released + '</div>' +
    // 平台是「一个 span 一个平台」，照抄真实结构（写成 class="platform_img win mac" 是错的）
    plats.map(p => '<span class="platform_img ' + p + '"></span>').join('') +
    '<img src="' + img + '" alt="">' +
    '</a>';
}
/* tooltip 必须用编码形式（&#x20;）—— 这正是真实抓取里常见的样子，
   也用来盯住「htmlDecode 漏了数值实体 → 好评率整片变 null」这个坑。 */
const TIP_90 = '&quot;239,506&#x20;篇用户评测&#x20;中有&#x20;90%&#x20;为好评&quot;';
const TIP_97 = '&quot;12,004&#x20;篇用户评测&#x20;中有&#x20;97%&#x20;为好评&quot;';
/* 再来一条「不编码的中文 tooltip」，对应另一种真实形态，两条都要解得出好评率 */
const TIP_RAW = '特别好评&lt;br&gt;此游戏的 8,120 篇用户评测中有 88% 为好评。';
const SAMPLE = row(1145360, 'Hades', 80, 69.75, 348.75, TIP_90, '2020 年 9 月 17 日', ['win'], 'https://cdn.example/h.jpg') +
  row(1091500, 'Cyberpunk 2077', 50, 199.00, 398.00, TIP_97, '2020年12月10日', ['win', 'mac', 'linux'], 'https://cdn.example/c.jpg') +
  row(70, 'Half-Life 2', 75, 5.99, 23.99, TIP_RAW, 'Nov 16, 2004', ['win'], 'https://cdn.example/hl.jpg');

(async () => {
  const M = await import(pathToFileURL(path.join(ROOT, 'tools', 'discover-specials.mjs')).href);

  console.log('=== A. 解析器：字段完整性 ===');
  const rows = M.parseSearchResults(SAMPLE);
  check('A-1 切出 3 条', rows.length === 3, rows.length);
  const h = rows[0];
  check('A-2 名字', h.name === 'Hades', h.name);
  check('A-3 折扣百分比', h.discountPercent === 80, h.discountPercent);
  check('A-4 现价（分→元）', h.finalPrice === 69.75, h.finalPrice);
  check('A-5 原价', h.originalPrice === 348.75, h.originalPrice);
  check('A-6 好评率从 HTML 实体 tooltip 解出', h.reviewPct === 90, h.reviewPct);
  check('A-7 评测数去千分位', h.reviewCount === 239506, h.reviewCount);
  check('A-8 好评等级', h.reviewSummary === 'positive', h.reviewSummary);
  check('A-9 平台多值（一个 span 一个平台）', rows[1].platforms.join(',') === 'win,mac,linux', rows[1].platforms);
  check('A-10 头图', /cdn\.example\/h\.jpg/.test(h.tinyImage || ''), h.tinyImage);
  check('A-11 币种默认 CNY', h.currency === 'CNY', h.currency);
  // 这两条是本次真修掉的 bug 的回归守卫：
  check('A-12 原价保留小数（¥348.75 不能变成 348）', h.originalPrice === 348.75, h.originalPrice);
  check('A-13 整数原价也正确', rows[2].originalPrice === 23.99, rows[2].originalPrice);
  check('A-14 未编码的中文 tooltip 也能解出好评率', rows[2].reviewPct === 88, rows[2].reviewPct);
  check('A-15 未编码 tooltip 的评测数也能解出', rows[2].reviewCount === 8120, rows[2].reviewCount);
  check('A-16 数值实体解码后无 U+FFFD 乱码',
    rows.every(r => !/\uFFFD/.test(r.name || '') && !/\uFFFD/.test(r.releaseDate || '')));

  console.log('\n=== A2. 缺字段不许编造 ===');
  const bad = M.parseSearchResults('<a class="search_result_row" data-ds-appid="123"><span class="title">   </span></a>');
  check('A2-1 空白名字 → null（不是空串）', bad.length === 1 && bad[0].name === null, bad[0] && bad[0].name);
  check('A2-2 无折扣 → null', bad[0].discountPercent === null, bad[0].discountPercent);
  check('A2-3 无价格 → null', bad[0].finalPrice === null && bad[0].originalPrice === null);
  check('A2-4 无评测 → null', bad[0].reviewPct === null && bad[0].reviewCount === null);
  check('A2-5 空 HTML → 空数组', M.parseSearchResults('').length === 0);
  check('A2-6 非字符串输入不炸', M.parseSearchResults(null).length === 0);

  console.log('\n=== B. 日期解析 ===');
  const utc = (y, m, d) => Date.UTC(y, m - 1, d);
  check('B-1 中文带空格', M.parseChineseDate('2020 年 9 月 17 日') === utc(2020, 9, 17), M.parseChineseDate('2020 年 9 月 17 日'));
  check('B-2 中文紧凑', M.parseChineseDate('2020年12月10日') === utc(2020, 12, 10));
  check('B-3 英文格式', M.parseChineseDate('Nov 16, 2004') === utc(2004, 11, 16), M.parseChineseDate('Nov 16, 2004'));
  check('B-4 只有年月 → 当月 1 号', M.parseChineseDate('2020 年 12 月') === utc(2020, 12, 1));
  check('B-5 解析不了返回 null（绝不返回 0）', M.parseChineseDate('即将推出') === null, M.parseChineseDate('即将推出'));
  check('B-6 空值 → null', M.parseChineseDate('') === null && M.parseChineseDate(null) === null);
  check('B-7 非法月份 → null', M.parseChineseDate('2020 年 13 月 5 日') === null);
  check('B-8 离谱年份 → null', M.parseChineseDate('1800 年 1 月 1 日') === null);
  check('B-9 未知英文月 → null', M.parseChineseDate('Xyz 5, 2020') === null);

  console.log('\n=== C. 折扣分档 ===');
  check('C-1 95% → S', M.discountTier(95) === 'S');
  check('C-2 90% → S（边界含）', M.discountTier(90) === 'S');
  check('C-3 89% → A', M.discountTier(89) === 'A');
  check('C-4 75% → A（边界含）', M.discountTier(75) === 'A');
  check('C-5 74% → B', M.discountTier(74) === 'B');
  check('C-6 60% → B（边界含）', M.discountTier(60) === 'B');
  check('C-7 59% → C', M.discountTier(59) === 'C');
  check('C-8 null → null（不是 C，避免「没数据」被当成「最低档」）', M.discountTier(null) === null);
  check('C-9 0 → C', M.discountTier(0) === 'C');

  console.log('\n=== D. 综合评分：折扣为主，好评为权，评测数为辅 ===');
  const bigGood = { discountPercent: 70, reviewPct: 97, reviewCount: 120040 };
  const bigBad = { discountPercent: 95, reviewPct: 60, reviewCount: 12 };
  const s1 = M.computeScore(bigGood), s2 = M.computeScore(bigBad);
  check('D-1 大厂高好评 > 小厂低好评（真实取舍，也兑现代码注释的意图）', s1 > s2, { bigGood: s1, bigBad: s2 });
  check('D-1b 折扣仍是最大权重（同好评率下 -95% 高于 -50%）',
    M.computeScore({ discountPercent: 95, reviewPct: 80, reviewCount: 1000 }) >
    M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 1000 }),
    { d95: M.computeScore({ discountPercent: 95, reviewPct: 80, reviewCount: 1000 }), d50: M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 1000 }) });
  check('D-1c 无评价数据要降权（不得虚高）',
    M.computeScore({ discountPercent: 80, reviewPct: null, reviewCount: 0 }) <
    M.computeScore({ discountPercent: 80, reviewPct: 90, reviewCount: 0 }),
    M.computeScore({ discountPercent: 80, reviewPct: null, reviewCount: 0 }));
  check('D-3 好评率越高分越高',
    M.computeScore({ discountPercent: 50, reviewPct: 95, reviewCount: 1000 }) >
    M.computeScore({ discountPercent: 50, reviewPct: 50, reviewCount: 1000 }));
  check('D-4 评测数加成有上限（不因刷量霸榜）',
    M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 1e9 }) -
    M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 100 }) < 10,
    M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 1e9 }) -
    M.computeScore({ discountPercent: 50, reviewPct: 80, reviewCount: 100 }));
  check('D-5 返回一位小数的数字', (String(s1).split('.')[1] || '').length <= 1, s1);

  console.log('\n=== E. 过滤 / 去重 / 排序 ===');
  const cfg = { minDiscount: 50, recentDays: 0 };
  const raw = [
    { appid: 10, name: '低折扣被滤', discountPercent: 20 },
    { appid: 0, name: '非法 appid', discountPercent: 90 },
    { appid: 20, name: null, discountPercent: 90 },
    { appid: 30, name: '正常', discountPercent: 85, reviewPct: 96, reviewCount: 5000 },
    { appid: 30, name: '正常重复', discountPercent: 85, reviewPct: 96, reviewCount: 5000 },
    { appid: 40, name: '次优', discountPercent: 60, reviewPct: 90, reviewCount: 900 },
    { appid: 50, name: '已在库', discountPercent: 95, reviewPct: 99, reviewCount: 90000 },
    /* appid 60 = 在愿望单里但还没买。与 50 的区别正是这次要锁死的东西。 */
    { appid: 60, name: '在清单未买', discountPercent: 88, reviewPct: 92, reviewCount: 3000 },
  ];
  /* 【2026-10-12 重写 E 组】
     老断言把第三个参数当成「已购集合」传 —— 那是**这个 bug 的根源**：
     filterItems 的第三参原本是「愿望单 appid 集合」，却被命名为 alreadyOwned，
     于是"已购"和"在清单"混成一个概念。现在两个数据源各管一件事，
     下面用完整对象 { ownedSet, wishSet } 传，把这个区分锁死。 */
  const ownedSet = new Set([50]);
  const wishSet = new Set([60]);
  const ex = { ownedSet, wishSet };
  const out = M.filterItems(raw, cfg, ex);
  check('E-1 低于门槛被滤', !out.some(x => x.name === '低折扣被滤'), out.map(x => x.name));
  check('E-2 非法 appid 被滤', !out.some(x => x.appid === 0));
  check('E-3 没名字被滤', out.length === 4, out.map(x => x.name));
  check('E-4 同 appid 去重只留一条', out.filter(x => x.appid === 30).length === 1);
  check('E-5 已在 Steam 库的打了 alreadyOwned', out.find(x => x.appid === 50).alreadyOwned === true);

  /* 🔴 核心回归守卫：alreadyOwned 与 inWishlist 必须来自**不同**数据源。
     这次的 bug 就是两者被混成一个（读的是 wishlist.json 却当成已购库），
     结果 18 款已购游戏被当成好价推给用户。所以这里不只看行为，
     还要直接断言「已在清单」的那款**没有**被误标成已购。 */
  const g50 = out.find(x => x.appid === 50);
  check('E-5b 已在 Steam 库的那款 also 打了 inWishlist=（取决于它在不在清单）',
    typeof g50.inWishlist === 'boolean');
  check('E-5c 已购但不在清单的，必须 alreadyOwned=true 且 inWishlist=false',
    g50.alreadyOwned === true && g50.inWishlist === false,
    'owned=' + g50.alreadyOwned + ' inWish=' + g50.inWishlist);
  check('E-5d 在 wishSet 里的那条被打 inWishlist=true，且不该被当成已购',
    out.find(x => x.appid === 60).inWishlist === true
    && out.find(x => x.appid === 60).alreadyOwned === false);
  check('E-5e 两个字段互相独立：把 ownedSet 清空不改变 inWishlist',
    M.filterItems(raw, cfg, { ownedSet: new Set(), wishSet }).find(x => x.appid === 60).inWishlist === true);
  check('E-6 不在库的 alreadyOwned=false', out.find(x => x.appid === 30).alreadyOwned === false);
  check('E-7 每条都补了 tier 和 score', out.every(x => x.tier && typeof x.score === 'number'));
  check('E-8 按 score 降序', out[0].score >= out[1].score && out[1].score >= out[2].score,
    out.map(x => x.appid + ':' + x.score));
  check('E-9 分数相同时按价格低优先（稳定、可预期）',
    M.filterItems([
      { appid: 1, name: '贵', discountPercent: 80, reviewPct: 90, reviewCount: 100, finalPrice: 300 },
      { appid: 2, name: '便宜', discountPercent: 80, reviewPct: 90, reviewCount: 100, finalPrice: 10 },
    ], cfg, new Set()).map(x => x.appid).join(',') === '2,1',
    M.filterItems([
      { appid: 1, name: '贵', discountPercent: 80, reviewPct: 90, reviewCount: 100, finalPrice: 300 },
      { appid: 2, name: '便宜', discountPercent: 80, reviewPct: 90, reviewCount: 100, finalPrice: 10 },
    ], cfg, new Set()).map(x => x.appid));

  console.log('\n=== E2. recentDays 只收新上架 ===');
  const recent = M.filterItems([
    { appid: 1, name: '刚发售', discountPercent: 80, releaseTs: Date.now() - 3 * 86400000 },
    { appid: 2, name: '老游戏', discountPercent: 80, releaseTs: Date.now() - 400 * 86400000 },
    { appid: 3, name: '没发售日', discountPercent: 80 },
  ], { minDiscount: 50, recentDays: 30 }, new Set());
  check('E2-1 只留 30 天内', recent.length === 1 && recent[0].name === '刚发售', recent.map(x => x.name));
  check('E2-2 没发售日的不算「新」', !recent.some(x => x.name === '没发售日'));

  /* ------------------------------------------------------------------
   * E3. 质量门槛（2026-10-11 用户定：「不要限制，但不要牛马小游戏烂游戏进来」）
   *     折扣不再设门槛，质量另设门槛。这两条必须分别钉死：
   *       · 折扣低的好游戏要进来（-10% 也收）
   *       · 评分差 / 评测数太少的要挡掉
   *       · 数据缺失的必须放行（不因「没抓到」就静默藏起来）
   * ------------------------------------------------------------------ */
  console.log('\n=== E3. 质量门槛：不限折扣，但挡烂游戏 ===');
  const qcfg = { minDiscount: 0, minReviewCount: 300, recentDays: 0 };
  const good = { reviewSummary: 'mostly_positive', reviewCount: 5000, reviewPct: 90 };
  const rows3 = [
    { appid: 10, name: '差评游戏', discountPercent: 80, reviewSummary: 'mixed', reviewCount: 9000 },
    { appid: 11, name: '多半差评', discountPercent: 80, reviewSummary: 'mostly_negative', reviewCount: 9000 },
    { appid: 12, name: '好评但样本小', discountPercent: 80, reviewSummary: 'very_positive', reviewCount: 50 },
    { appid: 13, name: '口碑都好但打折很浅', discountPercent: 10, ...good },
    { appid: 14, name: '全好评大样本', discountPercent: 95, reviewSummary: 'overwhelmingly_positive', reviewCount: 120000 },
    { appid: 15, name: '没抓到评分数据', discountPercent: 70 },
  ];
  const out3 = M.filterItems(rows3, qcfg, new Set());
  const ids3 = out3.map(x => x.appid);
  check('E3-1 评分 mixed（褒贬不一）挡掉', !ids3.includes(10), ids3);
  check('E3-2 mostly_negative 挡掉', !ids3.includes(11), ids3);
  check('E3-3 好评但评测仅 50 条挡掉（样本太小＝刷分或小游戏）', !ids3.includes(12), ids3);
  check('E3-4 ★ 折扣只有 10% 也照样收（折扣不限）', ids3.includes(13), ids3);
  check('E3-5 全好评大样本收', ids3.includes(14), ids3);
  check('E3-6 ★ 没抓到评分数据 → 放行（不因缺数据静默砍掉）', ids3.includes(15), ids3);
  check('E3-7 挡掉的条数有记账（能解释为什么少了）',
    M.filterItems.lastRejected && M.filterItems.lastRejected.quality === 3, M.filterItems.lastRejected);
  check('E3-8 默认配置就是「折扣不限 + 评测数 300」',
    M.CFG && M.CFG.minDiscount === 0 && M.CFG.minReviewCount === 300,
    M.CFG && { d: M.CFG.minDiscount, r: M.CFG.minReviewCount });
  check('E3-9 judgeQuality 是导出的纯函数（可直接断言）',
    typeof M.judgeQuality === 'function' && M.judgeQuality({ reviewSummary: 'mixed' }, qcfg).ok === false);

  console.log('\n=== F. 失败语义：抓不到也必须 exit 0 ===');
  check('F-1 复用 daily-refresh 的重试器（不重造轮子）',
    /await import\('\.\/daily-refresh\.mjs'\)/.test(CODE));
  check('F-2 走 fetchJSON（限速/退避在 daily-refresh 内统一处理）',
    /n\.fetchJSON\(/.test(CODE) && /retries:\s*\d/.test(CODE));
  check('F-3 写文件时带 error 字段（让页面能显示「今天没抓到」）',
    /error\s*:/.test(CODE) && /writeData|writeJson|fs\.writeFileSync/.test(CODE));
  check('F-4 main 不因异常抛出（整体被 try 包住）',
    /catch[\s\S]{0,400}(warn|log)/.test(CODE));
  check('F-5 有开关可关（SPECIALS_ENABLED）', /SPECIALS_ENABLED/.test(CODE));
  /* 2026-10-11：默认从 50 改成 0（不限折扣）。用户原话「不要限制」——
     折扣力度不再是门槛，质量由 E3 组单独把关。
     契约同步改，别让旧数字留在断言里骗人。 */
  check('F-6 折扣门槛走环境变量且默认 0（不限）',
    /SPECIALS_MIN_DISCOUNT\s*\|\|\s*0\b/.test(CODE));
  check('F-6b 质量门槛走环境变量 SPECIALS_MIN_REVIEWS',
    /SPECIALS_MIN_REVIEWS/.test(CODE));

  console.log('\n=== G. 不泄密 / 不越权 ===');
  check('G-1 绝不引用 STEAM_API_KEY（这个数据源必须免密钥可用）', !/STEAM_API_KEY/.test(SRC));
  check('G-2 不含 32 位十六进制串（防手滑把 Key 写死）', !/[0-9a-fA-F]{32}/.test(SRC));
  check('G-3 只打公开商店域名', (SRC.match(/store\.steampowered\.com/g) || []).length > 0 && !/api\.steampowered\.com/.test(SRC));
  check('G-4 结果里不含用户名/库内容（只有 appid 与价格评价）',
    !/steamId|SteamID|profile\/steamcommunity/.test(CODE));
  check('G-5 有分页上限（不会无限翻页打爆 Steam）', /SPECIALS_MAX_PAGES/.test(CODE));

  console.log('\n=== H. 与 CI 的接线 ===');
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'daily-refresh.yml'), 'utf8');
  check('H-1 workflow 里开了 DISCOVER_SPECIALS', /DISCOVER_SPECIALS:\s*'true'/.test(yml));
  check('H-2 门槛走 vars 可调', /vars\.SPECIALS_MIN_DISCOUNT/.test(yml));
  check('H-3 没动 refresh job 的 matrix 与 max-parallel',
    /max-parallel:\s*1/.test(yml) && /matrix:/.test(yml));
  const DR = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');
  check('H-4 daily-refresh 有 discoverSpecials 开关', /discoverSpecials:/.test(DR));
  check('H-5 邮件能读到 specials（TOP20 分区）', /readSpecialsForMail/.test(DR));
  check('H-6 导出限速工具给采集器复用（不两套逻辑）',
    /fetchJSON[\s\S]*fetchTextRetry[\s\S]*rateLimit/.test(DR));

  console.log('\n========================================');
  console.log('SPECIALS PASS ' + pass + '  FAIL ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃：', e); process.exit(2); });
