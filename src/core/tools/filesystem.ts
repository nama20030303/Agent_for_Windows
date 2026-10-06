import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { resolveWorkspacePath } from '../permissions/pathGuard.js';
import { defineTool, fail, ok, schema, str, num, bool, type Tool, type ToolContext } from './types.js';
import { isSensitiveFile, redactSecrets } from '../shared/secrets.js';

const MAX_READ_BYTES = 400_000;

function rp(ctx: ToolContext, p: unknown) {
  return resolveWorkspacePath(ctx.workspaceRoot, String(p ?? ''));
}

/** Atomic write: write to a temp file in the same directory, then rename. */
export async function atomicWrite(absolute: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const tmp = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, absolute);
}

export function unifiedDiff(file: string, before: string, after: string): string {
  return createTwoFilesPatch(file, file, before, after, '', '', { context: 3 });
}

export function diffStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', 'out',
  '.next', '.nuxt', 'target', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', '.idea', '.vscode'
]);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

export const listDirectory = defineTool(
  {
    name: 'list_directory',
    description: 'List files and folders inside a workspace directory.',
    category: 'filesystem',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ path: str('Directory path relative to the workspace root.'), recursive: bool('List nested entries (max depth 3).') })
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path ?? '.');
    if (!check.ok) return fail('list_directory', check.reason!);
    const recursive = args.recursive === true;
    const entries: { path: string; type: 'file' | 'dir'; size?: number }[] = [];

    const walk = async (dir: string, depth: number) => {
      let items: fssync.Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        throw err;
      }
      for (const item of items) {
        const abs = path.join(dir, item.name);
        const rel = path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/');
        if (item.isDirectory()) {
          entries.push({ path: rel, type: 'dir' });
          if (recursive && depth < 3 && !isIgnoredDir(item.name)) await walk(abs, depth + 1);
        } else {
          let size: number | undefined;
          try {
            size = (await fs.stat(abs)).size;
          } catch {
            /* ignore */
          }
          entries.push({ path: rel, type: 'file', size });
        }
      }
    };

    try {
      await walk(check.absolute, 0);
    } catch (err) {
      return fail('list_directory', (err as Error).message, { errorType: 'RUNTIME_ERROR' });
    }
    return ok('list_directory', {
      data: entries.slice(0, 1000),
      summary: `${entries.length} entries in ${check.relative}`
    });
  },
  (a) => `List directory ${a.path ?? '.'}`
);

export const readFile = defineTool(
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the current workspace.',
    category: 'filesystem',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      { path: str('File path relative to the workspace root.'), start_line: num('First line (1-based).'), end_line: num('Last line (inclusive).') },
      ['path']
    )
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('read_file', check.reason!);
    try {
      const stat = await fs.stat(check.absolute);
      if (stat.isDirectory()) return fail('read_file', 'Path is a directory.');
      if (stat.size > MAX_READ_BYTES) {
        return fail('read_file', `File is too large (${stat.size} bytes). Read a line range instead.`);
      }
      let content = await fs.readFile(check.absolute, 'utf8');
      if (isSensitiveFile(check.relative)) content = redactSecrets(content);
      const lines = content.split('\n');
      const start = typeof args.start_line === 'number' ? Math.max(1, args.start_line) : 1;
      const end = typeof args.end_line === 'number' ? Math.min(lines.length, args.end_line) : lines.length;
      const slice = lines.slice(start - 1, end);
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join('\n');
      return ok('read_file', {
        data: { path: check.relative, start, end, totalLines: lines.length, content: slice.join('\n') },
        summary: `Read ${check.relative} (lines ${start}-${end} of ${lines.length})`,
        stdout: numbered
      });
    } catch (err) {
      return fail('read_file', (err as Error).message, { errorType: 'RUNTIME_ERROR' });
    }
  },
  (a) => `Read ${a.path}`
);

