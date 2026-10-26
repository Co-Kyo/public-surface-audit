---
name: public-surface-audit
description: |
  Audit every word your project shows to outsiders before you publish — machines do the mechanical pairing, you do the judgment, and one adversarial reader catches what you cannot see in your own writing. Returns a PASS/FAIL verdict per batch. Use when shipping a release, publishing an npm/PyPI package, launching or updating a docs site, writing a README or CHANGELOG, adding files to a package `files` list, reviewing CLI/error text or generated prompt artifacts, or reviewing commit messages and PR titles before they enter public history. Also use when the user asks whether public-facing text leaks internal process, planning, or jargon.
  Trigger when users ask: "公开面审计", "发布前检查文案", "这个 README 能不能发", "有没有把内部的东西写进文档", "文档站文案审一遍", "这个 skill 的文案对外说清楚了吗", "发布前自查", "文案里有没有内部术语".
  Not for: copywriting style, SEO, translation, or fixing implementation bugs (this skill finds where public text and implementation disagree and routes the fix to you). Built on the graphify skill — a hard dependency, see the base section below.
license: MIT
requires: graphify
---

# 公开面审计

## 这个程序解决什么

发布之前，公开面上每一句话都已经被作者读了几十遍——**但这恰恰是问题**：作者知道自己为什么这么写，读者不知道。作者看不见的病，自己查不出来。

本程序把这件事拆成三层，各用各的器官：

| 层 | 谁做 | 凭什么 |
|---|---|---|
| 机械配对 | graphify ＋ 词表脚本 | 声称的量对实现的量、词面命中——**不需要判断，所以能自动化** |
| 逐条裁决 | 主会话（你），带证据 | 宪章判据＋原文行号＋量对照 |
| 陌生视角 | 一个对抗复查 agent（只一次，收口前） | 它没写过这些字，只描述"作为第一次读的人，我的反应" |

**大部分工作在第三层之前就做完了。**实测一轮 45 条裁决里，20 条由图的量比对直接给出线索、25 条靠读文本判——后者不需要查代码，也就没有任何理由为它开一个新上下文。

那还剩什么必须换一双眼睛？**只有一件：你写的句子，你自己不知道它在陌生人眼里是什么意思。**这件事开再多个陌生读者也做不到更好，一个就够——所以它被挪到收口前，只做一次，只问四个问题。

要审的是"这句话该不该给陌生人读"，不是"写得好不好"。所以：

- **不靠词表脚本当门**——脚本只查得到词面，语气、该不该说、承诺有没有据，它都看不见。脚本是召回工具；
- **不靠修改后复读**——已经在公开历史上的错（提交信息、发出去的包）改不掉，只能在源头守；
- **不靠作者"我觉得挺好"**——所以收口前那一次对抗复查不是可选项。

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

## 四步程序

| 步 | 干什么 | 谁做 | 产物（落 `.audit/rounds/{日期}-{slug}/`） |
|---|---|---|---|
| 00 | 定标：初始化工作区、建图/更新、圈文件集、切批次、标性质门 | 主会话 | `00-scope.md` 批次清单 |
| 01 | 取证：**先只读文本**抽声称，再跑图排队、词表、取 diff | 主会话 | `01-evidence-B{n}.md` 证据单 |
| 02 | 裁决：逐条判四值、记回图、出 PASS/FAIL | 主会话 | `02-verdict.md` 裁决表 |
| 03 | 对抗复查与收口：一个陌生读者找"只有你懂的那句"，路由，给门凭据 | 复查 agent＋主会话 | `03-review.md`＋`03-close.md` |

细则见 `references/procedure/00-scope.md` … `03-close.md`。**判据全在 `references/charter.md`**，一切"算不算违规"以它为准。

### 为什么第 01 步要先读文本、再碰代码

旧设计用"每批一个新上下文"解决的是**污染**：作者知道自己为什么这么写，就判不出自己那句有歧义。

单上下文里，这个隔离靠**顺序**做，而且顺序必须可查：

1. 先只读文本，把"这段话声称了什么"记成 `claims.json`（**此时不许打开实现**）；
2. 再读实现，逐条核量。

这不是口头纪律：`claims.json` 的写入时间早于任何核量记录，顺序错了立刻看得出来。**"我先看了代码再抽声称"＝抽取已被污染，重来。**

它挡不住的那部分（我写的句子在陌生人眼里什么意思），交给第 03 步。

## 基座：graphify（强制依赖）

**本 skill 建立在 graphify skill 之上，是硬依赖**：graphify 技能或 graphify 命令缺一，本 skill 停止并报告，**不降级、不给"手工版"**。判断仍是人的；检索、配对、记忆一律走图。架构、维护与实测陷阱见 `references/graphify-integration.md`。

