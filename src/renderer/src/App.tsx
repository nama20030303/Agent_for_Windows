import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isDesktop } from './bridge.js';
import {
  appendUserTurn,
  applyAgentEvent,
  getState,
  markPlanResolved,
  markQuestionAnswered,
  openSession,
  refreshGit,
  setState,
  toast,
  useStore
} from './state/store.js';
import { Sidebar } from './components/Sidebar.js';
import { ContextPanel } from './components/ContextPanel.js';
import { Composer } from './components/Composer.js';
import { Markdown } from './components/Markdown.js';
import { ToolActivityItem } from './components/ToolActivityItem.js';
import { ApprovalCard, CompletionCard, PlanCard, QuestionCard, RequirementsCard, VerificationCard } from './components/Cards.js';
import { TerminalPanel } from './components/TerminalPanel.js';
import { CodeViewer } from './components/CodeViewer.js';
import { CommandPalette, type Command } from './components/CommandPalette.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { Onboarding } from './components/Onboarding.js';
import { buildDiagnosticsReport } from '../../core/shared/diagnostics.js';
import type { AgentEvent, ManagedProcess } from '../../core/shared/types.js';

export default function App() {
  const state = useStore((s) => s);
  const conversation = useRef<HTMLDivElement>(null);
  const [recovery, setRecovery] = useState<{ id: string; title: string; state: string } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  /* ------------------------------------------------------------ boot */

  useEffect(() => {
    let disposed = false;
    const off: (() => void)[] = [];

    void (async () => {
      try {
        const settings = await api.settings.get();
        const hasApiKey = await api.settings.hasApiKey();
        document.documentElement.dataset.theme = settings.theme;
        const workspace = await api.workspace.current();
        const sessions = workspace ? await api.session.list(workspace.projectId) : [];
        if (disposed) return;
        setState({
          ready: true,
          settings,
          hasApiKey,
          workspace,
          index: workspace?.index ?? null,
          sessions,
          showOnboarding: isDesktop && (!settings.onboardingComplete || !hasApiKey)
        });
        if (workspace) void refreshGit();

        // Continue where the user left off: without this, the first message after
        // a restart silently started a brand-new session with no history at all.
        if (sessions.length) await openSession(sessions[0].id, sessions[0].state as any);

        const interrupted = await api.session.interrupted();
        if (interrupted.length) setRecovery({ id: interrupted[0].id, title: interrupted[0].title, state: interrupted[0].state });
      } catch (err) {
        setState({ ready: true });
        toast('err', (err as Error).message);
      }
    })();

    off.push(api.events.onAgentEvent((event) => applyAgentEvent(event as AgentEvent)));
    off.push(api.events.onProcesses((processes) => setState({ processes: processes as ManagedProcess[] })));
    off.push(
      api.events.onSettingsChanged((next) => {
        setState({ settings: next });
        document.documentElement.dataset.theme = next.theme;
      })
    );

    return () => {
      disposed = true;
      for (const fn of off) fn();
    };
  }, []);

  /**
   * Follow the stream while the user is reading the newest output, but never
   * yank the view away when they have scrolled up to read something. Streamed
   * text changes the last turn without changing the turn count, so the whole
   * conversation is watched, not just its length.
   */
  const last = state.turns.at(-1);
  const watched = state.turns.length + (last?.kind === 'assistant' ? last.content.length : 0);

  useEffect(() => {
    if (!atBottom) return;
    const el = conversation.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: state.busy ? 'auto' : 'smooth' });
  }, [watched, atBottom, state.busy]);

  const onConversationScroll = useCallback(() => {
    const el = conversation.current;
    if (!el) return;
    // 48px of slack so a resting scroll position still counts as "at the bottom".
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  }, []);

  /* -------------------------------------------------------- actions */

  const ensureSession = useCallback(async (): Promise<string | null> => {
    const current = getState();
    if (current.sessionId) return current.sessionId;
    if (!current.workspace) {
      toast('err', 'Open a project first.');
      return null;
    }
    const session = await api.session.create('New session', current.mode);
    setState({ sessionId: session.id, sessions: [session, ...current.sessions] });
    return session.id;
  }, []);

  const send = useCallback(
    async (text: string) => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      appendUserTurn(text);
      const response = await api.agent.send({ sessionId, message: text, mode: getState().mode });
      if (!response.accepted) toast('err', response.reason ?? 'The agent could not accept the message.');
      else if (response.reason) toast('info', response.reason);
      const current = getState();
      if (current.sessions.length && current.sessions[0].id === sessionId && current.sessions[0].title === 'New session') {
        const title = text.slice(0, 48);
        await api.session.rename(sessionId, title);
        setState({ sessions: current.sessions.map((s) => (s.id === sessionId ? { ...s, title } : s)) });
      }
    },
    [ensureSession]
  );

  const stop = useCallback(() => {
    const sessionId = getState().sessionId;
    if (sessionId) void api.agent.stop(sessionId);
  }, []);

  const openFile = useCallback(async (path: string, line?: number) => {
    try {
      const file = await api.workspace.readFile(path);
      setState({ openFile: { path: file.path, content: file.content, line } });
    } catch (err) {
      toast('err', (err as Error).message);
    }
  }, []);

  const newSession = useCallback(async () => {
    const workspace = getState().workspace;
    if (!workspace) return toast('err', 'Open a project first.');
    const session = await api.session.create('New session', getState().mode);
    setState({ sessionId: session.id, sessions: [session, ...getState().sessions], turns: [], tasks: [], timeline: [], filesCreated: 0, filesModified: 0, agentState: 'IDLE' });
  }, []);

  /* ----------------------------------------------------- shortcuts */

  /**
   * Everything a maintainer needs to understand a failed run, on the
   * clipboard in one click: configuration, what the agent actually did, and
   * where it stopped. Secrets are stripped before it leaves the app.
   */
  const copyDiagnostics = useCallback(async () => {
    let version = 'unknown';
    try {
      version = await api.app.version();
    } catch {
      /* the browser preview has no main process */
    }
    const report = buildDiagnosticsReport(getState(), version);
    try {
      await navigator.clipboard.writeText(report);
      toast('ok', 'Diagnostics copied — paste them into the bug report');
    } catch {
      // Clipboard permission can be refused; the report is useless if it
      // cannot leave the app, so show it instead.
      setState({ openFile: { path: 'diagnostics.md', content: report } });
    }
  }, []);

  const commands = useMemo<Command[]>(
    () => [
      { id: 'open', title: 'Open project…', hint: 'Ctrl+O', run: async () => {
          const picked = await api.workspace.pick();
          if (!picked) return;
          const info = await api.workspace.open(picked);
          setState({ workspace: info, index: info.index, sessions: await api.session.list(info.projectId) });
          void refreshGit();
        } },
      { id: 'new-session', title: 'New session', run: newSession },
      { id: 'reindex', title: 'Re-index project', run: async () => setState({ index: await api.workspace.reindex() }) },
      { id: 'tests', title: 'Run tests (agent)', run: () => void send('Run the test suite, report the real results and fix any failures.') },
      { id: 'review', title: 'Review this project', run: () => { setState({ mode: 'plan' }); void send('Review this project: architecture, code quality, security, dependencies, performance, testing and technical debt. Do not modify files.'); } },
      { id: 'terminal', title: 'Toggle terminal', hint: 'Ctrl+Shift+T', run: () => setState((s) => ({ showTerminal: !s.showTerminal })) },
      { id: 'checkpoint', title: 'Create checkpoint', run: async () => {
          try {
            const checkpoint = await api.checkpoints.create(`Manual checkpoint ${new Date().toLocaleTimeString()}`);
            toast('ok', `Checkpoint created (${checkpoint.fileCount} files)`);
          } catch (err) {
            toast('err', (err as Error).message);
          }
        } },
      { id: 'git', title: 'Git status', run: () => void send('Show the current git status and summarise uncommitted changes.') },
      { id: 'stop', title: 'Stop agent', hint: 'Esc', run: stop },
      { id: 'settings', title: 'Settings', run: () => setState({ showSettings: true }) },
      { id: 'diagnostics', title: 'Copy diagnostics', run: copyDiagnostics },
      { id: 'theme', title: 'Toggle theme', run: async () => {
          const next = (getState().settings?.theme === 'dark' ? 'light' : 'dark') as 'dark' | 'light';
          document.documentElement.dataset.theme = next;
          const settings = await api.settings.update({ theme: next });
          setState({ settings });
        } }
    ],
    [newSession, send, stop, copyDiagnostics]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        e.preventDefault();
        setState((s) => ({ showPalette: !s.showPalette }));
      } else if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setState({ showPalette: true });
      } else if (meta && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setState((s) => ({ showTerminal: !s.showTerminal }));
      } else if (e.key === 'Escape') {
        const s = getState();
        if (s.showPalette || s.showSettings || s.openFile) setState({ showPalette: false, showSettings: false, openFile: null });
        else if (s.busy) stop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stop]);

  /* ------------------------------------------------------------ ui */

  if (!state.ready) {
    return <div className="empty" style={{ paddingTop: '40vh' }}>Starting Nexus Code…</div>;
  }

  const connection = !isDesktop
    ? { tone: 'warn', label: 'Preview mode — no desktop backend' }
    : state.hasApiKey
      ? { tone: 'ok', label: `${state.settings?.ai.model ?? 'Model'} configured` }
      : { tone: 'err', label: 'AI provider not configured' };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          NEXUS<span>CODE</span>
        </div>
        <span className="status-chip">
          <span className={`dot ${state.busy ? 'busy' : connection.tone}`} />
          {connection.label}
        </span>
        {state.workspace && (
          <span className="status-chip" title={state.workspace.root}>
            {state.workspace.name}
          </span>
        )}
        <span className="status-chip" title="Permission mode">
          {state.settings?.permissionMode ?? 'balanced'}
        </span>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={() => setState((s) => ({ showTerminal: !s.showTerminal }))}>
          Terminal
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setState({ showPalette: true })}>
          ⌘ Commands
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setState({ showSettings: true })}>
          Settings
        </button>
      </header>

      {recovery && (
        <div className="banner info" style={{ margin: '10px 16px' }}>
          Previous session “{recovery.title}” was interrupted ({recovery.state}). Nexus Code will re-inspect the project before continuing.
          <button
            className="btn btn-sm"
            style={{ marginLeft: 10 }}
            onClick={async () => {
              await openSession(recovery.id);
              setRecovery(null);
              void send('Resume the interrupted task. First inspect the filesystem, git status and task state to confirm what actually completed, then continue.');
            }}
          >
            Resume
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setRecovery(null)}>
            Discard
          </button>
        </div>
      )}

      <div className="workbench">
        <Sidebar onOpenFile={openFile} onNewSession={newSession} />

        <main className="center">
          <div className="conversation" ref={conversation} onScroll={onConversationScroll}>
            <div className="stream">
              {state.turns.length === 0 && (
                <div style={{ paddingTop: 48, textAlign: 'center' }}>
                  <h2 style={{ fontWeight: 600, fontSize: 19, marginBottom: 6 }}>What should we build?</h2>
                  <p className="card-sub">
                    Nexus Code inspects your project, asks only the decisions that matter, plans, implements, runs your real tests and repairs what breaks.
                  </p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginTop: 16 }}>
                    {['Review this project', 'Find why the app fails to start and fix it', 'Add tests for the API and make them pass'].map((example) => (
                      <button key={example} className="btn btn-sm" onClick={() => void send(example)} disabled={!state.workspace}>
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {state.turns.map((turn) => {
                switch (turn.kind) {
                  case 'user':
                    return (
                      <div key={turn.id} className="turn user">
                        <div className="turn-role">You</div>
                        <div className="bubble">{turn.content}</div>
                      </div>
                    );
                  case 'assistant':
                    return (
                      <div key={turn.id} className="turn assistant">
                        <div className="turn-role">Nexus</div>
                        <Markdown content={turn.content} onOpenFile={openFile} />
                      </div>
                    );
                  case 'tool':
                    return <ToolActivityItem key={turn.id} activity={turn.activity} />;
                  case 'requirements':
                    return <RequirementsCard key={turn.id} analysis={turn.analysis} />;
                  case 'question':
                    return (
                      <QuestionCard
                        key={turn.id}
                        questions={turn.questions}
                        answered={turn.answered}
                        onAnswer={(answer) => {
                          markQuestionAnswered(turn.id, answer);
                          void send(answer);
                        }}
                      />
                    );
                  case 'plan':
                    return (
                      <PlanCard
                        key={turn.id}
                        plan={turn.plan}
                        resolved={turn.resolved}
                        onApprove={() => {
                          markPlanResolved(turn.id, 'approved');
                          void send('Plan approved. Proceed with the implementation and verify your work.');
                        }}
                        onCancel={() => {
                          markPlanResolved(turn.id, 'cancelled');
                          void send('Do not execute that plan. Wait for further instructions.');
                        }}
                      />
                    );
                  case 'approval':
                    return (
                      <ApprovalCard
                        key={turn.id}
                        request={turn.request}
                        decision={turn.decision}
                        onDecide={(decision) => void api.agent.resolveApproval(turn.request.id, decision)}
                      />
                    );
                  case 'verification':
                    return <VerificationCard key={turn.id} report={turn.report} />;
                  case 'completion':
                    return <CompletionCard key={turn.id} report={turn.report} verified={turn.verified} onOpenFile={openFile} />;
                  case 'error':
                    return (
                      <div key={turn.id} className="banner err">
                        <div>{turn.message}</div>
                        <button className="banner-action" onClick={() => void copyDiagnostics()}>
                          Copy diagnostics
                        </button>
                      </div>
                    );
                  default:
                    return null;
                }
              })}
            </div>
          </div>

          {!atBottom && (
            <button
              className="jump-latest"
              onClick={() => {
                const el = conversation.current;
                el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                setAtBottom(true);
              }}
            >
              ↓ Jump to latest
            </button>
          )}

          {state.showTerminal && <TerminalPanel onClose={() => setState({ showTerminal: false })} />}

          <Composer
            mode={state.mode}
            busy={state.busy}
            disabled={!state.workspace || (!state.hasApiKey && isDesktop)}
            disabledReason={!state.workspace ? 'Open a project to start.' : 'Configure the AI provider in Settings to start.'}
            onModeChange={(mode) => setState({ mode })}
            onSend={(text) => void send(text)}
            onStop={stop}
          />
        </main>

        <ContextPanel />
      </div>

      {state.toast && (
        <div className={`banner ${state.toast.kind}`} style={{ position: 'fixed', bottom: 18, left: '50%', transform: 'translateX(-50%)', background: 'var(--bg-elevated)', boxShadow: 'var(--shadow)', zIndex: 200 }}>
          {state.toast.message}
        </div>
      )}
      {state.showPalette && <CommandPalette commands={commands} onClose={() => setState({ showPalette: false })} />}
      {state.showSettings && <SettingsDialog onClose={() => setState({ showSettings: false })} />}
      {state.openFile && <CodeViewer {...state.openFile} onClose={() => setState({ openFile: null })} />}
      {state.showOnboarding && <Onboarding onDone={() => setState({ showOnboarding: false })} />}
    </div>
  );
}
