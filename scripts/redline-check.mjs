#!/usr/bin/env node
// redline-check —— 公开面「词表召回」工具：按词面扫一遍，把可疑行交给审计者裁决。
//
// 这不是门。脚本清零 ≠ 可发布：语气、弃留、红线 10/11 它都看不见，审计 PASS 才是门。
// 误报处理：行尾加 <!-- redline-ok --> 跳过该行；`examples/before-after/*/before.md` 这类
// 故意违规的教学样本，在前 5 行加 <!-- redline-ok-file --> 整文件跳过（正文与代码不用它）。
//
// 用法：node scripts/redline-check.mjs [--stat] <文件或目录>...
//   --stat  只打印每个文件的命中数与总计，不打印明细（CI 用）
//
// 为什么扫本仓不会自伤（三档跳过，全靠语法位置，无任何白名单豁免）：
//   1) 围栏代码块（``` / ~~~ 包裹）整块不扫；
//   2) 行内反引号内容先替换成等长空格再匹配——规则说明与"不许"原句都用反引号包住，
//      于是它们天然不命中，列号也不变；
//   3) 含行级放行标记的行不扫。
// 扫描集按文件类型收窄为 .md/.mdx/.txt（目录递归与显式文件同一条规则），所以本文件
// （词表定义处）按类型就不在扫描集内——这是类型收窄，不是文件级豁免。
//
// 输出：[红线号] 文件:行号  说明，下一行缩进给命中片段（截断 120 字符）；同一行只报首条。
// 命中 exit 1，零命中 exit 0；2＝用法错误或路径读不了（读取失败不得被当成"干净"）。Node ≥ 18，ESM，零依赖。
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';

// 每条规则：红线号 + 正则 + 一句中文说明（说明里的触发词一律用反引号包住，避免自命中）
const RULES = [
  [1, /裁定\s*[：:]|依据\s*[：:]|触发(?:条件|重议)\s*[：:]/, '内部档案格式：把对外文字写成了工作记录（`裁定：`/`依据：` 式条目）'],
  [1, /只追加[，,、]?\s*(?:不|永不?)\s*改写|只追加不改写/, '内部档案格式：向读者宣示记录规则（`只追加不改写`）'],
  [2, /经过.{0,6}轮|审计轮次|第[一二三四五六七八九十\d]{1,2}轮|验收门|门全绿|人肉收口|人工逐(?:页|份)收口|双盲测试|盲测/, '内部过程史：读者没参与过的流程、轮次与故事'],
  [2, /记在路线(?:图|上)|挂在路线(?:图|上)/, '内部过程史：以排期口吻交代没做完的事'],
  [3, /\bD\d{2}\b|\b轮-\d+\b|\bB\d{1,2}\s*基线|[A-Z]\d{1,2}\s*(?:基线|里程碑)|\b[A-Z]{1,2}-\d{2,}\b/, '内部编号与黑话：只有团队内部认得的代号与编号'],
  [3, /(?:曾|以前|原先|一度)(?:被)?(?:称为|叫作|叫|名为)|(?:改|换)名为|重新命名/, '内部编号与黑话：改名史与废弃旧词（`已废弃` 本身是合法的弃用声明，不算）'],
  [4, /修过的账|我们修过|已知缺陷清单|问题[×xX*]\s*归因|归因[×xX*]\s*处置|都改掉了/, '缺陷自曝与修复台账：把我们的问题清单摆给读者'],
  [5, /我们先区分|我们之所以|我们内部(?:的)?(?:做法|思考|约定|标准)|我们的思考|(?:本文|本节|这里|下面)[^。\n]{0,6}设计哲学|设计哲学是/, '设计哲学布道：向读者宣讲内部如何思考质量与拆分'],
  [6, /将(?:会)?支持|计划在|roadmap|后续(?:会|将)(?:支持|提供)|即将(?:推出|支持)|敬请期待|未来版本|v?\d+\.\d+(?:\.\d+)?\s*(?:将|计划)/i, '未兑现承诺与路线图泄漏：没做完的事一个字不写'],
  [7, /(?<![0-9A-Za-z])(?=[0-9a-f]{7,40}(?![0-9A-Za-z]))(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}/, '内部锚点：裸 commit SHA（7–40 位十六进制，含字母）'],
  [7, /\.(?:audit|internal|scratch|sessions)\/|(?:^|[^\w/])projects\/|[a-z0-9][a-z0-9-]*-(?:dev|work|internal)\b/i, '内部锚点：外部读者查不到的目录、路径与非公开仓名'],
  [8, /我们曾经|当年(?:也|曾)|历史包袱|早期(?:很|版本很)?(?:烂|糟糕)|全部认账|黑历史/, '自我贬抑式诚实：交代我们曾经多糟，而不是边界在哪'],
  [9, /保证[^。，；\n]{0,12}(?:散文|文笔|措辞|可读性|内容|语义)质量|承诺[^。，；\n]{0,12}(?:语义|内容|写作)质量/, '质量混谈：把内容质量说成工具承诺（只承诺可机检的那部分）'],
  ['H', /(?:^|[，,。；！？\s的])(?:本|这个|该|此|上述|这些)?(?:项目|文档|代码|文件|工具|脚本|页面|配置|仓库|系统|包)(?:[^。；！？\n]{0,6}(?:在|当)[^。；！？\n]{0,25}|[^。；！？\n]{0,6})(?:之后|以后|后)[，,、]/, '主语链启发式·误报率高：句首物名冒充施动者，真正的动词埋在后半句'],
];