**「命令在、但没有 LLM key」不算缺依赖**：改用 `graphify update`（免 key，产出代码符号＋文档结构节点），不要退回 `--code-only`——那个图文档节点为 0，配对已失效却和正常图长得一样。判据是图里有没有节点，不是有没有 key。

### 审计工作区住在被审仓里

审计记忆属于被审对象：谁的公开面被审，工作区就放谁的根目录。`node scripts/graph-audit.mjs init --root <被审仓>` 一次性建立：

```
<被审仓>/.audit/                  ← init 自动写进 .gitignore（不进版本库、不进公开面）
  graphify-out/graph.json         图基座（graphify 生成；源文件删除后跑 reconcile 补记忆）
  claims.json / verdicts.json     账本（写前记录，读取走图）
  rounds/{日期}-{slug}/           每轮产物
```

init 之后核对一次 detect 清单：**`.audit/` 下的文件不得出现在被审文件集里**——它是审计工具自己的影子，不是被审面。

### 图化的标准流程

```bash
node scripts/graph-audit.mjs init --root <被审仓>          # 每仓一次
cd <被审仓> && export GRAPHIFY_OUT=<被审仓>/.audit/graphify-out
graphify update                                            # 首建与增量同一条；免 key、零 token
# 抽声称：只读文本，按 references/claim-extraction-spec.md 产出 claims.json
node scripts/graph-audit.mjs ingest-claims --root <被审仓> --in claims.json
node scripts/graph-audit.mjs queue --root <被审仓>          # 待核队列
node scripts/graph-audit.mjs record --root <被审仓> --item <id> --verdict <四值>
node scripts/graph-audit.mjs status --root <被审仓>
```

**`GRAPHIFY_OUT` 是这条链上最容易漏的一环**：`graphify update` 不接受 `--out`，写的是「目标目录上一级的 `graphify-out/`」。不设这个变量、或按老写法 `cd .audit && graphify update`，图就落到仓根——而脚本读 `.audit/graphify-out/`，从此增量全白跑。`status` 与 `queue` 发现仓根另有一张图会显式报警。

查图比建图更省事：`graphify explain <符号>` 一条命令给完整调用链带行号；`graphify query "<词>" --budget 600` 先缩范围再精读。预算不是越大越好（实测过阈值输出反而翻倍），详见 `references/graphify-integration.md`。

**记忆就是图本身**：图基座（文件、符号、社区）＋声称层（claim 节点与 claim→符号 配对边）＋裁决层（claim 节点上的 `audit_verdict` 等属性）三层合一。文件内容哈希没变的声称不再入队——**审计跟着内容走，不跟着时间走**。

**图替你省的**：①`future`／`process`／`quality` 三类声称抽出来即违规候选（红线 6／2／9），不用核代码——实测里常占多数；②符号在图与源码里都找不到＝高置信发现（文档描述了不存在的东西）；③已核过的不再重复核。**符号找不到本身就是结论**——词频法很难得出它（词在别处出现只会稀释信号），这是"配对靠符号、不靠词"的原因。

**图替代不了两件事**：判断，和"这句在陌生人眼里什么意思"。它给的是"哪段文字关于这个主题"，不是"这句话违不违规"——`query` 一个语气问题会返回几十个相关节点，一个都不回答你的问题。**队列为空不等于没有无据宣称**："我们保证写得专业"在代码里没有对应物，靠人读。

## 六条硬规矩（违反即本轮作废）

1. **复查者只读，只描述反应。**对抗复查 agent 不改文件、不判违规、不给红线号——它只写"第一次读到这句，我的反应是 X"。判由与处置是主会话的事。
2. **顺序隔离。**第 01 步先只读文本抽声称，再核实现。先看了代码再抽声称＝抽取被污染，重来。
3. **批次不重叠。**一个文件只归一批。重叠会让同一句话被两套判据过，也会让遗漏查不出来。
4. **禁跨通道聚合数字。**不许输出"公开面共 N 处问题、整体良好"这类结论。每批独立 PASS/FAIL，结论只在这一级成立。
5. **判决必须可指认。**每条裁决必须指到：原文的 `文件:行`，或机器给的量对照／词表命中／复跑输出。指不到＝这条判决作废——**不许写"我看过了，没问题"**。
6. **门是审计，不是脚本。**`scripts/redline-check.mjs` 清零 ≠ 可发布。

## 主会话自己要做的两类核查

这两类机器替不了，因为它们要"对着实现读文本"，而不是"比对两个数"：

1. **术语对表**：文本里的名词逐个对项目术语表核——有没有撞上既有术语的不同含义，有没有用了没登记的新词。
2. **承诺句对签名**：每句"这个工具会 X"，对着实现核（红线 10）。配对由图队列排出——`graph-audit queue` 按符号定位实现、把"声称的量"与"函数体里的量"并列，主持者仍须逐条打开原文确认。**不核就是放行无据宣称**，这是最常见的事故。

