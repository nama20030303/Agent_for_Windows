import path from 'node:path';
import type {
  VerificationCheck,
  VerificationLevel,
  VerificationReport
} from '../shared/types.js';
import { runCommand, type ShellKind } from '../process/shell.js';
import { detectProjectCommands, type DetectedCommands } from './frameworks.js';
import { classifyErrorFromOutput } from './errorClassifier.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('verification');

export interface VerificationOptions {
  workspaceRoot: string;
  shell: ShellKind;
  levels?: VerificationLevel[];
  signal?: AbortSignal;
  timeoutMs?: number;
  onCheck?: (check: VerificationCheck) => void;
}

/**
 * Runs the real verification ladder: syntax → static → build → tests.
 * Runtime/functional verification is driven by the agent through
 * start_process + http_check, because it needs a target URL.
 */
export class VerificationEngine {
  async detect(workspaceRoot: string): Promise<DetectedCommands[]> {
    return detectProjectCommands(workspaceRoot);
  }

  async run(options: VerificationOptions): Promise<VerificationReport> {
    const levels = options.levels ?? ['syntax', 'static', 'build', 'tests'];
    const detected = await this.detect(options.workspaceRoot);
    const checks: VerificationCheck[] = [];
    const unverified: { level: VerificationLevel; reason: string }[] = [];

    if (detected.length === 0) {
      return {
        checks,
        passed: false,
        unverified: levels.map((level) => ({
          level,
          reason: 'No recognised project manifest (package.json, pyproject.toml, Cargo.toml, …) was found.'
        }))
      };
    }

    const mapping: Record<string, keyof DetectedCommands> = {
      syntax: 'syntax',
      static: 'lint',
      build: 'build',
      tests: 'test'
    };

    for (const level of levels) {
      const key = mapping[level];
      if (!key) {
        unverified.push({ level, reason: 'This level must be verified by running the application (runtime check).' });
        continue;
      }
      let ran = false;
      for (const project of detected) {
        const command = project[key] as string | undefined;
        if (!command) continue;
        ran = true;
        const cwd = path.resolve(options.workspaceRoot, project.cwd);
        const result = await runCommand(command, {
          cwd,
          shell: options.shell,
          timeoutMs: options.timeoutMs ?? 300_000,
          signal: options.signal
        });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const passed = result.exitCode === 0 && !result.timedOut;
        const check: VerificationCheck = {
          level,
          command: `${command} (${project.framework})`,
          outcome: passed ? 'passed' : 'failed',
          detail: output.slice(-6000) || (passed ? 'Completed with exit code 0.' : 'No output.'),
          durationMs: result.durationMs,
          errorType: passed ? undefined : classifyErrorFromOutput(output, result.timedOut)
        };
        checks.push(check);
        options.onCheck?.(check);
        log.info('Verification check', { level, command, outcome: check.outcome });
      }
      if (!ran) {
        unverified.push({ level, reason: `No ${level} command is configured in this project.` });
      }
    }

    const passed = checks.length > 0 && checks.every((c) => c.outcome === 'passed');
    return { checks, passed, unverified };
  }
}

export function summarizeReport(report: VerificationReport): string {
  const lines: string[] = [];
  for (const c of report.checks) {
    lines.push(`${c.outcome === 'passed' ? 'PASS' : 'FAIL'} [${c.level}] ${c.command ?? ''}`);
    if (c.outcome === 'failed') {
      lines.push(`  error_type=${c.errorType}`);
      lines.push(
        c.detail
          .split('\n')
          .slice(-40)
          .map((l) => `  ${l}`)
          .join('\n')
      );
    }
  }
  for (const u of report.unverified) lines.push(`NOT VERIFIED [${u.level}] ${u.reason}`);
  return lines.join('\n') || 'No verification checks could be executed.';
}
