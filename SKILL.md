---
name: public-surface-audit
description: |
  Audit every word your project shows to outsiders before you publish, using fresh-context readers rather than the author's own eyes — then return a PASS/FAIL verdict per batch. Use when shipping a release, publishing an npm/PyPI package, launching or updating a docs site, writing a README or CHANGELOG, adding files to a package `files` list, reviewing CLI/error text or generated prompt artifacts, or reviewing commit messages and PR titles before they enter public history. Also use when the user asks whether public-facing text leaks internal process, planning, or jargon.
  Trigger when users ask: "公开面审计", "发布前检查文案", "这个 README 能不能发", "有没有把内部的东西写进文档", "文档站文案审一遍", "这个 skill 的文案对外说清楚了吗", "发布前自查", "文案里有没有内部术语".
  Not for: copywriting style, SEO, translation, or fixing implementation bugs (this skill finds where public text and implementation disagree and routes the fix to you). Built on the graphify skill — a hard dependency, see the base section below.
license: MIT
requires: graphify
---

# 公开面审计

## 这个程序解决什么

发布之前，公开面上每一句话都已经被作者读了几十遍——**但这恰恰是问题**：作者知道自己为什么这么写，读者不知道。作者看不见的病，自己查不出来。

本程序用一群**第一次见到这些文字的读者**（每个批次一个新上下文的 agent，只给宪章和文本，不给写作过程）把公开面逐条审一遍，然后由主持者逐条核对原文，出 PASS/FAIL。**FAIL 不清零，不发布。**

要审的是"这句话该不该给陌生人读"，不是"写得好不好"。所以：

- **不靠作者自查**——写作上下文本身就是污染源；
- **不靠词表脚本**——脚本只查得到词面，语气、该不该说、承诺有没有据，它都看不见。脚本是召回工具，不是门；
- **不靠修改后复读**——已经在公开历史上的错（提交信息、发出去的包）改不掉，只能在源头守。

## 什么时候用

| 场景 | 说明 |
|---|---|
| 要发版本 | 站页、包页描述、CHANGELOG 一起过一遍 |
| 要发 npm/PyPI 包 | 尤其注意 `files` 白名单、类型声明里的注释 |
| 文档站上线或改版 | 手写页 + 自动生成的 API 页 + 图里嵌的字 |
| 新仓开源 | 全部文件 + 提交历史（历史不可抹，须先审） |
| 改渲染器/CLI 文案 | 运行时输出那一层：合并即公开 |
| 存量体检 | 不知道仓里藏了多少内部话，全扫一遍 |

**不适用**：文案风格润色、SEO、翻译、代码实现正确性审查。（本程序会标出"无据宣称"并交给下游，但不替你读源码。）

## 两种模式

- **增量门**：只审本次要发布的东西——`git diff` 范围加上不受 diff 保护的全量文件（README、包页描述这类每次发布都重新公开的）。发布前用这个。
- **存量全扫**：整个公开面切批次过一遍，得到一张完整的问题分布图。开源前、接手陌生项目时用这个。

## 五步程序

| 步 | 干什么 | 谁做 | 产物（落 `.audit/rounds/{日期}-{slug}/`） |
|---|---|---|---|
| 00 | 定标：初始化审计工作区、建图/更新、圈文件集、切批次、标性质门 | 主持者 | `00-scope.md` 批次清单 |
| 01 | 装配取证包：每批一份自足输入 | 主持者 | `01-package-B{n}.md` |
| 02 | 扇出审计：每批一个新上下文审计者，并行 | 审计者 | `02-findings-B{n}.md` 发现清单 |
| 03 | 合并裁决：图排队＋逐条打开原文核对，出 PASS/FAIL，裁决记回图 | 主持者 | `03-adjudication.md` 裁决表 |
| 04 | 路由与收口：问题落到该落的地方，门给凭据 | 主持者 | `04-close.md` ＋门凭据 |

细则见 `references/procedure/00-scope.md` … `04-route-close.md`。**判据全在 `references/charter.md`**，一切"算不算违规"以它为准。

## 基座：graphify（强制依赖）

