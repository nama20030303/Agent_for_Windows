import { useSyncExternalStore } from 'react';
import type {
  AgentEvent,
  AgentMode,
  AgentQuestion,
  AgentState,
  AppSettings,
  ManagedProcess,
  PermissionRequest,
  Plan,
  ProjectIndex,
  RequirementAnalysis,
  Task,
  ToolCall,
  ToolResult,
  TokenUsage,
  VerificationReport
} from '../../../core/shared/types.js';
import type { SessionSummary, WorkspaceInfo } from '../../../core/shared/ipc.js';
import type { ToolActivity, TurnItem } from '../../../core/shared/uiState.js';
import { api } from '../bridge.js';

export type { ToolActivity, TurnItem } from '../../../core/shared/uiState.js';

export interface AppState {
  ready: boolean;
  settings: AppSettings | null;
  hasApiKey: boolean;
  workspace: WorkspaceInfo | null;
  index: ProjectIndex | null;
  sessions: SessionSummary[];
  sessionId: string | null;
  mode: AgentMode;
  agentState: AgentState;
  agentDetail: string;
  turns: TurnItem[];
  tasks: Task[];
  timeline: { at: string; message: string }[];
  processes: ManagedProcess[];
  usage: TokenUsage;
  filesCreated: number;
  filesModified: number;
  git: { branch?: string; modified: number; staged: number; untracked: number; isRepo: boolean };
  openFile: { path: string; content: string; line?: number } | null;
  showTerminal: boolean;
  showPalette: boolean;
  showSettings: boolean;
  showOnboarding: boolean;
  busy: boolean;
  toast: { kind: 'ok' | 'err' | 'info'; message: string } | null;
}

const initial: AppState = {
  ready: false,
  settings: null,
  hasApiKey: false,
  workspace: null,
  index: null,
  sessions: [],
  sessionId: null,
  mode: 'agent',
  agentState: 'IDLE',
  agentDetail: '',
  turns: [],
  tasks: [],
  timeline: [],
  processes: [],
  usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
  filesCreated: 0,
  filesModified: 0,
  git: { modified: 0, staged: 0, untracked: 0, isRepo: false },
  openFile: null,
  showTerminal: false,
  showPalette: false,
  showSettings: false,
  showOnboarding: false,
  busy: false,
  toast: null
};

let state: AppState = initial;
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initial)
  );
}

export function toast(kind: 'ok' | 'err' | 'info', message: string): void {
  setState({ toast: { kind, message } });
  setTimeout(() => setState((s) => (s.toast?.message === message ? { toast: null } : {})), 5000);
}

let uidCounter = 0;
const nextId = () => `t${++uidCounter}`;

function pushTurn(item: TurnItem): void {
  setState((s) => ({ turns: [...s.turns, item] }));
}

const BUSY_STATES: AgentState[] = ['ANALYZING', 'INSPECTING_PROJECT', 'ANALYZING_REQUIREMENTS', 'PLANNING', 'EXECUTING', 'RUNNING_TOOL', 'VERIFYING', 'REPAIRING', 'STOPPING'];