export const writeFile = defineTool(
  {
    name: 'write_file',
    description: 'Create or overwrite a text file inside the workspace. Content is written atomically.',
    category: 'filesystem',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ path: str('File path relative to the workspace root.'), content: str('Full file content.') }, ['path', 'content'])
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('write_file', check.reason!);
    const content = String(args.content ?? '');
    let before = '';
    let existed = false;
    try {
      before = await fs.readFile(check.absolute, 'utf8');
      existed = true;
    } catch {
      /* new file */
    }
    try {
      await atomicWrite(check.absolute, content);
    } catch (err) {
      return fail('write_file', (err as Error).message, { errorType: 'PERMISSION_ERROR' });
    }
    const patch = unifiedDiff(check.relative, before, content);
    const stats = diffStats(patch);
    ctx.onFileTouched?.(check.relative, existed ? 'modified' : 'created');
    return ok('write_file', {
      data: { path: check.relative, created: !existed, diff: patch, ...stats },
      summary: `${existed ? 'Updated' : 'Created'} ${check.relative} (+${stats.added}/-${stats.removed})`
    });
  },
  (a) => `Write ${a.path}`
);

export const editFile = defineTool(
  {
    name: 'edit_file',
    description:
      'Apply a targeted edit by replacing an exact text block. Fails when the block is missing or ambiguous, so it never silently rewrites a file.',
    category: 'filesystem',
    risk: 'LOW',
    mutating: true,
    parameters: schema(
      {
        path: str('File path relative to the workspace root.'),
        old_text: str('Exact existing text to replace.'),
        new_text: str('Replacement text.'),
        replace_all: bool('Replace every occurrence instead of requiring a unique match.')
      },
      ['path', 'old_text', 'new_text']
    )
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('edit_file', check.reason!);
    const oldText = String(args.old_text);
    const newText = String(args.new_text);
    let before: string;
    try {
      before = await fs.readFile(check.absolute, 'utf8');
    } catch (err) {
      return fail('edit_file', `Cannot read file: ${(err as Error).message}`, { errorType: 'RUNTIME_ERROR' });
    }
    const occurrences = before.split(oldText).length - 1;
    if (occurrences === 0) {
      return fail('edit_file', 'old_text was not found in the file. Read the file again and use an exact excerpt.');
    }
    if (occurrences > 1 && args.replace_all !== true) {
      return fail('edit_file', `old_text matches ${occurrences} times. Provide more context or set replace_all.`);
    }
    const after = args.replace_all === true ? before.split(oldText).join(newText) : before.replace(oldText, newText);
    try {
      await atomicWrite(check.absolute, after);
    } catch (err) {
      return fail('edit_file', (err as Error).message, { errorType: 'PERMISSION_ERROR' });
    }
    const patch = unifiedDiff(check.relative, before, after);
    const stats = diffStats(patch);
    ctx.onFileTouched?.(check.relative, 'modified');
    return ok('edit_file', {
      data: { path: check.relative, diff: patch, occurrences, ...stats },
      summary: `Edited ${check.relative} (+${stats.added}/-${stats.removed})`
    });
  },
  (a) => `Edit ${a.path}`
);

export const createDirectory = defineTool(
  {
    name: 'create_directory',
    description: 'Create a directory (recursively) inside the workspace.',
    category: 'filesystem',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ path: str('Directory path relative to the workspace root.') }, ['path'])
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('create_directory', check.reason!);
    try {
      await fs.mkdir(check.absolute, { recursive: true });
    } catch (err) {
      return fail('create_directory', (err as Error).message, { errorType: 'PERMISSION_ERROR' });
    }
    ctx.onFileTouched?.(check.relative, 'created');
    return ok('create_directory', { summary: `Created directory ${check.relative}`, data: { path: check.relative } });
  },
  (a) => `Create directory ${a.path}`
);

export const deleteFile = defineTool(
  {
    name: 'delete_file',
    description: 'Delete a file or directory inside the workspace. High risk — always reviewed by the permission system.',
    category: 'filesystem',
    risk: 'HIGH',
    mutating: true,
    parameters: schema({ path: str('Path relative to the workspace root.'), recursive: bool('Delete directories recursively.') }, ['path'])
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('delete_file', check.reason!);
    if (check.relative === '.' || check.relative === '') return fail('delete_file', 'Refusing to delete the workspace root.');
    try {
      const stat = await fs.stat(check.absolute);
      if (stat.isDirectory()) {
        if (args.recursive !== true) return fail('delete_file', 'Path is a directory; set recursive to delete it.');
        await fs.rm(check.absolute, { recursive: true, force: false });
      } else {
        await fs.unlink(check.absolute);
      }
    } catch (err) {
      return fail('delete_file', (err as Error).message, { errorType: 'RUNTIME_ERROR' });
    }
    ctx.onFileTouched?.(check.relative, 'deleted');
    return ok('delete_file', { summary: `Deleted ${check.relative}`, data: { path: check.relative } });
  },
  (a) => `Delete ${a.path}`
);