**本 skill 建立在 graphify skill 之上，是硬依赖**：graphify 技能或 graphify 命令缺一，本 skill 停止并报告，**不降级、不给"手工版"**。判断仍是人的；检索、配对、记忆一律走图。架构、维护与实测陷阱见 `references/graphify-integration.md`。

### 审计工作区住在被审仓里

审计记忆属于被审对象：谁的公开面被审，工作区就放谁的根目录。`node scripts/graph-audit.mjs init --root <被审仓>` 一次性建立：

```
<被审仓>/.audit/                  ← init 自动写进 .gitignore（不进版本库、不进公开面）
  graphify-out/graph.json         图基座（graphify 生成；update 后必须 reconcile）
  claims.json / verdicts.json     账本（写前记录，读取走图）
  rounds/{日期}-{slug}/           每轮产物
```

init 之后核对一次 detect 清单：**`.audit/` 下的文件不得出现在被审文件集里**——它是审计工具自己的影子，不是被审面。

### 图化的标准流程

```bash
node scripts/graph-audit.mjs init --root <被审仓>          # 每仓一次
cd <被审仓>/.audit && graphify .. --no-viz                 # 首轮建图；以后 graphify update
node scripts/graph-audit.mjs reconcile --root <被审仓>     # update 之后必跑
# 抽声称：只读文档的新上下文，按 references/claim-extraction-spec.md 产出 claims.json
node scripts/graph-audit.mjs ingest-claims --root <被审仓> --in claims.json
node scripts/graph-audit.mjs queue --root <被审仓>          # 待核队列
node scripts/graph-audit.mjs record --root <被审仓> --item <id> --verdict <四值>
node scripts/graph-audit.mjs status --root <被审仓>
```

**记忆就是图本身**：图基座（文件、符号、社区）＋声称层（claim 节点与 claim→符号 配对边）＋裁决层（claim 节点上的 `audit_verdict` 等属性）三层合一。文件内容哈希没变的声称不再入队——**审计跟着内容走，不跟着时间走**。

**图替你省的**：①`future`／`process`／`quality` 三类声称抽出来即违规候选（红线 6／2／9），不用核代码——实测里常占多数；②符号在图与源码里都找不到＝高置信发现（文档描述了不存在的东西）；③已核过的不再重复核。**符号找不到本身就是结论**——词频法永远得不出它（词在别处出现只会稀释信号），这是"配对靠符号、不靠词"的原因。

**一条不许越的界：图给主持者，不给审计者。** 审计者的全部价值在于它不知道实现是什么样；把 queue、claim 节点或源码塞进取证包，它就会替源码说话，而它看不见源码。

**图替代不了三件事**：判断、审计者的新鲜眼睛、没有具体量的句子。**队列为空不等于没有无据宣称**："我们保证写得专业"在代码里没有对应物，靠人读。

## 六条硬规矩（违反即本轮作废）

1. **审计者只读，但必须给推荐。**推荐本身要过宪章；程序内不执行任何修改——改是主持者拿到裁决之后的事。
2. **简报自足。**审计者看不到写作过程、看不到其他批次、看不到主持者的怀疑。给了就等于污染。
3. **批次不重叠。**一个文件只归一批。重叠会让同一句话被两套判据过，也会让遗漏查不出来。
4. **禁跨通道聚合数字。**不许输出"公开面共 N 处问题、整体良好"这类结论。每批独立 PASS/FAIL，结论只在这一级成立。
5. **不做转述式验收。**主持者必须亲手在原文件里看到那一行、那段字，才能判"成立"。审计者说了算不算，得看过原文。
6. **门是审计，不是脚本。**`scripts/redline-check.mjs` 清零 ≠ 可发布。

## 主持者回捕网（审计者的两类结构性盲区）

审计者只拿到宪章和文本——**看不见代码，也看不见你的术语表**。两类病它天然查不出，别指望它，由主持者在裁决步补：

1. **术语对表**：文本里的名词逐个对项目术语表核——有没有撞上既有术语的不同含义，有没有用了没登记的新词。
2. **承诺句对签名**：每句"这个工具会 X"，对着实现核（红线 10）。配对由图队列排出——`graph-audit queue` 按符号定位实现、把"声称的量"与"函数体里的量"并列，主持者仍须逐条打开原文确认。**不核就是放行无据宣称**，这是最常见的事故。

