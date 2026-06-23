# fugue

[![CI](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml/badge.svg)](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-313%20passing-success.svg)](orchestration/fanout)

**[English](README.md) | 简体中文**

> **fugue** 是 [Sakana AI 的 Fugu](https://sakana.ai/fugu/) 的一个开源、harness 工程化版本：**多 agent 藏在单一接口后**，靠*编排*而非更大的模型协调成一个可信答案。一池便宜模型负责实现，一个独立家族的 reviewer 负责评判，一个**有界的 review-fix 循环**收敛到验收——永不无限循环，也永不硬标"完成"。

Fugu 的赌注是：**杠杆是协调，而不是模型本身的大小**——一个学习出来的协调器把任务路由给各专长 agent，再验证结果。fugue 用**工程而非训练**复刻了这个*形状*：一个 [`fanout`](#fanout-命令行) CLI 就是那个单一接口；**9 个国产 LLM**（每个都是一个隔离的 Claude Code 实例）是 workers；一个不同家族的 reviewer（Codex）是 verifier；路由器是一个**从每条 review verdict 学习"哪个模型擅长哪类任务"的贝叶斯 bandit**——Fugu 那个进化协调器的免训练版本。一个 fan-out/fan-in 缓存保证完整性，按任务的 **workspace 隔离**让弱模型不至于淹没在 context 里。

---

## 目录

- [为什么](#为什么)
- [架构](#架构)
- [与 Sakana Fugu 的关系](#与-sakana-fugu-的关系)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [作为 Claude Code Skill 安装](#作为-claude-code-skill-安装)
- [`fanout` 命令行](#fanout-命令行)
- [工作流](#工作流)
- [设计原则](#设计原则)
- [开发](#开发)
- [安全](#安全)
- [致谢](#致谢)
- [许可](#许可)

---

## 为什么

便宜/小模型会在 agent 每一步都给它看*全部*工具、记忆、规则和消息时失败——延迟和注意力被浪费，模型也会犯错（本仓里一份实测 [模型基准](orchestration/fanout/allocation.tsv) 精确显示了哪个模型在哪类任务上崩）。本项目用 **harness 工程**而非更大的模型来解决它：

- **跨家族分离** —— 实现者（国产模型）≠ reviewer（Codex）。生成 ≠ 审查，比自审强约 20%。
- **有界自我纠错** —— 一个带确定性闸门、keep-best、不收敛时元反思的 review-fix 循环（参考 Self-Refine / Reflexion / loop-engineering 研究）。
- **Context 隔离** —— 每个任务跑在一个只暴露它所需 prompt、工具、记忆和模型的 *workspace* 里。
- **完整性保证** —— 一个 fan-in barrier：派出 N 个任务 ⇒ 必须 N 个全部返回，本轮才推进。
- **自适应路由** —— 模型分配表是个贝叶斯 bandit：从手调先验起步，按每条 review verdict 学"哪个模型擅长哪类任务"（Thompson Sampling 探索、模型升级后 decay）——学习式协调器的免训练版。
- **技能渐进式披露** —— 一个母目录索引本机所有 skill（3 源），Planner 只把每个 agent 真正需要的那几个注入进去，而不是拿 500+ 个 skill 淹没弱模型——而且任务中学到的方法**沉淀回母目录**（闭环：index → dispatch → forge → validate → 重新 index）。

---

## 架构

<img src="docs/architecture.svg" alt="fugue architecture" width="760">

<details>
<summary>文本版示意图</summary>

```
                  ┌─────────────────────────────────────────────┐
   Planner         │  Claude (Desktop or Claude Code)            │  plan · split · decide · integrate
                  └───────────────┬─────────────────────────────┘
                                  │  ccb ask  (TASK file → ~/.claude/tasks/)
                  ┌───────────────▼─────────────────────────────┐
   Executor       │  Claude Code  =  fanout skill (5 phases)      │  dispatch · quality gate · loop
                  └──┬──────────────────────┬───────────────┬────┘
                     │ ccb dispatch         │               │ ccb ask coder
        ┌────────────▼───────────┐   ┌──────▼──────┐   ┌─────▼─────────┐
 Impl.  │ 9 Chinese CC backends   │   │ shared git   │   │ Codex (gpt-5.5)│ Reviewer
        │ deepseek/glm/kimi/qwen │   │ worktrees    │   │ = quality gate │
        │ doubao/minimax/mimo/   │   │ (main =      │   └─────┬─────────┘
        │ stepfun/longcat        │   │  truth)      │         │ VERDICT
        └────────────┬───────────┘   └──────┬──────┘         │
                     └────────► Phase 5: Review-Fix Loop ◄────┘
                          (gate → review → keep-best → fix, bounded)
```

</details>

| 角色 | 是谁 | 职责 |
|---|---|---|
| **Planner / Integrator / Fixer** | Claude（Desktop 或 Claude Code） | 规划、拆任务、整合、打补丁，握有最终运行决策权 |
| **实现者 Implementers** | 9 个国产模型经 [ccb](https://github.com/SeemSeam/claude_codex_bridge)（`cc-deepseek` `cc-glm` `cc-kimi` `cc-qwen` `cc-doubao` `cc-minimax` `cc-mimo` `cc-stepfun` `cc-longcat`）+ `cc-claude` | 在隔离的 worktree 里写代码 |
| **前端 Frontend**（可选） | Antigravity（`agy` CLI） | 只做前端/UI——绝不 review（它的后端是 Gemini） |
| **审查者 Reviewer** | Codex（`coder`） | 独立 VERDICT：ACCEPTED / NEEDS FIX——建议性，非强制 |

> 人（你）始终是最终权威：模型档位变更和不收敛的循环都会升级给你。

---

## 与 Sakana Fugu 的关系

[Sakana AI 的 Fugu](https://sakana.ai/fugu/) 把一池多样的模型藏在**一个 OpenAI 兼容 API**（Fugu / Fugu Ultra）后面；对外的路由是**专有不公开**的。它背后的*学习式*编排见两篇 ICLR 2026 论文：

- **TRINITY**（[arXiv:2512.04695](https://arxiv.org/abs/2512.04695)）—— 一个**进化**出来的协调器（**Qwen3-0.6B** 骨干，用 **sep-CMA-ES** 调，而非 RL/SFT），每轮选一个模型**和**一个角色 {**Thinker / Worker / Verifier**}，Verifier 接受即终止。
- **Conductor**（[arXiv:2512.04388](https://arxiv.org/abs/2512.04388)）—— 一个用 **RL（GRPO）** 训的 **Qwen2.5-7B** 协调器，每步动作是 *{一个模型, 一个自然语言子任务, 一个 access-list（谁能看谁的输出）}*。

fugue 是这个*想法*的一个**独立、免训练、可自托管的类比**——它用 **harness 工程**而非 RL/进化管线达成相似的分工：

| Sakana Fugu（TRINITY / Conductor） | fugue |
|---|---|
| 多 agent 藏在一个 **OpenAI 兼容 API** 后 | 多 agent 藏在一个 `fanout` bash CLI 后，你（或任何 agent）来驱动 |
| **Thinker / Worker / Verifier** 角色（TRINITY） | Planner / Implementers / Reviewer，按约定接线——生成 ≠ 审查 |
| **进化协调器** —— Qwen3-0.6B + sep-CMA-ES（TRINITY） | 自适应 `allocate` —— 一个透明的 Beta-Bernoulli bandit，从 verdict 学习，**零训练** |
| **RL 学出来的自然语言子任务** —— GRPO（Conductor） | 一条手写的 5 阶段流水线 + prompt 模板 |
| **Access-list** —— 谁能看谁的输出（Conductor） | context 隔离 —— workspace 裁剪 + 技能渐进披露 + `integrate --ownership` |
| 信任输出前先验证（Verifier 角色） | 一个有界 review-fix 循环，在任何模型自报之前先过确定性闸门 |

**相同的是**哲学—— *用 harness 做客观验证，不信模型自报*，并让协调（而非模型大小）来干活。**不同的是**：Fugu **训练/进化**它的协调器（并对外是一个托管的专有 API）；fugue 免训练、今天就能跑在任何模型队上——它的"学习"是从每条 review verdict 更新的贝叶斯先验+后验，不是梯度步，而且每个路由决策都是透明的 bash。它受 Fugu 的*框架*启发，**不源自** Sakana 的代码或模型——一个手写 harness 在协调质量上会输给训练出来的 0.6B 协调器（论文的消融证明角色/深度确实有用），但它零成本可跑、每个决策可审。

> **想要忠实复现？** [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) 是**真训**协调器的版本——TRINITY 用 sep-CMA-ES、Conductor 用 GRPO，权重已公开——并把它们当 OpenAI 兼容 API 对外服务，重建了 Fugu 的架构。fugue 刻意走**免训练的 harness 路线**：没有权重、没有 GPU、没有训练管线——只是编排一池你今天就能读、能跑的模型，接进一条编码工作流而非一个服务端点。同一个灵感，互补的答案。

---

## 仓库结构

| 路径 | 内容 |
|---|---|
| `backends/bin/` | 国产模型后端：`cc_model_launch` 公共核心 + 9 个瘦 `*-code` 启动器 + `cc-model-registry.tsv` + `cc-models` 派发器 + **`cc-sync`**（自动跟随 Claude Code + 模型更新） |
| `backends/{install,verify}.sh`、`backends/prompts/` | 安装 / 自检 / 每个 provider 的 prompt 增补 |
| `orchestration/fanout/` | `fanout` CLI（18 个子命令）+ **`fanout-lib.sh`/`fanout-testlib.sh`**（公共助手 + TTL 缓存，每个工具/测试都 source）+ `SKILL.md`（5 阶段工作流 + Phase 5 loop）+ `workspaces/` + `templates/` + 18 套测试 |
| `orchestration/ccb/ccb.config.example` | 脱敏的 ccb 多窗口拓扑模板（占位 key） |
| `orchestration/cn-plugin/cn/` | Claude Code 插件：`/cn:*` 命令 + `cn-dispatch` agent（派生自 `openai/codex-plugin-cc`） |
| `orchestration/agent-team/` | Workflow 工具编排示例（多模型规划 → 实现 → 审查） |
| `scripts/` | `scan-secrets.sh`（密钥泄漏门）+ `check-shell.sh`（bash -n + shellcheck）+ `check-docs.sh`（docs-match-code 漂移门）+ `install-skill.sh`——Make / CI / pre-commit 同源复用 |
| `AGENTS.md` | 跨 harness 入口——Claude Code / Codex / OpenCode 都读它；一个 bash CLI 从任何 agent 驱动工作流 |
| `docs/` | [`WORKFLOW.md`](docs/WORKFLOW.md)（端到端流水线）· [`AGENT_TEAM.md`](docs/AGENT_TEAM.md)（多模型规划 + sub-agent）· [`INTEGRATIONS.md`](docs/INTEGRATIONS.md)（把 fugue 当引擎消费，如 CivAgent） |

---

## 快速开始

**要求：** macOS/Linux · Node ≥ 18.18 · `git`、`tmux` · [ccb](https://github.com/SeemSeam/claude_codex_bridge)（多窗口 fan-out 用）· `codex`（reviewer）· 可选 `agy`（前端）。

```bash
git clone https://github.com/BicaMindLabs/fugue
cd fugue

# 0) 看这台机器有什么 + 拿一份工作流推荐（绝不读 key 的值）
make doctor

# 1) 装后端（镜像 ~/bin/cc-*；key 放 ~/.config/cc-model-secrets.env）
./backends/install.sh                  # 只装启动器
./backends/install.sh --install-claude-code   # 顺带按 env 装钉死版 claude-code
./backends/verify.sh && cc-models doctor

# 2) 单机、轻量 fan-out（不用 ccb）：在 Claude Code 里用 /cn:* 插件
#    /cn:team  /cn:ask  /cn:glm ...

# 3) 完整多 agent 工作流（ccb 多窗口）
cp orchestration/ccb/ccb.config.example /path/to/proj/.ccb/ccb.config   # 填真 key
cd /path/to/proj && ccb                # 起 planner/work/ark/review 窗格
#    然后驱动 5 阶段 fanout（见 docs/WORKFLOW.md）
```

API key **只**放在 `~/.config/cc-model-secrets.env`（启动器读它）——绝不进仓。见 [安全](#安全)。

---

## 作为 Claude Code Skill 安装

编排层以一个**可按名调用的 Claude Code Skill** 形式发布。一行安装：

```bash
make install-skill        # → ~/.claude/skills/fanout（已有的副本会先备份）
```

然后**重启你的 Claude Code 会话**并唤醒它：

- 斜杠命令：**`/fanout`**
- 或者直接描述一个多 agent 任务——它会在类似 *"fan out X"*、*"用模型队 + 一个 reviewer 做 Y"*、*"前端 + 后端 + review"*、*"拆给多个 agent 并行"* 的措辞上自动触发。

安装器会拷贝该 skill 加上所有 `fanout` 工具、workspaces 和 templates；用 `~/.claude/skills/fanout/fanout selftest` 验证。API key 绝不随 skill 走——它们待在 `~/.config/cc-model-secrets.env`。

---

## `fanout` 命令行

`orchestration/fanout/fanout` 是唯一入口——一个任何 agent（或你）都能驱动的 bash CLI。运行 `fanout help` 看完整列表；这 **18 个子命令**按它们在流水线里的位置分组。

**Setup & 侦察**

| 命令 | 作用 |
|---|---|
| `fanout doctor` | 探测已装的 agent/CLI + 已配的 API → 推荐一条工作流 |
| `fanout fleet status\|up\|down` | 起 / 查 / 停 ccb fleet——剥掉 `CLAUDE_CODE_*`（避开 OAuth 假 401），窗格在 detached tmux 里；就绪判定 = `mount_state: mounted`（不看配置意图） |
| `fanout preflight [cfg]` | Go/no-go 闸门：依赖 · ccbd 已挂载 · ccb.config 合理性 · **no-Gemini 守卫** · `.ccb/` 已 gitignore · `--probe` 端点活体 |

**Plan & 路由**

| 命令 | 作用 |
|---|---|
| `fanout task new\|log\|done` | 脚手架 / 记录 / 关闭一个 TASK 文件（审计轨迹） |
| `fanout plan "<goal>" [--models a,b,c]` | **规划面板** —— 把一个目标分解扇给若干模型 |
| `fanout allocate <type> [--top] [--sample]` · `record`·`feed`·`stats`·`reset`·`decay` | **学习式路由**（Beta-Bernoulli）：静态 bench 先验 + verdict 后验。`feed --from-ledger` 闭合飞轮（`dispatch --task-type` 记 `(type, agent)`，整轮一把 `feed` 更新）；`--sample` = Thompson Sampling（探索少样本 agent；Agrawal-Goyal 2012）；`decay` 模型升级后折扣陈旧统计（Garivier-Moulines 2011） |
| `fanout workspace list\|show\|model\|context <ws>` | 按任务的 **context 隔离** —— 组装 `System + Workspace + Tools + Memory + History` |
| `fanout skills index\|list\|match\|show\|inject\|validate\|forge` | **技能母目录** —— 扫 **3 源**（user `~/.claude/skills` + `.system` 元技能含官方 `skill-creator` + plugin 市场，`plugin:skill` id）成一个紧凑 catalog（source · functional/note · path）；`inject` 只把选中的 skill 喂进某 agent（配 `dispatch --skills` 做渐进披露）。**`forge`** 闭合循环：取沉淀的方法（`--from-experience`/`--source`）→ 候选门 → 派一个 worker 注入 `skill-creator` 去写新 skill → **`validate`** 质量门（镜像官方 `quick_validate.py`；`--official` 直接用它）→ `index --refresh` 回灌母目录（撰写委托官方 skill-creator） |
| `fanout template <name> [--set K=V]` | 渲染一个 prompt 模板（`impl` / `analysis` / `review`） |
| `fanout goal template\|show\|check <spec>` | **Goal 模式** —— 声明式目标 + 确定性验收门 |

**Dispatch & 收集**

| 命令 | 作用 |
|---|---|
| `fanout dispatch <target> [--harness ccb\|codex\|opencode] [--workspace ws] [--task-type T] [--skills a,b]` | 派给**任意 harness**（ccb / codex / opencode）上的一个实现者：渲染 → 跑 → 记录；`--task-type` 喂路由飞轮，`--skills` 只注入需要的 skill |
| `fanout cache init\|put\|fail\|barrier\|collect\|resume\|...` | 结果缓存 + **fan-in barrier**（派 N ⇒ 收 N）+ 计时 + resume |

**Integrate · review · loop**

| 命令 | 作用 |
|---|---|
| `fanout integrate --work <repo> --agents "a b" [--ownership <file>]` | **Phase 3** —— 各 worktree cherry-pick 到 `main`，**冲突隔离**（冲突 agent 单独 abort 并报告，其余照常落地）。`--ownership` 加**越界检测**（每 agent 的 owned/forbidden glob）：worker 改了越界文件 → 标 `violation` 扣下——*编排器侧强制、不信 prompt*（借鉴 Lynn） |
| `fanout loop init\|record\|decide\|status` | **Phase 5** review-fix **状态机** —— `record` 每轮（`--ask-user K` 分类 Findings）→ `decide` 返回一个退出态：DONE / CONFIRM / CONTINUE / **ASK_USER** / ESCALATE_MAX / ESCALATE_NONCONV；keep-best 自动维护 |
| `fanout run set\|round\|status\|next\|clear` | **Run 状态门面**（axi 启发） —— 把跨阶段状态（TASK / round / barrier N-of-M / loop decision / best）聚合成**一个机器可解析的 JSON** |
| `fanout summary <round> [--task f]` | 单轮可观测性摘要（状态 + 耗时） |

**观测 & 维护**

| 命令 | 作用 |
|---|---|
| `fanout experience add\|list\|recall\|show <ws>` | **经验记忆** —— 完成的工作 → 可复用方法 → 脱敏 → 召回进 context |
| `fanout ccb-sync check\|adapt [--apply]` | ccb 更新后适配（版本漂移 · 嫁接检查 · ccbd 重启） |
| `fanout selftest` | 跑全部 18 套测试（313 断言；主机无 pty 设备时 3 个 fleet 检查自动跳过） |

---

## 工作流

核心是一条 **5 阶段流水线**（完整细节见 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)）：

1. **Plan** —— preflight 闸门 + 脚手架一个 TASK 文件，按文件拆分。
2. **Dispatch + cache + barrier** —— `ccb ask` 并行；每个结果先缓存；fan-in barrier 要求 N 个全部返回才推进。
3. **Integrate** —— `fanout integrate` 把各 worktree cherry-pick 到 `main`，**冲突隔离**（冲突 agent 单独 abort 并报告，其余照常落地）；跑本地 sanity。*（前提：work repo 必须 `.gitignore` `.ccb/`——worktree 在它里面。）*
4. **Review** —— Codex 返回一个 VERDICT。
5. **Review-Fix Loop**（有界，由 `fanout loop` 状态机驱动） —— 先确定性闸门 → 增量 review → keep-best（回退退化）→ operator 打补丁；`fanout loop decide` 恰好返回一个退出态（DONE / CONFIRM / CONTINUE / ESCALATE_MAX / ESCALATE_NONCONV）；封顶后升级——永不无限循环，也永不硬标完成。

**更高层的入口模式**叠在上面：

- **Goal 模式** —— `fanout goal check <spec>` 跑一个 loop 朝其收敛的声明式验收门。
- **规划面板** —— `fanout plan` 把分解扇给多个模型；综合进 Phase 1。
- **Workspace 隔离** —— `fanout dispatch --workspace <ws>` 只给模型该工位需要的 context。
- **自适应分配** —— `fanout allocate` 把静态 bench 表（先验）和 `record` 的 verdict（后验）混合，随 loop 把结果喂回而自我改进——无需训练。
- **技能母目录 + 闭环** —— `fanout skills index` 把本机所有 skill（user + `.system` 元技能 + plugin 市场）建成母目录；Planner 读它来分配，`dispatch --skills` 只注入需要的那几个（渐进披露），`fanout skills forge` 把学到的方法沉淀成一个*新* skill——由官方 `skill-creator` 撰写、过 `validate` 门、再用 `index --refresh` 回灌母目录。

多模型规划 + 层级 sub-agent（ccb fleet vs 原生 Claude Code subagent）见 [`docs/AGENT_TEAM.md`](docs/AGENT_TEAM.md)。

---

## 设计原则

- **生成 ≠ 审查** —— 实现者和 reviewer 是不同的模型家族。
- **`main` 是唯一真相源** —— 实现者在 worktree 沙箱里干活；只有过审的改动才 cherry-pick 回来。
- **有界循环** —— 先闸门、keep-best、≥2 轮确认、元反思；封顶后升级。永不无限循环，也永不硬标 DONE。
- **缓存优先 + fan-in barrier** —— 每个结果都被持久缓存；派 N ⇒ 下一轮前收 N。
- **Context 隔离** —— 弱模型只看到 workspace 需要的东西。
- **自适应路由，非静态** —— 分配是个 Beta-Bernoulli bandit（bench 先验 + verdict 后验、Thompson Sampling 探索）；用 loop 的 verdict 自我改进、零训练。
- **渐进披露 + 技能沉淀** —— agent 只看到它需要的 skill（覆盖 3 源的母目录），任务中学到的方法闭环回灌母目录——由官方 `skill-creator` 撰写、过 `validate` 门校验。
- **密钥不进仓** —— 只在 `~/.config/cc-model-secrets.env`；仓里只发 `.example`。pre-commit + CI 扫描拦泄漏。
- **文档对齐代码** —— 一个 `check-docs` 闸门：README 的子命令/数量一旦与实际 `fanout` CLI 漂移就让 CI 失败。
- **公共库、零样板** —— 消息 / 可移植 `mtime` / TTL 探测缓存 / 缓存根都在 `fanout-lib.sh`（测试共用 `fanout-testlib.sh`），每个工具 source 它而非复制粘贴。只有幂等探测（端点活体）才缓存——诊断（`doctor`/`fleet`）故意保持新鲜。pty 兜底启动器优雅降级（调用方可见退出码、无 traceback），故 `selftest` 确定性全绿。
- **不用 Gemini** —— review / 第二意见走 Codex 或国产后端。

---

## 开发

三道闸门（密钥 / 脚本 / 测试）本地与 CI 同源，复用 `scripts/scan-secrets.sh` + `scripts/check-shell.sh`：

```bash
make ci          # = scan + lint + check-docs + test（等价 CI）
make scan        # 密钥泄漏门（指纹 + ccb.config 占位检查）
make lint        # bash -n + shellcheck（.shellcheckrc）
make check-docs  # docs-match-code 门：README 子命令/数量 == fanout CLI
make test        # cn-plugin + fanout selftest（313 断言）
make doctor      # 环境侦察
make help        # 所有目标

pipx install pre-commit && pre-commit install   # 每次 commit 都扫

```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）跑三个 job：**secret-scan**（自定义门 + gitleaks）、**shell**（`bash -n` + shellcheck + **docs-match-code**）、**node**（`npm test`）。见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 安全

本工作流处理 API key。硬规矩（完整策略见 [`SECURITY.md`](SECURITY.md)）：

- 真 key 只在 `~/.config/cc-model-secrets.env`（或你项目本地的 `.ccb/ccb.config`，已 git-ignore）。仓里只发带 `<PLACEHOLDER>` key 的 `ccb.config.example`。
- `.gitignore` 排除 `**/.ccb/ccb.config`、`*secrets*.env`、`.env*` 和运行时 `.fanout-cache/`。
- 每次 commit/push 都过自定义指纹扫描 + gitleaks；命中即 CI 拦合并。
- 漏洞请经 GitHub Security Advisory 私下上报——别开公开 issue。

---

## 致谢

- [**openai/codex-plugin-cc**](https://github.com/openai/codex-plugin-cc)（Apache-2.0）—— `orchestration/cn-plugin/` 派生自其插件架构（`/cn:*` 命令、agents、skills、companion 脚本）。
- [**Zleap-AI/Zleap-Agent**](https://github.com/Zleap-AI/Zleap-Agent) —— **Workspace 隔离**与**经验记忆**思想的灵感来源（只借思想；Zleap 无 license，代码独立实现）。
- [**kunchenguid/no-mistakes**](https://github.com/kunchenguid/no-mistakes) & [**lavish-axi**](https://github.com/kunchenguid/lavish-axi)（MIT）—— loop 的 **auto-fix vs ask-user** finding 二分 + **`run` 状态门面**（axi 式），以及 **docs-match-code** 漂移门（来自 `build:skill --check`）。
- [**merkyor/Lynn**](https://gitee.com/merkyor/Lynn) —— `integrate --ownership` 背后的**编排器侧 ownership / 越界检测**思想（在编排器侧强制、不信 worker 的 prompt）。
- **Anthropic `skill-creator`**（官方 Claude Code 元技能）—— `fanout skills forge` 把 skill *撰写*委托给它，`validate` 门镜像其 `quick_validate.py` 的检查。
- [**Sakana AI — Fugu**](https://sakana.ai/fugu/) —— 本项目命名所致敬的框架：多 agent 藏在单一接口后，一个学习式协调器 + verifier（TRINITY / Conductor）。fugue 是一个独立、免训练、harness 工程化的类比——受其*想法*启发，不源自他们的代码（见 [与 Sakana Fugu 的关系](#与-sakana-fugu-的关系)）。
- [**trotsky1997/OpenFugu**](https://github.com/trotsky1997/OpenFugu) —— 一个 sibling 项目，Fugu 的忠实开源*复现*（真训 TRINITY/Conductor 并当 API 服务）。独立项目、同一个灵感；fugue 是互补的免训练 harness 路线。
- **Phase 5 loop** 设计参考 agentic verification loop 文献（Self-Refine、Reflexion、loop-engineering 2026）；**自适应路由**参考多臂 bandit 文献——Thompson Sampling（Agrawal & Goyal 2012）、非平稳/折扣 bandit（Garivier & Moulines 2011）。

归属细节见 [`NOTICE`](NOTICE)。

---

## 许可

[Apache-2.0](LICENSE) © 2026 BicaMind Labs。见 [`NOTICE`](NOTICE)。
