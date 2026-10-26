#!/usr/bin/env node
// graph-audit —— 公开面审计的图基座操作。
//
// 架构（详见 references/graphify-integration.md）：
//   图基座  = graphify skill 产出的知识图：.audit/graphify-out/graph.json
//   声称层  = claim 节点 ＋ claim→符号 边（ingest-claims 贴到图上）
//   裁决层  = claim 节点上的 audit_* 属性（record 贴到图上）
//   账本    = .audit/claims.json / .audit/verdicts.json
//             —— graphify update 会重建图、审计层会被冲掉，reconcile 用账本贴回。
//             账本只是写前记录；**读取一律走图**（记忆就是图本身）。
//
// 子命令：
//   init          --root <被审仓>                          建 .audit/ 并自动写 .gitignore
//   ingest-claims --root <被审仓> --in <claims.json>       声称入图（＋配对边＋恢复裁决）
//   queue         --root <被审仓> [--out <file>]           排出待核队列（按符号定位实现）
//   record        --root <被审仓> --item <id> --verdict <证实|驳倒|部分|无定> [--note <t>] [--round <r>]
//   reconcile     --root <被审仓>                          graphify update 之后把审计层贴回图
//   status        --root <被审仓>                          记忆账汇总
//
// 它不判对错。量对不上也可能是主持者读错，必须逐条打开原文确认
// （references/procedure/02-verdict.md「不做转述式验收」）。
// Node ≥ 18，ESM，零依赖。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, extname, relative } from 'node:path';
import { createHash } from 'node:crypto';

const VERDICTS = new Set(['证实', '驳倒', '部分', '无定']);
const OVERLAY = 'audit-overlay';

function die(msg) {
  console.error(`错误：${msg}`);
  process.exit(2);
}
function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

// ---------- 路径约定：审计工作区住在被审仓里 ----------
function paths(rootArg) {
  const r = resolve(!rootArg || rootArg === true ? '.' : rootArg);
  return {
    root: r,
    audit: join(r, '.audit'),
    graph: join(r, '.audit', 'graphify-out', 'graph.json'),
    claims: join(r, '.audit', 'claims.json'),
    verdicts: join(r, '.audit', 'verdicts.json'),
    rounds: join(r, '.audit', 'rounds'),
    gitignore: join(r, '.gitignore'),
  };
}

// ---------- 图 IO ----------
// 图只有一张，位置固定：<被审仓>/.audit/graphify-out/graph.json
// 建图与增量都必须用 GRAPHIFY_OUT 指到这里（见 init 打印的命令），
// 否则 `graphify update` 会把图写到 <被审仓>/graphify-out/ —— 那是另一张图，
// 本脚本读不到，等于增量全部白跑。下面两个检查就是拦这种情况。
const OUT_REL = join('.audit', 'graphify-out');

function strayGraph(P) {
  const p = join(P.root, 'graphify-out', 'graph.json');
  return existsSync(p) ? p : null;
}

function loadGraph(P) {
  if (!existsSync(P.graph)) {
    const stray = strayGraph(P);
    const hint = stray
      ? `\n发现仓根有一张图：${stray}\n那是 ` + '`graphify update`' + ` 没定向时写出来的（本脚本不读它）。\n把图搬正：删掉仓根 graphify-out/，再用 init 打印的命令重建。`
      : `\n先用 graphify 技能建图。注意必须把输出定向到 .audit，且用 update（免 key、连文档节点一起出）：\n  cd <被审仓> && GRAPHIFY_OUT=$PWD/.audit/graphify-out graphify update`;
    die(`找不到图：${P.graph}${hint}`);
  }
  try {
    return JSON.parse(readFileSync(P.graph, 'utf8'));
  } catch (e) {
    die(`graph.json 解析失败：${e.message}`);
  }
}

// 图覆盖检查：只有代码节点的图，声称抽取拿不到文档语义，配对能力是残的。
// `graphify extract . --code-only` 产出合法但残缺的图，不检查就会静默降级。
function graphCoverage(g) {
  const nodes = g.nodes || [];
  const by = { code: 0, document: 0, other: 0 };
  const files = new Set();
  for (const n of nodes) {
    const ft = n.file_type || '';
    if (ft === 'code') by.code += 1;
    else if (ft === 'document' || ft === 'concept' || ft === 'rationale') by.document += 1;
    else by.other += 1;
    if (n.source_file) files.add(String(n.source_file));
  }
  return { ...by, total: nodes.length, files: files.size, code_only: by.document === 0 && by.code > 0 };
}

function warnCoverage(g, P) {
  const cov = graphCoverage(g);
  if (!cov.code_only) return cov;
  console.error(`警告：图里 0 个文档节点（${cov.code} 个代码节点）——这张图只覆盖代码符号。`);
  console.error('      文档类声称的语义配对不可用，抽声称会退化成纯人工读。');
  console.error('      补文档节点：去掉 --code-only 再跑一次 graphify extract（需要 LLM key）；');
  console.error('      或直接用 graphify update，它免 key 就能补出文档的 page/heading 结构节点。');
  return cov;
}
function saveGraph(P, g) {
  writeFileSync(P.graph, JSON.stringify(g, null, 2) + '\n', 'utf8');
}
function edgeKey(g) {
  if (Array.isArray(g.links)) return 'links';
  if (Array.isArray(g.edges)) return 'edges';
  g.links = [];
  return 'links';
}

