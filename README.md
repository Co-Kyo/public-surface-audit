# public-surface-audit

**English** · [中文](README.zh-CN.md)

> **Publish only after strangers have read it.** The *outward surface* is every word your project shows to outsiders — and this Agent Skill puts all of it in front of readers who have never seen it, ruling PASS/FAIL per batch. A batch that fails does not ship.

An Agent Skill · two modes · four steps · eleven redlines · MIT

## The problem

You have read your own README dozens of times. That is exactly the problem: you know why every sentence is there, and the reader does not. Your writing context is the contamination — it is the one thing you cannot audit from inside.

So the question is not **"is this well written?"** It is **"should a stranger be reading this at all?"** Most leaks are not bad prose. They are text written for an audience of teammates: a decision record, a round of review, a ticket number, a fix ledger. Perfectly normal inside the room, an incident once it is outside.

A wordlist script does not answer it either: it sees the shape of words, not tone, not that a sentence has no business existing, not whether a promise has anything behind it. The judgement body puts the test in one line: **does this sentence help the reader use the thing, or help you remember something? The second kind does not get published.** That is the criterion in [`references/charter.md`](references/charter.md), which opens with the keep-or-cut call — does this piece of information belong on the outward surface at all?

Readers arrive with only three questions: *should I use this, how do I run it, how far can I trust it.* A sentence that moves none of them is weight the reader pays for.

## What this is not

This section is itself one of the five finished forms in the charter's translation rules — a **boundary statement**, the "how far can I trust it" form. It is written here the way the skill asks anyone to write one.

| Not this | Why the line is drawn here |
|---|---|
| Copywriting, SEO, or translation | It does not make prose prettier or pages rank. It rules on whether a sentence belongs in front of a stranger. |
| A wordlist scanner | [`scripts/redline-check.mjs`](scripts/redline-check.mjs) is a recall tool, not the gate. **A clean script run does not mean the outward surface is publishable** — tone, the keep-or-cut call, and redlines 10–11 are invisible to regex. |
| A check that your implementation is real | It flags unbacked claims and routes them back to you. The queue *locates* the implementation and lines up the claimed quantity against the real one, but it renders no verdict — confirming each promise against the source is your job in adjudication. It does not judge your code for you. |
| A promise that the writing is any good | Content quality belongs to the writing layer. Claiming it would be redline 9 — this program does not commit the thing it audits. |

## How it works

Four steps. Most of the work happens in the session you are already in — the graph does the mechanical pairing, you do the judging, and one adversarial reader checks the part you cannot see.

| # | Step | Who | Artifact |
|---|---|---|---|
| 00 | **Scope** — list the files, cut batches, tag each batch's nature gate | You | batch list |
| 01 | **Evidence** — read the text *first* and record what it claims, then pair each claim against the implementation | You | evidence sheet |
| 02 | **Verdict** — open every cited line in the original file and rule PASS/FAIL | You | verdict table |
| 03 | **Adversarial review and close** — one stranger reads the text cold, then routing and the gate credential | Reviewer + you | review + close record |

Three rules carry most of the weight:

- **Text before code.** Record what the sentence claims *before* you open the implementation. `claims.json` is written before any `queue` output exists, so the order is auditable — start from the implementation and the claims you extract are already contaminated by what you know.
- **Batches never overlap.** One file belongs to exactly one batch. Otherwise a sentence gets judged against two rubrics at once, and the seam between them is where the miss hides.
- **One stranger, once, at the end.** Not one per batch. The reviewer gets the text and the charter — no verdict table, no source, no graph. It does not rule on violations; it reports its reaction as a first-time reader, and you decide what that reaction means.

Each step's detail: [`references/procedure/00-scope.md`](references/procedure/00-scope.md) through [`references/procedure/03-close.md`](references/procedure/03-close.md).

## What it catches

Eleven redlines. Read the right-hand column and see how many you recognise from your own docs.

