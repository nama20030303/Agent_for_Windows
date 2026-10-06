import type {
  AgentState,
  ChatMessage,
  ProjectMemory,
  Task
} from '../shared/types.js';
import type { Database, Row } from './db.js';
import { nowIso, uid } from '../shared/ids.js';

export interface ProjectRecord {
  id: string;
  name: string;
  root: string;
  lastOpenedAt: string;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: AgentState;
  mode: string;
  interrupted: boolean;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  at: string;
  role: ChatMessage['role'] | 'event';
  content: string;
  meta?: Record<string, unknown>;
}

const EMPTY_MEMORY: ProjectMemory = {
  projectName: '',
  projectGoal: '',
  architecture: '',
  stack: [],
  decisions: [],
  preferences: [],
  constraints: [],
  knownProblems: [],
  completedTasks: [],
  importantFiles: []
};

function row(id: string, data: Record<string, unknown>, parent?: string): Row {
  return { id, parent, updatedAt: nowIso(), data };
}

export class SessionManager {
  constructor(private db: Database) {}

  /* ------------------------------------------------------------ projects */

  upsertProject(root: string, name?: string): ProjectRecord {
    const existing = this.db.all('projects').find((r) => (r.data as any).root === root);
    const record: ProjectRecord = existing
      ? { ...(existing.data as unknown as ProjectRecord), lastOpenedAt: nowIso() }
      : { id: uid('proj'), name: name ?? root.split(/[\\/]/).filter(Boolean).pop() ?? root, root, lastOpenedAt: nowIso() };
    this.db.upsert('projects', row(record.id, record as unknown as Record<string, unknown>));
    return record;
  }

  listProjects(): ProjectRecord[] {
    return this.db.all('projects').map((r) => r.data as unknown as ProjectRecord);
  }

  /* ------------------------------------------------------------ sessions */

  createSession(projectId: string, title: string, mode = 'agent'): SessionRecord {
    const session: SessionRecord = {
      id: uid('sess'),
      projectId,
      title,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      state: 'IDLE',
      mode,
      interrupted: false
    };
    this.db.upsert('sessions', row(session.id, session as unknown as Record<string, unknown>, projectId));
    return session;
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.get('sessions', id)?.data as unknown as SessionRecord | undefined;
  }

  listSessions(projectId?: string): SessionRecord[] {
    const rows = projectId ? this.db.all('sessions', projectId) : this.db.all('sessions');
    return rows
      .map((r) => r.data as unknown as SessionRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateSession(id: string, patch: Partial<SessionRecord>): SessionRecord | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db.upsert('sessions', row(id, next as unknown as Record<string, unknown>, next.projectId));
    return next;
  }

  deleteSession(id: string): void {
    for (const m of this.db.all('messages', id)) this.db.remove('messages', m.id);
    this.db.remove('sessions', id);
  }

  renameSession(id: string, title: string): void {
    this.updateSession(id, { title });
  }

  /* ------------------------------------------------------------ messages */

  appendMessage(message: Omit<StoredMessage, 'id' | 'at'> & { id?: string; at?: string }): StoredMessage {
    const stored: StoredMessage = { id: message.id ?? uid('msg'), at: message.at ?? nowIso(), ...message } as StoredMessage;
    this.db.upsert('messages', row(stored.id, stored as unknown as Record<string, unknown>, stored.sessionId));
    this.updateSession(stored.sessionId, {});
    return stored;
  }

  listMessages(sessionId: string): StoredMessage[] {
    return this.db.all('messages', sessionId).map((r) => r.data as unknown as StoredMessage);
  }

  /* --------------------------------------------------------------- tasks */

  upsertTask(task: Task): void {
    this.db.upsert('tasks', row(task.id, task as unknown as Record<string, unknown>, task.sessionId));
  }

  listTasks(sessionId: string): Task[] {
    return this.db.all('tasks', sessionId).map((r) => r.data as unknown as Task);
  }

  /* --------------------------------------------------------- agent state */

  saveAgentState(sessionId: string, state: AgentState, detail?: Record<string, unknown>): void {
    this.db.upsert('agent_state', row(sessionId, { sessionId, state, detail, at: nowIso() }, sessionId));
    this.updateSession(sessionId, { state });
  }

  getAgentState(sessionId: string): { state: AgentState; detail?: Record<string, unknown> } | undefined {
    const r = this.db.get('agent_state', sessionId);
    return r ? (r.data as any) : undefined;
  }

  /** Sessions left in a non-terminal state by a crash or forced exit. */
  findInterruptedSessions(): SessionRecord[] {
    const terminal: AgentState[] = ['IDLE', 'COMPLETED', 'FAILED', 'STOPPED'];
    return this.listSessions().filter((s) => !terminal.includes(s.state));
  }

  /* -------------------------------------------------------------- memory */

  getMemory(projectId: string): ProjectMemory {
    const r = this.db.get('project_memory', projectId);
    return r ? ({ ...EMPTY_MEMORY, ...(r.data as any) } as ProjectMemory) : { ...EMPTY_MEMORY };
  }

  saveMemory(projectId: string, memory: ProjectMemory): void {
    this.db.upsert('project_memory', row(projectId, memory as unknown as Record<string, unknown>, projectId));
  }

  addMemoryFact(projectId: string, kind: string, value: string, rationale?: string): ProjectMemory {
    const memory = this.getMemory(projectId);
    switch (kind) {
      case 'decision':
        memory.decisions.push({ at: nowIso(), decision: value, rationale });
        break;
      case 'preference':
        if (!memory.preferences.includes(value)) memory.preferences.push(value);
        break;
      case 'constraint':
        if (!memory.constraints.includes(value)) memory.constraints.push(value);
        break;
      case 'known_problem':
        if (!memory.knownProblems.includes(value)) memory.knownProblems.push(value);
        break;
      case 'important_file':
        if (!memory.importantFiles.includes(value)) memory.importantFiles.push(value);
        break;
      case 'stack':
        if (!memory.stack.includes(value)) memory.stack.push(value);
        break;
      case 'goal':
        memory.projectGoal = value;
        break;
      case 'architecture':
        memory.architecture = value;
        break;
      default:
        memory.preferences.push(`${kind}: ${value}`);
    }
    this.saveMemory(projectId, memory);
    return memory;
  }

  /* ------------------------------------------------------------ settings */

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.get('settings', key);
    return r ? ((r.data as any).value as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.upsert('settings', row(key, { key, value }));
  }
}
