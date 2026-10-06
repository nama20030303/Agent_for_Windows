import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createToolManager } from '../src/core/tools/index.js';
import { PermissionManager } from '../src/core/permissions/permissionManager.js';
import { ProcessManager } from '../src/core/process/processManager.js';
import { tempDir, removeTempDir } from './helpers/harness.js';
import type { ToolContext } from '../src/core/tools/types.js';

let root: string;
let ctx: ToolContext;
const tools = createToolManager();

function context(root: string): ToolContext {
  return {
    workspaceRoot: root,
    projectId: 'p1',
    sessionId: 's1',
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    processManager: new ProcessManager()
  };
}

const autonomous = () => new PermissionManager('autonomous');

beforeEach(() => {
  root = tempDir();
  ctx = context(root);
});
afterEach(() => removeTempDir(root));

describe('filesystem tools', () => {
  it('writes files atomically and reports a diff', async () => {
    const result = await tools.execute({ id: '1', name: 'write_file', arguments: { path: 'src/app.py', content: 'print("hi")\n' } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'src/app.py'), 'utf8')).toBe('print("hi")\n');
    expect((result.data as any).created).toBe(true);
    expect(fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('reads files with line ranges', async () => {
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    const result = await tools.execute({ id: '2', name: 'read_file', arguments: { path: 'a.txt', start_line: 2, end_line: 3 } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect((result.data as any).content).toBe('two\nthree');
  });

  it('refuses an ambiguous edit instead of rewriting the file', async () => {
    fs.writeFileSync(path.join(root, 'b.py'), 'x = 1\nx = 1\n');
    const result = await tools.execute({ id: '3', name: 'edit_file', arguments: { path: 'b.py', old_text: 'x = 1', new_text: 'x = 2' } }, ctx, autonomous());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/matches 2 times/);
    expect(fs.readFileSync(path.join(root, 'b.py'), 'utf8')).toBe('x = 1\nx = 1\n');
  });

  it('applies a targeted edit', async () => {
    fs.writeFileSync(path.join(root, 'c.py'), 'def a():\n    return 1\n');
    const result = await tools.execute({ id: '4', name: 'edit_file', arguments: { path: 'c.py', old_text: 'return 1', new_text: 'return 2' } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'c.py'), 'utf8')).toContain('return 2');
    expect((result.data as any).diff).toContain('+    return 2');
  });

  it('fails cleanly when old_text is missing', async () => {
    fs.writeFileSync(path.join(root, 'd.py'), 'a = 1\n');
    const result = await tools.execute({ id: '5', name: 'edit_file', arguments: { path: 'd.py', old_text: 'nope', new_text: 'x' } }, ctx, autonomous());
    expect(result.success).toBe(false);
  });

  it('blocks writes outside the workspace', async () => {
    const result = await tools.execute({ id: '6', name: 'write_file', arguments: { path: '../escape.txt', content: 'x' } }, ctx, autonomous());
    expect(result.success).toBe(false);
    expect(result.denied).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(root), 'escape.txt'))).toBe(false);
  });

  it('refuses to delete the workspace root', async () => {
    const result = await tools.execute({ id: '7', name: 'delete_file', arguments: { path: '.', recursive: true } }, ctx, autonomous());
    expect(result.success).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });

  it('lists directories recursively', async () => {
    fs.mkdirSync(path.join(root, 'src/sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/sub/x.ts'), 'export const x = 1;');
    const result = await tools.execute({ id: '8', name: 'list_directory', arguments: { path: '.', recursive: true } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect((result.data as any[]).map((e) => e.path)).toContain('src/sub/x.ts');
  });

  it('moves and copies files', async () => {
    fs.writeFileSync(path.join(root, 'old.txt'), 'content');
    expect((await tools.execute({ id: '9', name: 'move_file', arguments: { source: 'old.txt', destination: 'nested/new.txt' } }, ctx, autonomous())).success).toBe(true);
    expect(fs.existsSync(path.join(root, 'nested/new.txt'))).toBe(true);
    expect((await tools.execute({ id: '10', name: 'copy_file', arguments: { source: 'nested/new.txt', destination: 'copy.txt' } }, ctx, autonomous())).success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'copy.txt'), 'utf8')).toBe('content');
  });

  it('redacts secrets when reading a sensitive file', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=abcdef123456789\n');
    const result = await tools.execute({ id: '11', name: 'read_file', arguments: { path: '.env' } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain('abcdef123456789');
  });
});

describe('search tools', () => {
  it('finds text with file:line references', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/auth.py'), 'def create_jwt():\n    return "token"\n');
    const result = await tools.execute({ id: '12', name: 'search_text', arguments: { query: 'jwt' } }, ctx, autonomous());
    expect(result.success).toBe(true);
    expect((result.data as any[])[0]).toMatchObject({ path: 'src/auth.py', line: 1 });
  });

  it('finds symbol definitions', async () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/svc.ts'), 'export function createUser() {}\n');
    const result = await tools.execute({ id: '13', name: 'find_symbol', arguments: { name: 'createUser' } }, ctx, autonomous());
    expect((result.data as any[]).length).toBe(1);
  });

  it('matches files by glob', async () => {
    fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/test_a.py'), '');
    const result = await tools.execute({ id: '14', name: 'search_files', arguments: { pattern: 'tests/**/*.py' } }, ctx, autonomous());
    expect(result.data).toContain('tests/test_a.py');
  });
});

describe('tool validation', () => {
  it('rejects unknown tools', async () => {
    const result = await tools.execute({ id: '15', name: 'rm_rf_everything', arguments: {} }, ctx, autonomous());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown tool/);
  });

  it('rejects missing required arguments', async () => {
    const result = await tools.execute({ id: '16', name: 'read_file', arguments: {} }, ctx, autonomous());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Missing required argument/);
  });

  it('rejects wrong argument types and unknown arguments', async () => {
    const wrongType = await tools.execute({ id: '17', name: 'read_file', arguments: { path: 42 } }, ctx, autonomous());
    expect(wrongType.success).toBe(false);
    const extra = await tools.execute({ id: '18', name: 'read_file', arguments: { path: 'a.txt', sudo: true } }, ctx, autonomous());
    expect(extra.success).toBe(false);
    expect(extra.error).toMatch(/Unknown argument/);
  });

  it('exposes only non-mutating tools in the read-only set', () => {
    const readOnly = tools.readOnlyDefinitions().map((d) => d.name);
    expect(readOnly).toContain('read_file');
    expect(readOnly).not.toContain('write_file');
    expect(readOnly).not.toContain('execute_command');
  });
});
