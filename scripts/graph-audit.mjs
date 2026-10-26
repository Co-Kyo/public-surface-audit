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
// （references/procedure/03-adjudicate.md「不做转述式验收」）。
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
function loadGraph(P) {
  if (!existsSync(P.graph)) die(`找不到图：${P.graph}\n先用 graphify 技能建图（cd <被审仓>/.audit && graphify .. --no-viz）`);
  try {
    return JSON.parse(readFileSync(P.graph, 'utf8'));
  } catch (e) {
    die(`graph.json 解析失败：${e.message}`);
  }
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
    if (m) probes.push({ q: t, label: `退出码 ${m[1]}`, re: new RegExp(`exit\\s*\\(\\s*${m[1]}\\s*\\)`) });
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

// 目标分类：文件路径 / 本仓脚本子命令 / 外部命令 / 纯符号。四类解析方式不同，
// 混在一起会把"文件/子命令没在图里"误报成"符号不存在"的高置信信号。
const OWN_TOOLS = new Set(['graph-audit', 'redline-check']);
const EXT_TOOLS = new Set(['graphify', 'node', 'git', 'npm', 'npx', 'python', 'python3', 'gh', 'uv']);

function classifyTarget(raw) {
  const t = String(raw || '').trim().replace(/`/g, '');
  if (!t) return null;
  if (t.startsWith('external:')) return { kind: 'external', raw: t };
  if (/\.[A-Za-z0-9]+$/.test(t) || t.includes('/')) return { kind: 'file', raw: t };
  const parts = t.split(/\s+/);
  const tool = (parts[0] || '').replace(/^scripts\//, '').replace(/\.mjs$/, '');
  if (parts.length >= 2 && OWN_TOOLS.has(tool)) return { kind: 'command', tool, sub: parts.slice(1).join(' '), raw: t };
  if (parts.length === 1 && OWN_TOOLS.has(tool)) return { kind: 'script', tool, raw: t };
  if (parts.length >= 2 && EXT_TOOLS.has(tool)) return { kind: 'external', raw: t };
  return { kind: 'symbol', sym: t.replace(/[()]/g, ''), raw: t };
}

const TOOL_FILES = { 'graph-audit': 'scripts/graph-audit.mjs', 'redline-check': 'scripts/redline-check.mjs' };

// 文件目标：存在与否 ＋ 图里有没有该文件的节点
function resolveFileTarget(g, root, raw) {
  const clean = raw.replace(/\/$/, '');
  const p = resolve(root, clean);
  const exists = existsSync(p);
  const nodes = (g.nodes || []).filter((n) => String(n.source_file || '').replace(/\/$/, '') === clean);
  return { raw, exists, node_count: nodes.length, sample: nodes[0] ? nodes[0].id : null };
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
      const cls = classifyTarget(t);
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

  const line = '.audit/';
  let gi = '';
  if (existsSync(P.gitignore)) gi = readFileSync(P.gitignore, 'utf8');
  if (!/^\.audit\/?\s*$/m.test(gi)) {
    const sep = gi && !gi.endsWith('\n') ? '\n' : '';
    writeFileSync(P.gitignore, `${gi}${sep}\n# 公开面审计工作区（不进版本库、不进公开面）\n${line}\n`, 'utf8');
    console.log(`.gitignore 已加入 ${line}：${P.gitignore}`);
  } else {
    console.log(`.gitignore 已含 ${line}，跳过`);
  }

  console.log(`
审计工作区就绪：${P.audit}/
  rounds/                 每轮的取证包、发现清单、裁决记录
  graphify-out/graph.json 图基座（由 graphify 技能生成与更新）
  claims.json             声称层账本（写前记录，读取走图）
  verdicts.json           裁决层账本（写前记录，读取走图）

下一步（顺序固定）：
  1. 建图：cd ${P.audit} && graphify .. --no-viz
     —— 产物落 .audit/graphify-out/；建完核对 detect 清单不含 .audit/ 本身
  2. 抽声称：按 references/claim-extraction-spec.md，由只读文档的新上下文产出 claims.json
  3. node scripts/graph-audit.mjs ingest-claims --root ${P.root} --in <claims.json>`);
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
  const raw = Array.isArray(data) ? data : data.nodes || [];
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
        || (c.targets || []).map((x) => classifyTarget(x)).find((x) => x && x.kind === 'file')?.raw
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
      const cls = classifyTarget(t);
      if (!cls || cls.kind === 'external') continue;
      if (cls.kind === 'file') {
        const ft = resolveFileTarget(g, P.root, cls.raw);
        resolved.push({ target: t, symbol: cls.raw, kind: 'file', hit: ft.exists ? { file: cls.raw, line: 0, symbol: `文件存在（图内节点 ${ft.node_count}）`, from_graph: ft.node_count > 0, body_size: 0, probes: [], body_writes: [], exit_codes: [] } : null, file_detail: ft });
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
  out.push(`图基座：${P.graph}（节点 ${(g.nodes || []).length}）`);
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
          if (p.ok) out.push(`      量「${p.label}」→ 命中 ${p.found.length} 处：${p.found.map((f) => `L${f.line}`).join(', ')}`);
          else out.push(`      量「${p.label}」→ 函数体内未出现　<<< 核对是否方向对、细节错`);
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
  out.push('      见 references/procedure/03-adjudicate.md「不做转述式验收」。');

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
  console.log('提醒：graphify update 会重建图，每次 update 之后都要跑本命令。');
}

// ---------- status ----------
function cmdStatus() {
  const P = paths(arg('root', '.'));
  const ledger = loadLedger(P.claims, { claims: [] });
  const items = loadLedger(P.verdicts, { items: {} }).items || {};
  const total = Object.keys(items).length;
  console.log(`审计工作区：${P.audit}`);
  console.log(`声称账本：${(ledger.claims || []).length} 条（${P.claims}）`);
  console.log(`图基座：${existsSync(P.graph) ? P.graph : '（未建图）'}`);
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
  图基座  .audit/graphify-out/graph.json（graphify 技能生成；--update 后须 reconcile）
  声称层  claim 节点 ＋ claim→符号 边
  裁决层  claim 节点上的 audit_* 属性
  账本    .audit/claims.json / .audit/verdicts.json（写前记录，读取走图）

它做什么：初始化审计工作区、把声称入图、按符号定位实现排出待核队列、把裁决写回图、
在 graphify update 之后把审计层贴回。审计结论跟着内容走（文件哈希没变不再入队）。
它不做什么：不下判断、不判 PASS/FAIL、不替代审计者。`);
}