**分级核验**（按"这条断言要到哪一层才能证伪"分配，不一刀切）：

| 档 | 什么时候用 | 例 |
|---|---|---|
| 浅核 | 一个文件/一张表/一个常量就能定 | 版本号、配置项是否存在 |
| 常核 | 要开签名与实现、顺导入链 | "自动校验"是否真在校验 |
| 深核 | 仓内证据定不了，需外部知识或复跑 | 与平台行为相关的宣称 |

升档要写理由。每项记**四值裁决**：`证实／驳倒／部分`（方向对细节偏）／`无定`（查了定不了——不硬猜，列出来问作者）。裁决表回捕行格式：`已核 N 项＝证实 a／驳倒 b／部分 c／无定 d`。

## 对抗复查：只问四个问题

收口前开**一个**新上下文 agent，输入只有拟发布文件全文＋宪章。**不给它**裁决表、不给代码、不给图、不给写作过程——给了它就替你的结论说话。

它的任务不是"按宪章再审一遍"（那是重复劳动，机器和你已经做过了），是**描述陌生读者的反应**：

1. 哪一句你读完不知道**谁在做**？
2. 哪一句像是**作者在跟自己说话**？
3. 哪一句你会**怀疑它做不到**？
4. 哪一句你**猜作者自己没意识到**它说了什么？

产出上限 10 条，每条只写 `文件:行` ＋ 一句反应。**它不判违规**——所以它的误报成本极低，你筛掉就行；它漏掉的也不致命，因为它补的本来就是你自己的盲区，不是覆盖率。

拿到反应后回到原文判：反应指向真实问题 → 进裁决表，本轮 FAIL；反应是误读 → 记一行"复查者误读＋理由"，**误读本身是信息**：一个人误读，读者就可能误读，该改的是句子的清晰度。

## 主语链专查（纯文本就可判的一条）

每句的施动者能否从语法直接确定？两种典型病：

- **话题冒充主语**：把读者最熟的词放句首当主语，真正干动作的词埋进句中。例：「打开 `shipAssets` 的项目，构建在拷贝完随包文件后，自动检查一遍……」——起手主语是"项目"，而真正干动作的是"构建"。 <!-- redline-ok -->
- **指代悬空**："为此""这个""等""其"有没有紧邻的先行词？读一句要回头想"谁在做"，就是违规。

这条不用代码，第 01 步通读时必须逐句过；它也是对抗复查第 1 问的主要命中区。

## 性质门：先分清两种句子

同一份文本里混着两种承诺，判据不同，混着判就会同时出假阳性和漏检：

- **工具承诺句**——"这个工具会 X／保证 X"。必须有测试或构建期检查对上（红线 10），对不上就补门或撤句。
- **技能意图句**——写给 agent 的流程说明（"优先做 A，其次 B"）。允许一定程度的未达成，不逐句索实证。

定标时按批次标出主导性质，写进 `00-scope.md` 与证据单，裁决时按标注索证。

## 路由：发现问题之后往哪送

裁决出 FAIL 后，每条问题就地分类，送到该管的环节（细则见 `references/procedure/03-close.md`）：

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
已完成：00, 01(B1,B2)      待办：01(B3), 02, 03
批次状态：B1 已取证待裁 / B2 已取证待裁 / B3 未取证
```

规则：**已完成步骤的产物不重做**；未完成步骤重跑时沿用已有 STATE.md。裁决必须一次做完（跨会话裁决会失去行号上下文，重开原文核）。

**中断就写 STATE.md，不分步骤。** 00 定标、01 取证中断时同样要写——前两步中断时轮次目录里可能只有半张批次表、几份证据单，不写 STATE 下一轮就不知道该重来还是接着做。断点续写是全局机制，不是收尾步骤的附属。

## 怎么调用

自然语言直接说，例如：

- 「跑一次公开面审计，范围是这次要发的版本」→ 增量门
- 「开源前把这个仓的公开面全扫一遍」→ 存量全扫
- 「这个 README 能不能发」→ 单批快审

## 目录

```
SKILL.md                      本文件：入口
references/charter.md         判断体：读者三判断、五通道、11 条红线、翻译规则
references/procedure/*.md     四步执行细则
references/review-brief.md    对抗复查简报（收口前那一个陌生读者）
references/verdict-format.md  证据单与裁决表格式
references/regression-exam.md 9 题回归考卷（验判序有没有退化）
references/graphify-integration.md   图基座：强制依赖、.audit 工作区、三层结构、实测陷阱
references/claim-extraction-spec.md  把"对外声称"抽成可核验节点（含 targets/quantities）
scripts/redline-check.mjs     词表召回（不是门）
scripts/graph-audit.mjs       图基座操作：init/ingest/queue/record/reconcile/status（不判对错）
examples/                     before/after 对照 ＋ 一次完整四步实录
```
