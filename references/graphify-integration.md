# 图基座：本 skill 建立在 graphify skill 之上

> **本 skill 是强制依赖 graphify skill 的**：没有 graphify 技能与 graphify 命令，本 skill 不运行、不降级、不给"手工版"。
> 判断仍是人的；但**检索、配对、记忆一律走图**。这份文件说明图在审计里承担什么、放在哪、怎么维护。

## 为什么是地基而不是配件

审计的本质是**跨载体一致性**：文档说 X，实现是 Y。这句话展开就是一堆"声称 ↔ 实现"的多对多关系，还要跨轮次记住"哪些核过、改没改"。这正是图的形状：

- **节点**：声称（claim）、实现符号、文件；
- **边**：claim→符号 的"约定"关系（配对即图查询）；
- **裁决**：claim 节点上的属性（`audit_verdict`／`audit_note`／`audit_file_hash`）——**记忆就是图本身**；
- **增量**：文件内容哈希没变的声称不再入队——审计跟着内容走，不跟着时间走。

手工审计做不到最后一条，因为它没有持久的共同记忆；这也是"重复审计"的根治办法。

## 审计工作区：住在被审仓里（对象视角）

审计记忆属于**被审对象**：谁的公开面被审，工作区就放谁的根目录。

```
<被审仓>/
  .audit/                        ← graph-audit init 创建；自动写进 .gitignore
    graphify-out/graph.json      ← 图基座（graphify 技能生成与更新）
    claims.json                  ← 声称层账本（写前记录，读取走图）
    verdicts.json                ← 裁决层账本（写前记录，读取走图）
    rounds/<日期-slug>/          ← 每轮的取证包、发现清单、裁决记录
  .gitignore                     ← init 自动加入 .audit/（不存在则创建）
```

一条 `.gitignore` 记录解决三件事：不进版本库、不进公开面（git 视角）、graphify 的 gitignore 感知扫描通常也不会把它卷进图。init 之后仍要核对一次 detect 清单：**`.audit/` 下的文件不得出现在被审文件集里**——它是审计工具自己的影子，不是被审面。

> 这条约定取代了早期"图必须建在被审目录外面"的做法。旧做法能防污染，但审计记忆无家可归、跨轮丢失；新做法把记忆还给对象仓，靠 gitignore 与文件集排除防污染——**两全，但排除必须每轮核一次**。

## 三层结构（深结合）

| 层 | 是什么 | 在哪 | 谁写 |
|---|---|---|---|
| 图基座 | graphify 知识图：文件、符号、社区 | `.audit/graphify-out/graph.json` | graphify 技能（build／update） |
| 声称层 | claim 节点 ＋ claim→符号 配对边 | 同一张图（`_origin: "audit-overlay"`） | `graph-audit ingest-claims` |
| 裁决层 | claim 节点上的 `audit_*` 属性 | 同一张图 | `graph-audit record` |

**读取一律走图**：排队看 claim 节点与配对边，跳过判断看 `audit_verdict` 与 `audit_file_hash`。两个账本（claims.json／verdicts.json）只是写前记录——因为 `graphify update` 会重建图、把审计层冲掉，`graph-audit reconcile` 用账本贴回。**每次 graphify update 之后必须跑 reconcile**，否则会拿一张"没有记忆的图"排队。

## 标准流程（五步的图化形态）

```bash
# 0 · 初始化（每仓一次）
node scripts/graph-audit.mjs init --root <被审仓>

# 1 · 建图（首轮）／增量（以后每轮）
cd <被审仓>/.audit && graphify .. --no-viz          # 首轮
graphify update                                     # 以后：只重抽改过的
node scripts/graph-audit.mjs reconcile --root <被审仓>   # update 之后必跑

# 2 · 抽声称（只读文档的新上下文，按 references/claim-extraction-spec.md）
#      产出 claims.json

# 3 · 声称入图 → 排队
node scripts/graph-audit.mjs ingest-claims --root <被审仓> --in claims.json
node scripts/graph-audit.mjs queue --root <被审仓>

# 4 · 主持者逐条核 → 记裁决
node scripts/graph-audit.mjs record --root <被审仓> --item <id> --verdict <证实|驳倒|部分|无定> [--note ...]

# 5 · 汇总
node scripts/graph-audit.mjs status --root <被审仓>
```

