/** IPC contract shared by the main process, the preload bridge and the renderer. */
import type {
  AgentEvent,
  AgentMode,
  AppSettings,
  ApprovalDecision,
  ManagedProcess,
  PermissionMode,
  ProjectIndex,
  ProjectMemory,
  Task
} from './types.js';

export interface WorkspaceInfo {
  projectId: string;
  root: string;
  name: string;
  index: ProjectIndex;
}

export interface SessionSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: string;
  state: string;
  mode: string;
}

export interface StoredMessageDTO {
  id: string;
  sessionId: string;
  at: string;
  role: string;
  content: string;
  meta?: Record<string, unknown>;
}

export interface CheckpointDTO {
  id: string;
  label: string;
  createdAt: string;
  fileCount: number;
  bytes: number;
  gitCommit?: string;
}

export interface GitStatusDTO {
  isRepo: boolean;
  branch?: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  clean: boolean;
}

export interface NexusApi {
  settings: {
    get(): Promise<AppSettings>;
    update(patch: Partial<AppSettings>): Promise<AppSettings>;
    setApiKey(key: string): Promise<{ ok: boolean }>;
    hasApiKey(): Promise<boolean>;
    testConnection(): Promise<{ ok: boolean; message: string; modelAvailable?: boolean; models?: string[] }>;
    setPermissionMode(mode: PermissionMode): Promise<void>;
  };
  workspace: {
    pick(): Promise<string | null>;
    open(root: string): Promise<WorkspaceInfo>;
    create(parent: string, name: string): Promise<WorkspaceInfo>;
    current(): Promise<WorkspaceInfo | null>;
    reindex(): Promise<ProjectIndex>;
    readFile(relativePath: string): Promise<{ path: string; content: string }>;
    recentProjects(): Promise<{ id: string; name: string; root: string; lastOpenedAt: string }[]>;
    search(query: string): Promise<{ path: string; line: number; text: string }[]>;
  };
  session: {
    list(projectId?: string): Promise<SessionSummary[]>;
    create(title: string, mode: AgentMode): Promise<SessionSummary>;
    messages(sessionId: string): Promise<StoredMessageDTO[]>;
    tasks(sessionId: string): Promise<Task[]>;
    rename(sessionId: string, title: string): Promise<void>;
    remove(sessionId: string): Promise<void>;
    interrupted(): Promise<SessionSummary[]>;
  };
  agent: {
    send(input: { sessionId: string; message: string; mode: AgentMode }): Promise<{ accepted: boolean; reason?: string }>;
    stop(sessionId: string): Promise<void>;
    interject(sessionId: string, instruction: string): Promise<boolean>;
    state(sessionId: string): Promise<string>;
    resolveApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  };
  memory: {
    get(): Promise<ProjectMemory>;
    save(memory: ProjectMemory): Promise<void>;
  };
  checkpoints: {
    list(): Promise<CheckpointDTO[]>;
    create(label: string): Promise<CheckpointDTO>;
    restore(id: string): Promise<{ restored: number; extraFiles: string[] }>;
    remove(id: string): Promise<void>;
  };
  git: {
    status(): Promise<GitStatusDTO>;
    diff(file?: string): Promise<string>;
    log(limit?: number): Promise<string>;
  };
  processes: {
    list(): Promise<ManagedProcess[]>;
    stop(id: string): Promise<void>;
    output(id: string, lines?: number): Promise<string[]>;
  };
  terminal: {
    run(command: string, cwd?: string): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  };
  verification: {
    detect(): Promise<{ framework: string; test?: string; build?: string; lint?: string; cwd: string }[]>;
  };
  events: {
    onAgentEvent(handler: (event: AgentEvent) => void): () => void;
    onProcesses(handler: (processes: ManagedProcess[]) => void): () => void;
    onLog(handler: (record: { at: string; level: string; scope: string; message: string }) => void): () => void;
  };
  app: {
    version(): Promise<string>;
    paths(): Promise<{ appData: string; logs: string; database: string }>;
  };
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  settingsSetApiKey: 'settings:setApiKey',
  settingsHasApiKey: 'settings:hasApiKey',
  settingsTest: 'settings:test',
  settingsPermissionMode: 'settings:permissionMode',
  workspacePick: 'workspace:pick',
  workspaceOpen: 'workspace:open',
  workspaceCreate: 'workspace:create',
  workspaceCurrent: 'workspace:current',
  workspaceReindex: 'workspace:reindex',
  workspaceReadFile: 'workspace:readFile',
  workspaceRecent: 'workspace:recent',
  workspaceSearch: 'workspace:search',
  sessionList: 'session:list',
  sessionCreate: 'session:create',
  sessionMessages: 'session:messages',
  sessionTasks: 'session:tasks',
  sessionRename: 'session:rename',
  sessionRemove: 'session:remove',
  sessionInterrupted: 'session:interrupted',
  agentSend: 'agent:send',
  agentStop: 'agent:stop',
  agentInterject: 'agent:interject',
  agentState: 'agent:state',
  agentApproval: 'agent:approval',
  memoryGet: 'memory:get',
  memorySave: 'memory:save',
  checkpointList: 'checkpoint:list',
  checkpointCreate: 'checkpoint:create',
  checkpointRestore: 'checkpoint:restore',
  checkpointRemove: 'checkpoint:remove',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitLog: 'git:log',
  processList: 'process:list',
  processStop: 'process:stop',
  processOutput: 'process:output',
  terminalRun: 'terminal:run',
  verificationDetect: 'verification:detect',
  appVersion: 'app:version',
  appPaths: 'app:paths',
  eventAgent: 'event:agent',
  eventProcesses: 'event:processes',
  eventLog: 'event:log'
} as const;
