#!/usr/bin/env node
/**
 * collect.mjs —— 云端每日抓取（跑在 GitHub Actions，不依赖个人电脑）
 *
 * 流程：GitHub 搜索新仓库 → 过滤去重 → 分类 5 硬 5 AI → 抓 README
 *      → 用 GitHub Models 写中文卡片文案 → 写入 data/db.json → 重建页面
 *
 * 环境变量：
 *   GITHUB_TOKEN   必填（Actions 自带，用来搜索 + 调 GitHub Models）
 *   MODEL          可选，默认 openai/gpt-4o-mini
 *   LOOKBACK_DAYS  可选，默认 45 天
 *   REMOTE_URLS    可选，页面运行时要拉的数据地址（逗号分隔）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDB, validateDB } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, 'data', 'db.json');

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const MODEL = process.env.MODEL || 'openai/gpt-4o-mini';
const MODELS_URL = process.env.MODELS_URL || 'https://models.github.ai/inference/chat/completions';
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 45);

const log = (...a) => console.log(...a);

/* ---------- 工具 ---------- */
function todayCN() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
const DAY = 86400 * 1000;
function daysAgo(n) {
  return new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
}
function normUrl(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').replace(/\.git$/, '');
}
function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[\s\u3000]+/g, '').replace(/[，。、：；！？·—\-_/\\|（）()【】\[\]"'“”‘’.,:;!?]/g, '');
}
function bigrams(s) {
  const o = [];
  for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2));
  return o;
}
function jac(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let x = 0;
  for (const v of A) if (B.has(v)) x++;
  return x / (A.size + B.size - x);
}
function similarity(t1, t2) {
  const a = normTitle(t1), b = normTitle(t2);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const r = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    if (r > 0.55) return Math.max(0.75, r);
  }
  return jac(bigrams(a), bigrams(b));
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
}

/* ---------- GitHub ---------- */
async function gh(url) {
  const r = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'esp32-daily-bot',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {})
    }
  });
  if (!r.ok) throw new Error(`GitHub ${r.status} ${url}`);
  return r.json();
}