### 图在五步程序里各管什么

| 步 | 图怎么用 | 产物 |
|---|---|---|
| 00 定标 | 节点去重＝文件全集（五通道归类）；社区分组切批次；**孤岛节点＝最容易漏的公开面** | `.audit/rounds/<轮>/00-scope.md` |
| 01 装配 | 只用文件集与批次表；**图产物不进取证包**（见下方界线） | 每批 `01-package-B{n}.md` |
| 02 扇出 | 审计者只拿取证包（不拿图） | 每批 `02-findings-B{n}.md` |
| 03 裁决 | ingest-claims 入图 → queue 排队（符号定位实现、量对照）→ record 记裁决 | `03-adjudication.md` ＋ 图上裁决属性 |
| 04 收口 | status 汇总四值；判定计数与批次 FAIL 对齐 | `04-close.md` |

## 一条不许越的界：图给主持者，不给审计者

| 谁 | 拿到什么 | 绝不能拿到什么 |
|---|---|---|
| 主持者 | 全部：图、queue、记忆账 | —— |
| 审计者 | **只有宪章和本批文本** | claim 节点、源码、术语表、其他批次 |

审计者的全部价值在于它不知道实现是什么样。把 queue 或图产物塞进取证包，它就会替源码说话，而它看不见源码——与 `procedure/01-package.md` 那条禁令（不许放主持者的辩护）同类。

## 队列的评分与含义

`queue` 把"声称的量"与"实现里的量"并列，按可疑度排序：

| 分 | 含义 |
|---|---|
| 10 | targets 里的符号**图与源码都找不到**（最可疑：文档描述了不存在的东西） |
| 9 | 声称只提某个退出码，实现里还有别的退出码（**方向对、细节错**） |
| 8 | 声称的量在函数体内没出现 |
| 7 | 部分 targets 找不到 |
| 1–6 | 量都对上了，仍需人确认 |

`future`／`process`／`quality`／`reference` 四类不进配对——抽出来即违规候选（红线 6／2／9／7），**这是最大的效率来源：大部分违规根本不用核代码**。

**队列为空不等于没有无据宣称**："我们保证写得专业"这种句子在代码里没有对应物，抽不出 targets，靠人读。图管的是可核验的那部分，判断仍是人的。

## 实测陷阱（每条都真踩过）

1. **`.audit/` 卷进被审文件集**：建图后必须核一次 detect 清单。`redline-check.mjs` 已跳过 `node_modules`、`.git`、`.audit`、`graphify-out`——但**别的扫描工具未必**，换工具时先确认它排不排 `.audit/`。
2. **`graphify update` 只重跑代码 AST**：文档改动要显式重跑语义抽取；改完必跑 `reconcile`，否则审计层被冲掉、图上没有记忆。
3. **词频配对不可用**（已被符号配对取代，留档）：靠"共同的词"配对在 41 文件真语料上排出 3 条**全部误报**——`check`、`push` 这类词到处都是。根因是 AST 只给函数名不给函数体，量的事实在图里不存在。**配对靠符号，不靠词**：抽取时就写出 `targets: ["shipAssets check"]`，配对变成在图里找符号节点；而"符号找不到"本身变成一条硬发现（词频法永远得不出它，`verify` 这个词在别处出现只会稀释信号）。
4. **裁决不带文件哈希**：record 时文件不可读就没记到哈希，该条永远会重新入队——提示信息会明说，别忽略。

## 图替代不了的三件事

1. **判断**：量对不上也可能是主持者读错（同名函数、分支差异），必须逐条打开原文确认。
2. **审计者的新鲜眼睛**：它不知道实现，这不是缺陷，是判据。
3. **没有具体量的句子**：质量自评、愿景、口吻问题，靠人读——但这些恰好是 `future`／`process`／`quality` 类声称能直接抓住的。
