/**
 * The shapes the conversation is made of.
 *
 * They live in the shared layer rather than in the renderer because the
 * diagnostics report is built from them and has to be testable without a
 * browser: a type that only exists inside the UI cannot be reasoned about by
 * anything else.
 */
import type {
  AgentQuestion,
  AgentState,
  AppSettings,
  PermissionRequest,
  Plan,
  ProjectIndex,
  RequirementAnalysis,
  TokenUsage,
  ToolCall,
  ToolResult,
  VerificationReport
} from './types.js';

export interface ToolActivity {
  id: string;
  call: ToolCall;
  risk: string;
  result?: ToolResult;
  startedAt: number;
}

export type TurnItem =
  | { kind: 'user'; id: string; content: string }
  | { kind: 'assistant'; id: string; content: string; streaming?: boolean }
  | { kind: 'tool'; id: string; activity: ToolActivity }
  | { kind: 'question'; id: string; questions: AgentQuestion[]; answered?: string }
  | { kind: 'plan'; id: string; plan: Plan; resolved?: 'approved' | 'cancelled' }
  | { kind: 'approval'; id: string; request: PermissionRequest; decision?: string }
  | { kind: 'verification'; id: string; report: VerificationReport }
  | { kind: 'requirements'; id: string; analysis: RequirementAnalysis }
  | { kind: 'completion'; id: string; report: string; verified: boolean }
  | { kind: 'error'; id: string; message: string };

/** Everything the diagnostics report reads out of the running application. */
export interface UiSnapshot {
  settings: AppSettings | null;
  hasApiKey: boolean;
  workspace: { name: string } | null;
  index: Pick<ProjectIndex, 'fileCount'> | null;
  agentState: AgentState;
  agentDetail: string;
  turns: TurnItem[];
  timeline: { at: string; message: string }[];
  usage: TokenUsage;
}