**分级核验**（按"这条断言要到哪一层才能证伪"分配，不一刀切）：

| 档 | 什么时候用 | 例 |
|---|---|---|
| 浅核 | 一个文件/一张表/一个常量就能定 | 版本号、配置项是否存在 |
| 常核 | 要开签名与实现、顺导入链 | "自动校验"是否真在校验 |
| 深核 | 仓内证据定不了，需外部知识或复跑 | 与平台行为相关的宣称 |

升档要写理由。每项记**四值裁决**：`证实／驳倒／部分`（方向对细节偏）／`无定`（查了定不了——不硬猜，列出来问作者）。裁决表回捕行格式：`已核 N 项＝证实 a／驳倒 b／部分 c／无定 d`。

## 主语链专查（纯文本就可判的一条）

每句的施动者能否从语法直接确定？两种典型病：

- **话题冒充主语**：把读者最熟的词放句首当主语，真正干动作的词埋进句中。例：「打开 `shipAssets` 的项目，构建在拷贝完随包文件后，自动检查一遍……」——起手主语是"项目"，而真正干动作的是"构建"。 <!-- redline-ok -->
- **指代悬空**："为此""这个""等""其"有没有紧邻的先行词？读一句要回头想"谁在做"，就是违规。

这条审计者能查（不需要代码），所以写进简报必查项。

## 性质门：先分清两种句子

同一份文本里混着两种承诺，判据不同，混着判就会同时出假阳性和漏检：

- **工具承诺句**——"这个工具会 X／保证 X"。必须有测试或构建期检查对上（红线 10），对不上就补门或撤句。
- **技能意图句**——写给 agent 的流程说明（"优先做 A，其次 B"）。允许一定程度的未达成，不逐句索实证。

定标时按批次标出主导性质，写进取证包提示审计者。

## 路由：发现问题之后往哪送

裁决出 FAIL 后，每条问题就地分类，送到该管的环节（细则见 `references/procedure/04-route-close.md`）：

| 问题类型 | 送去哪 |
|---|---|
| 文案本身要改 | 直接改，改完复审 |
| 无据宣称 | 补测试/补门，或撤句——两者选一，不许挂着 |
| 属于"这条信息根本不该出门" | 删，不是改写 |
| 判据本身有分歧（宪章没覆盖） | 停下来问作者，不要自造规则 |
| 实际行为与文档不符 | 修实现或修文档，进 issue 台账 |

## 断点续写

跑一半中断（上下文满、被打断），从 `.audit/rounds/{日期}-{slug}/STATE.md` 续：

```
已完成：00, 01(B1,B2)      待办：01(B3), 02, 03, 04
批次状态：B1 已审待裁决 / B2 已审待裁决 / B3 未装配
```

规则：**已完成步骤的产物不重做**；未完成步骤重跑时沿用已有 STATE.md。裁决必须一次做完（跨会话裁决会失去行号上下文，重开原文核）。

## 怎么调用

自然语言直接说，例如：

- 「跑一次公开面审计，范围是这次要发的版本」→ 增量门
- 「开源前把这个仓的公开面全扫一遍」→ 存量全扫
- 「这个 README 能不能发」→ 单批快审

## 目录

```
SKILL.md                      本文件：入口
references/charter.md         判断体：读者三判断、五通道、11 条红线、翻译规则
references/procedure/*.md     五步执行细则
references/brief-template.md  审计简报模板（逐字照贴）
references/findings-format.md 发现清单格式
references/regression-exam.md 9 题回归考卷（验审计者准不准）
references/graphify-integration.md   图基座：强制依赖、.audit 工作区、三层结构、实测陷阱
references/claim-extraction-spec.md  把"对外声称"抽成可核验节点（含 targets/quantities）
scripts/redline-check.mjs     词表召回（不是门）
scripts/graph-audit.mjs       图基座操作：init/ingest/queue/record/reconcile/status（不判对错）
examples/                     before/after 对照 ＋ 一次完整五步实录
```
