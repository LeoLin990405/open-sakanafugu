# fugue

[![CI](https://github.com/BicaMindLabs/open-sakanafugu/actions/workflows/ci.yml/badge.svg)](https://github.com/BicaMindLabs/open-sakanafugu/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.18-339933.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-342%20passing-success.svg)](orchestration/fuguectl)

**[English](README.md) | 简体中文**

<p align="center">
  <strong>免训练的多 agent 编码编排，把模型 fleet 变成可治理 loop。</strong>
</p>

<p align="center">
  fugue 负责规划、派发、缓存、整合、审查、修复，并让 harness 自己从失败中改进。
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
  <img src="docs/readme-overview-zh.svg" alt="fugue 多 agent 编码总览" width="920">
</p>

## 亮点

- **一个操作面** - `fuguectl` 驱动 preflight、dispatch、cache、integration、review、loop state、routing、skills 和 runtime maintenance。
- **Agent runtime 中立** - 逻辑 agent profile 可以把任务路由到 Claude Code provider instance、Codex model、OpenCode provider，或未来新增的 harness，而 loop 不变。
- **真实隔离** - worker 在独立 worktree 中编辑，配合 scoped workspace、按需 skills 和 ownership enforcement。
- **审查保持独立** - implementer 写代码，Codex 或另一个配置好的非 Gemini reviewer 给出 `ACCEPTED` / `NEEDS FIX`。
- **输出不会丢** - 每个派发任务都先落 cache；join barrier 强制“派出 N 个，收回 N 个”。
- **修复有边界** - keep-best、二次确认、询问用户、升级和非收敛状态避免无限循环。
- **免训练学习** - allocation 用 benchmark prior 加 live review outcome 迭代路由。
- **Self-Harness 就绪** - TypeScript engine 能挖失败 run、提出有界 harness edits，并只 promote 不回退的改动。

## 快速开始

要求：macOS 或 Linux、Node.js >= 18.18、`git`、`tmux`，以及你选择使用的模型/API 凭证。推荐用 Codex 做 review。

```bash
git clone https://github.com/BicaMindLabs/open-sakanafugu fugue
cd fugue

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
/path/to/fugue/orchestration/fuguectl/fuguectl preflight
/path/to/fugue/orchestration/fuguectl/fuguectl fleet status
```

## Operator Skill

```bash
make install-skill
```

这会把 `/fugue` 安装到 `~/.claude/skills/fugue`，作为 Claude Code 的便捷 operator 入口。但 workflow 本身不绑定 Claude Code：Codex、OpenCode 和其他 agent 也可以读取 [AGENTS.md](AGENTS.md)，并通过同一套 agent profiles 派发。安装后可冒烟测试：

```bash
~/.claude/skills/fugue/fuguectl selftest
```

## Loop 如何工作

```bash
fuguectl preflight
fuguectl task new "implement feature"
fuguectl dispatch cc-deepseek --template impl --task TASK.md --task-type backend
fuguectl cache barrier <round>
fuguectl integrate --work /path/to/project --agents "cc-deepseek cc-kimi"
fuguectl loop record --verdict NEEDS_FIX --round 1
fuguectl loop decide
```

| 阶段      | fugue 做什么                                                                  |
| --------- | ----------------------------------------------------------------------------- |
| Plan      | 运行 preflight，创建 TASK 文件，划分 ownership，选择 worker。                 |
| Dispatch  | 通过 `fuguectl dispatch` 发送 scoped prompts。                                |
| Gather    | 缓存每个终态结果，并等待 join barrier。                                       |
| Integrate | 把通过审查的 worktree cherry-pick 到 `main`；隔离冲突和 ownership violation。 |
| Review    | 请求独立 reviewer 给出 `ACCEPTED` / `NEEDS FIX` verdict。                     |
| Repair    | 用有界 loop 状态机直到 accepted 或 escalated。                                |

完整流程见 [docs/WORKFLOW.md](docs/WORKFLOW.md)。

## 命令面

`orchestration/fuguectl/fuguectl` 是生产操作入口。当前有 19 个子命令和 20 套测试。

| 区域                   | 命令                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and recon        | `fuguectl doctor`、`fuguectl preflight`、`fuguectl fleet status\|up\|down`                                                                                                                            |
| Planning               | `fuguectl task new\|log\|done`、`fuguectl template <name>`、`fuguectl plan "<goal>"`、`fuguectl goal template\|show\|check`                                                                           |
| Routing and context    | `fuguectl allocate <type>`、`fuguectl workspace list\|show\|model\|context`、`fuguectl agents template\|validate\|list\|resolve`、`fuguectl skills index\|list\|match\|show\|inject\|validate\|forge` |
| Dispatch and gather    | `fuguectl dispatch <target>`、`fuguectl cache init\|put\|fail\|barrier\|collect\|resume`                                                                                                              |
| Integration and loop   | `fuguectl integrate --work <repo>`、`fuguectl loop init\|record\|decide\|status`、`fuguectl run set\|round\|status\|next\|clear`、`fuguectl summary <round>`                                          |
| Memory and maintenance | `fuguectl experience add\|list\|recall\|show`、`fuguectl runtime check\|adapt`、`fuguectl selftest`                                                                                                   |

## TypeScript Engine

`engine/` 是 typed 实现：严格 TypeScript、ports-and-adapters 分层、纯 domain policy，以及真实 harness / storage adapters。`AgentRegistry` 是从 shell-only 编排走向 engine-native 编排的一步：coordinator 能在同一轮里把逻辑 agent id 解析到 `fugue-cc`、Codex 和 OpenCode runtime profile。

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
fugue task new|log|done
fugue template <name> --dir <templates> [--set KEY=VALUE ...]
fugue goal template|show|check
fugue agent-registry template|validate|list|resolve
fugue self-harness template|run
```

## Self-Harness

Self-Harness 改进的是 harness 配置，不是底层模型。fugue 的实现是对上海人工智能实验室论文 [Self-Harness: Harnesses That Improve Themselves](https://arxiv.org/abs/2606.09498) 的 engine-native 抽象。

<p align="center">
  <img src="docs/readme-self-harness-zh.svg" alt="fugue Self-Harness loop" width="920">
</p>

```bash
cd engine
npm run build
node dist/cli/main.js self-harness template > /tmp/self-harness.json
node dist/cli/main.js self-harness run \
  --spec /tmp/self-harness.json \
  --state ~/.config/fugue \
  --cwd /path/to/workspace
```

严格 JSON spec、editable surfaces、验证规则和 smoke tests 见 [docs/SELF_HARNESS.md](docs/SELF_HARNESS.md)。

## 仓库地图

| 路径                           | 内容                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `backends/bin/`                | 模型启动器、registry、`cc-models` 和 `cc-sync`。                                   |
| `backends/{install,verify}.sh` | 本地安装和 launcher 验证。                                                         |
| `orchestration/fuguectl/`      | `fuguectl`、shell libraries、templates、workspaces、skill bundle 和测试。          |
| `orchestration/fugue-cc/`      | runtime bridge 使用的脱敏 provider 配置模板。                                      |
| `orchestration/cn-plugin/`     | Claude Code `/cn:*` 插件和 dispatch agent。                                        |
| `orchestration/agent-team/`    | 更高层多模型规划示例。                                                             |
| `engine/`                      | TypeScript package、domain ports、adapters、CLI 和 Self-Harness loop。             |
| `scripts/`                     | 密钥扫描、shell lint、docs drift check 和 skill installer。                        |
| `docs/`                        | Agent runtime、workflow、architecture、parity、integrations 和 Self-Harness 指南。 |
| `AGENTS.md`                    | Claude Code、Codex、OpenCode 都可读取的跨 harness 操作入口。                       |

## 安全模型

- 真实 key 只放在 `~/.config/cc-model-secrets.env` 或已 ignore 的本地配置。
- `.fugue-cc/` 不进 git。
- review 路径走 Codex 或另一个独立的非 Gemini reviewer。
- join barrier 没收齐所有终态结果前，不进入下一轮。
- 先让确定性 gate 失败，再消耗 reviewer tokens。
- push 前跑 `npm run ci`。

## 开发

```bash
make ci          # scan + shell lint + docs + plugin/fuguectl + engine checks
make ci-clean    # 同上，但先干净安装 engine dependencies
make scan        # 密钥泄漏 gate
make lint        # bash -n + shellcheck
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
- 上海人工智能实验室的 [Self-Harness 论文](https://arxiv.org/abs/2606.09498) 启发了 `fugue self-harness` 的 harness-improvement loop。
- [kunchenguid/no-mistakes](https://github.com/kunchenguid/no-mistakes) 与 [lavish-axi](https://github.com/kunchenguid/lavish-axi) 启发了 loop-state 和 docs-drift 思路。
- [merkyor/Lynn](https://gitee.com/merkyor/Lynn) 启发了编排器侧 ownership enforcement。
- Anthropic 官方 `skill-creator` meta-skill 支撑了 skill authoring 和 validation flow。

归属细节见 [NOTICE](NOTICE)。

## 许可

[Apache-2.0](LICENSE) © 2026 BicaMind Labs.
