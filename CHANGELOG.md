# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/), versioning [SemVer](https://semver.org/).

## [Unreleased]

### Added
- **`docs/INTEGRATIONS.md`**：把 cn-cc 当执行引擎被上层框架消费的**稳定契约**（fanout CLI / `--harness` 派活 / backends / allocate / cache / fleet / preflight / no-Gemini）；CivAgent 集成路线图（两仓干净依赖，非 flat merge）。
- **多 harness 适配（civagent 依赖整合的地基）**：`AGENTS.md` 跨 harness 入口（Claude Code / Codex / OpenCode 都读）；`fanout dispatch --harness ccb|codex|opencode` —— 派活执行器可选（ccb=Claude Code cc-* 分身 / codex=codex exec / opencode=opencode run），`<target>` 含义随 harness 变；`FANOUT_CODEX`/`FANOUT_OPENCODE` 可 stub。dispatch 自测 +3（codex/opencode/未知 harness）。
- 架构 SVG 图 `docs/architecture.svg`，嵌入 README（图在前 + 文本版收进 `<details>`）。
- GitHub repo About 描述 + 12 topics + homepage。
- **Phase 5 `fanout loop` 状态机**：把 review-fix loop 从 SKILL.md 伪代码做成可执行工具——`record` 每轮→`decide` 判 5 个退出态（DONE / CONFIRM / CONTINUE / ESCALATE_MAX / ESCALATE_NONCONV），keep-best 基线自动维护，exit 0/10/20 分级。+24 自测。
- **Phase 3 `fanout integrate`**：worktree→`main` cherry-pick 工具，**冲突隔离**——单 agent 冲突 `cherry-pick --abort` 保 `main` 干净、其余照常落地（不再 `break` 整个循环）；显式带 committer 身份，无全局 git config 的环境/CI 也能跑。+19 自测。
- **自适应 `fanout allocate`**：静态查表 → **bench 先验 + 实战后验 贝叶斯混合**（Beta-Bernoulli；新增 `record` / `stats` / `reset`；冷启动 == 旧 bench 顺序，KAPPA 控漂移，Laplace 防饿死）= 学习式路由的免训练版，用 Phase 4/5 verdict 喂。allocate 自测 8→21。
- `fanout selftest` 总断言数 119 → 198（16 套测试）。
- **`scripts/check-docs.sh` 文档漂移闸门**（借鉴 `kunchenguid/lavish-axi` 的 `build:skill --check`，适配本仓双变体 SKILL.md 不做全量生成）：校验 README 收录每个 `fanout` 子命令、子命令数 / 测试套数声明 == 实际代码。进 `make ci` / `npm run ci` / CI 的 shell job。拦"加了工具但 README 数字过期"这类漂移。

- **`fanout integrate` 越界检测(借鉴 Lynn 编排器侧 ownership)**：`--ownership <file>`(TSV `agent⇥owned-globs⇥forbidden-globs`)在 cherry-pick 前校验每个 worker 的 diff——改了 owned 之外 / 命中 forbidden glob 的文件 → 标 `violation` 整笔扣下(像冲突一样隔离, exit 非0),不盲合。"编排器侧强制、不信 prompt"。不在清单的 agent 不受限(向后兼容)。integrate 自测 19→29,总断言→259。
- **自适应分配迭代:Thompson Sampling + 折扣遗忘(bandit 文献)**：`allocate <type> --sample` 把排序从贪心后验均值换成 **Thompson Sampling**(高斯近似 Beta 采样,探索少样本 agent、不早锁赢家;Agrawal-Goyal 2012,可用 `FANOUT_ALLOCATE_SEED` 固定种子);`allocate decay --gamma G [--type T]` 折扣陈旧统计(`s,f ×G`,模型升级后用;非平稳 bandit,Garivier-Moulines 2011)。默认仍均值贪心(向后兼容)。allocate 自测 32→41,总断言→249。
- **自适应分配数据飞轮(verdict 自动喂回)**：`fanout dispatch --task-type T` 把 `(T, agent)` 记进 alloc ledger;`fanout allocate feed --from-ledger --result ok [--fail <返工的 agent>]` 整轮 verdict 一把喂进后验(也支持 `feed type:agent:result` 显式批量)。**agent 名归一化**(`cc-doubao`→bench 的 `doubao`)让经验落在与排名同一 key 上、飞轮真闭合。allocate 自测 21→32,dispatch +2,总断言→240。
- **`fanout run` 跨阶段 run 状态门面(axi-inspired)**：借鉴 `kunchenguid/no-mistakes` 的 axi 思路,但不照搬 daemon 模型——引入轻量 'current run' 上下文(`.fanout-cache/run.meta` 记 active TASK+round),`run status` 把 TASK / cache barrier(N收M)/ loop decision / best 聚合成**一个机器可解析 JSON** 对象(`--human` 出人读摘要),`run next` 出 next-action 提示。让一次 fan-out run 可结构化查询/恢复,不改 operator 编排模型。新增 `fanout-run.sh` + 21 自测(含 JSON 合法性校验)。子命令 16→17,测试套 16→17,总断言→227。
- **`fanout loop` finding 二分(auto-fix / ask-user)**：借鉴 `kunchenguid/no-mistakes` 的 finding 模型——`record --ask-user K` 标记 N 个 findings 里碰意图(架构/语义/取舍)的个数;`decide` 新增 **`ASK_USER`** 退出态(exit 11):碰意图的升级给人 approve/fix/skip,其余机械的 Claude 直接 Edit-patch。优先级低于 ESCALATE_MAX/NONCONV。loop 自测 24→32。selftest 总断言 198→206。