function loadLedger(p, fallback) {
  if (!p || !existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}
function saveLedger(p, obj) {
  mkdirSync(dirname(resolve(p)), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function hashFile(root, rel) {
  if (!rel) return null;
  const p = resolve(root, rel);
  if (!existsSync(p)) return null;
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

// ---------- 符号：入图定位 ＋ 源码定位 ----------
function symbolOf(target) {
  const t = String(target || '').trim().replace(/`/g, '');
  if (!t || t.startsWith('external:')) return null;
  const m = t.match(/^([\w.-]+)\(\)$/);
  if (m) return m[1];
  const parts = t.split(/\s+/);
  if (parts.length > 1) return parts[parts.length - 1].replace(/[()]/g, '');
  return t.replace(/[()]/g, '');
}

function normLabel(s) {
  return String(s || '').trim().replace(/\(\)$/, '');
}

function findSymbolNode(g, sym) {
  const nodes = g.nodes || [];
  for (const n of nodes) {
    const label = normLabel(n.label);
    const id = normLabel(n.id);
    if (label === sym || id === sym) return n;
    if (label.startsWith(sym + '(') || label.endsWith('.' + sym) || label.endsWith('->' + sym) || label.endsWith('::' + sym)) return n;
  }
  return null;
}

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.sh', '.php']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.audit', 'graphify-out']);

function walk(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (CODE_EXT.has(extname(p).toLowerCase())) out.push(p);
  }
  return out;
}

const fileCache = new Map();
function linesOf(p) {
  if (fileCache.has(p)) return fileCache.get(p);
  let ls = null;
  try {
    ls = readFileSync(p, 'utf8').split(/\r?\n/);
  } catch {
    ls = null;
  }
  fileCache.set(p, ls);
  return ls;
}

function findSymbolDef(lines, sym) {
  if (!lines || !sym) return null;
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pats = [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*=`),
    new RegExp(`^\\s*(?:export\\s+)?class\\s+${esc}\\b`),
    new RegExp(`^\\s*def\\s+${esc}\\b`),
    new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?${esc}\\b`),
    new RegExp(`^\\s*fn\\s+${esc}\\b`),
    new RegExp(`^\\s*${esc}\\s*[:=]\\s*(?:async\\s*)?\\(`),
    new RegExp(`^\\s*${esc}\\s*\\([^)]*\\)\\s*\\{`),
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const re of pats) if (re.test(lines[i])) return i;
  }
  const loose = new RegExp(`(['"\`]|case\\s+|===?\\s*)${esc}(['"\`]|\\b)`);
  for (let i = 0; i < lines.length; i++) if (loose.test(lines[i])) return i;
  return null;
}

function bodyOf(lines, startIdx) {
  if (!lines || startIdx == null) return [];
  const line = lines[startIdx] || '';
  if (!/[{(]/.test(line)) {
    const out = [];
    for (let i = startIdx; i < lines.length; i++) {
      if (i > startIdx && /^\s*$/.test(lines[i])) break;
      if (i > startIdx && /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s/.test(lines[i])) break;
      out.push([i + 1, lines[i]]);
    }
    return out;
  }
  let depth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
  const out = [[startIdx + 1, line]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    out.push([i + 1, lines[i]]);
    depth += (lines[i].match(/{/g) || []).length - (lines[i].match(/}/g) || []).length;
    if (depth <= 0) break;
  }
  return out;
}

function quantityProbes(quantities) {
  const probes = [];
  for (const q of quantities || []) {
    const t = String(q).trim();
    let m = t.match(/退出码\s*(\d+)/);
    if (m) {
      // 退出码不只以字面量出现：`process.exit(c)` 里 c 是表达式（三元、常量），
      // 也见于 `exitCode = N`、`throw new Error` 旁的注释。只认 exit(1) 会漏掉
      // 三元式退出（redline-check 的 exit 1 就是这么写的，被判成"未出现"）。
      probes.push({
        q: t,
        label: `退出码 ${m[1]}`,
        re: new RegExp(`(?:exit\\s*\\(\\s*${m[1]}\\s*\\)|exitCode\\s*=\\s*${m[1]}(?![\\d])|\\?\\s*${m[1]}\\s*:\\s*|:\\s*${m[1]}\\s*\\)|\\b${m[1]}\\s*\\)\\s*;?\\s*$)`),
      });
    }
    m = t.match(/^(\d+)$/);
    if (m) probes.push({ q: t, label: `数字 ${m[1]}`, re: new RegExp(`(?<![\\w.])${m[1]}(?![\\w.])`) });
    if (/^[.\w/-]+\.\w+$/.test(t) || t.startsWith('.')) {
      probes.push({ q: t, label: `路径 ${t}`, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
    }
    if (/^[\w.$/-]+$/.test(t) && t.length >= 3 && !/^\d+$/.test(t)) {
      probes.push({ q: t, label: `标识符 ${t}`, re: new RegExp(`(^|[^\\w])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`) });
    }
  }
  const seen = new Set();
  return probes.filter((p) => (seen.has(p.label) ? false : (seen.add(p.label), true)));
}

// 目标分类：文件路径 / 本仓脚本子命令 / 外部命令 / 平台内置 / 纯符号。
// 混在一起会把"文件/子命令没在图里"误报成"符号不存在"的高置信信号。
const OWN_TOOLS = new Set(['graph-audit', 'redline-check']);
const EXT_TOOLS = new Set(['graphify', 'node', 'git', 'npm', 'npx', 'python', 'python3', 'gh', 'uv']);

// 平台／运行时内置：它们在文档里出现是正常描述，不是"本仓应该实现的符号"。
// 不排除的话，`process.exit(0)`、`console.log` 这类目标永远"图里找不到"，
// 每条都冒出一条假高置信发现——正是上一轮 130 条误报的同类毛病。
const BUILTIN_ROOTS = new Set([
  'process', 'console', 'require', 'module', 'exports', 'global', 'globalThis',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'Symbol', 'Buffer', 'fs', 'path',
  'os', 'url', 'http', 'https', 'crypto', 'util', 'stream', 'child_process',
  'window', 'document', 'localStorage', 'fetch', 'setTimeout', 'setInterval',
  'print', 'len', 'str', 'int', 'dict', 'list', 'self', 'sys', 'argparse',
]);

// root 可选：给了就按真实文件系统判目录，没给只认路径形状。
// 不判目录的后果是裸目录名（`css`）落到符号分支，凭空产出
// "符号找不到＝文档描述的东西不存在"的假高置信发现。
function classifyTarget(raw, root = null) {
  const t = String(raw || '').trim().replace(/`/g, '');
  if (!t) return null;
  if (t.startsWith('external:')) return { kind: 'external', raw: t };
  if (/\.[A-Za-z0-9]+$/.test(t) || t.includes('/')) return { kind: 'file', raw: t };
  if (root && !/\s/.test(t)) {
    try {
      if (statSync(resolve(root, t)).isDirectory()) return { kind: 'file', raw: t };
    } catch { /* 不是路径就当符号，照旧 */ }
  }
  const parts = t.split(/\s+/);
  const tool = (parts[0] || '').replace(/^scripts\//, '').replace(/\.mjs$/, '');
  if (parts.length >= 2 && OWN_TOOLS.has(tool)) return { kind: 'command', tool, sub: parts.slice(1).join(' '), raw: t };
  if (parts.length === 1 && OWN_TOOLS.has(tool)) return { kind: 'script', tool, raw: t };
  if (parts.length >= 2 && EXT_TOOLS.has(tool)) return { kind: 'external', raw: t };
  // 调用形态要取函数名再查：`process.exit(0)` 是整个成员表达式，
  // 简单去掉括号会变成 `process.exit0`，永远命中不了任何符号，
  // 于是每条带参数的调用都被判成"文档描述的东西不存在"（假高置信）。
  const called = t.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/);
  const sym = called ? called[1] : t.replace(/[()]/g, '');
  // 平台内置不算"本仓该有的符号"：找不到是正常的，不该报成候选发现。
  if (BUILTIN_ROOTS.has(sym.split('.')[0])) return { kind: 'external', raw: t };
  return { kind: 'symbol', sym, raw: t };
}

const TOOL_FILES = { 'graph-audit': 'scripts/graph-audit.mjs', 'redline-check': 'scripts/redline-check.mjs' };

// 目录聚合要数全部文件：walk 只收 CODE_EXT（代码文件），
// 拿它算 `css/` 的行数会恒得 0——而 CSS 恰恰是注释体公开面的主体。
function walkAll(dir, out = []) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkAll(p, out);
    else out.push(p);
  }
  return out;
}

// 文件目标：存在与否 ＋ 图里有没有该文件的节点 ＋ 实测体积
// 体积是文件类目标唯一能核的量：声称"1450 行"就必须给出实际行数，
// 只判"文件存在"等于没核（issue #2 §7.1）。
//
// 行数有两个口径，差在"末尾有没有换行"：
//   wc -l 口径   数换行符，`printf 'a\nb\nc'` → 2
//   逻辑行口径   数内容行，同上 → 3
// 作者写文档用的几乎都是 wc -l / `git diff --stat`，所以按 wc -l 为准，
// 两个数都报出来（issue #3）。
function countLines(text) {
  const wc = (text.match(/\n/g) || []).length;          // 换行符个数 = wc -l
  const logical = text.length === 0 ? 0 : text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  return { wc, logical, no_trailing_newline: text.length > 0 && !text.endsWith('\n') };
}

function resolveFileTarget(g, root, raw) {
  const clean = raw.replace(/\/$/, '');
  const p = resolve(root, clean);
  const exists = existsSync(p);
  const nodes = (g.nodes || []).filter((n) => String(n.source_file || '').replace(/\/$/, '') === clean);
  let lines = null;
  let linesLogical = null;
  let noTrailingNl = false;
  let bytes = null;
  let fileCount = null;
  if (exists) {
    try {
      const st = statSync(p);
      if (st.isFile()) {
        bytes = st.size;
        const c = countLines(readFileSync(p, 'utf8'));
        lines = c.wc;
        linesLogical = c.logical;
        noTrailingNl = c.no_trailing_newline;
      } else if (st.isDirectory()) {
        let n = 0;
        let b = 0;
        let wc = 0;
        let lg = 0;
        for (const f of walkAll(p)) {
          n += 1;
          try {
            b += statSync(f).size;
            const c = countLines(readFileSync(f, 'utf8'));
            wc += c.wc;
            lg += c.logical;
          } catch { /* 读不到就跳过 */ }
        }
        fileCount = n;
        lines = wc;          // 目录：把目录内所有文件的 wc -l 加起来
        linesLogical = lg;
        bytes = b;
      }
    } catch { /* 读不了就当没测到，不猜 */ }
  }
  const isDir = exists && (() => { try { return statSync(p).isDirectory(); } catch { return false; } })();
  return { raw, exists, node_count: nodes.length, sample: nodes[0] ? nodes[0].id : null, lines, lines_logical: linesLogical, no_trailing_newline: noTrailingNl, bytes, file_count: fileCount, is_dir: isDir };
}

// 命令目标：脚本里有没有这个子命令（找字面量 'sub' 或 --flag）
function resolveCommandTarget(root, tool, sub) {
  const rel = TOOL_FILES[tool];
  const p = resolve(root, rel);
  if (!existsSync(p)) return { raw: `${tool} ${sub}`, script_exists: false, found: false, line: null };
  const lines = linesOf(p);
  const token = sub.split(/\s+/)[0];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`'${token}'`) || lines[i].includes(`"${token}"`) || lines[i].includes(token)) {
      return { raw: `${tool} ${sub}`, script_exists: true, found: true, line: i + 1 };
    }
  }
  return { raw: `${tool} ${sub}`, script_exists: true, found: false, line: null };
}

// ---------- 审计层贴图（ingest 与 reconcile 共用） ----------
function sanitize(id) {
  return String(id).trim().replace(/\s+/g, '_').replace(/[^\w.-]/g, '_');
}

function patchGraph(P) {
  const g = loadGraph(P);
  const key = edgeKey(g);
  g.nodes = (g.nodes || []).filter((n) => n._origin !== OVERLAY && !String(n.id || '').startsWith('claim_'));
  g[key] = (g[key] || []).filter((e) => e._origin !== OVERLAY);

  const ledger = loadLedger(P.claims, { claims: [] });
  const claims = ledger.claims || [];
  const verdicts = loadLedger(P.verdicts, { items: {} }).items || {};

  let edges = 0, located = 0, restored = 0;
  const missing = [];
  for (const c of claims) {
    const id = `claim_${sanitize(c.id)}`;
    const node = {
      id,
      label: c.label,
      file_type: 'concept',
      source_file: c.source_file,
      source_location: c.source_location,
      _origin: OVERLAY,
      claim_id: c.id,
      claim_kind: c.claim_kind,
      quantities: c.quantities || [],
      targets: c.targets || [],
      confidence: c.confidence || 'EXTRACTED',
    };
    if (c.claim_kind_secondary) node.claim_kind_secondary = c.claim_kind_secondary;
    const v = verdicts[c.id];
    if (v) {
      Object.assign(node, {
        audit_verdict: v.verdict,
        audit_note: v.note || '',
        audit_round: v.round || '',
        audit_file_hash: v.file_hash || null,
        audit_recorded_at: v.recorded_at || '',
      });
      restored++;
    }
    g.nodes.push(node);
    for (const t of c.targets || []) {
      const cls = classifyTarget(t, P.root);
      if (!cls || cls.kind === 'external') continue;
      if (cls.kind === 'file') {
        const ft = resolveFileTarget(g, P.root, cls.raw);
        if (ft.sample) {
          g[key].push({ source: id, target: ft.sample, relation: 'references', confidence: 'EXTRACTED', confidence_score: 1.0, _origin: OVERLAY });
          edges++;
          located++;
        } else if (!ft.exists) {
          missing.push(`${c.id} → ${t}（文件不存在＝悬空引用候选）`);
        }
        continue;
      }
      if (cls.kind === 'command') {
        const ct = resolveCommandTarget(P.root, cls.tool, cls.sub);
        if (ct.found) {
          located++;
        } else {
          missing.push(`${c.id} → ${t}（脚本里无此子命令＝候选发现）`);
        }
        continue;
      }
      if (cls.kind === 'script') {
        if (existsSync(resolve(P.root, TOOL_FILES[cls.tool]))) located++;
        else missing.push(`${c.id} → ${t}（脚本文件不存在）`);
        continue;
      }
      const target = findSymbolNode(g, cls.sym);
      if (target) {
        g[key].push({
          source: id,
          target: target.id,
          relation: 'references',
          confidence: 'EXTRACTED',
          confidence_score: 1.0,
          _origin: OVERLAY,
        });
        edges++;
        located++;
      } else {
        missing.push(`${c.id} → ${t}（符号找不到＝候选发现）`);
      }
    }
  }
  saveGraph(P, g);
  return { claims: claims.length, edges, located, missing, restored };
}

// ---------- init ----------
function cmdInit() {
  const P = paths(arg('root', '.'));
  mkdirSync(P.audit, { recursive: true });
  mkdirSync(P.rounds, { recursive: true });

  // 两条都要：.audit/ 是审计工作区；graphify-out/ 是 `update` 没定向时的误落点。
  // 只写 .audit/ 的话，仓根会凭空长出一张图并进 git status（issue #2 §1）。
  const want = [
    ['.audit/', '# 公开面审计工作区（不进版本库、不进公开面）'],
    ['graphify-out/', '# graphify 输出目录：可能出现在仓根（update 未定向时），一律不进库'],
  ];
  let gi = '';
  if (existsSync(P.gitignore)) gi = readFileSync(P.gitignore, 'utf8');
  const add = [];
  for (const [line, note] of want) {
    const re = new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\s*$`, 'm');
    if (!re.test(gi)) add.push({ line, note });
  }
  if (add.length) {
    const sep = gi && !gi.endsWith('\n') ? '\n' : '';
    const block = add.map((a) => `${a.note}\n${a.line}\n`).join('\n');
    writeFileSync(P.gitignore, `${gi}${sep}\n${block}`, 'utf8');
    for (const a of add) console.log(`.gitignore 已加入 ${a.line}：${P.gitignore}`);
  } else {
    console.log('.gitignore 已含 .audit/ 与 graphify-out/，跳过');
  }

  const out = join(P.root, OUT_REL);
  console.log(`
审计工作区就绪：${P.audit}/
  rounds/                 每轮的证据单、裁决表、复查与收口记录
  graphify-out/graph.json 图基座（由 graphify 技能生成与更新）
  claims.json             声称层账本（写前记录，读取走图）
  verdicts.json           裁决层账本（写前记录，读取走图）

下一步（顺序固定）：

  1. 建图。必须用 GRAPHIFY_OUT 把输出定向到 .audit，否则 update 会把图写到
     仓根 graphify-out/（那是另一张图，本脚本不读，增量等于白跑）：

       cd ${P.root}
       export GRAPHIFY_OUT=${out}
       graphify update

     一条命令同时完成首建与增量，且免 LLM key、零 token（本地 AST＋结构抽取）。
     它给出代码符号 + 文档的 page/heading 结构节点。
     有 LLM key 时另跑一次不带 --code-only 的 extract 可得文档语义节点；
     CSS 注释等无扩展名支持的内容始终进不了图，那部分只能靠人工读。

     以后每轮同一条命令：

       GRAPHIFY_OUT=${out} graphify update

  2. 抽声称：按 references/claim-extraction-spec.md，由只读文档的新上下文产出 claims.json
  3. node scripts/graph-audit.mjs ingest-claims --root ${P.root} --in <claims.json>

建完先跑 status 核覆盖：文档节点为 0 说明图只覆盖代码符号，文档类声称的语义配对不可用。`);
}

// ---------- ingest-claims ----------
function cmdIngest() {
  const P = paths(arg('root', '.'));
  const inPath = arg('in');
  if (!inPath || inPath === true) die('ingest-claims 需要 --in <claims.json>（抽取规格的产物）');
  if (!existsSync(inPath)) die(`找不到 ${inPath}`);
  let data;
  try {
    data = JSON.parse(readFileSync(inPath, 'utf8'));
  } catch (e) {
    die(`claims 解析失败：${e.message}`);
  }
  // 三种形状都收：裸数组、抽取产物 {claims:[...]}、图的 {nodes:[...]}。
  // 只认后两种会导致「账本自己写出的 {claims:[...]} 读不回去」——同一轮里
  // ingest 写账本、下一轮想重放就得手改文件。
  const raw = Array.isArray(data) ? data : data.claims || data.nodes || [];
  if (!raw.length) die('claims 里没有节点');

  const claims = raw.map((c, i) => {
    const kind = c.claim_kind || 'behavior';
    if (!c.label) die(`第 ${i + 1} 条缺 label`);
    return {
      id: c.id || `claim_${i + 1}`,
      label: String(c.label),
      claim_kind: kind,
      claim_kind_secondary: c.claim_kind_secondary || null,
      source_file: c.source_file || '',
      source_location: c.source_location || '',
      targets: Array.isArray(c.targets) ? c.targets : [],
      quantities: Array.isArray(c.quantities) ? c.quantities : [],
      confidence: c.confidence || 'EXTRACTED',
    };
  });

  saveLedger(P.claims, { claims, ingested_at: new Date().toISOString() });
  const r = patchGraph(P);
  console.log(`声称入图：${r.claims} 条 → claim 节点；配对边 ${r.edges} 条（符号命中 ${r.located}）；恢复裁决 ${r.restored} 条`);
  if (r.missing.length) {
    console.log(`符号在图中找不到（＝候选发现，不是错误）：`);
    for (const m of r.missing) console.log(`  ${m}`);
  }
  console.log(`账本：${P.claims}`);
}

// ---------- queue ----------
function cmdQueue() {
  const P = paths(arg('root', '.'));
  const outFile = arg('out', null);
  const ledger = loadLedger(P.claims, null);
  if (!ledger) die(`没有声称账本：${P.claims}\n先跑 ingest-claims`);
  const g = loadGraph(P);
  const verdicts = loadLedger(P.verdicts, { items: {} }).items || {};
  const codeFiles = walk(P.root);

  const selfViolations = [];
  const queue = [];
  const skipped = [];

  for (const c of ledger.claims || []) {
    const kind = c.claim_kind || '';
    let rel = c.source_file || '';
    if (rel.startsWith(P.root)) rel = relative(P.root, rel);
    const fh = hashFile(P.root, rel);
    const prev = verdicts[c.id];

    if (prev && fh && prev.file_hash === fh) {
      skipped.push({ id: c.id, verdict: prev.verdict, label: c.label });
      continue;
    }

    if (['future', 'process', 'quality'].includes(kind)) {
      selfViolations.push({ id: c.id, kind, file: rel, line: c.source_location, label: c.label, file_hash: fh, claim_file: rel });
      continue;
    }
    if (kind === 'reference') {
      const target = (String(c.label).match(/[\w.-]+(?:\/[\w.-]+)+(?:\.[A-Za-z0-9]+)?\/?|[\w.-]+\.(?:md|mdx|ts|js|json|yml|yaml)\b/) || [])[0]
        || (c.targets || []).map((x) => classifyTarget(x, P.root)).find((x) => x && x.kind === 'file')?.raw
        || null;
      const targetPath = target ? resolve(P.root, target.replace(/\/$/, '')) : null;
      selfViolations.push({
        id: c.id, kind, file: rel, line: c.source_location, label: c.label,
        dangling: target ? !existsSync(targetPath) : null,
        target,
        file_hash: fh, claim_file: rel,
      });
      continue;
    }

    // behavior / boundary / version：按目标类别解析（文件／子命令／符号），外部目标跳过
    const probes = quantityProbes(c.quantities);
    const resolved = [];
    for (const t of c.targets || []) {
      const cls = classifyTarget(t, P.root);
      if (!cls || cls.kind === 'external') continue;
      if (cls.kind === 'file') {
        const ft = resolveFileTarget(g, P.root, cls.raw);
        // 文件类目标也要核量：声称的行数/字节数在这里对上，否则"文件存在"就是空判。
        // 只核数字类——标识符探针要扫函数体，文件目标没有"函数体"，
        // 拿整篇散文去搜一个词只会产出噪音（"banned"/"Chinese" 这类声称量的本来就不是字面出现）。
        // 行数双口径：wc -l 与逻辑行都报，命中任一即算对上（issue #3）。
        let size;
        if (ft.is_dir) {
          size = `${ft.file_count} 个文件／${ft.lines} 行（wc -l）／${ft.bytes} 字节`;
        } else if (ft.lines != null) {
          size = ft.lines === ft.lines_logical
            ? `${ft.lines} 行／${ft.bytes} 字节`
            : `${ft.lines} 行（wc -l）／${ft.lines_logical} 行（含末尾无换行）／${ft.bytes} 字节`;
        } else {
          size = '体积读不到';
        }
        const numProbes = probes
          .filter((p) => /^数字\s*\d+$/.test(p.label))
          .map((p) => {
            const claimed = Number(p.label.match(/^数字\s*(\d+)$/)[1]);
            const found = [];
            if (ft.lines === claimed) found.push({ line: 0, text: `行数 ${ft.lines}（wc -l）与声称一致` });
            if (ft.lines_logical === claimed && ft.lines_logical !== ft.lines) found.push({ line: 0, text: `行数 ${ft.lines_logical}（逻辑行）与声称一致` });
            if (ft.file_count === claimed && ft.is_dir) found.push({ line: 0, text: `文件数 ${ft.file_count} 与声称一致` });
            if (ft.bytes === claimed) found.push({ line: 0, text: `字节数 ${ft.bytes} 与声称一致` });
            return { ...p, found, ok: found.length > 0, claimed, lines: ft.lines, lines_logical: ft.lines_logical, bytes: ft.bytes, is_dir: ft.is_dir, file_count: ft.file_count };
          });
        resolved.push({ target: t, symbol: cls.raw, kind: 'file', hit: ft.exists ? { file: cls.raw, line: 0, symbol: `文件存在（图内节点 ${ft.node_count}；实测 ${size}）`, from_graph: ft.node_count > 0, body_size: ft.is_dir ? ft.file_count : (ft.lines || 0), probes: numProbes, body_writes: [], exit_codes: [] } : null, file_detail: ft });
        continue;
      }
      if (cls.kind === 'command') {
        const ct = resolveCommandTarget(P.root, cls.tool, cls.sub);
        resolved.push({ target: t, symbol: cls.raw, kind: 'command', hit: ct.found ? { file: TOOL_FILES[cls.tool], line: ct.line || 0, symbol: `子命令存在（${TOOL_FILES[cls.tool]}:${ct.line}）`, from_graph: false, body_size: 0, probes: [], body_writes: [], exit_codes: [] } : null, command_detail: ct });
        continue;
      }
      if (cls.kind === 'script') {
        const rel = TOOL_FILES[cls.tool];
        const ls = linesOf(resolve(P.root, rel));
        if (ls) {
          const body = ls.map((l, i) => [i + 1, l]);
          resolved.push({ target: t, symbol: cls.raw, kind: 'script', hit: {
            file: rel, line: 1, symbol: `${cls.tool}（整脚本 ${ls.length} 行）`, from_graph: false, body_size: ls.length,
            probes: probes.map((p) => {
              const found = body.filter(([, l]) => p.re.test(l)).map(([n, l]) => ({ line: n, text: l.trim().slice(0, 100) }));
              return { q: p.q, label: p.label, found, ok: found.length > 0 };
            }),
            body_writes: [],
            exit_codes: body.map(([n, l]) => { const m = l.match(/exit\s*\(\s*(\d+)\s*\)/); return m ? { code: m[1], line: n, text: l.trim().slice(0, 100) } : null; }).filter(Boolean),
          } });
        } else {
          resolved.push({ target: t, symbol: cls.raw, kind: 'script', hit: null });
        }
        continue;
      }
      const sym = cls.sym;
      let hit = null;
      const node = findSymbolNode(g, sym);
      let defLine = null;
      let defFile = null;
      if (node && node.source_file) {
        defFile = node.source_file.startsWith(P.root) ? relative(P.root, node.source_file) : node.source_file;
        const m = String(node.source_location || '').match(/L(\d+)/);
        defLine = m ? Number(m[1]) - 1 : null;
      }
      if (defFile == null || defLine == null) {
        for (const cf of codeFiles) {
          const ls = linesOf(cf);
          const idx = findSymbolDef(ls, sym);
          if (idx != null) {
            defFile = relative(P.root, cf);
            defLine = idx;
            break;
          }
        }
      }
      if (defFile != null && defLine != null) {
        const ls = linesOf(resolve(P.root, defFile));
        const body = bodyOf(ls, defLine);
        hit = {
          file: defFile,
          line: defLine + 1,
          symbol: sym,
          from_graph: !!node,
          body_size: body.length,
          probes: probes.map((p) => {
            const found = body.filter(([, l]) => p.re.test(l)).map(([n, l]) => ({ line: n, text: l.trim().slice(0, 100) }));
            return { q: p.q, label: p.label, found, ok: found.length > 0 };
          }),
          body_writes: body
            .filter(([, l]) => /writeFile|writeFileSync|appendFile|createWriteStream|fs\.write/.test(l))
            .map(([n, l]) => ({ line: n, text: l.trim().slice(0, 100) })),
          exit_codes: body
            .map(([n, l]) => {
              const m = l.match(/exit\s*\(\s*(\d+)\s*\)/);
              return m ? { code: m[1], line: n, text: l.trim().slice(0, 100) } : null;
            })
            .filter(Boolean),
        };
      }
      resolved.push({ target: t, symbol: sym, hit });
    }

    const foundCount = resolved.filter((r) => r.hit).length;
    const missingByKind = {
      file: resolved.filter((r) => r.kind === 'file' && !r.hit).map((r) => r.target),
      command: resolved.filter((r) => r.kind === 'command' && !r.hit).map((r) => r.target),
      symbol: resolved.filter((r) => (!r.kind || r.kind === 'symbol') && !r.hit).map((r) => r.target),
      script: resolved.filter((r) => r.kind === 'script' && !r.hit).map((r) => r.target),
    };
    const claimedCodes = new Set(
      (c.quantities || []).map((q) => { const m = String(q).match(/退出码\s*(\d+)/); return m ? m[1] : null; }).filter(Boolean)
    );
    // 只有声称**确实提了**退出码、实现里还有别的，才算"方向对、细节错"；
    // 声称没提退出码时实现里有 exit 是常态，不构成信号。
    const extraCodes = [];
    if (claimedCodes.size) {
      for (const r of resolved) {
        if (!r.hit || !r.hit.exit_codes) continue;
        for (const ec of r.hit.exit_codes) if (!claimedCodes.has(ec.code)) extraCodes.push({ ...ec, target: r.target });
      }
    }
    let score = 1;
    if (missingByKind.symbol.length) score = 10;
    else if (missingByKind.file.length) score = 8;
    else if (missingByKind.command.length) score = 8;
    else if (extraCodes.length) score = 9;
    else if (resolved.some((r) => r.hit && r.hit.probes.some((p) => !p.ok))) score = 8;
    else if (foundCount < (c.targets || []).length) score = 7;
    if (kind === 'boundary') score += 1;

    queue.push({
      id: c.id, kind, file: rel, line: c.source_location, label: c.label,
      quantities: c.quantities || [],
      targets: resolved,
      missing_by_kind: missingByKind,
      score,
      extra_exit_codes: extraCodes,
      file_hash: fh,
      claim_file: rel,
      previously: prev ? { verdict: prev.verdict, note: prev.note || '' } : null,
    });
  }

  queue.sort((a, b) => b.score - a.score);

  const out = [];
  out.push(`声称 ${ledger.claims.length} 条 → 不用核代码 ${selfViolations.length} / 需核实现 ${queue.length} / 跳过（已核且未变）${skipped.length}`);
  const cov = graphCoverage(g);
  out.push(`图基座：${P.graph}（节点 ${cov.total}：代码 ${cov.code}／文档 ${cov.document}／其他 ${cov.other}）`);
  if (cov.code_only) {
    out.push('');
    out.push('<<< 警告：这张图 0 个文档节点，只覆盖代码符号。');
    out.push('    文档类声称的语义配对不可用；下面的配对只对"能被符号索引命中"的声称有效。');
    out.push('    别据此判"队列为空＝没有无据宣称"。');
  }
  const stray = strayGraph(P);
  if (stray) {
    out.push('');
    out.push(`<<< 警告：仓根另有一张图 ${stray}——\`graphify update\` 没定向时写在那里，本脚本不读。`);
    out.push('    本轮读的是上面这张，增量可能没生效。');
  }
  out.push('');

  if (selfViolations.length) {
    out.push('## 一、不用核代码的（抽出来就是结论）');
    out.push('');
    for (const v of selfViolations) {
      const why =
        v.kind === 'future' ? '红线 6 未来时／路线图泄漏'
        : v.kind === 'process' ? '红线 2 内部过程史'
        : v.kind === 'quality' ? '红线 9 质量混谈'
        : v.kind === 'reference' ? (v.dangling ? `红线 7 悬空引用（${v.target} 不存在）` : `引用存在（${v.target}），仍需确认章节真有`)
        : '未分类';
      out.push(`- [${v.kind}] ${v.file}:${v.line}　${why}`);
      out.push(`    ${v.label}`);
      out.push(`    id=${v.id}`);
    }
    out.push('');
  }

  if (queue.length) {
    out.push('## 二、需核实现（按可疑度排序）');
    out.push('');
    for (const q of queue) {
      out.push(`### [${q.score}] ${q.file}:${q.line}　${q.kind}　id=${q.id}`);
      out.push(`声称：${q.label}`);
      if (q.quantities.length) out.push(`声称的量：${q.quantities.join('、')}`);
      for (const r of q.targets) {
        if (!r.hit) {
          const msg = r.kind === 'file'
            ? `目标 ${r.target} → 文件不存在　<<< 悬空引用候选（红线 7）`
            : r.kind === 'command'
              ? `目标 ${r.target} → 脚本里无此子命令　<<< 候选发现：文档描述的东西可能不存在`
              : `目标 ${r.target}（符号 ${r.symbol}）→ 图与源码都找不到　<<< 高置信：文档描述的东西可能不存在`;
          out.push(`  ${msg}`);
          continue;
        }
        out.push(`  目标 ${r.target} → ${r.hit.file}:${r.hit.line}（${r.hit.symbol}${r.hit.from_graph ? '，来自图节点' : '，源码兜底定位'}，函数体 ${r.hit.body_size} 行）`);
        for (const p of r.hit.probes) {
          // 文件类目标的量没有行号（量是"整篇的行数/字节数"），只报说明文字；
          // 符号类才有行号可报。
          if (p.ok) {
            const hits = p.found.map((f) => (f.line ? `L${f.line}` : f.text)).join('；');
            out.push(`      量「${p.label}」→ 命中：${hits}`);
          } else if (r.kind === 'file') {
            const measured = p.is_dir
              ? `${p.file_count} 个文件／${p.lines} 行（wc -l）`
              : `${p.lines} 行（wc -l）／${p.lines_logical} 行（逻辑行）／${p.bytes} 字节`;
            out.push(`      量「${p.label}」→ 实测 ${measured}，都对不上声称的 ${p.claimed}　<<< 核对是否方向对、细节错`);
          } else {
            out.push(`      量「${p.label}」→ 函数体内未出现　<<< 核对是否方向对、细节错`);
          }
        }
        if (r.hit.exit_codes && r.hit.exit_codes.length) {
          out.push(`      函数体内全部退出码：${r.hit.exit_codes.map((e) => `exit(${e.code})@L${e.line}`).join('、')}`);
        }
        if (r.hit.body_writes.length) out.push(`      函数体内写盘调用：${r.hit.body_writes.map((w) => `L${w.line}`).join(', ')}`);
        else out.push(`      函数体内无写盘调用`);
      }
      if (q.extra_exit_codes.length) {
        const codes = [...new Set(q.extra_exit_codes.map((e) => `exit(${e.code})`))].join('、');
        out.push(`  <<< 声称只提退出码 ${[...new Set((q.quantities || []).map((x) => (String(x).match(/退出码\s*(\d+)/) || [])[1]).filter(Boolean))].join('/')}，但实现里还有 ${codes}——典型的"方向对、细节错"`);
      }
      if (q.previously) out.push(`  上轮：${q.previously.verdict}（文件已变，重新入队）`);
      out.push('');
    }
  }

  out.push('说明：本清单只把"声称的量"与"实现里的量"摆在一起，**不判定对错**。');
  out.push('      量对不上也可能是主持者读错（同名函数、分支差异），须逐条打开原文确认——');
  out.push('      见 references/procedure/02-verdict.md「不做转述式验收」。');

  console.log(out.join('\n'));

  if (outFile && outFile !== true) {
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(outFile, JSON.stringify({ root: P.root, self_violations: selfViolations, queue, skipped: skipped.length }, null, 2) + '\n', 'utf8');
    console.log(`\n已写入 ${outFile}`);
  }
}

// ---------- record ----------
function cmdRecord() {
  const P = paths(arg('root', '.'));
  const id = arg('item');
  const verdict = arg('verdict');
  const note = arg('note', '');
  const round = arg('round', '');

  if (!id || id === true) die('record 需要 --item <id>');
  if (!VERDICTS.has(verdict)) die(`--verdict 只接受：${[...VERDICTS].join(' / ')}`);

  const ledger = loadLedger(P.claims, { claims: [] });
  const claim = (ledger.claims || []).find((c) => c.id === id);
  if (!claim) die(`账本里没有 id=${id}（先 ingest-claims）`);

  let rel = claim.source_file || '';
  if (rel.startsWith(P.root)) rel = relative(P.root, rel);
  const fh = hashFile(P.root, rel);

  const items = loadLedger(P.verdicts, { items: {} }).items || {};
  items[id] = {
    verdict,
    note: note === true ? '' : note,
    round: round === true ? '' : round,
    file_hash: fh,
    claim_file: rel,
    recorded_at: new Date().toISOString(),
  };
  saveLedger(P.verdicts, { items });
  const r = patchGraph(P);
  console.log(`已记：${id} → ${verdict}${note && note !== true ? `（${note}）` : ''}；图上恢复裁决 ${r.restored} 条`);
  if (!fh) console.log('提示：没记到文件哈希（文件不存在或不可读），这条下次仍会入队。');
  console.log(`记忆账：${P.verdicts}（共 ${Object.keys(items).length} 条）`);
}

// ---------- reconcile ----------
function cmdReconcile() {
  const P = paths(arg('root', '.'));
  const r = patchGraph(P);
  console.log(`审计层已贴回图：claim 节点 ${r.claims}、配对边 ${r.edges}、恢复裁决 ${r.restored}`);
  if (r.missing.length) {
    console.log(`符号在图中找不到（＝候选发现）：${r.missing.length} 条`);
    for (const m of r.missing) console.log(`  ${m}`);
  }
  console.log('提醒：源文件被删除时，图会连带驱逐该文件的审计层节点——它挂在文件上，文件没了就没有落点。');
  console.log('      源文件还在时 update 不会冲掉审计层（实测），本命令是"确认贴回"，不是每轮必跑的补救。');
}

// ---------- status ----------
function cmdStatus() {
  const P = paths(arg('root', '.'));
  const ledger = loadLedger(P.claims, { claims: [] });
  const items = loadLedger(P.verdicts, { items: {} }).items || {};
  const total = Object.keys(items).length;
  console.log(`审计工作区：${P.audit}`);
  console.log(`声称账本：${(ledger.claims || []).length} 条（${P.claims}）`);

  const hasGraph = existsSync(P.graph);
  console.log(`图基座：${hasGraph ? P.graph : '（未建图）'}`);
  if (hasGraph) {
    let g;
    try { g = JSON.parse(readFileSync(P.graph, 'utf8')); } catch { g = null; }
    if (g) {
      const cov = graphCoverage(g);
      const edges = (g.links || g.edges || []).length;
      console.log(`  节点 ${cov.total}、边 ${edges}、覆盖文件 ${cov.files} 个（代码 ${cov.code}／文档 ${cov.document}／其他 ${cov.other}）`);
      const claimsInGraph = (g.nodes || []).filter((n) => n._origin === OVERLAY).length;
      if (claimsInGraph) console.log(`  图内 claim 节点 ${claimsInGraph} 条（审计层已贴图）`);
      else if ((ledger.claims || []).length) console.log(`  图内 0 个 claim 节点——审计层没贴上图，跑 ingest-claims`);
      warnCoverage(g, P);
    }
  }

  // 图一致性：仓根另有一张图＝`graphify update` 没定向，本脚本读的图不会更新。
  const stray = strayGraph(P);
  if (stray) {
    console.log(`\n<<< 仓根另有一张图：${stray}`);
    console.log('    `graphify update` 没带 GRAPHIFY_OUT 就会写到那里，本脚本不读它——');
    console.log('    结果是"增量跑了但队列没变"。删掉它，按 init 打印的命令重建。');
  }

  if (!total) {
    console.log('裁决账：空');
    return;
  }
  const by = {};
  for (const it of Object.values(items)) by[it.verdict] = (by[it.verdict] || 0) + 1;
  console.log(`已核 ${total} 条`);
  for (const v of ['证实', '驳倒', '部分', '无定']) if (by[v]) console.log(`  ${v}：${by[v]}`);
  const bad = (by['驳倒'] || 0) + (by['部分'] || 0);
  if (bad) console.log(`\n注意：${bad} 条被判"驳倒/部分"——按程序计入对应批次的 FAIL，处置完才能收口。`);
  if (by['无定']) console.log(`另有 ${by['无定']} 条无定——不硬猜，列出来问作者。`);
}

// ---------- 入口 ----------
const cmd = process.argv[2];
if (cmd === 'init') cmdInit();
else if (cmd === 'ingest-claims') cmdIngest();
else if (cmd === 'queue') cmdQueue();
else if (cmd === 'record') cmdRecord();
else if (cmd === 'reconcile') cmdReconcile();
else if (cmd === 'status') cmdStatus();
else {
  console.log(`graph-audit —— 公开面审计的图基座操作（建立在 graphify skill 之上）

用法：
  node scripts/graph-audit.mjs init          --root <被审仓>
  node scripts/graph-audit.mjs ingest-claims --root <被审仓> --in <claims.json>
  node scripts/graph-audit.mjs queue         --root <被审仓> [--out <file>]
  node scripts/graph-audit.mjs record        --root <被审仓> --item <id> --verdict <证实|驳倒|部分|无定> [--note <t>] [--round <r>]
  node scripts/graph-audit.mjs reconcile     --root <被审仓>
  node scripts/graph-audit.mjs status        --root <被审仓>

架构：
  图基座  .audit/graphify-out/graph.json（graphify 技能生成；源文件增删后跑 reconcile）
  声称层  claim 节点 ＋ claim→符号 边
  裁决层  claim 节点上的 audit_* 属性
  账本    .audit/claims.json / .audit/verdicts.json（写前记录，读取走图）

它做什么：初始化审计工作区、把声称入图、按符号定位实现排出待核队列、把裁决写回图、
在源文件增删之后把审计层贴回。审计结论跟着内容走（文件哈希没变不再入队）。
它不做什么：不下判断、不判 PASS/FAIL、不替代裁决。`);
  // 没给子命令：打用法，exit 0（无参数调用不算错误）。
  // 给了不认的子命令：同样打用法，但必须非零退出——否则 CI 里"敲错命令"
  // 和"跑完没问题"都是 exit 0，脚本调用者分不出来（与 redline-check 同一条规矩）。
  process.exit(cmd ? 2 : 0);
}
