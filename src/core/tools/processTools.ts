import { resolveWorkspacePath } from '../permissions/pathGuard.js';
import { findFreePorts, isPortFree } from '../process/processManager.js';
import { defineTool, fail, ok, schema, str, num, type Tool } from './types.js';

export const startProcess = defineTool(
  {
    name: 'start_process',
    description: 'Start a long-running process (dev server, API, watcher) and keep it running in the background.',
    category: 'process',
    risk: 'MEDIUM',
    mutating: true,
    parameters: schema(
      {
        name: str('Short label, e.g. "Backend".'),
        command: str('Command line to run.'),
        cwd: str('Working directory relative to the workspace root.'),
        port: num('Expected port, if known.')
      },
      ['name', 'command']
    )
  },
  async (args, ctx) => {
    const cwdCheck = resolveWorkspacePath(ctx.workspaceRoot, String(args.cwd ?? '.'));
    if (!cwdCheck.ok) return fail('start_process', cwdCheck.reason!);
    const port = typeof args.port === 'number' ? args.port : undefined;
    if (port && !(await isPortFree(port))) {
      const alternatives = await findFreePorts(port + 1, 3);
      return fail('start_process', `Port ${port} is already in use. Free ports: ${alternatives.join(', ')}.`, {
        errorType: 'ENVIRONMENT_ERROR',
        data: { busyPort: port, alternatives }
      });
    }
    const record = ctx.processManager.start({
      name: String(args.name),
      command: String(args.command),
      cwd: cwdCheck.absolute,
      shell: ctx.shell,
      port
    });
    await new Promise((r) => setTimeout(r, 2500));
    const current = ctx.processManager.get(record.id);
    return ok('start_process', {
      data: { id: record.id, pid: current?.pid, status: current?.status, port: current?.port },
      stdout: (current?.output ?? []).slice(-40).join('\n'),
      summary: `Started "${args.name}" (${current?.status}, pid ${current?.pid ?? 'n/a'})`
    });
  },
  (a) => `Start process: ${a.command}`
);

export const stopProcess = defineTool(
  {
    name: 'stop_process',
    description: 'Stop a background process started by start_process.',
    category: 'process',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ id: str('Process id.') }, ['id'])
  },
  async (args, ctx) => {
    const stopped = ctx.processManager.stop(String(args.id));
    return stopped
      ? ok('stop_process', { summary: `Stopped process ${args.id}` })
      : fail('stop_process', `No process with id ${args.id}.`);
  },
  (a) => `Stop process ${a.id}`
);

export const listProcesses = defineTool(
  {
    name: 'list_processes',
    description: 'List background processes managed by the agent.',
    category: 'process',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({})
  },
  async (_args, ctx) => {
    const list = ctx.processManager.list().map((p) => ({
      id: p.id,
      name: p.name,
      command: p.command,
      pid: p.pid,
      status: p.status,
      port: p.port
    }));
    return ok('list_processes', { data: list, summary: `${list.length} managed processes` });
  },
  () => 'List running processes'
);

export const getProcessOutput = defineTool(
  {
    name: 'get_process_output',
    description: 'Read recent output from a background process.',
    category: 'process',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ id: str('Process id.'), lines: num('Number of trailing lines (default 100).') }, ['id'])
  },
  async (args, ctx) => {
    const record = ctx.processManager.get(String(args.id));
    if (!record) return fail('get_process_output', `No process with id ${args.id}.`);
    const lines = ctx.processManager.output(String(args.id), Number(args.lines ?? 100));
    return ok('get_process_output', {
      stdout: lines.join('\n'),
      data: { status: record.status, port: record.port, exitCode: record.exitCode },
      summary: `${record.name}: ${record.status}${record.port ? ` on port ${record.port}` : ''}`
    });
  },
  (a) => `Read output of process ${a.id}`
);

export const httpCheck = defineTool(
  {
    name: 'http_check',
    description: 'Send an HTTP GET to a localhost URL to verify a running service responds (runtime verification).',
    category: 'process',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ url: str('URL, must target localhost/127.0.0.1.'), timeout_ms: num('Timeout (default 8000).') }, ['url'])
  },
  async (args) => {
    const url = String(args.url);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(url)) {
      return fail('http_check', 'Only localhost URLs can be checked.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(args.timeout_ms ?? 8000));
    const started = Date.now();
    try {
      const res = await fetch(url, { signal: controller.signal });
      const body = (await res.text()).slice(0, 4000);
      return {
        success: res.ok,
        tool: 'http_check',
        exitCode: res.ok ? 0 : 1,
        stdout: body,
        durationMs: Date.now() - started,
        summary: `GET ${url} → ${res.status}`,
        error: res.ok ? undefined : `HTTP ${res.status}`,
        errorType: res.ok ? undefined : 'RUNTIME_ERROR'
      };
    } catch (err) {
      return fail('http_check', `Request failed: ${(err as Error).message}`, { errorType: 'NETWORK_ERROR' });
    } finally {
      clearTimeout(timer);
    }
  },
  (a) => `HTTP check ${a.url}`
);

export const processTools: Tool[] = [startProcess, stopProcess, listProcesses, getProcessOutput, httpCheck];