export const moveFile = defineTool(
  {
    name: 'move_file',
    description: 'Move or rename a file inside the workspace.',
    category: 'filesystem',
    risk: 'MEDIUM',
    mutating: true,
    parameters: schema({ source: str('Existing path.'), destination: str('New path.') }, ['source', 'destination'])
  },
  async (args, ctx) => {
    const from = rp(ctx, args.source);
    const to = rp(ctx, args.destination);
    if (!from.ok) return fail('move_file', from.reason!);
    if (!to.ok) return fail('move_file', to.reason!);
    try {
      await fs.mkdir(path.dirname(to.absolute), { recursive: true });
      await fs.rename(from.absolute, to.absolute);
    } catch (err) {
      return fail('move_file', (err as Error).message, { errorType: 'RUNTIME_ERROR' });
    }
    ctx.onFileTouched?.(from.relative, 'deleted');
    ctx.onFileTouched?.(to.relative, 'created');
    return ok('move_file', { summary: `Moved ${from.relative} → ${to.relative}` });
  },
  (a) => `Move ${a.source} → ${a.destination}`
);

export const copyFile = defineTool(
  {
    name: 'copy_file',
    description: 'Copy a file inside the workspace.',
    category: 'filesystem',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ source: str('Existing path.'), destination: str('Target path.') }, ['source', 'destination'])
  },
  async (args, ctx) => {
    const from = rp(ctx, args.source);
    const to = rp(ctx, args.destination);
    if (!from.ok) return fail('copy_file', from.reason!);
    if (!to.ok) return fail('copy_file', to.reason!);
    try {
      await fs.mkdir(path.dirname(to.absolute), { recursive: true });
      await fs.copyFile(from.absolute, to.absolute);
    } catch (err) {
      return fail('copy_file', (err as Error).message, { errorType: 'RUNTIME_ERROR' });
    }
    ctx.onFileTouched?.(to.relative, 'created');
    return ok('copy_file', { summary: `Copied ${from.relative} → ${to.relative}` });
  },
  (a) => `Copy ${a.source} → ${a.destination}`
);

export const fileExists = defineTool(
  {
    name: 'file_exists',
    description: 'Check whether a path exists inside the workspace.',
    category: 'filesystem',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ path: str('Path relative to the workspace root.') }, ['path'])
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('file_exists', check.reason!);
    const exists = fssync.existsSync(check.absolute);
    return ok('file_exists', { data: { path: check.relative, exists }, summary: `${check.relative}: ${exists ? 'exists' : 'missing'}` });
  },
  (a) => `Check ${a.path}`
);

export const getFileInfo = defineTool(
  {
    name: 'get_file_info',
    description: 'Get metadata (size, type, modification time, line count) for a workspace path.',
    category: 'filesystem',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ path: str('Path relative to the workspace root.') }, ['path'])
  },
  async (args, ctx) => {
    const check = rp(ctx, args.path);
    if (!check.ok) return fail('get_file_info', check.reason!);
    try {
      const stat = await fs.stat(check.absolute);
      let lines: number | undefined;
      if (stat.isFile() && stat.size < MAX_READ_BYTES) {
        lines = (await fs.readFile(check.absolute, 'utf8')).split('\n').length;
      }
      return ok('get_file_info', {
        data: {
          path: check.relative,
          type: stat.isDirectory() ? 'dir' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
          lines
        },
        summary: `${check.relative}: ${stat.isDirectory() ? 'directory' : `${stat.size} bytes`}`
      });
    } catch (err) {
      return fail('get_file_info', (err as Error).message);
    }
  },
  (a) => `Inspect ${a.path}`
);

export const filesystemTools: Tool[] = [
  listDirectory,
  readFile,
  writeFile,
  editFile,
  createDirectory,
  deleteFile,
  moveFile,
  copyFile,
  fileExists,
  getFileInfo
];
