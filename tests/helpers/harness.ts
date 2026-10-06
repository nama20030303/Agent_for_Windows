import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentController } from '../../src/core/agent/agentController.js';
import { createToolManager } from '../../src/core/tools/index.js';
import { PermissionManager } from '../../src/core/permissions/permissionManager.js';
import { ContextManager } from '../../src/core/context/contextManager.js';
import { ProjectIndexer } from '../../src/core/indexer/projectIndexer.js';
import { VerificationEngine } from '../../src/core/verification/verificationEngine.js';
import { ProcessManager } from '../../src/core/process/processManager.js';
import { SessionManager } from '../../src/core/session/sessionManager.js';
import { CheckpointManager } from '../../src/core/session/checkpointManager.js';
import { openDatabase } from '../../src/core/session/db.js';
import type { AgentEvent, PermissionMode } from '../../src/core/shared/types.js';
import type { AIProvider } from '../../src/core/ai/provider.js';

export function tempDir(prefix = 'nexus-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function buildHarness(options: {
  provider: AIProvider;
  workspaceRoot: string;
  permissionMode?: PermissionMode;
  autoApprove?: boolean;
}) {
  const storage = tempDir('nexus-store-');
  const db = await openDatabase(path.join(storage, 'db', 'nexus.db'));
  const sessions = new SessionManager(db);
  const permissions = new PermissionManager(options.permissionMode ?? 'balanced');
  const approvals: string[] = [];
  permissions.setApprovalHandler(async (request) => {
    approvals.push(`${request.tool}:${request.risk}`);
    return options.autoApprove ? 'allow_session' : 'deny';
  });

  const processes = new ProcessManager();
  const agent = new AgentController({
    provider: options.provider,
    tools: createToolManager(),
    permissions,
    context: new ContextManager(),
    indexer: new ProjectIndexer(),
    verification: new VerificationEngine(),
    processes,
    sessions,
    checkpoints: new CheckpointManager(db, path.join(storage, 'checkpoints'))
  });

  const events: AgentEvent[] = [];
  agent.events.on((e) => events.push(e));

  const project = sessions.upsertProject(options.workspaceRoot, 'test-project');
  const session = sessions.createSession(project.id, 'test session');

  return {
    agent,
    events,
    approvals,
    sessions,
    permissions,
    processes,
    storage,
    projectId: project.id,
    sessionId: session.id,
    cleanup: () => {
      processes.stopAll();
      db.close();
      fs.rmSync(storage, { recursive: true, force: true });
    }
  };
}
