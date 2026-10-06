import { spawn } from 'node:child_process';
import { redactSecrets } from '../shared/secrets.js';

export type ShellKind = 'powershell' | 'cmd' | 'bash';

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
}

export interface RunOptions {
  cwd: string;
  shell?: ShellKind;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  maxOutputChars?: number;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
}

export function defaultShell(): ShellKind {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

/**
 * Build the executable + argv for a shell invocation.
 * The command is always passed as a single argument to the shell binary
 * (`shell: false`), so no host-level shell interpolation happens.
 */
export function buildShellInvocation(command: string, shell: ShellKind): { file: string; args: string[] } {
  switch (shell) {
    case 'powershell': {
      const file = process.env.NEXUS_POWERSHELL ?? 'powershell.exe';
      return {
        file,
        args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]
      };
    }
    case 'cmd':
      return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] };
    case 'bash':
    default:
      return { file: '/bin/bash', args: ['-lc', command] };
  }
}

const DEFAULT_MAX_OUTPUT = 200_000;

export function runCommand(command: string, options: RunOptions): Promise<ShellResult> {
  const shell = options.shell ?? defaultShell();
  const { file, args } = buildShellInvocation(command, shell);
  const maxChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<ShellResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;
    let settled = false;

    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        durationMs: Date.now() - started,
        timedOut,
        killed
      });
    };

    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      if (target === 'stdout') {
        stdout = (stdout + chunk).slice(-maxChars);
      } else {
        stderr = (stderr + chunk).slice(-maxChars);
      }
      options.onOutput?.(chunk, target);
    };

    child.stdout?.on('data', (d: Buffer) => append('stdout', d.toString()));
    child.stderr?.on('data', (d: Buffer) => append('stderr', d.toString()));

    const kill = () => {
      killed = true;
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
        }
      } catch {
        /* process already gone */
      }
    };

    const onAbort = () => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? 180_000);
    timer.unref?.();

    child.on('error', (err) => {
      append('stderr', `\n${err.message}`);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? (killed ? 130 : -1)));
  });
}
