<div align="center">

[![English](https://img.shields.io/badge/Language-English-555555?style=for-the-badge)](README.md) &nbsp; [![中文](https://img.shields.io/badge/%E8%AF%AD%E8%A8%80-%E4%B8%AD%E6%96%87-2ea44f?style=for-the-badge)](README.zh-CN.md)

# FuguNano

### Sakana Fugu 的开放轻量重实现。

<p align="center">
  <img src="https://img.shields.io/badge/Runtime-Node%20%E2%89%A518.18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js >= 18.18" />
  <img src="https://img.shields.io/badge/Engine-TypeScript-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript engine" />
  <img src="https://img.shields.io/badge/fuguectl-25%20%E5%A5%97%E6%B5%8B%E8%AF%95-7c3aed?style=for-the-badge" alt="25 套 fuguectl 测试" />
  <img src="https://img.shields.io/badge/assertions-351-brightgreen?style=for-the-badge" alt="351 个 fuguectl 断言" />
  <a href="https://github.com/BicaMindLabs/FuguNano/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/BicaMindLabs/FuguNano/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI status" /></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-yellowgreen?style=for-the-badge" alt="Apache-2.0 license" />
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/AGENT_RUNTIME.md">Agent Runtime</a> ·
  <a href="docs/WORKFLOW.md">工作流</a> ·
  <a href="docs/SELF_HARNESS.md">Self-Harness</a> ·
  <a href="docs/PARITY.md">Engine 迁移</a> ·
  <a href="NOTICE">归属说明</a>
</p>

<p align="center">
  <img src="docs/readme-overview-zh.svg" alt="FuguNano 多 agent 编码总览" width="920">
</p>

</div>

> FuguNano 是 repo-native 的多 agent 编码 loop：由 9+ LLMs 驱动，
> 通过 Claude Code 隔离运行，并由独立 Codex reviewer 审查。
> 它轻量、有界、可自改进（Self-Harness），不需要训练 coordinator。
> 它不绑定某一类模型或某一个地区的供应商：今天接入你能稳定使用、信任的模型，
> 明天社区可以继续补新的 runtime，而工程闭环保持不变。

## 亮点

- **一个操作面** - `fuguectl` 驱动 preflight、dispatch、cache、integration、review、loop state、routing、skills 和 runtime maintenance。
- **Agent runtime 中立** - 逻辑 agent profile 可以把任务路由到 Claude Code provider instance、Codex model、OpenCode provider，或未来新增的 harness，而 loop 不变。
- **可扩展模型池** - 现有 profile 只是起点。社区可以继续接入可用的商业、开源、私有、本地或自托管模型，而不改变 FuguNano 的核心协议。
- **真实隔离** - worker 在独立 worktree 中编辑，配合 scoped workspace、按需 skills 和 ownership enforcement。
- **审查保持独立** - implementer 写代码，Codex 或另一个配置好的独立 reviewer 给出 `ACCEPTED` / `NEEDS FIX`。
- **输出不会丢** - dispatch 可用 `--out` 持久化 reviewer/agent 输出；join barrier 仍强制“派出 N 个，收回 N 个”。
- **修复有边界** - keep-best、二次确认、询问用户、升级和非收敛状态避免无限循环。
- **免训练学习** - allocation 用 benchmark prior 加 live review outcome 迭代路由；已完成和经人工重标注的失败 TASK trace 会沉淀成按任务、prompt 与失败原因选择回放的 experience memory。
- **Self-Harness 就绪** - TypeScript engine 能挖失败 run、提出有界 harness edits，并只 promote 不回退的改动。

## 快速开始

要求：macOS 或 Linux、Node.js >= 18.18、`git`、`tmux`，以及你选择使用的模型/API 凭证。推荐用 Codex 做 review。

```bash
git clone https://github.com/BicaMindLabs/FuguNano fugunano
cd fugunano

/path/to/fugunano/orchestration/fuguectl/fuguectl help quickstart
/path/to/fugunano/orchestration/fuguectl/fuguectl init --dry-run
make doctor       # 检查本机 CLI 和 provider readiness
make install      # 安装模型启动器
make verify       # 验证 launcher wiring
make ci-clean     # 从干净 engine install 跑完整本地 gate
```

真实 key 不进仓：

```bash
mkdir -p ~/.config
$EDITOR ~/.config/cc-model-secrets.env
```

先选择你要使用的 runtime。TypeScript engine 现在把 agent 建模成 profile：逻辑 id、harness（`fugue-cc` / `codex` / `opencode`）、可选的 harness-native target，以及供 policy 判断的 model family。详见 [docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md)。

可选的 `fugue-cc` worktree fleet 需要把 provider config 放到实际要编辑的项目里：

```bash
cp orchestration/fugue-cc/provider.config.example /path/to/project/.fugue-cc/provider.config
cd /path/to/project
fugue-cc
```

然后在另一个 shell 中运行 operator：

```bash
/path/to/fugunano/orchestration/fuguectl/fuguectl preflight --harness fugue-cc
/path/to/fugunano/orchestration/fuguectl/fuguectl fleet status
```

## Operator Skill

```bash
make install-skill
```

这会把 `/fugunano` 安装到 `~/.claude/skills/fugunano`，作为 Claude Code 的便捷 operator 入口。但 workflow 本身不绑定 Claude Code：Codex、OpenCode、Antigravity 和其他 agent 也可以读取 [AGENTS.md](AGENTS.md)，并通过同一套 agent profiles 派发。安装后可冒烟测试：

```bash
~/.claude/skills/fugunano/fuguectl selftest
```

## Loop 如何工作

```bash
fuguectl preflight --harness codex        # 轻量 reviewer 路径
fuguectl preflight --harness opencode --target opencode/deepseek-v4-flash-free
fuguectl preflight --harness agy
fuguectl preflight --harness lite         # 全部轻量 runtime：codex + opencode + agy
fuguectl preflight --harness fugue-cc     # 完整 worktree fleet 路径
fuguectl task new "implement feature"
fuguectl plan "implement feature" --harness lite --codex-clean --allow-partial --out /tmp/fugunano-plan --task TASK.md
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

| 阶段      | FuguNano 做什么                                                               |
| --------- | ----------------------------------------------------------------------------- |
| Plan      | 运行 preflight，创建 TASK 文件，划分 ownership，选择 worker。                 |
| Dispatch  | 通过 `fuguectl dispatch` 发送 scoped prompts。                                |
| Gather    | 缓存每个终态结果，并等待 join barrier。                                       |
| Integrate | 把通过审查的 worktree cherry-pick 到 `main`；隔离冲突和 ownership violation。 |
| Review    | 请求独立 reviewer 给出 `ACCEPTED` / `NEEDS FIX` verdict。                     |
| Repair    | 用有界 loop 状态机直到 accepted 或 escalated。                                |

完整流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## Fugu、OpenFugu 与 FuguNano

Fugu、OpenFugu 和 FuguNano 在同一条路线上：当单一前沿模型或硬件路径变贵、
变窄、难治理时，系统能力开始来自“协调层”。区别在于这个协调层放在哪里。

<p align="center">
  <img src="docs/readme-fugu-comparison-zh.svg" alt="Fugu、OpenFugu 与 FuguNano 对比" width="920">
</p>

| 系统        | 协调层放在哪里             | 打开的能力                                          | 使用形态                                        |
| ----------- | -------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| Sakana Fugu | API 背后的训练式 conductor | 不绑定单一模型的类前沿多模型合成能力                | 托管 / 闭源服务；conductor 训练与访问在仓库外   |
| OpenFugu    | 开放训练与服务栈           | 重建 Fugu 式 conductor 训练与 OpenAI 兼容服务的路径 | 适合想训练、检查、服务 conductor 路线的团队     |
| FuguNano    | 仓库原生工程闭环           | 免训练的多 agent 编码、独立审查与 Self-Harness      | 可 clone、可审计，先跑起来再决定是否训练 router |

FuguNano 不是要替代 Fugu / OpenFugu，而是把同一方向落到更轻的开放入口上：
先用策略、端口、审查门和 harness 自改进打开协作，再判断是否值得训练一个 conductor。

Planning panel 会打印每个 agent 的 dispatch 耗时；带 `--task` 时还会把 planner 状态、
输出大小或错误类型 / 退出码，以及 artifact 路径通过 append-safe 写入持久化进 TASK log，
所以并发 planner 不会互相覆盖审计行。`dispatch --verbose` 会把 obs 行写到 stderr；带
`--task` 的 dispatch 会把开始状态、终态、耗时、输出大小、失败错误类型和可选 `--out`
artifact 路径持久化进 TASK log。所以真实 Codex/OpenCode/AGY 运行会留下可观察痕迹，同时不污染模型
stdout 或 durable artifact。`task new` 使用独占创建避免并发 operator 抢同一个编号；所有 TASK audit appender
（`task log`、`dispatch --task`、`plan --task`、`summary --task`、`integrate --task`）都会和 `task done`
共享轻量 lock，避免最终关闭状态覆盖并发审计行。

## 命令面

`orchestration/fuguectl/fuguectl` 是生产操作入口。当前有 24 个子命令和 25 套测试。

| 区域                   | 命令                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and recon        | `fuguectl doctor`、`fuguectl init --dry-run\|--write`、`fuguectl version`、`fuguectl preflight --harness fugue-cc\|codex\|opencode\|agy\|lite\|all`、`fuguectl smoke`、`fuguectl fleet status\|up\|down`                                                                                                               |
| Planning               | `fuguectl task new\|log\|done\|handoff`、`fuguectl template <name>`、`fuguectl plan "<goal>" [--harness h\|lite] [--models a,b] [--out <dir>] [--timeout-ms n] [--allow-partial] [--codex-clean] [--harness-arg x] [--codex-arg x] [--opencode-arg x] [--agy-arg x] [--task f]`、`fuguectl goal template\|show\|check` |
| Routing and context    | `fuguectl allocate <type>`、`fuguectl workspace list\|show\|model\|context`、`fuguectl agents template\|validate\|list\|resolve`、`fuguectl skills index\|list\|match\|show\|inject\|validate\|forge`                                                                                                                  |
| Dispatch and gather    | `fuguectl dispatch <target> [--certificate <file>]`、`fuguectl cache init\|put\|fail\|barrier\|collect\|resume`                                                                                                                                                                                                         |
| Integration and loop   | `fuguectl integrate --work <repo>`、`fuguectl loop init\|record\|decide\|status`、`fuguectl run set\|round\|status\|next\|clear`、`fuguectl summary <round>`                                                                                                                                                           |
| Memory and maintenance | `fuguectl experience add\|audit\|eval\|learn\|list\|policy\|promote\|recall\|show`、`fuguectl self-harness template\|run`、`fuguectl runtime check\|adapt`（provider + 已安装 workflow bundle 漂移）、`fuguectl selftest`                                                                                              |

## TASK 交接包

多智能体工程其实是一串 handoff：planner 交给 implementer，implementer
交给 reviewer，reviewer 交给经验学习，最后 repo 交给 CI。借鉴 Agentic EDA
里 handoff validity 的说法，`task handoff` 会把 TASK 文件转成一个有界、确定性的交接包，给下一个消费者看。它包含 TASK provenance（`taskId`、`status`、`priority`、时间戳、`sourceRef`）、Requirements 里的验收条件、Output files 里的交接对象、Subtasks checklist、最近的 Log 证据，以及缺 requirement / 缺 output anchor 这类本地 issue。

```bash
fuguectl task handoff ~/.claude/tasks/TASK-2026-06-29-023.md
fuguectl task handoff ~/.claude/tasks/TASK-2026-06-29-023.md --json --tail 8
fuguectl task handoff ~/.claude/tasks/TASK-2026-06-29-023.md --require-done
```

这不是模型总结，也不会修改 TASK。适合在 review、交给另一个 agent、或 `experience learn` 之前，把“验收条件 / 输出物 / 证据 / provenance”用紧凑格式先交清楚。

## Dispatch 动作证书

PCAA 的核心判断是：异构 agent runtime 不能只依赖某个厂商的 session 记录，而应该给高价值动作携带一个可移植的 action certificate，用来回答“授权了什么、谁授权、按什么语义批准、执行后有什么证据”。FuguNano 的 `dispatch --certificate <file>` 是这个思路的本地、模型无关版本：证书记录 harness/target、prompt hash、output hash/chars、rc/status、TASK provenance、approval class、operator assumptions、externality facts，以及五个 checkpoint：pre-action admissibility、action open、assumption capture、approval、outcome closure。

```bash
fuguectl dispatch gpt-5.5 \
  --harness codex \
  --prompt "review this diff" \
  --certificate /tmp/review.cert.json \
  --approval-class operator-reviewed \
  --certificate-assumption "reviewer is independent" \
  --certificate-externality "destination=local-file"
```

证书是 deterministic JSON sidecar；正常 dispatch stdout 不变。如果用户明确要求写证书但写入失败，dispatch 会非零退出，不会悄悄丢掉 proof artifact。

## Experience Memory

FuguNano 现在把 memory 当成一个小型的 write-manage-read loop，而不是把日志原样塞回上下文。完成的 TASK 可以蒸馏成 reusable method；终态失败或 blocked 的 TASK 默认仍会被拒绝，只有 operator 明确提供 `--allow-failure --lesson` 时才会作为“重标注失败经验”进入 memory。重标注失败还可以携带受控的 `--failure-cause` 标签（`planning`、`context`、`retrieval`、`tooling`、`implementation`、`verification`、`integration`、`runtime`、`policy`、`other`），recall 时可以先按失败原因过滤，再做 query ranking。
每条记录也会带轻量 provenance：`experience add` 写成 `source=manual`，`experience learn --task <TASK.md>` 写成 `source=task:<TASK.md>`。导入/手写记录还可以在写入时加 `experience add --source-ref <url|path|note>`，让浏览器笔记、论文摘要、模型输出导入在之后 recall 时仍然看得到原始来源。需要把手写经验和 TASK 蒸馏经验分开路由时，用 `--source manual|task`；需要只按某一个写入时来源召回时，用 `--source-ref <url|path|note>` 做精确来源路由。记录还会带 `trustKind=trusted|untrusted`：从浏览器、模型输出或其它未经复核通道导入的内容可以用 `experience add --trust untrusted` 标记；operator 手写经验和 TASK 审计学习默认是 `trusted`。`experience promote` 是导入记忆的显式提权路径：只有调用方提供存储时绑定的 `--source-ref`，并再提供至少一个不同的 `--confirm-source-ref`，一条 `untrusted` 记录才会被改写成 `trusted`，确认来源会以 `confirmedBy` metadata 留在记录里。这仍然是 operator 侧的治理原语，不是完整形式化 authority 系统，但它避免了让 LLM 只看内容就判断某条 memory 是否已经可信。当一条新经验明确替换旧经验时，用 `--supersedes <old-slug>` 写入；recall 和自动 prompt 注入默认会隐藏被替换的旧记录，避免过时/冲突经验和新修正一起回放。需要审计旧记录时，用 `--include-superseded` 显式打开。需要审计“为什么选中这条经验”时，加 `--explain`；输出会给出分数、命中的 query 词、存储的 failure cause、当前启用的 cause filter、source filter、source-ref filter、trust filter、superseded filter、这条经验的来源和 stored trust。
需要更保守时，可以在带 query 的手动 recall 上加 `--min-score <n>`；低于这个分数的弱匹配会从本次 recall 结果里被丢掉。如果模型、依赖、API 或工作流刚刚升级，可以在本次手动 recall 上加 `--max-age-days <n>`；旧记录仍然保留在磁盘上，但检索会忽略超出 freshness window 的经验，`--explain` 也会打印当前启用的 age gate。
需要把“召回了什么、为什么召回”单独拿出来评估时，加 `--json`。它会在同一套过滤/排序之后输出稳定 JSON 数组，字段包括 `workspace`、`title`、`slug`、`created`、`sourceKind`、可选 `sourceRef`、`trustKind`、可选 `confirmedBy`、可选 `supersedes`、可选 `failureCause`、`score`、`matchedTerms` 和 `body`。这个输出用于 precision-aware memory retrieval 审计，可以独立于下游 LLM 最终回答来检查召回质量；`--json --explain` 仍只输出 JSON，避免把人工审计行混进机器可读流里。
当 reviewer 或下游 agent 不需要完整 memory 正文，只需要可执行的策略视图时，用 `experience policy <workspace> (<slug>|--query <q>) [--json]`。它会把精确指定或召回出来的经验 deterministic 地转成带 provenance 的 policy card：`[experience:policy]`、`[experience:policy:meta]`，以及从 stored method 里抽取出来的 requirement/output/audit checklist。这个过程不是 LLM 总结，也不会改写 store。
当这份 recall 审计需要跨隐私边界流转时，可以和 `--json` 一起加 `--metadata-only`：它保留同一套 metadata 与命中证据，但用 `bodySha256` 和 `bodyChars` 替代 `body`，让 reviewer 能确认选中的是哪条 memory，却不会拿到原始经验正文。
需要把 recall 本身当成小型 benchmark 跑时，用 `experience eval <workspace> --cases <file> --json`。cases 文件可以是 JSON 数组或 JSONL，每条记录包含 `query`、`expectedSlugs`，以及可选 recall filters。命令会走同一条真实 recall 路径，输出每个 case 的 `precision`、`recall`、`f1`、`hit`、`mrr` 和聚合均值，这样 memory retrieval 不需要借助下游 LLM 最终回答也能被测试。
需要检查 memory store 本身是否满足治理约束时，用 `experience audit [workspace] --json [--max-age-days <n>]`。它仍然走同一条 experience store/list 路径，再交给纯 domain policy 扫描：untrusted 记录缺少写入时 `sourceRef`、trusted 导入/手写记录有 `sourceRef` 但没有 `confirmedBy`、untrusted 记录声明替换旧记录、`supersedes` 指向不存在的目标、确认来源重复或等于原始来源，都会作为 `error` 或 `warning` 输出；如果提供 `--max-age-days`，过旧的 trusted 记录也会被标成 `stale-trusted`。命令在出现 `error` 时非零退出，可以作为 replay 前的 VMG-style 本地 gate。
自动注入 Memory 时，可以给 `workspace context` 或 `dispatch --workspace`
加 `--experience-source manual|task`；它会在 query ranking 和 prompt
assembly 之前套用同一条来源路由。需要让自动注入只回放某一个精确来源时，加 `--experience-source-ref <url|path|note>`。需要更小候选集合时，在同一条自动注入路径上加 `--experience-limit <n>`，限制召回的经验条数；需要硬 prompt 预算时，加 `--experience-budget-chars <n>`，按渲染后的字符数做 deterministic packing，只保留完整的 provenance-bearing memory unit，不截断正文，也不让 LLM 临场改写摘要。自动注入默认只回放 trusted 经验；只有在明确要检查或沙盒使用 untrusted memory 时，才加 `--experience-trust all` 放宽。需要让自动注入只看近期经验时，加 `--experience-max-age-days <n>`。
自动注入进去的经验现在是带 provenance 的 evidence unit：`workspace context` 和 `dispatch --workspace` 会在正文前渲染一行 JSON metadata，例如 `[experience:meta] {"slug":...,"sourceKind":...,"trustKind":...,"created":...}`；如果这条经验有写入来源、失败重标注或替换旧经验，还会带 `sourceRef`、`failureCause` 或 `supersedes`。agent 仍然读到原方法正文，但 reviewer、日志和后续恢复工具能稳定解析这段 memory 为什么会进入 prompt、来自哪里、可信级别是什么。

```bash
cat web-note.md | fuguectl experience add code "browser memory import" \
  --trust untrusted \
  --source-ref https://example.com/original-note

fuguectl experience promote code browser-memory-import \
  --source-ref https://example.com/original-note \
  --confirm-source-ref https://example.com/operator-review

printf "Use the corrected dispatch route." | fuguectl experience add code "new route" \
  --supersedes old-route

fuguectl experience learn code "failed-query retro" \
  --task TASK.md \
  --allow-failure \
  --lesson "Score relevance on title/body tokens only" \
  --failure-cause retrieval \
  --supersedes old-query-retro

fuguectl experience recall code \
  --failure-cause retrieval \
  --source task \
  --source-ref TASK.md \
  --trust trusted \
  --query "dispatch output" \
  --min-score 2 \
  --max-age-days 30 \
  --explain

fuguectl experience recall code \
  --query "dispatch route" \
  --include-superseded \
  --explain

fuguectl experience recall code \
  --query "dispatch output" \
  --min-score 2 \
  --json

fuguectl experience policy code dispatch-observability-retro
fuguectl experience policy code --query "dispatch output" --json

fuguectl experience recall code \
  --query "dispatch output" \
  --min-score 2 \
  --json \
  --metadata-only

cat > recall-cases.jsonl <<'EOF'
{"id":"dispatch","query":"dispatch output","expectedSlugs":["dispatch-observability-retro"],"limit":3,"minScore":2}
EOF
fuguectl experience eval code --cases recall-cases.jsonl --json

fuguectl experience audit code --json --max-age-days 30

fuguectl workspace context code \
  --experience-source task \
  --experience-source-ref TASK.md \
  --experience-limit 3 \
  --experience-budget-chars 1200 \
  --experience-trust all \
  --experience-max-age-days 30 \
  --task "fix dispatch output"
```

这个方向借鉴的是 Agent Workflow Memory、AgentHER、MemRL、agent-native memory、stale/evolving memory、conflict-aware memory、确定性 freshness/conflict resolution、budget-tier routing、token economics、store routing、workflow provenance、execution provenance、evidence tracing、memory lifecycle governance 与 memory poisoning 研究里的共同结论：不要回放所有 trace，不要让模型自己猜哪条冲突记忆才是当前版本，也不要在 memory 进入 prompt 后隐藏它的来源链路。FuguNano 当前这一步刻意保持朴素：按 workspace、来源类别、精确写入时 source ref、trust 标记、显式 supersession、失败模式、检索证据、效用门槛、freshness window 和显式 recall cap 来选择；把 recall 集合暴露成 JSON，方便独立做 retrieval-precision 审计；用来源绑定确认门把导入 memory 从 untrusted 提升为 trusted；在 replay 前扫描 store 的治理违规；在自动注入前用硬字符预算打包完整 memory unit；需要 checklist 而不是完整正文时，把精确/召回经验转成 policy card；然后把被注入的经验渲染成带 source/trust metadata 的 evidence block。学习式 budget-tier routing、语义冲突裁决、更丰富的 provenance graph 与 machine-checked authority 是后续方向。新补的参考包括 [Traversal-as-Policy](https://arxiv.org/abs/2603.05517)、[MemRefine](https://arxiv.org/abs/2606.13177)、[Decision-Aware Memory Cards / CICL](https://arxiv.org/abs/2606.08151)、[Useful Memories Become Faulty](https://arxiv.org/abs/2605.12978)、[Memory for Autonomous LLM Agents](https://arxiv.org/abs/2603.07670)、[MemConflict](https://arxiv.org/abs/2605.20926)、[Don't Ask the LLM to Track Freshness](https://arxiv.org/abs/2606.01435)、[Agent-Native Memory Systems](https://arxiv.org/abs/2606.24775)、[Origin-Bound Memory Authority](https://arxiv.org/abs/2606.24322)、[From Untrusted Input to Trusted Memory](https://arxiv.org/abs/2606.04329)、[A Survey on Long-Term Memory Security in LLM Agents](https://arxiv.org/abs/2604.16548)、[Governed Memory](https://arxiv.org/abs/2603.17787)、[From Storage to Steering](https://arxiv.org/abs/2603.15125)、[Agents That Know Too Much](https://arxiv.org/abs/2606.26627)、[From Agent Traces to Trust](https://arxiv.org/abs/2606.04990)、[LLM Agents for Interactive Workflow Provenance](https://arxiv.org/abs/2509.13978)、[Distilling Feedback into Memory-as-a-Tool](https://arxiv.org/abs/2601.05960) 和 [Structured Belief State](https://arxiv.org/abs/2605.11325)。

## TypeScript Engine

`engine/` 是 typed 实现：严格 TypeScript、ports-and-adapters 分层、纯 domain policy，以及真实 harness / storage adapters。`AgentRegistry` 是从 script-first 编排走向 engine-native 编排的一步：coordinator 能在同一轮里把逻辑 agent id 解析到 `fugue-cc`、Codex 和 OpenCode runtime profile。

```bash
cd engine
npm run check
npm run build
node dist/cli/main.js version
```

当前 engine CLI 暴露：

```bash
fugue version
fugue doctor
fugue init [--dry-run|--write]
fugue fleet status|up|down
fugue allocate <task-type>|list|record|feed|stats|reset|decay
fugue smoke [--harness all|codex|opencode|agy] [--timeout-ms n] [--task <file>] [--out-dir <dir>]
fugue dispatch <target> --harness fugue-cc|codex|opencode|agy [--timeout-ms n] [--codex-clean] [--harness-arg x] [--out <file>] [--certificate <file> [--approval-class class] [--certificate-assumption text] [--certificate-externality fact]] [--require-output] [--verbose] [--workspace ws [--experience-query q] [--experience-source manual|task] [--experience-source-ref ref] [--experience-limit n] [--experience-budget-chars n] [--experience-trust trusted|all] [--experience-max-age-days n]] --template <name>|--prompt-file <file>|--prompt <text>
fugue integrate --work <repo> --agents "a b" [--ownership file] [--dry]
fugue skills index|list|match|show|inject|validate|forge
fugue preflight [--harness fugue-cc|codex|opencode|agy|lite|all] [--model provider/model|--target provider/model] [--config-only] [provider.config]
fugue cache init|put|fail|status|barrier|collect|list|resume --cache <dir>
fugue plan "<goal>" --harness fugue-cc|codex|opencode|agy|lite --out <dir> [--models m1,m2] [--timeout-ms n] [--allow-partial] [--codex-clean] [--harness-arg x] [--codex-arg x] [--opencode-arg x] [--agy-arg x] [--task <file>]
fugue task new|log|done|handoff [handoff: --json --tail n --require-done]
fugue template <name> --dir <templates> [--set KEY=VALUE ...]
fugue workspace list|show|model|context [context: --experience-source manual|task --experience-source-ref ref --experience-limit n --experience-budget-chars n --experience-trust trusted|all --experience-max-age-days n]
fugue experience add|list|show --store <dir> [add: --trust trusted|untrusted --source-ref ref --supersedes slug]
fugue experience audit --store <dir> [workspace] --json [--max-age-days n]
fugue experience learn --store <dir> [--failure-cause cause] [--supersedes slug]
fugue experience promote --store <dir> <workspace> <slug> --source-ref ref --confirm-source-ref ref
fugue experience policy --store <dir> <workspace> (<slug>|--query q) [--source manual|task] [--source-ref ref] [--trust trusted|untrusted|all] [--min-score n] [--max-age-days n] [--include-superseded] [--json]
fugue experience recall --store <dir> [--failure-cause cause] [--source manual|task] [--source-ref ref] [--trust trusted|untrusted|all] [--min-score n] [--max-age-days n] [--include-superseded] [--explain] [--json] [--metadata-only]
fugue experience eval --store <dir> <workspace> --cases <json|jsonl> --json
fugue summary <round> --cache <dir> [--task <file>]
fugue runtime check [--strict] --state <dir> [--skill <installed SKILL.md>] [--alias-skill <legacy SKILL.md>] [--repo-skill <repo SKILL.md>]
fugue runtime adapt --state <dir> [--skill <installed SKILL.md>] [--alias-skill <legacy SKILL.md>] [--repo-skill <repo SKILL.md>]
fugue run set|round|status|next|clear
fugue loop init|record|decide|next|status
fugue goal template|show|check
fugue agent-registry template|validate|list|resolve
fugue self-harness template|run
```

`preflight --harness lite` 通过后，可以用最小 live smoke 确认当前机器上的 runtime 真能跑：

```bash
fuguectl preflight --harness lite
fuguectl smoke --harness all --codex-clean --timeout-ms 120000 --task TASK.md --out-dir /tmp/fugunano-smoke
```

设置 `--out-dir` 时，smoke 会写每个 harness 的 transcript，并额外写入
`summary.json`，里面包含顶层 `status`/`passed`/`failed`/`exitCode`，以及每个 lite runtime 的状态、耗时、输出长度和 artifact
路径，方便 CI 或后续循环直接解析。带 `--task` 时，任务审计里也会记录最终 summary 路径和 pass/fail 计数。

OpenCode 场景下，`preflight --target <provider/model>` 会先检查本机
`opencode models` registry，过期或不可用的模型会在 dispatch 前被拦住。
Antigravity 场景下，`--harness agy` 会走 `agy --prompt`；target 为
`default` 时使用当前 Antigravity 设置，其它 target 会传给 `--model`。
要让 Codex Bar 里的轻量 runtime 一起参与规划，可以用
`fuguectl plan --harness lite` 并行调用 Codex、OpenCode 和 Antigravity。
自定义 lite planner target 时需要加前缀，例如
`--models codex:gpt-5.5,opencode:opencode/deepseek-v4-flash-free,agy:default`。
需要让 Codex planner 忽略本机配置和规则时，加 `--codex-clean`；它会保持 plan 输出目录可写，只作用于 Codex 规划目标，不会污染 OpenCode 或 Antigravity 参数。
探索式规划时可以加 `--allow-partial`：某个 planner 慢或失败时，其他已经成功完成并写出的计划仍然可以进入综合。
设置 `--out` 时，planning 还会写 `<out>/summary.json`，里面包含顶层
`status`/`exitCode`/`allowPartial`/`succeeded`/`available`/`failed`，以及每个 planner 的 artifact 状态、耗时和错误元数据。
这个 summary 会在 dispatch 启动时先写成 `status=running`、每个 planner 为 `artifactStatus=pending`，结束后再原子替换为最终的 `ok|partial|failed` 结果，避免自动化误读上一轮旧摘要。

`runtime check` 也会比较仓库里的 `orchestration/fuguectl/` bundle 和本机已安装的 workflow bundle；自动化需要把安装 skill 漂移视为失败时，加 `--strict`：
`fuguectl runtime check --strict --skill ~/.claude/skills/fugunano/SKILL.md --repo-skill orchestration/fuguectl/SKILL.md`。
默认情况下，当主目标是 canonical `fugunano` skill 时，runtime sync 也会检查 legacy `~/.claude/skills/fugue` alias；迁移期可以用 `--alias-skill` 显式增加别名。`runtime adapt --apply` 会同步所有配置的 skill 目标，避免本机 agent 指令和 helper 入口落后于仓库里的最新工作流。如果 `fugue-cc` 不可用，adapt 仍会同步 bundle，但会保留非零退出码，让自动化知道 provider restart/stamp 被跳过了。

## Self-Harness

Self-Harness 改进的是 harness 配置，不是底层模型。FuguNano 的实现是对上海人工智能实验室论文 [Self-Harness: Harnesses That Improve Themselves](https://arxiv.org/abs/2606.09498) 的 engine-native 抽象。

<p align="center">
  <img src="docs/readme-self-harness-zh.svg" alt="FuguNano Self-Harness loop" width="920">
</p>

```bash
orchestration/fuguectl/fuguectl self-harness template > /tmp/self-harness.json
orchestration/fuguectl/fuguectl self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugunano \
  --cwd /path/to/workspace
```

严格 JSON spec、editable surfaces、验证规则和 smoke tests 见 [docs/SELF_HARNESS.md](docs/SELF_HARNESS.md)。

## 仓库地图

| 路径                           | 内容                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `backends/bin/`                | 模型启动器、registry、`cc-models` 和 `cc-sync`。                                   |
| `backends/{install,verify}.ts` | 本地安装和 launcher 验证。                                                         |
| `orchestration/fuguectl/`      | Node `fuguectl` wrappers、templates、workspaces、skill bundle 和测试。             |
| `orchestration/fugue-cc/`      | runtime bridge 使用的脱敏 provider 配置模板。                                      |
| `orchestration/cn-plugin/`     | Claude Code `/cn:*` 插件和 dispatch agent。                                        |
| `orchestration/agent-team/`    | 更高层多模型规划示例。                                                             |
| `engine/`                      | TypeScript package、domain ports、adapters、CLI 和 Self-Harness loop。             |
| `scripts/`                     | 密钥扫描、launcher lint、docs drift check 和 skill installer。                     |
| `docs/`                        | Agent runtime、workflow、architecture、parity、integrations 和 Self-Harness 指南。 |
| `AGENTS.md`                    | Claude Code、Codex、OpenCode 都可读取的跨 harness 操作入口。                       |

## 安全模型

- 真实 key 只放在 `~/.config/cc-model-secrets.env` 或已 ignore 的本地配置。
- `.fugue-cc/` 不进 git。
- review 路径走 Codex 或另一个独立 reviewer。Antigravity（`agy`）可作为 implementer runtime；旧 `gemini` CLI 已退役。
- join barrier 没收齐所有终态结果前，不进入下一轮。
- 先让确定性 gate 失败，再消耗 reviewer tokens。
- push 前跑 `npm run ci`。

## 开发

```bash
make ci          # scan + launcher lint + docs + plugin/fuguectl + engine checks
make ci-clean    # 同上，但先干净安装 engine dependencies
make scan        # 密钥泄漏 gate
make lint        # Node launcher syntax check
make check-docs  # README + Self-Harness docs drift gate
make test        # cn-plugin + fuguectl selftest
make test-engine # TypeScript engine typecheck + lint + vitest
make doctor      # 本机环境侦察
make help        # 列出所有 make targets
```

根目录 npm scripts 镜像同一批 gates：

```bash
npm run ci
npm run ci:clean
npm run lint:launchers
npm run test:fuguectl
npm run test:engine
```

## 安全报告

见 [SECURITY.md](SECURITY.md)。仓库只放脱敏 examples，CI 会扫泄漏，漏洞请通过 GitHub Security Advisory 私下报告。

## 致谢

- [Sakana AI Fugu](https://sakana.ai/fugu/) 给出了多模型编排框架。
- [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) 是互补的训练式重建。
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 提供了 `/cn:*` 层派生的 plugin 架构。
- [Zleap-AI/Zleap-Agent](https://github.com/Zleap-AI/Zleap-Agent) 启发了 workspace isolation 和 experience memory。
- [SeemSeam/claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge) 作为 provider-runtime bridge 的参考。
- 上海人工智能实验室的 [Self-Harness 论文](https://arxiv.org/abs/2606.09498) 启发了 `fuguectl self-harness` 的 harness-improvement loop。
- [Proof-Carrying Agent Actions](https://arxiv.org/abs/2606.04104) 支撑了 `dispatch --certificate` 背后的 runtime-neutral action certificate 与 checkpoint 设计。
- [Agentic Electronic Design Automation: A Handoff Perspective](https://arxiv.org/abs/2606.19795) 与 [HarnessFix](https://arxiv.org/abs/2606.06324) 支撑了 `task handoff` 交接包背后的 handoff validity 与 trace-to-harness-flaw 思路。
- [Agent Workflow Memory](https://arxiv.org/abs/2409.07429)、[AgentHER](https://arxiv.org/abs/2603.21357)、[MemRL](https://arxiv.org/abs/2601.03192)、[How Memory Management Impacts LLM Agents](https://arxiv.org/abs/2505.16067)、[Agent-Native Memory Systems](https://arxiv.org/abs/2606.24775)、[STALE](https://arxiv.org/abs/2605.06527)、[Governing Evolving Memory in LLM Agents](https://arxiv.org/abs/2603.11768)、[Agent Memory: Characterization and System Implications](https://arxiv.org/abs/2606.06448)、[MemMachine](https://arxiv.org/abs/2604.04853)、[RCR-Router](https://arxiv.org/abs/2508.04903)、[BudgetMem](https://arxiv.org/abs/2602.06025)、[Token Economics for LLM Agents](https://arxiv.org/abs/2605.09104)、[Graph Memory for LLM Agents](https://arxiv.org/abs/2606.06036)、[Externalization in LLM Agents](https://arxiv.org/abs/2604.08224)、[Cost-Sensitive Store Routing](https://arxiv.org/abs/2603.15658)、[Compute Allocation for Reasoning-Intensive Retrieval Agents](https://openreview.net/forum?id=nqr4eTODKl) 和 [RecoAtlas](https://arxiv.org/abs/2605.18805) 启发了 stale-aware、按失败原因过滤、来源可见、预算可控、可解释、带效用门控的 experience replay。
- [Traversal-as-Policy](https://arxiv.org/abs/2603.05517)、[From Agent Traces to Trust](https://arxiv.org/abs/2606.04990)、[PROV-AGENT](https://arxiv.org/abs/2508.02866)、[LLM Agents for Interactive Workflow Provenance](https://arxiv.org/abs/2509.13978)、[Distilling Feedback into Memory-as-a-Tool](https://arxiv.org/abs/2601.05960) 与 [Structured Belief State](https://arxiv.org/abs/2605.11325) 支撑了 provenance-bearing injected memory、`experience policy` 和 `experience recall --json` 背后的 evidence tracing、workflow provenance、policy card 与 retrieval precision 设计。
- [MemoryAgentBench](https://openreview.net/forum?id=DT7JyQC3MR) 与 [StructMemEval](https://arxiv.org/abs/2602.11243) 把 memory 当作独立能力评估，支撑了 `experience eval` 这种直接跑 recall cases 的本地 benchmark。
- [MRMMIA](https://arxiv.org/abs/2605.27825) 揭示了 agent memory 的 membership inference 风险，支撑了 metadata-only recall audit：用正文哈希替代原始 memory 文本。
- [Securing LLM-Agent Long-Term Memory Against Poisoning](https://arxiv.org/abs/2606.24322)、[From Untrusted Input to Trusted Memory](https://arxiv.org/abs/2606.04329) / [OpenReview](https://openreview.net/forum?id=5cgg9yenCZ) 和 [Agents That Know Too Much](https://arxiv.org/abs/2606.26627) 支撑了写入时 trust metadata、自动注入 trusted-only gate、以及 `experience promote` 的来源绑定提权路径，用来开始处理 memory write-channel 与跨会话隐私风险。
- [A Survey on Long-Term Memory Security in LLM Agents](https://arxiv.org/abs/2604.16548)、[Governed Memory](https://arxiv.org/abs/2603.17787)、[From Storage to Steering](https://arxiv.org/abs/2603.15125) 与 [From Agent Traces to Trust](https://arxiv.org/abs/2606.04990) 支撑了 `experience audit` 的 lifecycle governance、VMG、memory control-flow 和 provenance 风险建模。
- [MemRefine](https://arxiv.org/abs/2606.13177)、[Decision-Aware Memory Cards](https://arxiv.org/abs/2606.08151)、[Useful Memories Become Faulty](https://arxiv.org/abs/2605.12978) 与 [Memory for Autonomous LLM Agents](https://arxiv.org/abs/2603.07670) 支撑了 `--experience-budget-chars` 背后的 storage-budgeted、decision-relevant、evidence-preserving memory management 方向。
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) 与 [lavish-axi](https://github.com/kunchenguid/lavish-axi) 启发了 loop-state 和 docs-drift 思路。
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) 启发了编排器侧 ownership enforcement。
- Anthropic 官方 `skill-creator` meta-skill 支撑了 skill authoring 和 validation flow。

归属细节见 [NOTICE](NOTICE)。

## 许可

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
