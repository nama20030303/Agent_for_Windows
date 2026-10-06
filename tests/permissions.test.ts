import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PermissionManager } from '../src/core/permissions/permissionManager.js';
import { createToolManager } from '../src/core/tools/index.js';
import { ProcessManager } from '../src/core/process/processManager.js';
import { tempDir } from './helpers/harness.js';
import type { ToolContext } from '../src/core/tools/types.js';
import type { PermissionRequest } from '../src/core/shared/types.js';

const tools = createToolManager();
let root: string;
let ctx: ToolContext;

beforeEach(() => {
  root = tempDir();
  fs.writeFileSync(path.join(root, 'file.txt'), 'data');
  fs.mkdirSync(path.join(root, 'old_backend'), { recursive: true });
  ctx = {
    workspaceRoot: root,
    projectId: 'p',
    sessionId: 's',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    processManager: new ProcessManager()
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('permission modes', () => {
  it('safe mode blocks all mutating tools', async () => {
    const pm = new PermissionManager('safe');
    pm.setApprovalHandler(async () => 'deny');
    const result = await tools.execute({ id: '1', name: 'write_file', arguments: { path: 'x.txt', content: 'x' } }, ctx, pm);
    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false);
  });

  it('safe mode still allows reads', async () => {
    const pm = new PermissionManager('safe');
    const result = await tools.execute({ id: '2', name: 'read_file', arguments: { path: 'file.txt' } }, ctx, pm);
    expect(result.success).toBe(true);
  });

  it('balanced mode auto-allows low-risk writes but asks before deleting a directory', async () => {
    const pm = new PermissionManager('balanced');
    const handler = vi.fn(async (_request: PermissionRequest) => 'deny' as const);
    pm.setApprovalHandler(handler);

    const write = await tools.execute({ id: '3', name: 'write_file', arguments: { path: 'y.txt', content: 'y' } }, ctx, pm);
    expect(write.success).toBe(true);
    expect(handler).not.toHaveBeenCalled();

    const del = await tools.execute({ id: '4', name: 'delete_file', arguments: { path: 'old_backend', recursive: true } }, ctx, pm);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].risk).toBe('HIGH');
    expect(del.success).toBe(false);
    expect(fs.existsSync(path.join(root, 'old_backend'))).toBe(true);
  });

  it('remembers a session grant so the user is asked once', async () => {
    const pm = new PermissionManager('balanced');
    const handler = vi.fn(async () => 'allow_session' as const);
    pm.setApprovalHandler(handler);
    await tools.execute({ id: '5', name: 'delete_file', arguments: { path: 'file.txt' } }, ctx, pm);
    fs.writeFileSync(path.join(root, 'file2.txt'), 'data');
    await tools.execute({ id: '6', name: 'delete_file', arguments: { path: 'file2.txt' } }, ctx, pm);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, 'file2.txt'))).toBe(false);
  });

  it('blocks dangerous commands even in autonomous mode without asking', async () => {
    const pm = new PermissionManager('autonomous');
    const handler = vi.fn(async () => 'allow_once' as const);
    pm.setApprovalHandler(handler);
    const result = await tools.execute({ id: '7', name: 'execute_command', arguments: { command: 'shutdown /s /t 0' } }, ctx, pm);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('always asks before remote git operations', async () => {
    const pm = new PermissionManager('autonomous');
    const handler = vi.fn(async (_request: PermissionRequest) => 'deny' as const);
    pm.setApprovalHandler(handler);
    const result = await tools.execute({ id: '8', name: 'git_push', arguments: {} }, ctx, pm);
    expect(handler).toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('custom mode honours the configured ceiling', async () => {
    const pm = new PermissionManager('custom', {
      autoAllowUpTo: 'SAFE',
      allowNetwork: false,
      allowOutsideWorkspaceRead: false,
      allowDelete: false,
      allowGitRemote: false
    });
    const handler = vi.fn(async (_request: PermissionRequest) => 'deny' as const);
    pm.setApprovalHandler(handler);
    const write = await tools.execute({ id: '9', name: 'write_file', arguments: { path: 'z.txt', content: 'z' } }, ctx, pm);
    expect(write.success).toBe(false);
    expect(handler).toHaveBeenCalled();
  });

  it('never executes a command that escapes the workspace via cwd', async () => {
    const pm = new PermissionManager('autonomous');
    pm.setApprovalHandler(async () => 'allow_once');
    const result = await tools.execute({ id: '10', name: 'execute_command', arguments: { command: 'echo hi', cwd: '../..' } }, ctx, pm);
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
  });
});
