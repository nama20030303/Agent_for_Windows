import path from 'node:path';
import { resolveWorkspacePath } from '../permissions/pathGuard.js';
import { runCommand } from '../process/shell.js';
import { detectProjectCommands } from '../verification/frameworks.js';
import { classifyErrorFromOutput } from '../verification/errorClassifier.js';
import { defineTool, fail, ok, schema, str, type Tool, type ToolContext } from './types.js';

async function runDetected(
  tool: string,
  key: 'test' | 'build' | 'lint' | 'format',
  args: Record<string, unknown>,
  ctx: ToolContext
) {
  const base = resolveWorkspacePath(ctx.workspaceRoot, String(args.cwd ?? '.'));
  if (!base.ok) return fail(tool, base.reason!);
  const detected = await detectProjectCommands(base.absolute);
  const explicit = typeof args.command === 'string' && args.command.trim() ? String(args.command) : undefined;
  const candidate = detected.find((d) => d[key]);
  const command = explicit ?? candidate?.[key];
  if (!command) {
    return fail(tool, `No ${key} command detected in this project. Configure one or pass an explicit command.`, {
      errorType: 'CONFIGURATION_ERROR',
      data: { detected: detected.map((d) => d.framework) }
    });
  }
  const cwd = explicit ? base.absolute : path.resolve(base.absolute, candidate!.cwd);
  const result = await runCommand(command, { cwd, shell: ctx.shell, timeoutMs: 600_000, signal: ctx.signal });
  const output = `${result.stdout}\n${result.stderr}`;
  const success = result.exitCode === 0 && !result.timedOut;
  return {
    success,
    tool,
    exitCode: result.exitCode,
    stdout: result.stdout.slice(-20_000),
    stderr: result.stderr.slice(-20_000),
    durationMs: result.durationMs,
    summary: `${command} → exit ${result.exitCode}`,
    errorType: success ? undefined : classifyErrorFromOutput(output, result.timedOut),
    error: success ? undefined : `${key} failed with exit code ${result.exitCode}.`
  };
}

export const detectTestFramework = defineTool(
  {
    name: 'detect_test_framework',
    description: 'Detect the project test / build / lint commands from real manifests in the workspace.',
    category: 'testing',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ cwd: str('Sub-directory to inspect (default workspace root).') })
  },
  async (args, ctx) => {
    const base = resolveWorkspacePath(ctx.workspaceRoot, String(args.cwd ?? '.'));
    if (!base.ok) return fail('detect_test_framework', base.reason!);
    const detected = await detectProjectCommands(base.absolute);
    return ok('detect_test_framework', {
      data: detected,
      summary: detected.length ? detected.map((d) => d.framework).join(', ') : 'No known project manifest found.'
    });
  },
  () => 'Detect test framework'
);

export const runTests = defineTool(
  {
    name: 'run_tests',
    description: 'Run the project test suite and return the real output.',
    category: 'testing',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ command: str('Optional explicit test command.'), cwd: str('Working directory.') })
  },
  (args, ctx) => runDetected('run_tests', 'test', args, ctx),
  (a) => `Run tests${a.command ? `: ${a.command}` : ''}`
);

export const runBuild = defineTool(
  {
    name: 'run_build',
    description: 'Build or compile the project.',
    category: 'testing',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ command: str('Optional explicit build command.'), cwd: str('Working directory.') })
  },
  (args, ctx) => runDetected('run_build', 'build', args, ctx),
  (a) => `Run build${a.command ? `: ${a.command}` : ''}`
);

export const runLinter = defineTool(
  {
    name: 'run_linter',
    description: 'Run the project linter / static analysis.',
    category: 'testing',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ command: str('Optional explicit lint command.'), cwd: str('Working directory.') })
  },
  (args, ctx) => runDetected('run_linter', 'lint', args, ctx),
  () => 'Run linter'
);

export const runFormatter = defineTool(
  {
    name: 'run_formatter',
    description: 'Run the project code formatter.',
    category: 'testing',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ command: str('Optional explicit format command.'), cwd: str('Working directory.') })
  },
  (args, ctx) => runDetected('run_formatter', 'format', args, ctx),
  () => 'Run formatter'
);

export const testingTools: Tool[] = [detectTestFramework, runTests, runBuild, runLinter, runFormatter];
