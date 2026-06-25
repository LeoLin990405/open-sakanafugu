# fugue

[![CI](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml/badge.svg)](https://github.com/BicaMindLabs/fugue/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-317%20passing-success.svg)](orchestration/fanout)

**[English](README.md) | 简体中文**

**fugue** 是一个免训练、可自托管的多 agent 编码 harness。它把多个模型放在同一个操作界面后面，让更便宜的专长 worker 在隔离 context 里实现，再由独立 reviewer 判断，最终只信通过验证的结果。

公开控制面是 [`fuguectl`](#fuguectl-命令行)。历史上的 `fanout` 名称仍保留为兼容 alias，旧脚本和已安装的 Claude Code skill 还能继续用；新的文档和命令统一使用 `fuguectl`。

## 它是什么

fugue 受 [Sakana AI Fugu](https://sakana.ai/fugu/) 启发：真正有用的杠杆不是一个更大的模型，而是对多模型池的编排。Fugu 训练一个协调器；fugue 用普通工程把这个形状搭出来：

- **一个入口** - `fuguectl` 驱动 dispatch、cache、integration、review、loop state、routing、skills 和 fleet 维护。
- **角色分离** - 国产模型 Claude Code workers 负责实现；Codex 负责 review；operator 保留最终决策权。
- **有界纠错** - review-fix 是显式状态机，有 keep-best、确认和升级，不靠无限循环碰运气。
- **Context 隔离** - 每个 workspace 只暴露该任务所需的 prompt、tools、memory、history 和 skills。
- **免训练学习** - allocation 是透明的 Beta-Bernoulli / Thompson-Sampling router，从 review outcome 更新。
- **Harness 自演化** - TypeScript engine 带 Self-Harness loop：挖失败 run，提出有界 harness edit，只提升不回退的改动。

## 当前形态

这个仓库有两层：

| 层                      | 状态                                                                          | 用途                                                |
| ----------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `orchestration/fanout/` | 生产可用的操作层：`fuguectl`、旧 `fanout`、18 个子命令、18 套测试、317 个断言 | 日常多 agent 编码工作流                             |
| `engine/`               | 严格 TypeScript 的 ports-and-adapters engine，仍按能力逐步迁移                | 类型化集成、`fugue` CLI、以及新的 Self-Harness 能力 |

bash 操作层保持全绿，能力逐步迁移到 typed engine。迁移状态见 [`docs/PARITY.md`](docs/PARITY.md)。

## 架构

<img src="docs/architecture.svg" alt="fugue architecture" width="760">

```
Planner / operator
      |
      v
fuguectl control plane
      |
      +--> 在隔离 worktree 中派发 worker
      +--> 缓存每个结果，并在 fan-in barrier 等齐
      +--> 只把通过 review 的工作整合到 main
      +--> 请求独立 reviewer 给出 VERDICT
      +--> 驱动有界 review-fix loop
      +--> 把结果回灌到 allocation 和 skills
```

| 角色                         | 具体实现                                                                                                                                                                                               | 职责                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Planner / integrator / fixer | Claude Desktop、Claude Code 或人类 operator                                                                                                                                                            | 拆任务、决定何时接受风险、整合和补丁 |
| Implementers                 | 经 [ccb](https://github.com/SeemSeam/claude_codex_bridge) 接入的 `cc-deepseek`、`cc-glm`、`cc-kimi`、`cc-qwen`、`cc-doubao`、`cc-minimax`、`cc-mimo`、`cc-stepfun`、`cc-longcat`，以及可选 `cc-claude` | 在隔离 worktree 里写代码             |
| Reviewer                     | Codex（`coder` / `codex`）                                                                                                                                                                             | 独立 ACCEPTED / NEEDS FIX verdict    |
| 可选前端 worker              | Antigravity（`agy`）                                                                                                                                                                                   | 只做 UI / frontend，不做 reviewer    |

## 快速开始

要求：macOS 或 Linux、Node >= 18.18、`git`、`tmux`，完整 fleet 需要 [ccb](https://github.com/SeemSeam/claude_codex_bridge)，review 需要 Codex，前端可选 `agy`。

```bash
git clone https://github.com/BicaMindLabs/fugue
cd fugue

# 检查这台机器，并得到推荐工作流。
make doctor

# 安装模型启动器。真实 key 放在 ~/.config/cc-model-secrets.env。
make install
make verify

# 新 clone 建议先完整跑一次本地 gate。
make ci-clean
```

完整 ccb fleet：

```bash
cp orchestration/ccb/ccb.config.example /path/to/project/.ccb/ccb.config
cd /path/to/project
ccb

# 在另一个 shell 或 agent session 中：
/path/to/fugue/orchestration/fanout/fuguectl preflight
/path/to/fugue/orchestration/fanout/fuguectl fleet status
```

API key 不进仓。启动器读取 `~/.config/cc-model-secrets.env`；项目本地的 ccb 配置放在已 git-ignore 的 `.ccb/` 下。

## 作为 Claude Code Skill 安装

```bash
make install-skill
```

它会安装到 `~/.claude/skills/fanout`，并先备份旧副本。重启 Claude Code 后，可以用 `/fanout` 唤醒，或直接描述一个多 agent 任务。安装后的 skill 同时包含 `fuguectl` 和兼容用的 `fanout` alias：

```bash
~/.claude/skills/fanout/fuguectl selftest
```

## 日常工作流

operator loop 有五个阶段：

1. **Plan** - 先 preflight，创建 TASK 文件，按 ownership 拆任务。
2. **Dispatch** - 把 scoped prompt 派给 worker；缓存每个终态结果。
3. **Integrate** - 把 worktree cherry-pick 到 `main`；隔离冲突和 ownership violation。
4. **Review** - 请求独立 reviewer 给出 verdict。
5. **Fix or finish** - 用 loop 状态机决定继续、确认、询问用户或升级。

核心命令长这样：

```bash
fuguectl preflight
fuguectl task new "implement feature"
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

完整过程见 [`docs/WORKFLOW.md`](docs/WORKFLOW.md)。

## fuguectl 命令行

`orchestration/fanout/fuguectl` 是主操作入口。精确语法看 `fuguectl help`。这 18 个子命令按工作流位置分组如下。

### Setup And Recon

| 命令                              | 用途                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `fuguectl doctor`                 | 探测已安装 CLI、已配置 API，并推荐运行模式。                                                            |
| `fuguectl fleet status\|up\|down` | 检查、启动或停止 ccb worker fleet；启动前剥掉 `CLAUDE_CODE_*`，避免 OAuth 假 401。                      |
| `fuguectl preflight [cfg]`        | Go/no-go gate：依赖、ccbd mount、ccb config、no-Gemini policy、`.ccb/` gitignore、可选 endpoint probe。 |

### Plan And Route

| 命令                                                                | 用途                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `fuguectl task new\|log\|done`                                      | 创建、更新、关闭 TASK 审计轨迹。                                                                                     |
| `fuguectl plan "<goal>" [--models a,b,c]`                           | 先让多个模型做目标分解，再选择实际工作拆分。                                                                         |
| `fuguectl allocate <type> [--top] [--sample]`                       | 用 benchmark prior + live review posterior 给 worker 排序；`record`、`feed`、`stats`、`reset`、`decay` 维护 router。 |
| `fuguectl workspace list\|show\|model\|context <ws>`                | 组装某个 workspace 的 scoped context。                                                                               |
| `fuguectl skills index\|list\|match\|show\|inject\|validate\|forge` | 建本地 skill catalog，只注入选中 skills，校验新写的 skill，并把学到的方法沉淀回 catalog。                            |
| `fuguectl template <name> [--set K=V]`                              | 渲染 implementation、analysis 或 review prompt template。                                                            |
| `fuguectl goal template\|show\|check <spec>`                        | 运行声明式 acceptance gate。                                                                                         |

### Dispatch And Gather

| 命令                                                                                                          | 用途                                                                                                            |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `fuguectl dispatch <target> [--harness ccb\|codex\|opencode] [--workspace ws] [--task-type T] [--skills a,b]` | 渲染或读取 prompt，可叠加 workspace 和 skill context，经 ccb / Codex / OpenCode dispatch，并记录 routing 数据。 |
| `fuguectl cache init\|put\|fail\|barrier\|collect\|resume`                                                    | 持久结果缓存、fan-in barrier、耗时和 resume 支持。                                                              |

### Integrate, Review, Loop

| 命令                                                                   | 用途                                                                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `fuguectl integrate --work <repo> --agents "a b" [--ownership <file>]` | 把 worker worktree cherry-pick 到 `main`；冲突和 ownership violation 按 agent 隔离。           |
| `fuguectl loop init\|record\|decide\|status`                           | Phase 5 review-fix 状态机：DONE、CONFIRM、CONTINUE、ASK_USER、ESCALATE_MAX、ESCALATE_NONCONV。 |
| `fuguectl run set\|round\|status\|next\|clear`                         | 机器可读的 run facade，聚合 task、cache、loop、best result 和 next action。                    |
| `fuguectl summary <round> [--task f]`                                  | 人可读的 round 状态和耗时摘要。                                                                |

### Observe And Maintain

| 命令                                               | 用途                                                   |
| -------------------------------------------------- | ------------------------------------------------------ |
| `fuguectl experience add\|list\|recall\|show <ws>` | 保存脱敏的可复用方法，并召回到未来 workspace context。 |
| `fuguectl ccb-sync check\|adapt [--apply]`         | 检测并适配 ccb / Claude Code 的版本漂移。              |
| `fuguectl selftest`                                | 运行完整操作层测试：18 套测试、317 个断言。            |

## TypeScript Engine

`engine/` 包是 fugue 编排模型的 typed 版本：严格 TypeScript、ports-and-adapters 分层、纯 domain policy，以及真实 harness / store 的可注入 adapters。

```bash
cd engine
npm run check
npm run build
node dist/cli/main.js version
```

目前 engine CLI 暴露：

```bash
fugue version
fugue doctor
fugue task new|log|done
fugue goal check <spec>
fugue self-harness template|run
```

在每个命令都有同等或更高覆盖的 typed 等价物之前，bash `fuguectl` 仍是日常操作面。

## Self-Harness

Self-Harness 改进的是 harness 配置本身，而不是模型。一次 run 做四件事：

1. 从失败 run events 里挖 verifier-grounded weaknesses。
2. 让配置好的 harness agent 提出有界的 full-surface replacement edits。
3. 用固定 held-in / held-out task list 验证每个候选。
4. 只有当改动不让任一 split 回退，且至少提升一个 split 时才 promote。

```bash
cd engine
npm run build
node dist/cli/main.js self-harness template > /tmp/self-harness.json
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

严格 JSON spec、editable surfaces、验证规则和 smoke tests 见 [`docs/SELF_HARNESS.md`](docs/SELF_HARNESS.md)。

## 仓库结构

| 路径                           | 内容                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `backends/bin/`                | 模型启动器、registry、`cc-models` 和 `cc-sync`。                                            |
| `backends/{install,verify}.sh` | 本地安装和启动器验证。                                                                      |
| `orchestration/fanout/`        | `fuguectl`、旧 `fanout`、共享 shell libraries、templates、workspaces、skill bundle 和测试。 |
| `orchestration/ccb/`           | 脱敏 ccb 配置模板。                                                                         |
| `orchestration/cn-plugin/`     | 派生自 `openai/codex-plugin-cc` 的 Claude Code `/cn:*` 插件和 dispatch agent。              |
| `orchestration/agent-team/`    | 更高层的多模型规划示例。                                                                    |
| `engine/`                      | TypeScript package、domain ports、adapters、CLI 和 Self-Harness loop。                      |
| `scripts/`                     | 密钥扫描、shell lint、docs drift check 和 skill installer。                                 |
| `docs/`                        | Workflow、architecture、parity、integrations 和 Self-Harness 操作指南。                     |
| `AGENTS.md`                    | Claude Code、Codex、OpenCode 都可读取的跨 harness 操作入口。                                |

## 设计规则

- **生成不是审查** - worker 和 reviewer 来自不同模型家族。
- **`main` 是真相源** - worker 改隔离 worktree；integration 必须显式发生。
- **不要信模型自报** - loop 由确定性 gate 和 reviewer verdict 驱动。
- **每个 loop 都要有界** - 继续、确认、问用户或升级；永不无限转。
- **先缓存再推进** - 派出 N 个任务，下一轮前必须有 N 个终态结果。
- **让弱模型少看一点** - workspace 和 skill injection 把 context 保持小。
- **从 outcome 学习** - allocation 和 skill precipitation 回灌未来轮次。
- **密钥不进 git** - key 留在本地配置，CI 扫泄漏。
- **让文档足够可执行，能失败** - `check-docs` 校验 README 命令覆盖、数量和 Self-Harness 指南。

## 开发

本地 gate 与 CI 复用同一批脚本：

```bash
make ci          # scan + shell lint + docs + plugin/fuguectl + engine checks
make ci-clean    # 同上，但先干净安装 engine dependencies
make scan        # 密钥泄漏 gate
make lint        # bash -n + shellcheck
make check-docs  # README + Self-Harness docs drift gate
make test        # cn-plugin + fuguectl/fanout selftest
make test-engine # TypeScript engine typecheck + lint + vitest
make doctor      # 本机环境侦察
make help        # 列出所有 make target
```

根目录 npm scripts 镜像这些 gates：

```bash
npm run ci
npm run ci:clean
npm run test:fuguectl
npm run test:engine
```

CI 会跑密钥扫描、shell checks、docs drift checks、Node/plugin tests，以及 engine 的 typecheck/lint/vitest。见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 安全

这个工作流会处理 API key。硬规则：

- 真实 key 只放在 `~/.config/cc-model-secrets.env`，或项目本地、已 git-ignore 的 `.ccb/ccb.config`。
- 仓库只保留脱敏 examples。
- 让 `.gitignore`、自定义 scanner 和 gitleaks 拦住意外泄漏。
- 漏洞请通过 GitHub Security Advisory 私下报告。

完整策略见 [`SECURITY.md`](SECURITY.md)。

## 致谢

- [Sakana AI Fugu](https://sakana.ai/fugu/) 给出了“多模型藏在一个接口后面”的框架。
- [trotsky1997/OpenFugu](https://github.com/trotsky1997/OpenFugu) 是互补的忠实训练式重建。
- [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) 提供了 `/cn:*` 层派生的 plugin 架构。
- [Zleap-AI/Zleap-Agent](https://github.com/Zleap-AI/Zleap-Agent) 启发了 workspace isolation 和 experience memory。
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) 与 [lavish-axi](https://github.com/kunchenguid/lavish-axi) 启发了 loop-state 和 docs-drift 思路。
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) 启发了编排器侧 ownership enforcement。
- Anthropic 官方 `skill-creator` meta-skill 支撑了 skill authoring 和 validation flow。

归属细节见 [`NOTICE`](NOTICE)。

## 许可

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
