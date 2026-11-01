#!/usr/bin/env node
/**
 * add-day.mjs —— 把一天的 10 条新内容加进库，查重通过后才入库并重新构建
 * 用法: node tools/add-day.mjs 2026-11-01 data/inbox/2026-11-01.json [--replace] [--no-build]
 *
 * inbox 文件格式：一个数组，10 个对象
 * [{ "kind":"hw"|"ai", "t":"标题", "d":"简介", "hw":"上手需要", "lv":"入门|进阶|硬核",
 *    "s":"来源名", "u":"https://...", "id":"可选，缺省自动生成" }, ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

const args = process.argv.slice(2);
const date = args[0];
const inboxPath = args[1];
const replace = args.includes('--replace');
const noBuild = args.includes('--no-build');

if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !inboxPath) {
  console.error('用法: node tools/add-day.mjs YYYY-MM-DD data/inbox/YYYY-MM-DD.json [--replace] [--no-build]');
  process.exit(1);
}

/* ---------------- 归一化与相似度 ---------------- */
function normUrl(u) {
  try {
    const x = new URL(u);
    return (x.hostname.replace(/^www\./, '') + x.pathname)
      .toLowerCase().replace(/\/+$/, '').replace(/^\/+/, '');
  } catch { return String(u).toLowerCase(); }
}
function normTitle(t) {
  return String(t).toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[，。、：；！？·—\-_/\\|（）()【】\[\]"'“”‘’·.,:;!?]/g, '');
}
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function similarity(t1, t2) {
  const a = normTitle(t1), b = normTitle(t2);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const r = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (r > 0.55) return Math.max(0.75, r);
  }
  const bg = jaccard(bigrams(a), bigrams(b));
  const wa = a.split(/[^0-9a-z]+/).filter(w => w.length > 1);
  const wb = b.split(/[^0-9a-z]+/).filter(w => w.length > 1);
  const wg = wa.length && wb.length ? jaccard(wa, wb) : 0;
  return Math.max(bg, wg);
}

const SIM_THRESHOLD = 0.62;

/* 通用词：出现频率高，不能作为「同一个项目」的证据 */
const GENERIC = new Set([
  'esp32', 'esp32s3', 'esp32c3', 'esp32c6', 'esp32p4', 'esp32s2', 'esp', 'espressif',
  'wifi', 'arduino', 'platformio', 'github', 'open', 'source', 'opensource', 'project',
  'projects', 'based', 'build', 'builds', 'maker', 'diy', 'iot', 'board', 'firmware',
  'software', 'hardware', 'code', 'http', 'https', 'com', 'www', 'with', 'from', 'the',
  'and', 'for', 'your', 'you', 'how', 'new', 'app', 'api', 'sdk', 'tool', 'tools'
]);

function asciiTokens(t) {
  return String(t).toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{2,}/g) || [];
}
/** 拆出「项目名」：标题冒号前那一段，通常是项目名 */
function nameKey(t) {
  const s = String(t);
  const m = s.split(/[：:]/)[0];
  if (m && m.length < s.length) {
    const k = m.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (k.length >= 3 && /[a-z]/.test(k)) return k;
  }
  return '';
}


function slugId(it) {
  const base = normUrl(it.u).split('/').filter(Boolean);
  const tail = base[base.length - 1] || 'item';
  return tail.replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'item';
}

/* ---------------- 主流程 ---------------- */
const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
const inbox = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));

if (!Array.isArray(inbox) || inbox.length !== 10) {
  console.error(`✗ inbox 必须是 10 条的数组，当前 ${Array.isArray(inbox) ? inbox.length : '非数组'}`);
  process.exit(1);
}

const existing = [];
for (const day of db.days) for (const it of day.items) existing.push({ ...it, _from: day.date });
for (const it of db.legacy) existing.push({ ...it, _from: 'legacy' });

const usedIds = new Set(existing.map(x => x.id));
const problems = [];
const accepted = [];

/* 专有词文档频率：某词在历史里只出现在极少数条目中，说明它是项目名/产品名 */
const tf = new Map();
for (const x of existing) for (const w of new Set(asciiTokens(x.t))) if (!GENERIC.has(w)) tf.set(w, (tf.get(w) || 0) + 1);

