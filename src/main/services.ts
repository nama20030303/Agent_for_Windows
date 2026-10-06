import path from 'node:path';
import fs from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { AgentEvent, ApprovalDecision, AppSettings, PermissionRequest } from '../core/shared/types.js';
import { openDatabase, type Database } from '../core/session/db.js';
import { SessionManager } from '../core/session/sessionManager.js';
import { CheckpointManager } from '../core/session/checkpointManager.js';
import { ProjectIndexer } from '../core/indexer/projectIndexer.js';
import { ContextManager } from '../core/context/contextManager.js';
import { ProcessManager } from '../core/process/processManager.js';
import { VerificationEngine } from '../core/verification/verificationEngine.js';
import { PermissionManager } from '../core/permissions/permissionManager.js';
import { createToolManager } from '../core/tools/index.js';
import { createProvider } from '../core/ai/index.js';
import { AgentController } from '../core/agent/agentController.js';
import { SettingsStore } from './settingsStore.js';
import { resolveAppPaths, type AppPaths } from './paths.js';
import { addLogSink, createLogger } from '../core/shared/logger.js';
import { uid } from '../core/shared/ids.js';
import { IPC } from '../core/shared/ipc.js';

const log = createLogger('services');

export interface CurrentWorkspace {
  projectId: string;
  root: string;
  name: string;
}

export class AppServices {
  readonly paths: AppPaths;
  readonly settingsStore: SettingsStore;
  readonly db!: Database;
  readonly sessions!: SessionManager;
  readonly checkpoints!: CheckpointManager;
  readonly indexer = new ProjectIndexer();
  readonly context = new ContextManager();
  readonly processes = new ProcessManager();
  readonly verification = new VerificationEngine();
  readonly permissions: PermissionManager;
  readonly tools = createToolManager();
  agent!: AgentController;
  workspace: CurrentWorkspace | null = null;

  private window: BrowserWindow | null = null;
  private pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
  private logStream: fs.WriteStream;

  private constructor(paths: AppPaths, settingsStore: SettingsStore, db: Database) {
    this.paths = paths;
    this.settingsStore = settingsStore;
    (this as any).db = db;
    (this as any).sessions = new SessionManager(db);
    (this as any).checkpoints = new CheckpointManager(db, paths.checkpoints);
    const settings = settingsStore.public();
    this.permissions = new PermissionManager(settings.permissionMode, settings.customPermissions);
    this.logStream = fs.createWriteStream(path.join(paths.logs, `nexus-${new Date().toISOString().slice(0, 10)}.log`), { flags: 'a' });
    addLogSink((record) => {
      this.logStream.write(`${record.at} ${record.level} [${record.scope}] ${record.message}\n`);
      this.window?.webContents.send(IPC.eventLog, record);
    });
  }

  static async create(): Promise<AppServices> {
    const paths = resolveAppPaths();
    const settingsStore = new SettingsStore(paths.config);
    const db = await openDatabase(path.join(paths.database, 'nexus.db'));
    const services = new AppServices(paths, settingsStore, db);
    services.rebuildAgent();
    log.info('Services initialised', { backend: db.backend, appData: paths.appData });
    return services;
  }

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    this.processes.changes.on((list) => this.window?.webContents.send(IPC.eventProcesses, list));
  }

  send(event: AgentEvent): void {
    this.window?.webContents.send(IPC.eventAgent, event);
  }

  settings(): AppSettings {
    return this.settingsStore.withSecrets();
  }

  /** Rebuilds the provider + agent after a settings change. */
  rebuildAgent(): void {
    const settings = this.settings();
    this.permissions.setMode(settings.permissionMode);
    this.permissions.setCustomRules(settings.customPermissions);
    this.permissions.setApprovalHandler((request) => this.requestApproval(request));

    const provider = createProvider(settings.ai);
    const previous = this.agent;
    this.agent = new AgentController({
      provider,
      tools: this.tools,
      permissions: this.permissions,
      context: this.context,
      indexer: this.indexer,
      verification: this.verification,
      processes: this.processes,
      sessions: this.sessions,
      checkpoints: this.checkpoints
    });
    this.agent.events.on((event) => this.send(event));
    if (previous) previous.events.clear();
  }

  private requestApproval(request: PermissionRequest): Promise<ApprovalDecision> {
    const id = request.id || uid('appr');
    const payload = { ...request, id };
    return new Promise<ApprovalDecision>((resolve) => {
      if (!this.window) {
        resolve('deny');
        return;
      }
      this.pendingApprovals.set(id, resolve);
      this.send({ type: 'approval_request', sessionId: 'current', request: payload });
      // Safety: never block the agent forever.
      const timer = setTimeout(() => {
        if (this.pendingApprovals.delete(id)) {
          log.warn('Approval timed out; denying', { tool: request.tool });
          resolve('deny');
        }
      }, 10 * 60 * 1000);
      timer.unref?.();
    });
  }

  resolveApproval(requestId: string, decision: ApprovalDecision): void {
    const resolver = this.pendingApprovals.get(requestId);
    if (!resolver) return;
    this.pendingApprovals.delete(requestId);
    resolver(decision);
    this.send({ type: 'approval_resolved', sessionId: 'current', requestId, decision });
  }

  setWorkspace(root: string): CurrentWorkspace {
    const project = this.sessions.upsertProject(root);
    this.workspace = { projectId: project.id, root: project.root, name: project.name };
    this.settingsStore.update({ lastWorkspace: root });
    this.permissions.clearSessionGrants();
    return this.workspace;
  }

  dispose(): void {
    this.processes.stopAll();
    this.db.close();
    this.logStream.end();
  }
}