| # | Redline | A sentence that trips it |
|---|---|---|
| 1 | Internal record format — public text shaped like a work log | `Ruling: … / Basis: … / Revisit if: …` |
| 2 | Process history — rounds, checks and war stories the reader never sat through | `Cleared after three review rounds` |
| 3 | Internal numbers and jargon — codes only your team decodes | `fix #4821, third rework` |
| 4 | Defect confessions and fix ledgers — your problem list, formatted for public | `Problems × causes × actions` table |
| 5 | Design-philosophy preaching — telling readers how quality is thought about | `First split quality into two kinds, because …` |
| 6 | Unshipped promises and future-tense leaks | `v0.5 will support incremental builds` |
| 7 | Internal anchors — pointers that mean nothing outside the room | `see commit 9f2c1ab` |
| 8 | Self-deprecating honesty — recounting how bad it used to be | `This shipped broken for a while; all of it is acknowledged` |
| 9 | Blending two qualities — claiming content quality for the tool | `guarantees the docs read well` |
| 10 | Unbacked behaviour claims — "will X" with no test or build-time check behind it | `runs on any directory`, and nothing tests that |
| 11 | Shifting the boundary onto the reader — "whether that is any good is your problem" | `whether it reads well is up to your review process` |

Redlines 10 and 11 are machine-invisible and need a sentence-by-sentence ruling. Redlines 1–9 each have a regex backstop in the recall script; it is tuned to over-report rather than miss, and a false positive is cleared with a line-level note.

## Install

Nothing to build. The script is one zero-dependency Node file (Node ≥ 18).

Claude Code or any compatible harness:

```bash
# personal skills directory — available in every project
git clone <repo-url> ~/.claude/skills/public-surface-audit

# or per project, so it travels with the repository
git clone <repo-url> .claude/skills/public-surface-audit
```

Manual — drop the directory into whichever skills folder your harness reads:

```bash
cp -r public-surface-audit ~/.claude/skills/
```

Set it up once per repo: `node scripts/graph-audit.mjs init --root .` creates `.audit/`, adds it (and `graphify-out/`) to `.gitignore`, and prints the exact graph-building command. Then build the graph once:

```bash
export GRAPHIFY_OUT=$PWD/.audit/graphify-out   # required — see "Built on graphify"
graphify update                                 # first build and every increment; no API key needed
```

After that, an audit run is a few commands — see *Built on graphify* below.

**Language boundary:** the reference set ships in Chinese, with technical terms left in English (PASS/FAIL, diff, CLI, batch IDs, `file:line`). The English page is the front door; the judgement body is Chinese prose.

## Quick start

Say it in plain language; the skill picks the mode.

**Incremental gate before a release**

> Audit the outward surface for this release: everything in the diff, plus the files that go public again on every release — README, package description, CHANGELOG.

Expect `.audit/rounds/{date}-{slug}/` to fill up, containing the batch list, one evidence package and findings list per batch, an adjudication table, and either a gate credential or a FAIL list to work through.

**Full scan before open-sourcing**

> Before I open-source this repo, scan the whole outward surface — all five channels, commit history and PR titles included.

Expect a per-channel batch map with a PASS/FAIL per batch. No "N issues overall, largely fine" summary: cross-channel aggregation is banned by design.

**Single README quick review**

> Can this README ship?

Expect one batch, a verdict table with `file:line` for each item, and the exact lines to change.

## What you get

One directory per run, safe to archive or delete:

```
.audit/rounds/{date}-{slug}/
├── STATE.md            where the run stopped: finished steps, per-batch status
├── 00-scope.md         file set, batches, and each batch's nature gate
├── 01-evidence-B1.md   what the text claims, then how each claim measured up
├── 02-verdict.md       PASS/FAIL per item, each with original file:line
├── 03-review.md        what the cold reader reacted to, and what you made of it
└── 03-close.md         where each finding went, plus the gate credential
```

The gate credential is one sentence, written only after every batch is PASS, and it has to point back to the evidence in the verdict table. No pointer, no credential.

## Built on graphify (hard dependency)

This skill stands on top of the **graphify** skill — a hard dependency, not an optional plugin. Judgement stays human; retrieval, pairing and memory all run on a knowledge graph that lives in the audited repo itself.

**The workspace belongs to the object.** `node scripts/graph-audit.mjs init --root <repo>` creates `.audit/` in the project root and adds it to `.gitignore` automatically — the audit's working files never enter version control or the public surface. Three layers share one graph:

