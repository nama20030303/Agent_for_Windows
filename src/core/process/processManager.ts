import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import type { ManagedProcess } from '../shared/types.js';
import { buildShellInvocation, defaultShell, type ShellKind } from './shell.js';
import { Emitter } from '../shared/emitter.js';
import { redactSecrets } from '../shared/secrets.js';
import { uid, nowIso } from '../shared/ids.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('process');
const MAX_LINES = 500;

export interface StartProcessOptions {
  name: string;
  command: string;
  cwd: string;
  shell?: ShellKind;
  port?: number;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcess>();
  private children = new Map<string, ChildProcess>();
  readonly changes = new Emitter<ManagedProcess[]>();

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  private publish(): void {
    this.changes.emit(this.list());
  }

  start(options: StartProcessOptions): ManagedProcess {
    const id = uid('proc');
    const shell = options.shell ?? defaultShell();
    const { file, args } = buildShellInvocation(options.command, shell);
    const record: ManagedProcess = {
      id,
      name: options.name,
      command: options.command,
      cwd: options.cwd,
      status: 'starting',
      port: options.port,
      startedAt: nowIso(),
      output: []
    };
    this.processes.set(id, record);

    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: options.cwd, shell: false, windowsHide: true, detached: false });
    } catch (err) {
      record.status = 'failed';
      record.output.push(String((err as Error).message));
      this.publish();
      return record;
    }

    this.children.set(id, child);
    record.pid = child.pid;
    record.status = 'running';

    const push = (chunk: string) => {
      for (const line of redactSecrets(chunk).split(/\r?\n/)) {
        if (!line) continue;
        record.output.push(line);
        const detected = detectPort(line);
        if (detected && !record.port) record.port = detected;
      }
      if (record.output.length > MAX_LINES) record.output.splice(0, record.output.length - MAX_LINES);
      this.publish();
    };

    child.stdout?.on('data', (d: Buffer) => push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => push(d.toString()));
    child.on('error', (err) => {
      record.status = 'failed';
      push(err.message);
    });
    child.on('close', (code) => {
      record.status = record.status === 'stopped' ? 'stopped' : code === 0 ? 'exited' : 'failed';
      record.exitCode = code ?? undefined;
      this.children.delete(id);
      this.publish();
    });

    log.info('Process started', { id, name: options.name, pid: child.pid });
    this.publish();
    return record;
  }

  stop(id: string): boolean {
    const child = this.children.get(id);
    const record = this.processes.get(id);
    if (!record) return false;
    record.status = 'stopped';
    if (child) {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
        } else {
          child.kill('SIGTERM');
          const pid = child.pid;
          setTimeout(() => {
            try {
              if (pid) process.kill(pid, 'SIGKILL');
            } catch {
              /* already dead */
            }
          }, 2000).unref?.();
        }
      } catch {
        /* ignore */
      }
    }
    this.publish();
    return true;
  }

  stopAll(): void {
    for (const id of [...this.children.keys()]) this.stop(id);
  }

  output(id: string, lines = 200): string[] {
    return (this.processes.get(id)?.output ?? []).slice(-lines);
  }

  remove(id: string): void {
    this.stop(id);
    this.processes.delete(id);
    this.publish();
  }
}

const PORT_RE = /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):|port\s+|:)(\d{4,5})\b/i;

export function detectPort(line: string): number | undefined {
  const m = PORT_RE.exec(line);
  if (!m) return undefined;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? port : undefined;
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (free: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(600);
    socket.once('connect', () => done(false));
    socket.once('timeout', () => done(true));
    socket.once('error', () => done(true));
  });
}

export async function findFreePorts(start: number, count = 3): Promise<number[]> {
  const found: number[] = [];
  for (let port = start; port < start + 100 && found.length < count; port++) {
    if (await isPortFree(port)) found.push(port);
  }
  return found;
}
