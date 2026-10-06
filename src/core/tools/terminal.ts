import { resolveWorkspacePath } from '../permissions/pathGuard.js';
import { runCommand } from '../process/shell.js';
import { classifyErrorFromOutput } from '../verification/errorClassifier.js';
import { defineTool, fail, ok, schema, str, num, type Tool } from './types.js';

export const executeCommand = defineTool(
  {
    name: 'execute_command',
    description:
      'Run a shell command (PowerShell on Windows) inside the workspace and return exit code, stdout and stderr. Use for builds, tests, linters and package managers. Do not use it to start long-running servers — use start_process instead.',
    category: 'terminal',
    risk: 'MEDIUM',
    mutating: true,
    parameters: schema(
      {
        command: str('The command line to execute.'),
        cwd: str('Working directory relative to the workspace root (default: workspace root).'),
        timeout_ms: num('Timeout in milliseconds (default 180000, max 600000).')
      },
      ['command']
    )
  },
  async (args, ctx) => {
    const cwdCheck = resolveWorkspacePath(ctx.workspaceRoot, String(args.cwd ?? '.'));
    if (!cwdCheck.ok) return fail('execute_command', cwdCheck.reason!);
    const timeoutMs = Math.min(Number(args.timeout_ms ?? 180_000) || 180_000, 600_000);
    const result = await runCommand(String(args.command), {
      cwd: cwdCheck.absolute,
      shell: ctx.shell,
      timeoutMs,
      signal: ctx.signal
    });
    const success = result.exitCode === 0 && !result.timedOut;
    return {
      success,
      tool: 'execute_command',
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-20_000),
      stderr: result.stderr.slice(-20_000),
      durationMs: result.durationMs,
      summary: `${args.command} → exit ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}`,
      errorType: success ? undefined : classifyErrorFromOutput(`${result.stdout}\n${result.stderr}`, result.timedOut),
      error: success ? undefined : result.timedOut ? 'Command timed out.' : `Command exited with code ${result.exitCode}.`
    };
  },
  (a) => `Run: ${a.command}`
);

export const terminalTools: Tool[] = [executeCommand];
