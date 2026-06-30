import { useEffect, useReducer, useState } from 'react';

import { bridge } from './bridge';
import {
  buildDispatchCmd,
  buildIntegrateCmd,
  buildLoopCmd,
  buildPlanCmd,
  buildReviewCmd,
  buildTaskNewCmd,
  parseTaskFile,
} from './logic/command-builder';
import { initialWorkflowState, reducer } from './logic/workflow-state';
import type { AgentInfo } from './logic/types';

export function App() {
  const [state, dispatch] = useReducer(reducer, initialWorkflowState());
  const [goal, setGoal] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void bridge.agents().then(setAgents);
  }, []);

  const log = (...lines: string[]): void => {
    for (const line of lines) dispatch({ type: 'append-log', line });
  };

  // Run a command; `after()` is called ONLY on exitCode 0 — a failed step never advances the phase.
  const run = (cmd: string, after: () => void): void => {
    setBusy(true);
    void bridge.run(cmd).then((r) => {
      log(`$ ${cmd}`, r.stdout.trim() || `(exit ${String(r.exitCode)}, no output)`);
      dispatch({ type: 'set-result', result: r });
      if (r.exitCode === 0) after();
      setBusy(false);
    });
  };

  // Plan Task: create a REAL task file first (fuguectl task new), parse its path, then plan against it.
  const planTask = (): void => {
    const taskNewCmd = buildTaskNewCmd(goal);
    setBusy(true);
    void bridge.run(taskNewCmd).then((r1) => {
      log(`$ ${taskNewCmd}`, r1.stdout.trim() || `(exit ${String(r1.exitCode)}, no output)`);
      dispatch({ type: 'set-result', result: r1 });
      if (r1.exitCode !== 0) {
        setBusy(false);
        return;
      }
      const taskFile = parseTaskFile(r1.stdout);
      if (taskFile === '') {
        log('task new returned no task file path; aborting plan');
        setBusy(false);
        return;
      }
      const planCmd = buildPlanCmd(goal, taskFile);
      void bridge.run(planCmd).then((r2) => {
        log(`$ ${planCmd}`, r2.stdout.trim() || `(exit ${String(r2.exitCode)}, no output)`);
        dispatch({ type: 'set-result', result: r2 });
        if (r2.exitCode === 0) dispatch({ type: 'plan-done', taskId: taskFile });
        setBusy(false);
      });
    });
  };

  const tid = state.taskId;
  const canStep = !busy && tid !== null;

  return (
    <div className="app">
      <main className="main">
        <header className="header">
          <h1>FuguNano</h1>
          <span className="phase">{state.phase}</span>
        </header>

        <section className="panel">
          <div className="goal-row">
            <input
              className="input"
              aria-label="goal"
              placeholder="Describe the task goal…"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && goal && !busy) planTask();
              }}
            />
            <button className="btn btn-primary" disabled={busy || !goal} onClick={planTask}>
              Plan Task
            </button>
          </div>
          <div className="steps">
            <button
              className="btn btn-secondary"
              disabled={!canStep}
              onClick={() => tid !== null && run(buildDispatchCmd(tid, 'cc-deepseek', 'codex', goal), () => dispatch({ type: 'dispatch-done' }))}
            >
              Dispatch
            </button>
            <button
              className="btn btn-secondary"
              disabled={!canStep}
              onClick={() => tid !== null && run(buildIntegrateCmd(tid, '.', 'cc-deepseek'), () => dispatch({ type: 'integrate-done' }))}
            >
              Integrate
            </button>
            <button
              className="btn btn-secondary"
              disabled={!canStep}
              onClick={() => tid !== null && run(buildReviewCmd(tid), () => dispatch({ type: 'review-done', accepted: true }))}
            >
              Review
            </button>
            <button
              className="btn btn-secondary"
              disabled={!canStep}
              onClick={() => tid !== null && run(buildLoopCmd(tid), () => dispatch({ type: 'loop-done' }))}
            >
              Loop
            </button>
          </div>
        </section>

        <section className="panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <h2>Task Log</h2>
          <div className="log-wrap">
            {state.taskLog.length === 0 ? (
              <div className="empty">No commands yet. Describe a goal and run Plan Task.</div>
            ) : (
              <div className="log">
                {state.taskLog.map((line, i) => (
                  <div className="log-line" key={`${String(i)}:${line.slice(0, 12)}`}>
                    <span className={line.startsWith('$ ') ? 'log-cmd' : ''}>{line}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      <aside className="side">
        <section className="panel">
          <h2>Agents</h2>
          {agents.length === 0 ? (
            <div className="empty">Loading…</div>
          ) : (
            agents.map((a) => (
              <div className="agent-row" key={a.name}>
                <span>
                  <span className="dot" />
                  {a.name}
                </span>
                <span className="muted">{a.role}</span>
              </div>
            ))
          )}
        </section>

        <section className="panel">
          <h2>Task</h2>
          <div className="meta">
            <span>file</span>
            <span title={state.taskId ?? undefined}>{state.taskId ?? '—'}</span>
          </div>
          <div className="meta">
            <span>phase</span>
            <span>{state.phase}</span>
          </div>
          {state.lastResult !== null && (
            <div className="meta">
              <span>last exit</span>
              <span>{String(state.lastResult.exitCode)}</span>
            </div>
          )}
        </section>
      </aside>
    </div>
  );
}
