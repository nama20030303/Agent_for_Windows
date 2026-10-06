import path from 'node:path';
import os from 'node:os';

export interface PathCheck {
  ok: boolean;
  /** Absolute, normalized path. */
  absolute: string;
  /** Workspace-relative posix path (only meaningful when ok). */
  relative: string;
  inside: boolean;
  reason?: string;
}

/** Windows device names and other paths that must never be touched. */
const FORBIDDEN_SEGMENTS = [
  'system32',
  'syswow64',
  'windows\\system',
  '$recycle.bin',
  'config\\systemprofile'
];

const FORBIDDEN_ROOTS_WIN = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];

function normalizeForCompare(p: string): string {
  let out = p.replace(/\//g, path.sep);
  if (process.platform === 'win32') out = out.toLowerCase();
  return out;
}

/**
 * Resolve `candidate` relative to `workspaceRoot` and verify containment.
 * Rejects traversal (`..`), absolute escapes, UNC paths, null bytes and
 * (on Windows) protected system locations.
 */
export function resolveWorkspacePath(workspaceRoot: string, candidate: string): PathCheck {
  const fail = (reason: string, absolute = ''): PathCheck => ({
    ok: false,
    absolute,
    relative: '',
    inside: false,
    reason
  });

  if (typeof candidate !== 'string' || candidate.length === 0) return fail('Path must be a non-empty string.');
  if (candidate.includes('\0')) return fail('Path contains a null byte.');
  if (/^\\\\/.test(candidate) || /^\/\//.test(candidate)) return fail('UNC / network paths are not allowed.');

  const root = path.resolve(workspaceRoot);
  // Backslashes are treated as separators on every platform so that Windows-style
  // traversal cannot slip through when the application runs on another OS.
  const unified = process.platform === 'win32' ? candidate : candidate.replace(/\\/g, '/');
  const expanded = unified.startsWith('~') ? path.join(os.homedir(), unified.slice(1)) : unified;
  const absolute = path.resolve(root, expanded);

  const nRoot = normalizeForCompare(root);
  const nAbs = normalizeForCompare(absolute);
  const inside = nAbs === nRoot || nAbs.startsWith(nRoot.endsWith(path.sep) ? nRoot : nRoot + path.sep);

  const lower = absolute.toLowerCase().replace(/\//g, '\\');
  if (FORBIDDEN_SEGMENTS.some((s) => lower.includes(s))) {
    return fail('Path targets a protected system location.', absolute);
  }
  if (process.platform === 'win32' && FORBIDDEN_ROOTS_WIN.some((r) => lower.startsWith(r))) {
    return fail('Path targets a protected system location.', absolute);
  }

  if (!inside) {
    return {
      ok: false,
      absolute,
      relative: '',
      inside: false,
      reason: 'Path is outside the workspace sandbox.'
    };
  }

  const rel = path.relative(root, absolute).split(path.sep).join('/');
  return { ok: true, absolute, relative: rel === '' ? '.' : rel, inside: true };
}

export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  return resolveWorkspacePath(workspaceRoot, candidate).inside;
}