### Changed
- **README(中英)重构**:`fanout` CLI 表从平铺 17 行 → 按流水线阶段分组（Setup & 侦察 / Plan & 路由 / Dispatch & 收集 / Integrate·review·loop / 观测 & 维护），更易扫读;"为什么"+设计原则补**自适应路由**(贝叶斯 bandit)和 **docs-match-code 门**;致谢补 `kunchenguid/no-mistakes`+`lavish-axi`(finding 二分/run 门面/漂移门)与多臂 bandit 文献(Thompson Sampling、折扣 bandit)。fanout 脚本审计确认风格已一致(shebang/`set -uo pipefail`/`die()`/help 范围),无 churn。

### Fixed
- **`fanout fleet status` / `preflight` 假就绪**：旧版只 grep `health` / `state`，会被 `mount_state: unmounted` 和 `desired_state: running`（配置意图 ≠ 实际挂载）假命中 → 假 ready/GO → 派活卡进空队列。改成认 `^mount_state:[[:space:]]*mounted`，加 unmounted / desired_state 两个回归测试。

## [1.0.0] - 2026-06-21

First public release — the Chinese-model multi-agent coding workflow plus its full tooling and engineering layer.

### Added

**Foundation**
- `backends/` — Chinese-model backends: `cc_model_launch` shared core + 9 thin launchers + `cc-model-registry.tsv` + `cc-models` dispatcher + `cc-sync` (auto-follow Claude Code + model updates) + research-prompt + install/verify/prompts.
- `orchestration/fanout/SKILL.md` — 5-phase workflow + Phase 5 Review-Fix Loop v2 (deterministic gate first / keep-best / ≥2 confirmation passes / meta-reflect on non-convergence).
- `orchestration/ccb/ccb.config.example` — sanitized multi-window ccb topology template.
- `orchestration/cn-plugin/cn/` — `/cn:*` commands + `cn-dispatch` (derived from openai/codex-plugin-cc).
- `docs/WORKFLOW.md` — end-to-end pipeline + two run modes + maintenance layer + security boundary.

**`fanout` CLI tooling layer** — unified driver `orchestration/fanout/fanout` (doctor/fleet/preflight/task/template/dispatch/cache/allocate/workspace/experience/plan/goal/summary/ccb-sync/selftest):
- `fanout-doctor.sh` — environment recon + workflow recommendation.
- `fanout-preflight.sh` — go/no-go gate (deps / ccbd / ccb.config sanity / **no-Gemini guard** / `--probe` endpoint liveness / `--config-only`).
- `fanout-fleet.sh` + `fleet-launch.py` — bring up/check/stop the ccb fleet; strips `CLAUDE_CODE_*` (OAuth false-401) + detached tmux, with `--pty` (pty.fork) fallback. Solves "stuck-in-queue, no worker".
- `fanout-cache.sh` — result cache + **fan-in barrier** (dispatch N ⇒ return N) + timing + resume.
- `fanout-task.sh` — TASK scaffolder (new/log/done, cross GNU/BSD sed).
- `fanout-template.sh` + `templates/` — externalized prompt templates (impl/analysis/review).
- `fanout-dispatch.sh` — wraps `ccb ask` (render → dispatch → log; `--workspace`).
- `fanout-summary.sh` — round observability summary (status + elapsed).
- `fanout-allocate.sh` + `allocation.tsv` — bench-driven task-type → model allocation.
- `fanout-workspace.sh` + `workspaces/` — per-task **context isolation** (`System + Workspace + Tools + Memory + History`), inspired by Zleap-Agent.
- `fanout-experience.sh` — **experience memory** (completed work → reusable method → sanitized → recalled into workspace context), inspired by Zleap-Agent.
- `fanout-plan.sh` — multi-model planning panel (design panel).
- `fanout-goal.sh` — **goal mode**: declarative spec + deterministic acceptance gate.
- `fanout-ccb-sync.sh` + `launchd/com.user.fanout-ccb-sync.plist.example` — adapt after a ccb update (version drift / grafting check / ccbd restart).

**Agent Team** — `docs/AGENT_TEAM.md` (multi-model planning + hierarchical sub-agents: ccb fleet vs. native Claude Code subagents) + `orchestration/agent-team/team-review.workflow.mjs` (Workflow orchestration example).

**Frontend** — agy (Antigravity) as Frontend Implementer (manual or headless `agy --print`); frontend-only, never reviews (no-Gemini).

**Install** — `scripts/install-skill.sh` + `make install-skill` → install as a Claude Code Skill (`~/.claude/skills/fanout`, backs up existing); bilingual `/fanout` triggers.

**Engineering** — CI (`secret-scan` + `shell` + `node`), `scripts/scan-secrets.sh` + `scripts/check-shell.sh` (shared by Make/CI/pre-commit), `.gitleaks.toml`, `.shellcheckrc`, `.pre-commit-config.yaml`, `Makefile`, `.editorconfig`, `.gitattributes`, `package.json`, `SECURITY.md`, `CONTRIBUTING.md`, PR/issue templates. **14 test suites, 119 assertions; CI green.**

### Documentation
- Bilingual GitHub-standard README: English `README.md` + `README_ZH.md` (badges / TOC / architecture / CLI reference / workflow / security / acknowledgements). Acknowledges openai/codex-plugin-cc (Apache-2.0) + Zleap-Agent (concepts).

[Unreleased]: https://github.com/LeoLin990405/cn-cc-workflow/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/LeoLin990405/cn-cc-workflow/releases/tag/v1.0.0