for (const [i, raw] of inbox.entries()) {
  const it = { ...raw };
  const label = `#${i + 1} ${it.t || '(无标题)'}`;

  if (!['hw', 'ai'].includes(it.kind)) { problems.push(`${label} → kind 必须是 hw 或 ai`); continue; }
  for (const k of ['t', 'd', 'u']) if (!it[k]) problems.push(`${label} → 缺字段 ${k}`);
  if (!/^https?:\/\//.test(it.u || '')) { problems.push(`${label} → 链接不是 http(s)`); continue; }

  // 1) URL 查重
  const nu = normUrl(it.u);
  const sameUrl = existing.find(x => normUrl(x.u) === nu);
  if (sameUrl) { problems.push(`${label} → 链接重复（${sameUrl._from} 已用）`); continue; }

  // 2) 标题查重
  let worst = null;
  for (const x of existing) {
    const s = similarity(it.t, x.t);
    if (s >= SIM_THRESHOLD && (!worst || s > worst.s)) worst = { s, x };
  }
  if (worst) {
    problems.push(`${label} → 标题与「${worst.x.t}」相似度 ${worst.s.toFixed(2)}（${worst.x._from}）`);
    continue;
  }

  // 3) 项目名查重（冒号前那一段）
  const nk = nameKey(it.t);
  if (nk) {
    const hit = existing.find(x => nameKey(x.t) === nk);
    if (hit) { problems.push(`${label} → 项目名「${nk}」已推送过（${hit._from}）`); continue; }
  }

  // 4) 稀有专有词重合（换个说法讲同一个项目）
  const rare = asciiTokens(it.t).filter(w => !GENERIC.has(w) && w.length >= 5 && (tf.get(w) || 0) <= 2);
  if (rare.length) {
    const hit = existing.find(x => {
      const ws = new Set(asciiTokens(x.t));
      return rare.some(w => ws.has(w));
    });
    if (hit) { problems.push(`${label} → 与「${hit.t}」撞了专有词（${rare.filter(w => asciiTokens(hit.t).includes(w)).join('/')}）`); continue; }
  }

  // 5) 本批次内部查重
  const dupInBatch = accepted.find(a => normUrl(a.u) === nu || similarity(a.t, it.t) >= SIM_THRESHOLD);
  if (dupInBatch) { problems.push(`${label} → 与本批「${dupInBatch.t}」重复`); continue; }

  // id
  let id = it.id || slugId(it);
  if (usedIds.has(id)) { let n = 2; while (usedIds.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
  usedIds.add(id);

  accepted.push({
    id,
    kind: it.kind,
    t: it.t.trim(),
    d: it.d.trim(),
    hw: (it.hw || '').trim(),
    lv: it.lv || '进阶',
    s: it.s || '网络检索',
    u: it.u.trim()
  });
}

const hwN = accepted.filter(x => x.kind === 'hw').length;
const aiN = accepted.filter(x => x.kind === 'ai').length;

console.log(`\n== ${date} ==`);
console.log(`通过 ${accepted.length}/10   (硬件 ${hwN} / AI ${aiN})`);
if (problems.length) {
  console.log('被拒：');
  problems.forEach(p => console.log('  ✗ ' + p));
}

if (accepted.length !== 10 || hwN !== 5 || aiN !== 5) {
  console.error('\n✗ 配比或数量不达标，未写入。请补齐/替换后重跑。');
  process.exit(2);
}

const idx = db.days.findIndex(d => d.date === date);
if (idx >= 0) {
  if (!replace) { console.error(`\n✗ ${date} 已存在，若要覆盖请加 --replace`); process.exit(3); }
  db.days[idx] = { date, items: accepted };
  console.log(`已覆盖 ${date} 原有内容`);
} else {
  db.days.push({ date, items: accepted });
  db.days.sort((a, b) => (a.date < b.date ? -1 : 1));
  console.log(`已新增 ${date}`);
}

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 1));

if (!noBuild) {
  console.log('');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build.mjs')], { stdio: 'inherit', cwd: ROOT });
}
console.log(`\n累计 ${db.days.length} 天 / ${db.days.reduce((a, d) => a + d.items.length, 0)} 条每日内容`);