| Layer | What | Written by |
|---|---|---|
| Graph base | files, symbols, communities | the graphify skill (build / update) |
| Claim layer | claim nodes + claim→symbol pairing edges | `graph-audit ingest-claims` |
| Verdict layer | `audit_verdict` etc. on claim nodes | `graph-audit record` |

**Memory is the graph itself.** A claim whose file's content hash is unchanged is not re-queued next round; changed ones return with the previous verdict attached. Judgement follows content, not time. `graphify update` preserves the audit layer (verified), but it evicts nodes whose source file is gone — run `graph-audit reconcile` after files are added or deleted to put the memory back.

**One environment variable holds the whole graph chain together.** `graphify update` takes no `--out`: it writes to `graphify-out/` one level above its target. Run it from `.audit` and the graph lands in the repo root while the scripts read `.audit/graphify-out/` — every increment silently no-ops. Set `GRAPHIFY_OUT=<repo>/.audit/graphify-out` (absolute, cwd-independent) and both `extract` and `update` stay on the same graph. `graph-audit status` warns when a stray root-level graph exists.

**No API key is not a dead end.** `graphify extract .` needs an LLM key for docs, but `graphify update` does not — it produces code symbols plus document structure nodes (pages and headings). That is enough to run the queue. Do **not** fall back to `--code-only`: its zero document nodes make pairing useless while still looking like a healthy graph.

**Most violations need no code check at all.** Claims tagged `future` / `process` / `quality` (future tense, development history, self-praise) are violations on their own — redlines 6, 2 and 9. They skip straight to the findings list.

**Symbol not found is itself a finding.** If neither the graph nor the source has a `verify` symbol, the doc is describing something that does not exist — the single highest-confidence signal. Pairing is **by symbol, never by shared words**: words like `check` and `push` appear everywhere, so a word-based match drowns in false positives.

**The queue never judges.** It places "what the doc claims" next to "what the function body actually does"; a mismatch may still be the reader's error, so every line is confirmed against the original text. An empty queue does not mean the surface is clean — "we promise it's professional" has no code correlate at all. See [`references/graphify-integration.md`](references/graphify-integration.md) for the architecture and the measured traps.

## Self-check

This repository runs the program on itself:

- [`self-check.yml`](.github/workflows/self-check.yml) runs `node scripts/redline-check.mjs --stat .` on every push and pull request.
- [`examples/before-after/`](examples/before-after/) holds real rewrites, each labelled with the redline it broke.
- [`examples/walkthrough/`](examples/walkthrough/) records one complete run on a small file set, scoping through closing. In that run the recall script returned zero hits and the verdict still upheld five violations — the worked argument for the gate being an audit rather than a script.
- The same walkthrough ends with the program auditing **its own `SKILL.md`**. The cold reader raised 8 objections; all 8 held. Six of them were invisible to every other layer — a pronoun meaning two different people, an undefined term used before its definition, a rule that contradicted itself, and an argument whose two halves cancelled out. That last one is the reason the review step exists: it found a crack in the reasoning that three read-throughs by the author did not.

This program goes through its own gate before it asks you to pass yours.

## Repo map

```
SKILL.md                          entry: when to use, two modes, four steps, six hard rules
references/charter.md             judgement body: readers, five channels, 11 redlines, translation rules
references/procedure/*.md          how to run each of the four steps
references/review-brief.md         the cold-reader brief, pasted verbatim
references/verdict-format.md      formats for the evidence sheet and the verdict table
references/regression-exam.md     nine questions to calibrate the judge before a real run
references/graphify-integration.md  the graph base: hard dependency, .audit workspace, three layers
references/claim-extraction-spec.md extract "this tool will X" into verifiable claim nodes
scripts/graph-audit.mjs           graph operations: init / ingest / queue / record / reconcile
scripts/redline-check.mjs         wordlist recall — an aid, not the gate
examples/before-after/            real rewrites, labelled by redline
examples/walkthrough/             one full run, recorded
.github/workflows/self-check.yml  dogfood: the recall script on this repository
LICENSE                           MIT
```

## License

MIT — see [`LICENSE`](LICENSE).
