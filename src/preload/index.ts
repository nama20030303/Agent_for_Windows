import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../core/shared/ipc.js';

/**
 * The only bridge between the renderer and the main process.
 * No Node APIs and no raw ipcRenderer are exposed to the UI.
 */
const api = {
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: unknown) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
    setApiKey: (key: string) => ipcRenderer.invoke(IPC.settingsSetApiKey, key),
    hasApiKey: () => ipcRenderer.invoke(IPC.settingsHasApiKey),
    testConnection: () => ipcRenderer.invoke(IPC.settingsTest),
    setPermissionMode: (mode: string) => ipcRenderer.invoke(IPC.settingsPermissionMode, mode)
  },
  workspace: {
    pick: () => ipcRenderer.invoke(IPC.workspacePick),
    open: (root: string) => ipcRenderer.invoke(IPC.workspaceOpen, root),
    create: (parent: string, name: string) => ipcRenderer.invoke(IPC.workspaceCreate, parent, name),
    current: () => ipcRenderer.invoke(IPC.workspaceCurrent),
    reindex: () => ipcRenderer.invoke(IPC.workspaceReindex),
    readFile: (p: string) => ipcRenderer.invoke(IPC.workspaceReadFile, p),
    recentProjects: () => ipcRenderer.invoke(IPC.workspaceRecent),
    search: (q: string) => ipcRenderer.invoke(IPC.workspaceSearch, q)
  },
  session: {
    list: (projectId?: string) => ipcRenderer.invoke(IPC.sessionList, projectId),
    create: (title: string, mode: string) => ipcRenderer.invoke(IPC.sessionCreate, title, mode),
    messages: (id: string) => ipcRenderer.invoke(IPC.sessionMessages, id),
    tasks: (id: string) => ipcRenderer.invoke(IPC.sessionTasks, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.sessionRename, id, title),
    remove: (id: string) => ipcRenderer.invoke(IPC.sessionRemove, id),
    interrupted: () => ipcRenderer.invoke(IPC.sessionInterrupted)
  },
  agent: {
    send: (input: unknown) => ipcRenderer.invoke(IPC.agentSend, input),
    stop: (id: string) => ipcRenderer.invoke(IPC.agentStop, id),
    interject: (id: string, instruction: string) => ipcRenderer.invoke(IPC.agentInterject, id, instruction),
    state: (id: string) => ipcRenderer.invoke(IPC.agentState, id),
    resolveApproval: (requestId: string, decision: string) => ipcRenderer.invoke(IPC.agentApproval, requestId, decision)
  },
  memory: {
    get: () => ipcRenderer.invoke(IPC.memoryGet),
    save: (memory: unknown) => ipcRenderer.invoke(IPC.memorySave, memory)
  },
  checkpoints: {
    list: () => ipcRenderer.invoke(IPC.checkpointList),
    create: (label: string) => ipcRenderer.invoke(IPC.checkpointCreate, label),
    restore: (id: string) => ipcRenderer.invoke(IPC.checkpointRestore, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.checkpointRemove, id)
  },
  git: {
    status: () => ipcRenderer.invoke(IPC.gitStatus),
    diff: (file?: string) => ipcRenderer.invoke(IPC.gitDiff, file),
    log: (limit?: number) => ipcRenderer.invoke(IPC.gitLog, limit)
  },
  processes: {
    list: () => ipcRenderer.invoke(IPC.processList),
    stop: (id: string) => ipcRenderer.invoke(IPC.processStop, id),
    output: (id: string, lines?: number) => ipcRenderer.invoke(IPC.processOutput, id, lines)
  },
  terminal: {
    run: (command: string, cwd?: string) => ipcRenderer.invoke(IPC.terminalRun, command, cwd)
  },
  verification: {
    detect: () => ipcRenderer.invoke(IPC.verificationDetect)
  },
  events: {
    onAgentEvent: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on(IPC.eventAgent, listener);
      return () => ipcRenderer.removeListener(IPC.eventAgent, listener);
    },
    onProcesses: (handler: (processes: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on(IPC.eventProcesses, listener);
      return () => ipcRenderer.removeListener(IPC.eventProcesses, listener);
    },
    onLog: (handler: (record: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => handler(payload);
      ipcRenderer.on(IPC.eventLog, listener);
      return () => ipcRenderer.removeListener(IPC.eventLog, listener);
    }
  },
  app: {
    version: () => ipcRenderer.invoke(IPC.appVersion),
    paths: () => ipcRenderer.invoke(IPC.appPaths)
  }
};

contextBridge.exposeInMainWorld('nexus', api);
