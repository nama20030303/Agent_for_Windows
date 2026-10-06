import { spawn } from 'node:child_process';
import fssync from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../shared/secrets.js';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitStatus {
  isRepo: boolean;
  branch?: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead?: number;
  behind?: number;
  clean: boolean;
}

/** Runs git with an explicit argv array — never through a shell. */
export function git(args: string[], cwd: string, timeoutMs = 60_000): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: '', stderr: err.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        exitCode: code ?? -1
      });
    });
  });
}

export class GitManager {
  constructor(private cwd: string) {}

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  isRepo(): boolean {
    let dir = path.resolve(this.cwd);
    for (let i = 0; i < 8; i++) {
      if (fssync.existsSync(path.join(dir, '.git'))) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return false;
  }

  async status(): Promise<GitStatus> {
    if (!this.isRepo()) {
      return { isRepo: false, staged: [], modified: [], untracked: [], clean: true };
    }
    const res = await git(['status', '--porcelain=v1', '--branch'], this.cwd);
    const staged: string[] = [];
    const modified: string[] = [];
    const untracked: string[] = [];
    let branch: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;

    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('##')) {
        const m = /^## ([^.\s]+)/.exec(line);
        branch = m?.[1];
        const a = /ahead (\d+)/.exec(line);
        const b = /behind (\d+)/.exec(line);
        if (a) ahead = Number(a[1]);
        if (b) behind = Number(b[1]);
        continue;
      }
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code === '??') untracked.push(file);
      else {
        if (code[0] !== ' ') staged.push(file);
        if (code[1] !== ' ') modified.push(file);
      }
    }
    return {
      isRepo: true,
      branch,
      staged,
      modified,
      untracked,
      ahead,
      behind,
      clean: staged.length === 0 && modified.length === 0 && untracked.length === 0
    };
  }

  diff(file?: string, staged = false): Promise<GitResult> {
    const args = ['diff', '--no-color'];
    if (staged) args.push('--cached');
    if (file) args.push('--', file);
    return git(args, this.cwd);
  }

  log(limit = 20): Promise<GitResult> {
    return git(['log', `-${limit}`, '--pretty=format:%h|%an|%ar|%s'], this.cwd);
  }

  branches(): Promise<GitResult> {
    return git(['branch', '--list', '--no-color'], this.cwd);
  }

  add(paths: string[]): Promise<GitResult> {
    return git(['add', '--', ...paths], this.cwd);
  }

  commit(message: string): Promise<GitResult> {
    return git(['commit', '-m', message], this.cwd);
  }

  checkout(ref: string, create = false): Promise<GitResult> {
    return git(create ? ['checkout', '-b', ref] : ['checkout', ref], this.cwd);
  }

  revParseHead(): Promise<GitResult> {
    return git(['rev-parse', 'HEAD'], this.cwd);
  }

  init(): Promise<GitResult> {
    return git(['init'], this.cwd);
  }

  stashCreate(message: string): Promise<GitResult> {
    return git(['stash', 'push', '-u', '-m', message], this.cwd);
  }

  pull(): Promise<GitResult> {
    return git(['pull', '--ff-only'], this.cwd);
  }

  push(): Promise<GitResult> {
    return git(['push'], this.cwd);
  }
}