async function searchRepos(q, perPage = 30) {
  const u = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${perPage}`;
  const j = await gh(u);
  return j.items || [];
}

async function readmeOf(fullName) {
  for (const br of ['main', 'master']) {
    for (const f of ['README.md', 'readme.md', 'README.MD', 'Readme.md']) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${fullName}/${br}/${f}`, {
          headers: { 'User-Agent': 'esp32-daily-bot' }
        });
        if (r.ok) {
          const t = await r.text();
          if (t.length > 60) return cleanReadme(t).slice(0, 3000);
        }
      } catch (e) { /* 继续尝试 */ }
    }
  }
  return '';
}
function cleanReadme(t) {
  return t
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/* ---------- 分类 ---------- */
const AI_WORDS = ['llm', 'gpt', 'openai', 'claude', 'ollama', 'ai', 'voice', 'speech', 'asr', 'tts', 'wake word',
  'vision', 'yolo', 'neural', 'tinyml', 'tensorflow', 'model', 'agent', 'mcp', 'inference', 'embedding',
  'whisper', 'chat', 'language model', 'transcri', 'gesture', 'detection'];
const HW_WORDS = ['robot', 'servo', 'motor', 'stepper', 'lidar', 'sensor', 'relay', 'cnc', '3d print', 'pcb',
  'antenna', 'lora', 'meshtastic', 'radio', 'sdr', 'audio', 'dac', 'amp', 'speaker', 'display', 'screen',
  'epaper', 'e-ink', 'lcd', 'oled', 'matrix', 'led', 'battery', 'solar', 'power', 'driver', 'usb', 'uart',
  'gps', 'keyboard', 'watch', 'clock', 'camera', 'thermal', 'water', 'solar', 'fan', 'valve', 'pump'];

function scoreKind(repo) {
  const hay = `${repo.name} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
  let ai = 0, hw = 0;
  for (const w of AI_WORDS) if (hay.includes(w)) ai++;
  for (const w of HW_WORDS) if (hay.includes(w)) hw++;
  return ai > hw ? 'ai' : 'hw';
}

/* ---------- 文案 ---------- */
async function askModel(repo, readme, strict = false) {
  if (!TOKEN) return null;
  const sys = '你是中文硬件媒体的编辑，为 ESP32 项目撰写卡片文案。只输出一个 JSON 对象，不要代码块、不要解释。';
  const user = [
    `仓库：${repo.full_name}`,
    `名称：${repo.name}`,
    `描述：${repo.description || '(无)'}`,
    `语言：${repo.language || '未知'}　星标：${repo.stargazers_count}　创建：${repo.created_at.slice(0, 10)}`,
    `topics：${(repo.topics || []).join(', ') || '(无)'}`,
    `README 摘录：\n${readme || '(抓不到 README)'}`,
    '',
    '请输出 JSON，字段：',
    '  t  —— 中文标题，格式「项目名：一句话点题」，不超过 40 字',
    '  d  —— 80~140 字中文简介，说清它做了什么、技术亮点在哪，可以点出一个真实的坑或限制',
    '  hw —— 「上手需要」一句话，写到具体板子型号或关键器件；README 没提到就写「一块 ESP32 开发板」',
    '  lv —— 只能是 入门 / 进阶 / 硬核 三者之一',
    '铁律：只用上面给的信息，不许编造型号、参数、日期、星数；README 里是英文就直接译成中文，不要保留英文长句。',
    strict ? '特别注意：t 和 d 必须全部是中文，不要出现英文描述句。' : ''
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch(MODELS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 700,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }]
      })
    });
    if (!r.ok) {
      log(`  ! 模型返回 ${r.status}，改用模板文案`);
      return null;
    }
    const j = await r.json();
    let txt = j?.choices?.[0]?.message?.content || '';
    txt = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    if (!o.t || !o.d) return null;
    if (!/[\u4e00-\u9fa5]/.test(String(o.t) + String(o.d))) {
      return strict ? null : askModel(repo, readme, true);   // 没写出中文就再要一次
    }
    return {
      t: String(o.t).slice(0, 60),
      d: String(o.d).slice(0, 220),
      hw: String(o.hw || '一块 ESP32 开发板').slice(0, 80),
      lv: ['入门', '进阶', '硬核'].includes(o.lv) ? o.lv : '进阶'
    };
  } catch (e) {
    log(`  ! 模型调用失败：${e.message}`);
    return null;
  }
}

function fallbackText(repo) {
  const desc = (repo.description || '').trim();
  return {
    t: `${repo.name}：${(desc || '新上线的 ESP32 项目').slice(0, 34)}`,
    d: `${desc || '暂无仓库自述'}　（${repo.created_at.slice(0, 10)} 创建，主要语言 ${repo.language || '未知'}，当前 ${repo.stargazers_count} 星。文案由自动流程生成，未经过人工核实细节。）`,
    hw: '一块 ESP32 开发板',
    lv: '进阶'
  };
}

/* ---------- 主流程 ---------- */
async function main() {
  const today = process.env.FORCE_DATE || todayCN();
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  db.days = db.days || [];

  const already = db.days.find(d => d.date === today && (d.items || []).length === 10);
  if (already) {
    log(`= ${today} 已有 10 条，跳过抓取`);
    return;
  }

  const seenUrls = new Set();
  const seenTitles = [];
  for (const x of db.legacy || []) { seenUrls.add(normUrl(x.u)); seenTitles.push(x.t); }
  for (const d of db.days) for (const x of d.items || []) { seenUrls.add(normUrl(x.u)); seenTitles.push(x.t); }

  const QUERIES = ['esp32', 'esp32 ai', 'esp32 robot', 'esp32 camera', 'esp32 audio', 'esp32 display', 'esp32 sensor'];
  let cands = [];
  for (const lookback of [LOOKBACK, LOOKBACK * 2, LOOKBACK * 4]) {
    const since = daysAgo(lookback);
    const map = new Map();
    for (const base of QUERIES) {
      try {
        const items = await searchRepos(`${base} created:>${since}`);
        for (const it of items) if (!map.has(it.html_url)) map.set(it.html_url, it);
      } catch (e) {
        log(`  ! 搜索失败「${base}」：${e.message}`);
      }
    }
    cands = [...map.values()].filter(r => {
      if (r.fork || r.archived || r.disabled) return false;
      if (!r.description) return false;
      if (/awesome|curated list|collection of|resources|cheatsheet|tutorial list/i.test(`${r.name} ${r.description}`)) return false;
      if (/\b(guide|handbook|roadmap|course|book|blog|cheat ?sheet)\b/i.test(`${r.name} ${r.description}`)) return false;
      if (/^(docs?|documentation|wiki|website|homepage)$/i.test(r.name)) return false;
      if (seenUrls.has(normUrl(r.html_url))) return false;
      if (seenTitles.some(t => similarity(t, `${r.name}：${r.description}`) >= 0.72)) return false;
      return true;
    });
    log(`· 回溯 ${lookback} 天：候选 ${cands.length} 个`);
    if (cands.length >= 12) break;
  }

  if (cands.length < 10) {
    log('✗ 够格的候选不足 10 个，本次不写库（宁缺毋滥）');
    process.exit(2);
  }

  const hwPool = cands.filter(r => scoreKind(r) === 'hw').sort((a, b) => b.stargazers_count - a.stargazers_count);
  const aiPool = cands.filter(r => scoreKind(r) === 'ai').sort((a, b) => b.stargazers_count - a.stargazers_count);
  const picked = [];
  for (let i = 0; i < 5 && i < hwPool.length; i++) picked.push({ repo: hwPool[i], kind: 'hw' });
  for (let i = 0; i < 5 && i < aiPool.length; i++) picked.push({ repo: aiPool[i], kind: 'ai' });

  if (picked.length < 10) {
    log(`✗ 分类后只凑到 ${picked.length} 条（hw ${hwPool.length} / ai ${aiPool.length}），本次不写库`);
    process.exit(2);
  }

  const items = [];
  for (const { repo, kind } of picked) {
    log(`→ ${repo.full_name} (${kind}, ${repo.stargazers_count}★)`);
    const readme = await readmeOf(repo.full_name);
    const text = (await askModel(repo, readme)) || fallbackText(repo);
    items.push({
      id: `${today.replace(/-/g, '')}-${slug(repo.name)}`,
      kind,
      t: text.t,
      d: text.d,
      hw: text.hw,
      lv: text.lv,
      s: 'GitHub',
      u: repo.html_url,
      stars: repo.stargazers_count,
      created: repo.created_at.slice(0, 10)
    });
    await new Promise(r => setTimeout(r, 400));
  }

  db.days.push({ date: today, items });
  db.days.sort((a, b) => (a.date < b.date ? -1 : 1));

  const errors = validateDB(db);
  if (errors.length) {
    log('✗ 校验失败，不写库：');
    errors.forEach(e => log('  - ' + e));
    process.exit(1);
  }

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 1));
  buildDB(db);
  const size = fs.statSync(path.join(ROOT, 'site', 'index.html')).size;
  log(`✓ ${today} 已写入 10 条，页面重建完成（${(size / 1024).toFixed(1)} KB）`);
  items.forEach((x, i) => log(`   ${i + 1}. [${x.kind}] ${x.t}`));
}

main().catch(e => {
  console.error('✗ 抓取失败：', e.message);
  process.exit(1);
});
