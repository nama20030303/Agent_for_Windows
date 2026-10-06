import type { NexusApi } from '../../core/shared/ipc.js';

declare global {
  interface Window {
    nexus?: NexusApi;
  }
}

/**
 * The renderer talks to the application only through the preload bridge.
 * When the UI is opened in a plain browser (design/preview mode) there is no
 * backend, so a clearly-labelled inert bridge is used instead: it performs no
 * filesystem, terminal or model work and says so in the UI.
 */
export const isDesktop = typeof window !== 'undefined' && !!window.nexus;

const notAvailable = async (): Promise<never> => {
  throw new Error('Preview mode: the Nexus Code desktop backend is not running, so this action is unavailable.');
};

const previewApi: NexusApi = {
  settings: {
    get: async () =>
      ({
        ai: {
          provider: 'nemotron',
          baseUrl: 'https://api.nemotron.ai/v1',
          model: 'am/nemotron-3-ultra-550b-a55b',
          temperature: 0.2,
          maxTokens: 8192,
          timeoutMs: 180000,
          streaming: true
        },
        permissionMode: 'balanced',
        customPermissions: { autoAllowUpTo: 'LOW', allowNetwork: true, allowOutsideWorkspaceRead: false, allowDelete: false, allowGitRemote: false },
        requirePlanApproval: true,
        maxRepairAttempts: 5,
        maxAgentIterations: 40,
        theme: 'dark',
        shell: 'powershell',
        onboardingComplete: true
      }) as any,
    update: async (p: any) => p,
    setApiKey: notAvailable,
    hasApiKey: async () => false,
    testConnection: async () => ({ ok: false, message: 'Preview mode: no desktop backend is connected.' }),
    detectProvider: async () => ({
      ok: false,
      reachable: [],
      attempts: [],
      message: 'Preview mode: no desktop backend is connected.'
    }),
    setPermissionMode: async () => undefined
  },
  workspace: {
    pick: notAvailable,
    open: notAvailable,
    create: notAvailable,
    current: async () => null,
    reindex: notAvailable,
    readFile: notAvailable,
    recentProjects: async () => [],
    search: async () => []
  },
  session: {
    list: async () => [],
    create: notAvailable,
    messages: async () => [],
    tasks: async () => [],
    rename: async () => undefined,
    remove: async () => undefined,
    interrupted: async () => []
  },
  agent: {
    send: async () => ({ accepted: false, reason: 'Preview mode: the agent runs only in the desktop application.' }),
    stop: async () => undefined,
    interject: async () => false,
    state: async () => 'IDLE',
    resolveApproval: async () => undefined
  },
  memory: { get: notAvailable, save: notAvailable },
  checkpoints: { list: async () => [], create: notAvailable, restore: notAvailable, remove: notAvailable },
  git: { status: async () => ({ isRepo: false, staged: [], modified: [], untracked: [], clean: true }), diff: async () => '', log: async () => '' },
  processes: { list: async () => [], stop: async () => undefined, output: async () => [] },
  terminal: { run: notAvailable },
  verification: { detect: async () => [] },
  events: { onAgentEvent: () => () => undefined, onProcesses: () => () => undefined, onLog: () => () => undefined },
  app: { version: async () => '0.1.0-preview', paths: async () => ({ appData: '—', logs: '—', database: '—' }) }
};

export const api: NexusApi = (typeof window !== 'undefined' && window.nexus) || previewApi;
