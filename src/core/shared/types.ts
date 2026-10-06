/**
 * Shared domain types for Nexus Code.
 * These types are used by the agent core, the Electron main process and the renderer.
 */

/* ------------------------------------------------------------------ agent */

export const AGENT_STATES = [
  'IDLE',
  'ANALYZING',
  'INSPECTING_PROJECT',
  'ANALYZING_REQUIREMENTS',
  'WAITING_FOR_USER',
  'PLANNING',
  'WAITING_FOR_APPROVAL',
  'EXECUTING',
  'RUNNING_TOOL',
  'VERIFYING',
  'REPAIRING',
  'BLOCKED',
  'STOPPING',
  'STOPPED',
  'COMPLETED',
  'FAILED'
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export type AgentMode = 'chat' | 'plan' | 'agent' | 'auto';

/* ------------------------------------------------------------------- task */

export type TaskStatus =
  | 'pending'
  | 'planning'
  | 'awaiting_user'
  | 'executing'
  | 'verifying'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'stopped';

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface TaskStep {
  id: string;
  description: string;
  status: StepStatus;
  detail?: string;
}

export interface Task {
  id: string;
  sessionId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
  steps: TaskStep[];
}

/* -------------------------------------------------------------- tool layer */

export type RiskLevel = 'SAFE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ToolCategory =
  | 'filesystem'
  | 'search'
  | 'terminal'
  | 'process'
  | 'git'
  | 'testing'
  | 'meta';

export interface JSONSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  /** Static baseline risk; a tool may refine it per-invocation. */
  risk: RiskLevel;
  /** True when the tool can change the filesystem or system state. */
  mutating: boolean;
  parameters: JSONSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  success: boolean;
  tool: string;
  callId?: string;
  /** Human/model readable summary of the outcome. */
  summary?: string;
  data?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  error?: string;
  errorType?: ErrorType;
  denied?: boolean;
}

/* ------------------------------------------------------------ permissions */

export type PermissionMode = 'safe' | 'balanced' | 'autonomous' | 'custom';

export type ApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'allow_project'
  | 'deny';

export interface PermissionRequest {
  id: string;
  tool: string;
  operation: string;
  target: string;
  command?: string;
  reason: string;
  risk: RiskLevel;
}

export interface PermissionVerdict {
  allowed: boolean;
  requiresApproval: boolean;
  blocked: boolean;
  risk: RiskLevel;
  reason: string;
}

export interface CustomPermissionRules {
  /** Maximum risk level auto-allowed without approval. */
  autoAllowUpTo: RiskLevel;
  allowNetwork: boolean;
  allowOutsideWorkspaceRead: boolean;
  allowDelete: boolean;
  allowGitRemote: boolean;
}

/* ----------------------------------------------------------- requirements */

export type RequirementKind =
  | 'explicit'
  | 'implicit'
  | 'missing'
  | 'optional'
  | 'conflicting';