const EXT = new Set(['.md', '.mdx', '.txt']);
const maskCode = (s) => s.replace(/`+[^`]*`+/g, (m) => ' '.repeat(m.length));
const clip = (s) => (s.trim().length > 120 ? `${s.trim().slice(0, 120)}…` : s.trim());
const disp = (p) => {
  const r = relative(process.cwd(), p);
  return !r || r.startsWith('..') ? p : r;
};

function usage() {
  console.error('用法：node scripts/redline-check.mjs [--stat] <文件或目录>...\n  --stat  只打印每个文件的命中数与总计，不打印明细');
}

function collect(p, out, quiet) {
  let st;
  try {
    st = statSync(p);
  } catch (e) {
    console.error(`路径不可用：${p}（${e.code || e.message}）`);
    process.exitCode = 2;
    return out;
  }
  if (st.isDirectory()) {
    for (const d of readdirSync(p, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name === '.git' || d.name === '.audit' || d.name === 'graphify-out') continue;
      collect(join(p, d.name), out, quiet);
    }
  } else if (EXT.has(extname(p).toLowerCase())) out.push(p);
  else if (!quiet) console.error(`跳过（非 .md/.mdx/.txt）：${p}`);
  return out;
}

const args = process.argv.slice(2);
const statMode = args.includes('--stat');
const targets = args.filter((a) => !a.startsWith('-'));
const unknown = args.filter((a) => a.startsWith('-') && !['--stat', '-h', '--help'].includes(a));
if (unknown.length) {
  console.error(`未知选项：${unknown.join(' ')}`);
  usage();
  process.exit(2);
}
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}
if (!targets.length) {
  usage();
  process.exit(2);
}

const files = [...new Set(targets.flatMap((t) => collect(t, [], statMode)))];
let hits = 0;
let skipped = 0;
const rows = [];

for (const file of files) {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (e) {
    console.error(`读取失败：${disp(file)}（${e.code || e.message}）`);
    process.exitCode = 2;
    continue;
  }
  if (lines.slice(0, 5).some((l) => l.includes('redline-ok-file'))) {
    skipped += 1;
    rows.push([disp(file), 0, true]);
    continue;
  }
  let fence = null;
  let count = 0;
  lines.forEach((raw, i) => {
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = { ch: f[1][0], len: f[1].length };
      else if (f[1][0] === fence.ch && f[1].length >= fence.len) fence = null;
      return;
    }
    if (fence || raw.includes('redline-ok')) return;
    const line = maskCode(raw);
    for (const [id, re, why] of RULES) {
      if (!re.test(line)) continue;
      count += 1;
      if (!statMode) console.log(`[${id}] ${disp(file)}:${i + 1}  ${why}\n     > ${clip(raw)}`);
      break;
    }
  });
  hits += count;
  rows.push([disp(file), count, false]);
}

if (statMode) for (const [f, n, sk] of rows) console.log(`${String(n).padStart(4)}  ${f}${sk ? '  （整文件跳过）' : ''}`);
console.log(`\n扫描 ${files.length} 个文件，命中 ${hits} 条`);
if (skipped) console.log(`（其中 ${skipped} 个文件带文件级放行指令，整文件跳过）`);
// 一个文件都没扫到，和"扫了、干净"的输出形态几乎一样（都是 0 命中），
// 但结论完全相反。CI 与脚本调用者区分不出来，所以这里必须非零退出。
if (!files.length) {
  console.error('错误：没有可扫描的文件（路径不存在、目录为空，或一个 .md/.mdx/.txt 都没有）');
  console.error('      "0 命中"只在真的读了文件时才作数。');
  process.exit(2);
}
// 退出码：0 零命中 / 1 有命中 / 2 用法错误或路径读不了（优先，免得读取失败被当成"干净"）
process.exit(process.exitCode === 2 ? 2 : hits ? 1 : 0);
