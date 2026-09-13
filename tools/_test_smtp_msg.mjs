#!/usr/bin/env node
// 验证 SMTP 缺项提示的精确性
// 把 daily-refresh.mjs 里的 CFG 用 mock 注入，然后调 sendMail
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 改写 daily-refresh.mjs 让它不读 process.env（用我们传入的 mock）
const orig = fs.readFileSync(path.join(ROOT, 'tools', 'daily-refresh.mjs'), 'utf8');

// 准备临时文件
const tmpPath = path.join(ROOT, 'tools', '_dr_tmp.mjs');
let modified = orig;
// 替换 CFG.smtp 来自的代码：让 SMTP_*/MAIL_* env 由我们注入
fs.writeFileSync(tmpPath, modified);

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' ' + extra : '')); }
}

// 抠出 sendMail 函数，直接用 eval + mock CFG
async function runOnce(env, expectedPattern) {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('SMTP_') || k === 'MAIL_FROM' || k === 'MAIL_TO') delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  // 注入 CFG.smtp 的 mock + sendMail 函数
  const src = orig;
  // 找到 sendMail 函数体
  const fnStart = src.indexOf('async function sendMail(mail, attachmentPath)');
  let depth = 0, i = src.indexOf('{', fnStart);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const fnBody = src.slice(fnStart, i + 1);

  // 用 mock 替换 CFG
  const code = `
    const CFG = { smtp: { host: process.env.SMTP_HOST, port: 465, secure: true, user: process.env.SMTP_USER, pass: process.env.SMTP_PASS, from: process.env.MAIL_FROM || process.env.SMTP_USER, to: process.env.MAIL_TO } };
    const log = (m) => console.log(m);
    const warn = (m) => console.log('[warn] ' + m);
    ${fnBody}
    return sendMail;
  `;
  const sendMail = new Function(code)();

  let captured = '';
  const origLog = console.log;
  console.log = (...a) => { captured += a.join(' ') + '\n'; };
  await sendMail({ subject: 't', html: '', text: '' }, null);
  console.log = origLog;
  return captured;
}

async function run(name, env, expect) {
  const captured = await runOnce(env, expect);
  if (expect.test(captured)) check(name, true);
  else check(name, false, `输出: ${captured.slice(0, 120).replace(/\n/g, ' ')}`);
}

await run('全空 → 提示缺 4 项', {}, /缺 SMTP_HOST、SMTP_USER、SMTP_PASS、MAIL_TO/);
await run('只缺 MAIL_TO', { SMTP_HOST: 'a', SMTP_USER: 'b', SMTP_PASS: 'c' }, /缺 MAIL_TO/);
await run('只缺前 3 个', { MAIL_TO: 'd' }, /缺 SMTP_HOST、SMTP_USER、SMTP_PASS/);

try { fs.unlinkSync(tmpPath); } catch {}

console.log(`\nSMTP-MSG PASS ${pass}  FAIL ${fail}`);
fs.writeFileSync(path.join(ROOT, '_sm_res.txt'), `SMTP-MSG PASS ${pass} FAIL ${fail}`, 'utf8');
