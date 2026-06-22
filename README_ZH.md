# cn-cc-workflow

[![CI](https://github.com/LeoLin990405/cn-cc-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoLin990405/cn-cc-workflow/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-259%20passing-success.svg)](orchestration/fanout)

**[English](README.md) | 简体中文**

> 一套多 Agent 编码工作流：**9 个国产大模型**（各自跑成隔离的 Claude Code 实例）当实现者，独立的前沿模型（Codex）当质量门，外加一个**有界 review-fix loop** 收敛到过审——绝不死循环、绝不硬标 DONE。

便宜快的国产模型干活，跨家 reviewer 评判，编排者（Claude）规划/整合/打补丁。fan-out/fan-in 缓存保证「发出多少任务就收回多少」才进下一轮；按任务的 **Workspace 隔离**让弱模型不被全量 context 淹没。

---

## 目录

- [为什么](#为什么)
- [架构](#架构)
- [仓库结构](#仓库结构)
- [快速上手](#快速上手)
- [装成 Claude Code Skill](#装成-claude-code-skill)
- [`fanout` 命令行](#fanout-命令行)
- [工作流](#工作流)
- [设计原则](#设计原则)
- [开发](#开发)
- [安全](#安全)
- [致谢](#致谢)
- [许可](#许可)

---

## 为什么

小/便宜模型在「每一步都看到全部工具、记忆、规则、消息」时会翻车——注意力和延迟被浪费，还出错（本仓的[模型实测](orchestration/fanout/allocation.tsv)正好显示哪些模型在哪类任务上崩）。本项目靠**工程化**而非更大模型来解决：

- **跨家分离**——实现者（国产模型）≠ reviewer（Codex）。生成≠审查比自审好 ~20%。
- **有界自我修正**——review-fix loop：确定性门优先 + keep-best + 不收敛元反思（参考 Self-Refine / Reflexion / loop-engineering 研究）。
- **上下文隔离**——每个任务跑在一个「工位」里，只暴露它需要的 prompt/工具/记忆/模型。
- **完整性保证**——fan-in barrier：发出 N 个任务 ⇒ N 个全回才进下一轮。
- **自适应路由**——模型分配表是个贝叶斯 bandit：从手调先验起步，按每次 review verdict 学"哪个模型擅长哪类任务"（Thompson Sampling 探索、模型升级后 decay）——学习式协调器的免训练版。

---

## 架构

<img src="docs/architecture.svg" alt="cn-cc-workflow 架构" width="760">

<details>
<summary>文本版示意图</summary>

```
                  ┌─────────────────────────────────────────────┐
   战略层 Planner  │  Claude (Desktop 或 Claude Code)            │  规划·拆分·决策·整合
                  └───────────────┬─────────────────────────────┘
                                  │  ccb ask  (TASK 文件 → ~/.claude/tasks/)
                  ┌───────────────▼─────────────────────────────┐
   执行+监工       │  Claude Code  =  fanout skill (5 阶段)        │  派活·质量门·loop
                  └──┬──────────────────────┬───────────────┬────┘
                     │ ccb dispatch         │               │ ccb ask coder
        ┌────────────▼───────────┐   ┌──────▼──────┐   ┌─────▼─────────┐
  实现层 │ 9 国产 CC 后端          │   │ 共享 git     │   │ Codex (gpt-5.5)│ 审查层
        │ deepseek/glm/kimi/qwen │   │ worktree     │   │ = 质量门       │
        │ doubao/minimax/mimo/   │   │ (主 branch = │   └─────┬─────────┘
        │ stepfun/longcat        │   │  唯一真相)   │         │ VERDICT
        └────────────┬───────────┘   └──────┬──────┘         │
                     └────────► Phase 5: Review-Fix Loop ◄────┘
                          (确定性门→审→keep-best→修, 有界)
```

</details>

| 角色 | 谁 | 职责 |
|---|---|---|
| **Planner / 整合 / Fixer** | Claude（Desktop 或 Claude Code） | 规划、拆任务、整合、打补丁，握运营层最终决策 |
| **实现者** | 9 国产模型经 [ccb](https://github.com/SeemSeam/claude_codex_bridge)（`cc-deepseek` `cc-glm` `cc-kimi` `cc-qwen` `cc-doubao` `cc-minimax` `cc-mimo` `cc-stepfun` `cc-longcat`）+ `cc-claude` | 各自 worktree 里写代码 |
| **前端**（opt-in） | Antigravity（`agy` CLI） | 仅前端/UI——不当 reviewer（后端=Gemini） |
| **审查** | Codex（`coder`） | 独立 VERDICT：ACCEPTED / NEEDS FIX——建议性、不绑定 |

> 人（你）是终极权威：默认/旗舰档变更、loop 不收敛都升级给你。

---

## 仓库结构

| 路径 | 内容 |
|---|---|
| `backends/bin/` | 国产模型后端：`cc_model_launch` 公共尾 + 9 个瘦 `*-code` 启动器 + `cc-model-registry.tsv` + `cc-models` 调度 + **`cc-sync`**（自动跟随 Claude Code + 模型更新） |
| `backends/{install,verify}.sh`、`backends/prompts/` | 装机 / 自检 / 各 provider 追加 prompt |
| `orchestration/fanout/` | `fanout` 命令行（17 子命令）+ `SKILL.md`（5 阶段 + Phase 5 loop）+ `workspaces/` + `templates/` + 17 套测试 |
| `orchestration/ccb/ccb.config.example` | ccb 多窗口拓扑**脱敏**模板（占位 key） |
| `orchestration/cn-plugin/cn/` | Claude Code 插件：`/cn:*` 命令 + `cn-dispatch`（派生自 `openai/codex-plugin-cc`） |
| `orchestration/agent-team/` | Workflow 工具编排示例（多模型规划→实现→审查） |
| `scripts/` | `scan-secrets.sh` + `check-shell.sh`（Make / CI / pre-commit 同源复用） |
| `AGENTS.md` | 跨 harness 入口——Claude Code / Codex / OpenCode 都读它；一套 bash CLI 让任意 agent 驱动工作流 |
| `docs/` | [`WORKFLOW.md`](docs/WORKFLOW.md)（端到端流水线）· [`AGENT_TEAM.md`](docs/AGENT_TEAM.md)（多模型规划 + sub-agent）· [`INTEGRATIONS.md`](docs/INTEGRATIONS.md)（把 cn-cc 当引擎被消费，如 CivAgent） |

---

## 快速上手

**依赖：** macOS/Linux · Node ≥ 18.18 · `git`、`tmux` · [ccb](https://github.com/SeemSeam/claude_codex_bridge)（多窗口扇出）· `codex`（reviewer）· 可选 `agy`（前端）。

```bash
git clone https://github.com/LeoLin990405/cn-cc-workflow
cd cn-cc-workflow

# 0) 先看本机装了什么 + 拿工作流推荐（不读 key 值）
make doctor

# 1) 装后端（镜像 ~/bin/cc-*；key 放 ~/.config/cc-model-secrets.env）
./backends/install.sh                  # 仅启动器
./backends/install.sh --install-claude-code   # 顺带把 pinned claude-code 装进各 env
./backends/verify.sh && cc-models doctor

# 2) 单机轻量扇出（不开 ccb）：Claude Code 里用 /cn:* 插件
#    /cn:team  /cn:ask  /cn:glm ...

# 3) 完整多 Agent 工作流（ccb 多窗口）
cp orchestration/ccb/ccb.config.example /path/to/proj/.ccb/ccb.config   # 填真 key
cd /path/to/proj && ccb                # 起 planner/work/ark/review 窗口
#    然后走 5 阶段 fanout（见 docs/WORKFLOW.md）
```

API key **只**放 `~/.config/cc-model-secrets.env`（启动器读取）——绝不进仓。见[安全](#安全)。

---

## 装成 Claude Code Skill

编排层本身是一个**可按名唤醒的 Claude Code Skill**。一行安装：

```bash
make install-skill        # → ~/.claude/skills/fanout（已存在会先自动备份）
```

然后**重开一个 Claude Code 会话**唤醒它：

- 斜杠命令：**`/fanout`**
- 或直接描述一个多 agent 任务——它会在「用 fanout 做 X」「用 cc 分身 + codex 写 Y」「多 agent 协作」「前后端 + review」等触发词上**自动唤醒**。

安装器会把 skill + 全部 `fanout` 工具/工位/模板拷过去；用 `~/.claude/skills/fanout/fanout selftest` 自检。API key 不随 skill 走——仍在 `~/.config/cc-model-secrets.env`。

---

## `fanout` 命令行

`orchestration/fanout/fanout` 是统一入口——一套 bash CLI,任意 agent(或你)都能驱动。`fanout help` 看全表;**17 个子命令**按在流水线里的位置分组:

**Setup & 侦察**

| 命令 | 作用 |
|---|---|
| `fanout doctor` | 侦测装了哪些 Agent/CLI + 配了哪些 API → 推荐工作流 |
| `fanout fleet status\|up\|down` | 拉起/查看/停 ccb fleet——剥 `CLAUDE_CODE_*`(防 OAuth 假 401) + detached tmux 起 pane;就绪 = `mount_state: mounted`(非配置意图) |
| `fanout preflight [cfg]` | go/no-go 门：依赖 · ccbd mounted · ccb.config 健全 · **no-Gemini 守卫** · `.ccb/` 已 gitignore · `--probe` 活体探端点 |

**Plan & 路由**

| 命令 | 作用 |
|---|---|
| `fanout task new\|log\|done` | TASK 文件脚手架 / 日志 / 收尾(审计线) |
| `fanout plan "<goal>" [--models a,b,c]` | **规划面板**——把目标拆解扇出给多个模型 |
| `fanout allocate <type> [--top] [--sample]` · `record`·`feed`·`stats`·`reset`·`decay` | **学习式路由**(Beta-Bernoulli):bench 先验 + verdict 后验。`feed --from-ledger` 闭合飞轮(`dispatch --task-type` 记 `(type,agent)`,整轮 verdict 后一把 `feed`);`--sample` = Thompson Sampling(探索少样本 agent;Agrawal-Goyal 2012);`decay` 模型升级后折扣陈旧统计(Garivier-Moulines 2011) |
| `fanout workspace list\|show\|model\|context <ws>` | 按任务**上下文隔离**——组装 `System + Workspace + Tools + Memory + History` |
| `fanout template <name> [--set K=V]` | 渲染 prompt 模板（`impl` / `analysis` / `review`） |
| `fanout goal template\|show\|check <spec>` | **目标模式**——声明式目标 + 确定性验收门 |

**Dispatch & 收集**

| 命令 | 作用 |
|---|---|
| `fanout dispatch <target> [--harness ccb\|codex\|opencode] [--workspace ws] [--task-type T]` | 派活到**任意 harness**（ccb / codex / opencode）：渲 prompt → 跑 → 记日志；`--task-type` 喂路由飞轮 |
| `fanout cache init\|put\|fail\|barrier\|collect\|resume\|...` | 结果缓存 + **fan-in barrier**（发 N 收 N）+ 计时 + resume |

**Integrate · review · loop**

| 命令 | 作用 |
|---|---|
| `fanout integrate --work <repo> --agents "a b" [--ownership <file>]` | **Phase 3**——各 worktree cherry-pick 到 `main`，**冲突隔离**（冲突 agent 单独 abort 并报告，其余照常落地）。`--ownership` 加**越界检测**（每 agent 的 owned/forbidden glob）：worker 改了越界文件 → 标 `violation` 扣下不整合——*编排器侧强制、不信 prompt*（借鉴 Lynn） |
| `fanout loop init\|record\|decide\|status` | **Phase 5** review-fix **状态机**——每轮 `record`（`--ask-user K` 给 finding 分类）→ `decide` 给唯一退出态：DONE / CONFIRM / CONTINUE / **ASK_USER** / ESCALATE_MAX / ESCALATE_NONCONV；keep-best 自动维护 |
| `fanout run set\|round\|status\|next\|clear` | **Run 状态门面**（axi-inspired）——把跨阶段状态（TASK / round / barrier N收M / loop decision / best）聚合成**一个机器可解析 JSON** |
| `fanout summary <round> [--task f]` | round 可观测汇总（状态 + 耗时） |

**观测 & 维护**

| 命令 | 作用 |
|---|---|
| `fanout experience add\|list\|recall\|show <ws>` | **经验记忆**——完成→抽方法→脱敏→回灌 context |
| `fanout ccb-sync check\|adapt [--apply]` | ccb 更新后同步适配（版本漂移 · grafting 校验 · ccbd 重启） |
| `fanout selftest` | 跑全部 17 套测试（259 断言） |

---

## 工作流

核心是 **5 阶段流水线**（详见 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)）：

1. **Plan**——preflight 门 + 建 TASK 文件，按文件拆分。
2. **Dispatch + 缓存 + barrier**——`ccb ask` 并行；每个结果先进缓存；fan-in barrier 要求 N 全回才进下一步。
3. **Integrate**——`fanout integrate` 把各 worktree cherry-pick 到 `main`，**冲突隔离**（冲突的 agent 单独 abort 并报告，其余照常落地）；跑本地 sanity。*（前提：work repo 必须 `.gitignore` 掉 `.ccb/`——worktree 就在它里面。）*
4. **Review**——Codex 给 VERDICT。
5. **Review-Fix Loop**（有界，由 `fanout loop` 状态机驱动）——确定性门优先 → 增量审 → keep-best（回退退化） → 我 Edit 补丁；`fanout loop decide` 给唯一退出态（DONE / CONFIRM / CONTINUE / ESCALATE_MAX / ESCALATE_NONCONV）；封顶后升级——绝不死循环、绝不硬标 DONE。

**更高层入口**叠加其上：

- **目标模式**——`fanout goal check <spec>` 跑声明式验收门，loop 朝它收敛。
- **规划面板**——`fanout plan` 把拆解扇给多模型，综合进 Phase 1。
- **Workspace 隔离**——`fanout dispatch --workspace <ws>` 只给模型该工位需要的 context。
- **自适应分配**——`fanout allocate` 把静态 bench 表（先验）和 `record` 的实战 verdict（后验）混合，随 loop 把结果喂回而自我改进——无需训练。

多模型规划 + 层级 sub-agent（ccb fleet vs 原生 Claude Code subagent）见 [`docs/AGENT_TEAM.md`](docs/AGENT_TEAM.md)。

---

## 设计原则

- **生成 ≠ 审查**——实现者与 reviewer 必须不同家。
- **主 branch 唯一真相**——实现者在 worktree 沙箱干，只 cherry-pick 过审改动回主。
- **有界 loop**——门优先、keep-best、≥2 次确认审、元反思；封顶后升级。绝不死循环、绝不硬标 DONE。
- **缓存优先 + fan-in barrier**——每个结果持久缓存；发 N 收 N 才进下一轮。
- **上下文隔离**——弱模型只看工位需要的。
- **自适应路由,非静态**——分配是 Beta-Bernoulli bandit（bench 先验 + verdict 后验、Thompson Sampling 探索）；用 loop 的 verdict 自我改进、零训练。
- **密钥外置**——只在 `~/.config/cc-model-secrets.env`；仓里只有 `.example`。pre-commit + CI 扫描拦泄漏。
- **文档对齐代码**——`check-docs` 门:README 的子命令/数量若与实际 `fanout` CLI 漂移,CI 直接挂。
- **不用 Gemini**——审查/第二意见走 Codex 或国产分身。

---

## 开发

三道闸门（密钥 / 脚本 / 测试）本地与 CI 同源（复用 `scripts/scan-secrets.sh` + `scripts/check-shell.sh`）：

```bash
make ci          # = scan + lint + check-docs + test（CI 等价）
make scan        # 密钥泄漏闸门（指纹 + ccb.config 占位校验）
make lint        # bash -n + shellcheck（走 .shellcheckrc）
make check-docs  # 文档漂移闸门：README 子命令/数量 == fanout CLI 实际
make test        # cn-plugin + fanout selftest（259 断言）
make doctor      # 环境侦察
make help        # 所有目标

pipx install pre-commit && pre-commit install   # 提交即自动扫
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）三 job：**secret-scan**（自定义闸门 + gitleaks）、**shell**（`bash -n` + shellcheck + **docs-match-code**）、**node**（`npm test`）。贡献见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

---

## 安全

本工作流会接触 API key。硬规矩（完整策略见 [`SECURITY.md`](SECURITY.md)）：

- 真 key 只在 `~/.config/cc-model-secrets.env`（或你项目本地的 `.ccb/ccb.config`，已 git-ignore）。仓里只有 `ccb.config.example`（`<占位>` key）。
- `.gitignore` 忽略 `**/.ccb/ccb.config`、`*secrets*.env`、`.env*`、运行态 `.fanout-cache/`。
- 每次提交/推送过自定义指纹扫描 + gitleaks；CI 命中即拦合并。
- 安全漏洞请走 GitHub Security Advisory 私下上报——不要开公开 issue。

---

## 致谢

- [**openai/codex-plugin-cc**](https://github.com/openai/codex-plugin-cc)（Apache-2.0）——`orchestration/cn-plugin/` 派生自其插件架构（`/cn:*` 命令、agents、skills、companion 脚本）。
- [**Zleap-AI/Zleap-Agent**](https://github.com/Zleap-AI/Zleap-Agent)——**Workspace 隔离**与**经验记忆**思想的灵感来源（只借思想；Zleap 无 license，代码独立实现）。
- [**kunchenguid/no-mistakes**](https://github.com/kunchenguid/no-mistakes) & [**lavish-axi**](https://github.com/kunchenguid/lavish-axi)（MIT）——loop 的 **auto-fix vs ask-user** finding 二分 + **`run` 状态门面**（axi 式），以及 **docs-match-code** 漂移门（来自 `build:skill --check`）。
- **Phase 5 loop** 设计参考 agentic verification loop 文献（Self-Refine、Reflexion、loop-engineering 2026）；**自适应路由**参考多臂 bandit 文献——Thompson Sampling（Agrawal & Goyal 2012）、非平稳/折扣 bandit（Garivier & Moulines 2011）。

归属细节见 [`NOTICE`](NOTICE)。

---

## 许可

[Apache-2.0](LICENSE) © 2026 LeoLin990405。见 [`NOTICE`](NOTICE)。
