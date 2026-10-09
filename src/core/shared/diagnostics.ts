import { redactSecrets } from './secrets.js';
import type { ToolActivity, TurnItem, UiSnapshot } from './uiState.js';

/**
 * One block of text that explains a failed session to someone who was not
 * watching it: the configuration, what the agent did, and exactly where it
 * stopped. It is meant to be copied into a bug report, so it carries the
 * facts a maintainer asks for first and never carries a key — everything is
 * passed through the same redaction used for logs and model context.
 */

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url || '(not set)';
  }
}

function toolLine(activity: ToolActivity): string {
  const { call, result } = activity;
  const args = Object.entries(call.arguments as Record<string, unknown>)
    .map(([key, value]) => {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      // Arguments are for identifying the call, not for reproducing a file.
      return `${key}=${(text ?? '').slice(0, 120)}${(text ?? '').length > 120 ? '…' : ''}`;
    })
    .join(' ');

  if (!result) return `- ${call.name} ${args} → still running`;
  const outcome = result.success ? 'ok' : result.denied ? 'denied' : 'FAILED';
  const detail = [
    result.summary,
    result.error,
    result.exitCode !== undefined && result.exitCode !== 0 ? `exit ${result.exitCode}` : null,
    result.stderr ? `stderr: ${result.stderr.trim().slice(-400)}` : null
  ]
    .filter(Boolean)
    .join(' | ');
  return `- ${call.name} ${args} → ${outcome}${detail ? ` — ${detail}` : ''}`;
}

function turnLine(turn: TurnItem): string | null {
  switch (turn.kind) {
    case 'user':
      return `> ${turn.content.slice(0, 400)}`;
    case 'assistant':
      return turn.content.trim() ? `model: ${turn.content.slice(0, 400)}` : null;
    case 'tool':
      return toolLine(turn.activity);
    case 'error':
      return `ERROR: ${turn.message}`;
    case 'verification':
      return `verification: ${turn.report.passed ? 'passed' : 'FAILED'} (${turn.report.checks.length} checks)`;
    case 'completion':
      return `completion (verified: ${turn.verified})`;
    case 'question':
      return 'the agent asked the user a question';
    case 'plan':
      return `plan with ${turn.plan.steps.length} steps`;
    case 'approval':
      return `approval requested: ${turn.request.tool} ${turn.request.operation} ${turn.request.target}`;
    case 'requirements':
      return `requirements recorded: ${turn.analysis.requirements.length}`;
    default:
      return null;
  }
}

export function buildDiagnosticsReport(state: UiSnapshot, appVersion: string): string {
  const ai = state.settings?.ai;
  const failures = state.turns.filter(
    (t): t is Extract<TurnItem, { kind: 'tool' }> => t.kind === 'tool' && !!t.activity.result && !t.activity.result.success
  );
  const errors = state.turns.filter((t): t is Extract<TurnItem, { kind: 'error' }> => t.kind === 'error');

  const lines = [
    '## Nexus Code diagnostics',
    '',
    `When: ${new Date().toISOString()}`,
    `App: ${appVersion}`,
    `Agent state: ${state.agentState}${state.agentDetail ? ` — ${state.agentDetail}` : ''}`,
    '',
    '### Configuration',
    `Endpoint: ${host(ai?.baseUrl ?? '')}`,
    `Model: ${ai?.model ?? '(not set)'}`,
    `API key configured: ${state.hasApiKey ? 'yes' : 'NO'}`,
    `Streaming: ${ai?.streaming ?? '?'} · max tokens: ${ai?.maxTokens ?? '?'} · temperature: ${ai?.temperature ?? '?'}`,
    `Permission mode: ${state.settings?.permissionMode ?? '?'} · shell: ${state.settings?.shell ?? '?'}`,
    `Workspace: ${state.workspace ? `${state.workspace.name} (${state.index?.fileCount ?? '?'} files)` : 'none open'}`,
    `Tokens: ${state.usage.inputTokens} in / ${state.usage.outputTokens} out over ${state.usage.requests} requests`,
    '',
    '### What the agent did',
    ...(state.turns.map(turnLine).filter(Boolean).slice(-40) as string[]),
    ''
  ];

  if (errors.length) {
    lines.push('### Errors reported to the user', ...errors.slice(-5).map((e) => `- ${e.message}`), '');
  }

  if (failures.length) {
    lines.push('### Failed tool calls', ...failures.slice(-10).map((f) => toolLine(f.activity)), '');
  }

  if (state.timeline.length) {
    lines.push('### Timeline', ...state.timeline.slice(-30).map((t) => `${t.at} ${t.message}`), '');
  }

  return redactSecrets(lines.join('\n'));
}