/** Applies an agent protocol event to the UI state. */
export function applyAgentEvent(event: AgentEvent): void {
  switch (event.type) {
    case 'assistant_delta': {
      setState((s) => {
        const turns = [...s.turns];
        const last = turns.at(-1);
        if (last?.kind === 'assistant' && last.streaming) {
          turns[turns.length - 1] = { ...last, content: last.content + event.delta };
        } else {
          turns.push({ kind: 'assistant', id: nextId(), content: event.delta, streaming: true });
        }
        return { turns };
      });
      break;
    }
    case 'assistant_restart': {
      // The provider threw away its partial answer and is starting over.
      setState((s) => {
        const turns = [...s.turns];
        if (turns.at(-1)?.kind === 'assistant' && (turns.at(-1) as any).streaming) turns.pop();
        return { turns };
      });
      break;
    }
    case 'assistant_message': {
      setState((s) => {
        const turns = [...s.turns];
        const last = turns.at(-1);
        if (last?.kind === 'assistant' && last.streaming) {
          turns[turns.length - 1] = { kind: 'assistant', id: last.id, content: event.content, streaming: false };
          return { turns };
        }
        return { turns: [...turns, { kind: 'assistant', id: nextId(), content: event.content }] };
      });
      break;
    }
    case 'tool_call':
      pushTurn({ kind: 'tool', id: event.call.id, activity: { id: event.call.id, call: event.call, risk: event.risk, startedAt: Date.now() } });
      break;
    case 'tool_result':
      setState((s) => ({
        turns: s.turns.map((t) => (t.kind === 'tool' && t.activity.id === event.callId ? { ...t, activity: { ...t.activity, result: event.result } } : t)),
        filesCreated: s.filesCreated + (['write_file', 'create_directory'].includes(event.result.tool) && event.result.success && (event.result.data as any)?.created !== false ? 1 : 0),
        filesModified: s.filesModified + (event.result.tool === 'edit_file' && event.result.success ? 1 : 0)
      }));
      break;
    case 'question':
      pushTurn({ kind: 'question', id: nextId(), questions: event.questions });
      break;
    case 'plan':
      pushTurn({ kind: 'plan', id: event.plan.id, plan: event.plan });
      break;
    case 'approval_request':
      pushTurn({ kind: 'approval', id: event.request.id, request: event.request });
      break;
    case 'approval_resolved':
      setState((s) => ({ turns: s.turns.map((t) => (t.kind === 'approval' && t.id === event.requestId ? { ...t, decision: event.decision } : t)) }));
      break;
    case 'requirements':
      pushTurn({ kind: 'requirements', id: nextId(), analysis: event.analysis });
      break;
    case 'verification':
      pushTurn({ kind: 'verification', id: nextId(), report: event.report });
      break;
    case 'completion':
      pushTurn({ kind: 'completion', id: nextId(), report: event.report, verified: event.verified });
      break;
    case 'error':
      pushTurn({ kind: 'error', id: nextId(), message: event.message });
      break;
    case 'task_update':
      setState((s) => ({ tasks: [...s.tasks.filter((t) => t.id !== event.task.id), event.task] }));
      break;
    case 'agent_state_change':
      setState({ agentState: event.state, agentDetail: event.detail ?? '', busy: BUSY_STATES.includes(event.state) });
      break;
    case 'timeline':
      setState((s) => ({ timeline: [...s.timeline, { at: event.at, message: event.message }].slice(-200) }));
      break;
    case 'usage':
      setState({ usage: event.usage });
      break;
  }
}

export function appendUserTurn(content: string): void {
  pushTurn({ kind: 'user', id: nextId(), content });
}

export function markQuestionAnswered(id: string, answer: string): void {
  setState((s) => ({ turns: s.turns.map((t) => (t.kind === 'question' && t.id === id ? { ...t, answered: answer } : t)) }));
}

export function markPlanResolved(id: string, resolution: 'approved' | 'cancelled'): void {
  setState((s) => ({ turns: s.turns.map((t) => (t.kind === 'plan' && t.id === id ? { ...t, resolved: resolution } : t)) }));
}

export async function refreshGit(): Promise<void> {
  try {
    const status = await api.git.status();
    setState({ git: { branch: status.branch, modified: status.modified.length, staged: status.staged.length, untracked: status.untracked.length, isRepo: status.isRepo } });
  } catch {
    /* git is optional */
  }
}

/**
 * Open a stored session and rebuild its transcript.
 *
 * Only real conversation turns are shown: persisted tool lines exist so a
 * resumed agent knows what it already did, but replaying them as assistant
 * messages would misrepresent them as things the agent said.
 */
export async function openSession(id: string, agentState?: AppState['agentState']): Promise<void> {
  setState({
    sessionId: id,
    turns: [],
    tasks: [],
    timeline: [],
    filesCreated: 0,
    filesModified: 0,
    ...(agentState ? { agentState } : {})
  });

  const [messages, tasks] = await Promise.all([api.session.messages(id), api.session.tasks(id)]);

  setState({
    tasks,
    turns: messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m, i) => ({ kind: m.role as 'user' | 'assistant', id: `stored-${id}-${i}`, content: m.content }))
  });
}
