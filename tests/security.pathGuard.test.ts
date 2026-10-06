import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { resolveWorkspacePath, isInsideWorkspace } from '../src/core/permissions/pathGuard.js';

const root = path.join(os.tmpdir(), 'nexus-workspace');

describe('workspace sandbox', () => {
  it('accepts paths inside the workspace', () => {
    const check = resolveWorkspacePath(root, 'src/app/main.py');
    expect(check.ok).toBe(true);
    expect(check.relative).toBe('src/app/main.py');
    expect(check.absolute.startsWith(root)).toBe(true);
  });

  it('normalises redundant segments inside the workspace', () => {
    const check = resolveWorkspacePath(root, 'src/../src/./main.ts');
    expect(check.ok).toBe(true);
    expect(check.relative).toBe('src/main.ts');
  });

  for (const traversal of [
    '../../Windows/System32/config',
    '..\\..\\Users\\admin\\.ssh\\id_rsa',
    'src/../../../etc/passwd',
    './../../secret.txt',
    'a/b/../../../..'
  ]) {
    it(`rejects traversal: ${traversal}`, () => {
      const check = resolveWorkspacePath(root, traversal);
      expect(check.ok).toBe(false);
      expect(check.inside).toBe(false);
      expect(isInsideWorkspace(root, traversal)).toBe(false);
    });
  }

  it('rejects absolute paths outside the workspace', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/shadow';
    expect(resolveWorkspacePath(root, outside).ok).toBe(false);
  });

  it('rejects UNC and null-byte paths', () => {
    expect(resolveWorkspacePath(root, '\\\\server\\share\\file').ok).toBe(false);
    expect(resolveWorkspacePath(root, 'src/main\0.py').ok).toBe(false);
  });

  it('rejects protected system locations even when nested', () => {
    expect(resolveWorkspacePath(root, 'nested/system32/cmd.exe').ok).toBe(false);
  });

  it('rejects empty paths', () => {
    expect(resolveWorkspacePath(root, '').ok).toBe(false);
  });
});
