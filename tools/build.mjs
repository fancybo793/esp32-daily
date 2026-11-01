#!/usr/bin/env node
/**
 * build.mjs —— 把 data/db.json 注入模板，产出单文件 HTML
 * 用法: node tools/build.mjs
 * 远端数据地址（可选）：环境变量 REMOTE_URLS="url1,url2"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');
const TPL_PATH = path.join(ROOT, 'tools', 'template.html');
const OUT_PATH = path.join(ROOT, 'ESP32灵感日历.html');
const SITE_DIR = path.join(ROOT, 'site');
const SITE_INDEX = path.join(SITE_DIR, 'index.html');

export function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

export function validateDB(db) {
  const errors = [];
  const ids = new Set();

  for (const x of db.legacy || []) {
    if (!x.id || !x.t || !x.u) errors.push(`legacy 条目缺字段: ${JSON.stringify(x).slice(0, 80)}`);
    if (ids.has(x.id)) errors.push(`legacy id 重复: ${x.id}`);
    ids.add(x.id);
  }

  const dates = new Set();
  for (const day of db.days || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) errors.push(`日期格式错误: ${day.date}`);
    if (dates.has(day.date)) errors.push(`日期重复: ${day.date}`);
    dates.add(day.date);

    const items = day.items || [];
    const hw = items.filter(i => i.kind === 'hw').length;
    const ai = items.filter(i => i.kind === 'ai').length;
    if (items.length !== 10) errors.push(`${day.date} 条目数 ${items.length}，应为 10`);
    if (hw !== 5 || ai !== 5) errors.push(`${day.date} 配比 hw=${hw} ai=${ai}，应为 5/5`);

    for (const it of items) {
      for (const k of ['id', 'kind', 't', 'd', 'u']) if (!it[k]) errors.push(`${day.date} 条目缺 ${k}: ${it.t || it.id}`);
      if (it.kind && !['hw', 'ai'].includes(it.kind)) errors.push(`${day.date} kind 非法: ${it.kind}`);
      if (it.u && !/^https?:\/\//.test(it.u)) errors.push(`${day.date} 链接非法: ${it.u}`);
      if (it.id && ids.has(it.id)) errors.push(`id 重复: ${it.id}`);
      if (it.id) ids.add(it.id);
    }
  }
  return errors;
}

export function buildDB(db, opts = {}) {
  db.meta = db.meta || {};
  db.meta.built = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

  const remote = opts.remoteUrls ?? (process.env.REMOTE_URLS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const tpl = fs.readFileSync(TPL_PATH, 'utf8');
  const dbMarker = /let DB = \/\*__DB__\*\/ [\s\S]*?;\n/;
  const rmMarker = /const REMOTE_DATA = \/\*__REMOTE__\*\/ [\s\S]*?;\n/;
  if (!dbMarker.test(tpl)) throw new Error('模板里找不到 DB 占位符');
  if (!rmMarker.test(tpl)) throw new Error('模板里找不到 REMOTE 占位符');

  let out = tpl.replace(dbMarker, 'let DB = /*__DB__*/ ' + JSON.stringify(db) + ';\n');
  out = out.replace(rmMarker, 'const REMOTE_DATA = /*__REMOTE__*/ ' + JSON.stringify(remote) + ';\n');

  fs.writeFileSync(OUT_PATH, out);
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(SITE_INDEX, out);
  return { out, outPath: OUT_PATH };
}

function main() {
  const db = loadDB();
  const errors = validateDB(db);
  if (errors.length) {
    console.error('✗ 数据校验失败：');
    errors.forEach(e => console.error('  - ' + e));
    process.exit(1);
  }
  buildDB(db);
  const nDays = db.days.length;
  const nDaily = db.days.reduce((a, d) => a + d.items.length, 0);
  console.log(`✓ 构建完成 → ${path.basename(OUT_PATH)} + site/index.html`);
  console.log(`  ${nDays} 天 / ${nDaily} 条每日内容 + ${db.legacy.length} 条历史库`);
  console.log(`  文件大小 ${(fs.statSync(OUT_PATH).size / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