export interface Requirement {
  id: string;
  kind: RequirementKind;
  topic: string;
  statement: string;
  /** 0..1 — how sure the agent is about this decision. */
  confidence: number;
  importance: 'critical' | 'high' | 'medium' | 'low';
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentQuestion {
  id: string;
  topic: string;
  question: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  options: QuestionOption[];
  recommendedOptionId?: string;
  recommendationReason?: string;
}

export interface RequirementAnalysis {
  summary: string;
  requirements: Requirement[];
  questions: AgentQuestion[];
  assumptions: string[];
}

/* ---------------------------------------------------------------- planning */

export interface PlanStep {
  id: string;
  title: string;
  detail?: string;
}

export interface Plan {
  id: string;
  title: string;
  technology: string[];
  steps: PlanStep[];
  estimatedFiles?: number;
  includesTests: boolean;
  requiresApproval: boolean;
  notes?: string;
}

/* ------------------------------------------------------------ verification */

export const ERROR_TYPES = [
  'SYNTAX_ERROR',
  'IMPORT_ERROR',
  'DEPENDENCY_ERROR',
  'BUILD_ERROR',
  'RUNTIME_ERROR',
  'DATABASE_ERROR',
  'NETWORK_ERROR',
  'CONFIGURATION_ERROR',
  'ENVIRONMENT_ERROR',
  'PERMISSION_ERROR',
  'ARCHITECTURE_ERROR',
  'TEST_FAILURE',
  'UNKNOWN_ERROR'
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export type VerificationLevel =
  | 'syntax'
  | 'static'
  | 'build'
  | 'tests'
  | 'runtime'
  | 'functional';

export type VerificationOutcome = 'passed' | 'failed' | 'skipped' | 'not_available';

export interface VerificationCheck {
  level: VerificationLevel;
  command?: string;
  outcome: VerificationOutcome;
  detail: string;
  errorType?: ErrorType;
  durationMs?: number;
}

export interface VerificationReport {
  checks: VerificationCheck[];
  passed: boolean;
  /** Levels that could not be verified, with the reason. */
  unverified: { level: VerificationLevel; reason: string }[];
}

/* ------------------------------------------------------------------ index */

export interface IndexedFile {
  path: string; // workspace-relative, posix separators
  ext: string;
  size: number;
  mtimeMs: number;
  language?: string;
  symbols?: string[];
  lines?: number;
}

export interface ProjectIndex {
  root: string;
  generatedAt: string;
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
  languages: Record<string, number>;
  frameworks: string[];
  packageManagers: string[];
  testFrameworks: string[];
  entryPoints: string[];
  hasGit: boolean;
  files: IndexedFile[];
  tree: string;
}

/* ----------------------------------------------------------------- memory */

export interface ProjectMemory {
  projectName: string;
  projectGoal: string;
  architecture: string;
  stack: string[];
  decisions: { at: string; decision: string; rationale?: string }[];
  preferences: string[];
  constraints: string[];
  knownProblems: string[];
  completedTasks: string[];
  importantFiles: string[];
}

/* ---------------------------------------------------------------- process */

export interface ManagedProcess {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid?: number;
  status: 'starting' | 'running' | 'exited' | 'failed' | 'stopped';
  exitCode?: number;
  port?: number;
  startedAt: string;
  output: string[];
}

/* ------------------------------------------------------------- ai provider */

export interface AIProviderSettings {
  provider: 'nemotron' | 'openai-compatible' | 'custom';
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  streaming: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: string }[];
}

export interface TokenUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/* ------------------------------------------------------------ agent events */

export type AgentEvent =
  | { type: 'assistant_message'; sessionId: string; content: string; final: boolean }
  | { type: 'assistant_delta'; sessionId: string; delta: string }
  | { type: 'tool_call'; sessionId: string; call: ToolCall; risk: RiskLevel }
  | { type: 'tool_result'; sessionId: string; callId: string; result: ToolResult }
  | { type: 'question'; sessionId: string; questions: AgentQuestion[] }
  | { type: 'approval_request'; sessionId: string; request: PermissionRequest }
  | { type: 'approval_resolved'; sessionId: string; requestId: string; decision: ApprovalDecision }
  | { type: 'plan'; sessionId: string; plan: Plan }
  | { type: 'task_update'; sessionId: string; task: Task }
  | { type: 'agent_state_change'; sessionId: string; state: AgentState; detail?: string }
  | { type: 'requirements'; sessionId: string; analysis: RequirementAnalysis }
  | { type: 'verification'; sessionId: string; report: VerificationReport }
  | { type: 'timeline'; sessionId: string; at: string; message: string }
  | { type: 'usage'; sessionId: string; usage: TokenUsage }
  | { type: 'error'; sessionId: string; message: string; errorType?: ErrorType }
  | { type: 'completion'; sessionId: string; report: string; verified: boolean };

/* --------------------------------------------------------------- settings */

export interface AppSettings {
  ai: AIProviderSettings;
  permissionMode: PermissionMode;
  customPermissions: CustomPermissionRules;
  requirePlanApproval: boolean;
  maxRepairAttempts: number;
  maxAgentIterations: number;
  theme: 'dark' | 'light';
  shell: 'powershell' | 'cmd' | 'bash';
  onboardingComplete: boolean;
  lastWorkspace?: string;
}

/** A host that answered a provider-detection probe. */
export interface DetectedProvider {
  providerId: string;
  label: string;
  baseUrl: string;
  matches: string[];
  models: string[];
}

/** Outcome of probing known OpenAI-compatible hosts with the user's key. */
export interface DetectionResult {
  ok: boolean;
  best?: DetectedProvider & { model: string };
  reachable: DetectedProvider[];
  attempts: { label: string; baseUrl: string; status: string }[];
  message: string;
}
