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
const MODEL = process.env.MODEL || 'openai';
const TEXT_API = (process.env.TEXT_API || 'https://text.pollinations.ai').replace(/\/+$/, '');
const ZHIPU_KEY = process.env.ZHIPU_API_KEY || '';
const ZHIPU_MODEL = process.env.ZHIPU_MODEL || 'glm-4.5-flash';
const ZHIPU_FALLBACK_MODEL = process.env.ZHIPU_FALLBACK_MODEL || 'glm-4-flash';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
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
// 用免密钥的公共文本接口（默认 text.pollinations.ai）把 README 变成中文卡片文案。
// 优先走 POST（无 URL 长度限制），失败再走 GET，最后退回机器翻译。
function buildPrompt(repo, readme, strict, readmeLimit) {
  return [
    '你是中文硬件媒体的编辑，为 ESP32 项目撰写卡片文案。只输出一个 JSON 对象，不要代码块、不要解释。',
    `仓库：${repo.full_name}`,
    `描述：${repo.description || '(无)'}`,
    `语言：${repo.language || '未知'}　星标：${repo.stargazers_count}　创建：${repo.created_at.slice(0, 10)}`,
    `topics：${(repo.topics || []).join(', ') || '(无)'}`,
    `README 摘录：${(readme || '(抓不到 README)').slice(0, readmeLimit)}`,
    '',
    '输出 JSON，字段：',
    `  t  —— 中文标题，格式固定为「${repo.name}：一句话点题」：冒号前必须是上面这个仓库名原文，冒号后用一句中文点题，合计 40 字内。严禁输出「项目名」「标题」这类占位词。`,
    '  d  —— 80~140 字中文简介（不能少于 80 字）：做了什么、技术亮点、一个真实的限制或门槛',
    '  hw —— 只写硬件：具体板子型号 / 模块 / 关键器件；README 没写就写「一块 ESP32 开发板」。不要写环境、不要写「需具备…基础」',
    '  lv —— 只能是从「入门」「进阶」「硬核」里选一个词，不要附加任何说明',
    '铁律：只用上面给的信息，不许编造型号、参数、日期、星数；英文要译成中文；专有名词（项目名、人名、作品名）不要意译，拿不准就保留英文。',
    strict ? '特别注意：t 和 d 必须全部是中文。' : ''
  ].filter(Boolean).join('\n');
}

// 标题兜底：去掉模型写下的「项目名：」占位，保证冒号前是仓库名
function fixTitle(t, repoName) {
  let s = String(t || '').trim().replace(/^(项目名|项目|标题|仓库名)[：:]\s*/, '');
  const idx = s.indexOf('：');
  const head = idx > 0 ? s.slice(0, idx) : '';
  if (!head || head.length > 18) s = `${repoName}：${idx > 0 ? s.slice(idx + 1).trim() : s}`;
  return s.slice(0, 60);
}

function parseCard(txt) {
  if (!txt) return null;
  const cleaned = String(txt).replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch (e) { return null; }
  if (!o || !o.t || !o.d) return null;
  return {
    t: String(o.t).slice(0, 60),
    d: String(o.d).slice(0, 220),
    hw: String(o.hw || '一块 ESP32 开发板').slice(0, 80),
    lv: ['入门', '进阶', '硬核'].includes(o.lv) ? o.lv : '进阶'
  };
}

async function postText(prompt) {  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(`${TEXT_API}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'esp32-daily-bot' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }] }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return { status: r.status, text: null };
    return { status: 200, text: await r.text() };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: null };
  }
}

async function getText(prompt) {
  const url = `${TEXT_API}/${encodeURIComponent(prompt)}?model=${encodeURIComponent(MODEL)}&json=true&seed=${Math.floor(Math.random() * 1e6)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'esp32-daily-bot' } });
    clearTimeout(timer);
    if (!r.ok) return { status: r.status, text: null };
    return { status: 200, text: await r.text() };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: null };
  }
}

async function askZhipu(prompt, model = ZHIPU_MODEL) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  try {
    const r = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZHIPU_KEY}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 1400,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: ctl.signal
    });
    clearTimeout(timer);
    if (!r.ok) return { status: r.status, text: null };
    const j = await r.json();
    return { status: 200, text: j?.choices?.[0]?.message?.content || null };
  } catch (e) {
    clearTimeout(timer);
    return { status: 0, text: null };
  }
}

async function askModel(repo, readme, strict = false) {
  // 0) 智谱：有 key 就优先，质量最高也最稳
  if (ZHIPU_KEY) {
    for (const limit of [1600, 500]) {
      let z = await askZhipu(buildPrompt(repo, readme, strict, limit));
      if (!z.text && z.status) z = await askZhipu(buildPrompt(repo, readme, strict, limit), ZHIPU_FALLBACK_MODEL);
      const card = parseCard(z.text);
      if (card && /[\u4e00-\u9fa5]/.test(card.t + card.d)) return card;
      if (z.status) log(`  ! 智谱返回 ${z.status}`);
    }
  }

  for (const limit of [800, 300]) {
    const prompt = buildPrompt(repo, readme, strict, limit);

    // 1) POST：免费额度是每 45 秒一条，撞上就等一轮再来
    let res = await postText(prompt);
    if (res.status === 402 || res.status === 429) {
      log('  · POST 限流，等 45 秒');
      await new Promise(r => setTimeout(r, 46000));
      res = await postText(prompt);
    }
    let card = parseCard(res.text);
    if (card && /[\u4e00-\u9fa5]/.test(card.t + card.d)) {
      await new Promise(r => setTimeout(r, 46000));   // 给下一条留出限流窗口
      return card;
    }

    // 2) GET：走 URL 传参，提示词要短
    const g = await getText(prompt);
    card = parseCard(g.text);
    if (card && /[\u4e00-\u9fa5]/.test(card.t + card.d)) return card;

    log(`  ! 文案接口未返回可用内容（POST ${res.status} / GET ${g.status}）`);
  }
  return null;
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

// 兜底：模型接口不可用时，用免费翻译接口把仓库自述译成中文，至少保证中文可读
async function translateCN(text) {
  const q = String(text || '').trim().slice(0, 400);
  if (!q) return '';
  try {
    const r = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(q)}&langpair=en%7Czh-CN`,
      { headers: { 'User-Agent': 'esp32-daily-bot' } }
    );
    if (!r.ok) return '';
    const j = await r.json();
    const t = j?.responseData?.translatedText || '';
    return /[\u4e00-\u9fa5]/.test(t) ? t.trim() : '';
  } catch (e) {
    return '';
  }
}

async function fallbackTranslated(repo) {
  const base = fallbackText(repo);
  const zhDesc = await translateCN(repo.description || '');
  if (!zhDesc) return base;
  const firstClause = (zhDesc.split(/[。；;，,]/)[0] || zhDesc).replace(/\s+/g, ' ').trim().slice(0, 24);
  return {
    t: `${repo.name}：${firstClause}`,
    d: `${zhDesc.replace(/[。.\s]+$/, '')}。（${repo.created_at.slice(0, 10)} · ${repo.language || '未知'} · ${repo.stargazers_count}★，文案为自动翻译，细节以原仓库为准）`,
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
    const text = (await askModel(repo, readme)) || (await fallbackTranslated(repo));
    text.t = fixTitle(text.t, repo.name);
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
    await new Promise(r => setTimeout(r, 1500));   // 兜底路径也留一点间隔
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
