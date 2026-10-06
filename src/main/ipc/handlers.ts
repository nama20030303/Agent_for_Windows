import { dialog, ipcMain, app, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import type { AgentMode, AppSettings, PermissionMode } from '../../core/shared/types.js';
import { IPC } from '../../core/shared/ipc.js';
import type { AppServices } from '../services.js';
import { createProvider } from '../../core/ai/index.js';
import { GitManager } from '../../core/git/gitManager.js';
import { runCommand } from '../../core/process/shell.js';
import { resolveWorkspacePath } from '../../core/permissions/pathGuard.js';
import { detectProjectCommands } from '../../core/verification/frameworks.js';
import { createLogger } from '../../core/shared/logger.js';
import { redactSecrets } from '../../core/shared/secrets.js';

const log = createLogger('ipc');

function handle(channel: string, fn: (...args: any[]) => any): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      log.error(`IPC ${channel} failed`, { reason: (err as Error).message });
      throw new Error((err as Error).message);
    }
  });
}

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  /* --------------------------------------------------------- settings */

  handle(IPC.settingsGet, () => ({ ...services.settingsStore.public(), hasApiKey: services.settingsStore.hasApiKey() }));

  handle(IPC.settingsUpdate, (patch: Partial<AppSettings>) => {
    const updated = services.settingsStore.update(patch);
    services.rebuildAgent();
    return updated;
  });

  handle(IPC.settingsSetApiKey, (key: string) => {
    const ok = services.settingsStore.setApiKey(key);
    services.rebuildAgent();
    return { ok };
  });

  handle(IPC.settingsHasApiKey, () => services.settingsStore.hasApiKey());

  handle(IPC.settingsTest, async () => {
    const settings = services.settings();
    if (!settings.ai.baseUrl) return { ok: false, message: 'Base URL is not configured.' };
    if (!settings.ai.apiKey) return { ok: false, message: 'No API key stored. Enter the key and save it first.' };
    const provider = createProvider(settings.ai);
    return provider.testConnection();
  });

  handle(IPC.settingsPermissionMode, (mode: PermissionMode) => {
    services.settingsStore.update({ permissionMode: mode });
    services.permissions.setMode(mode);
  });

  /* -------------------------------------------------------- workspace */

  handle(IPC.workspacePick, async () => {
    const window = getWindow();
    const result = await dialog.showOpenDialog(window!, {
      title: 'Select a project folder',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  const openWorkspace = async (root: string) => {
    if (!fssync.existsSync(root)) throw new Error(`Folder does not exist: ${root}`);
    const workspace = services.setWorkspace(path.resolve(root));
    const index = await services.indexer.index(workspace.root);
    return { ...workspace, index };
  };

  handle(IPC.workspaceOpen, (root: string) => openWorkspace(root));

  handle(IPC.workspaceCreate, async (parent: string, name: string) => {
    if (!/^[\w.\- ]{1,64}$/.test(name)) throw new Error('Invalid project name.');
    const root = path.join(parent, name);
    await fs.mkdir(root, { recursive: true });
    return openWorkspace(root);
  });

  handle(IPC.workspaceCurrent, async () => {
    if (!services.workspace) return null;
    const index = services.indexer.get(services.workspace.root) ?? (await services.indexer.index(services.workspace.root));
    return { ...services.workspace, index };
  });

  handle(IPC.workspaceReindex, async () => {
    if (!services.workspace) throw new Error('No workspace is open.');
    return services.indexer.index(services.workspace.root);
  });

  handle(IPC.workspaceReadFile, async (relativePath: string) => {
    if (!services.workspace) throw new Error('No workspace is open.');
    const check = resolveWorkspacePath(services.workspace.root, relativePath);
    if (!check.ok) throw new Error(check.reason);
    const stat = await fs.stat(check.absolute);
    if (stat.size > 2_000_000) throw new Error('File is too large to display.');
    const content = await fs.readFile(check.absolute, 'utf8');
    return { path: check.relative, content: redactSecrets(content) };
  });

  handle(IPC.workspaceRecent, () => services.sessions.listProjects());

  handle(IPC.workspaceSearch, async (query: string) => {
    if (!services.workspace || !query.trim()) return [];
    const tool = services.tools.get('search_text')!;
    const result = await tool.execute(
      { query, max_results: 80 },
      {
        workspaceRoot: services.workspace.root,
        projectId: services.workspace.projectId,
        sessionId: 'ui',
        shell: services.settings().shell,
        processManager: services.processes
      }
    );
    return (result.data as any[]) ?? [];
  });

  /* ---------------------------------------------------------- session */

  handle(IPC.sessionList, (projectId?: string) => services.sessions.listSessions(projectId ?? services.workspace?.projectId));

  handle(IPC.sessionCreate, (title: string, mode: AgentMode) => {
    if (!services.workspace) throw new Error('Open a project first.');
    return services.sessions.createSession(services.workspace.projectId, title, mode);
  });

  handle(IPC.sessionMessages, (sessionId: string) => services.sessions.listMessages(sessionId));
  handle(IPC.sessionTasks, (sessionId: string) => services.sessions.listTasks(sessionId));
  handle(IPC.sessionRename, (sessionId: string, title: string) => services.sessions.renameSession(sessionId, title));
  handle(IPC.sessionRemove, (sessionId: string) => {
    services.agent.release(sessionId);
    services.sessions.deleteSession(sessionId);
  });
  handle(IPC.sessionInterrupted, () => services.sessions.findInterruptedSessions());

  /* ------------------------------------------------------------ agent */

  handle(IPC.agentSend, async (input: { sessionId: string; message: string; mode: AgentMode }) => {
    if (!services.workspace) return { accepted: false, reason: 'Open a project first.' };
    const settings = services.settings();
    if (!settings.ai.apiKey) return { accepted: false, reason: 'Configure the AI provider API key in Settings first.' };

    const running = services.agent.isRunning(input.sessionId);
    if (running) {
      const injected = services.agent.injectInstruction(input.sessionId, input.message);
      return { accepted: injected, reason: injected ? 'Instruction applied to the running task.' : 'Agent is busy.' };
    }

    const options = {
      sessionId: input.sessionId,
      projectId: services.workspace.projectId,
      workspaceRoot: services.workspace.root,
      mode: input.mode,
      shell: settings.shell,
      userMessage: input.message,
      maxIterations: settings.maxAgentIterations,
      maxRepairAttempts: settings.maxRepairAttempts,
      requirePlanApproval: settings.requirePlanApproval
    };
    const state = services.agent.getState(input.sessionId);
    const resuming = ['WAITING_FOR_USER', 'WAITING_FOR_APPROVAL', 'BLOCKED'].includes(state);
    void (resuming ? services.agent.continueWith(options) : services.agent.run(options));
    return { accepted: true };
  });

  handle(IPC.agentStop, (sessionId: string) => services.agent.stop(sessionId));
  handle(IPC.agentInterject, (sessionId: string, instruction: string) => services.agent.injectInstruction(sessionId, instruction));
  handle(IPC.agentState, (sessionId: string) => services.agent.getState(sessionId));
  handle(IPC.agentApproval, (requestId: string, decision: any) => services.resolveApproval(requestId, decision));

  /* ----------------------------------------------------------- memory */

  handle(IPC.memoryGet, () => {
    if (!services.workspace) throw new Error('No workspace is open.');
    return services.sessions.getMemory(services.workspace.projectId);
  });

  handle(IPC.memorySave, (memory: any) => {
    if (!services.workspace) throw new Error('No workspace is open.');
    services.sessions.saveMemory(services.workspace.projectId, memory);
  });

  /* ------------------------------------------------------ checkpoints */

  handle(IPC.checkpointList, () => (services.workspace ? services.checkpoints.list(services.workspace.projectId) : []));

  handle(IPC.checkpointCreate, (label: string) => {
    if (!services.workspace) throw new Error('No workspace is open.');
    return services.checkpoints.create({ projectId: services.workspace.projectId, workspaceRoot: services.workspace.root, label });
  });

  handle(IPC.checkpointRestore, (id: string) => {
    if (!services.workspace) throw new Error('No workspace is open.');
    return services.checkpoints.restore(id, services.workspace.root);
  });

  handle(IPC.checkpointRemove, (id: string) => services.checkpoints.delete(id));

  /* -------------------------------------------------------------- git */

  handle(IPC.gitStatus, () => new GitManager(services.workspace?.root ?? process.cwd()).status());
  handle(IPC.gitDiff, async (file?: string) => (await new GitManager(services.workspace?.root ?? process.cwd()).diff(file)).stdout);
  handle(IPC.gitLog, async (limit?: number) => (await new GitManager(services.workspace?.root ?? process.cwd()).log(limit ?? 20)).stdout);

  /* -------------------------------------------------------- processes */

  handle(IPC.processList, () => services.processes.list());
  handle(IPC.processStop, (id: string) => services.processes.stop(id));
  handle(IPC.processOutput, (id: string, lines?: number) => services.processes.output(id, lines ?? 200));

  /* --------------------------------------------------------- terminal */

  handle(IPC.terminalRun, async (command: string, cwd?: string) => {
    if (!services.workspace) throw new Error('Open a project first.');
    const check = resolveWorkspacePath(services.workspace.root, cwd ?? '.');
    if (!check.ok) throw new Error(check.reason);
    // The integrated terminal is driven by the user, not the model, but the
    // same hard blocklist still applies.
    const { classifyCommand } = await import('../../core/permissions/riskClassifier.js');
    const classification = classifyCommand(command);
    if (classification.blocked) {
      return { exitCode: 1, stdout: '', stderr: `Blocked by Nexus Code security policy: ${classification.reason}`, durationMs: 0 };
    }
    const result = await runCommand(command, { cwd: check.absolute, shell: services.settings().shell, timeoutMs: 300_000 });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs };
  });

  /* ---------------------------------------------------- verification */

  handle(IPC.verificationDetect, () => (services.workspace ? detectProjectCommands(services.workspace.root) : []));

  /* ---------------------------------------------------------- app */

  handle(IPC.appVersion, () => app.getVersion());
  handle(IPC.appPaths, () => ({
    appData: services.paths.appData,
    logs: services.paths.logs,
    database: services.paths.database
  }));
}
