/**
 * The report a user copies when something goes wrong. It has to be worth
 * reading on its own and it must never carry a key.
 */
import { describe, it, expect } from 'vitest';
import { buildDiagnosticsReport } from '../src/renderer/src/state/diagnostics.js';
import type { AppState } from '../src/renderer/src/state/store.js';

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    ready: true,
    settings: {
      ai: {
        provider: 'openai-compatible',
        baseUrl: 'https://anymodel.org/v1',
        model: 'am/nemotron-3-ultra-550b-a55b',
        temperature: 0.2,
        maxTokens: 0,
        timeoutMs: 120000,
        streaming: true
      },
      permissionMode: 'balanced',
      customPermissions: {} as any,
      requirePlanApproval: true,
      maxRepairAttempts: 5,
      maxAgentIterations: 50,
      theme: 'dark',
      shell: 'powershell',
      onboardingComplete: true
    } as any,
    hasApiKey: true,
    workspace: { name: 'demo', projectId: 'p1', root: 'C:\\dev\\demo' } as any,
    index: { fileCount: 42 } as any,
    sessions: [],
    sessionId: 's1',
    mode: 'agent',
    agentState: 'BLOCKED',
    agentDetail: 'The model is not calling tools.',
    turns: [],
    tasks: [],
    timeline: [{ at: '12:00:01', message: 'Project indexed: 42 files' }],
    processes: [],
    usage: { requests: 3, inputTokens: 1200, outputTokens: 450 },
    filesCreated: 0,
    filesModified: 0,
    git: { modified: 0, staged: 0, untracked: 0, isRepo: true },
    openFile: null,
    showTerminal: false,
    showPalette: false,
    showSettings: false,
    showOnboarding: false,
    busy: false,
    toast: null,
    ...overrides
  } as AppState;
}

describe('the diagnostics report', () => {
  it('answers the first questions a maintainer asks', () => {
    const report = buildDiagnosticsReport(state(), '0.1.0 (build 26)');
    expect(report).toContain('0.1.0 (build 26)');
    expect(report).toContain('anymodel.org');
    expect(report).toContain('am/nemotron-3-ultra-550b-a55b');
    expect(report).toContain('BLOCKED');
    expect(report).toContain('API key configured: yes');
    expect(report).toContain('Project indexed: 42 files');
    // The endpoint is identified by host, not by a pasted URL with a token in it.
    expect(report).not.toContain('https://anymodel.org/v1');
  });

  it('shows what failed, with the real error text', () => {
    const report = buildDiagnosticsReport(
      state({
        turns: [
          { kind: 'user', id: '1', content: 'build the app' },
          {
            kind: 'tool',
            id: '2',
            activity: {
              id: '2',
              risk: 'MEDIUM',
              startedAt: 0,
              call: { id: '2', name: 'execute_command', arguments: { command: 'npm test' } },
              result: {
                success: false,
                tool: 'execute_command',
                callId: '2',
                exitCode: 1,
                stderr: 'Error: Cannot find module \'express\'',
                error: 'Command exited with code 1.'
              }
            }
          },
          { kind: 'error', id: '3', message: 'The model returned no usable response.' }
        ] as any
      }),
      '0.1.0'
    );
    expect(report).toContain('npm test');
    expect(report).toContain('FAILED');
    expect(report).toContain('exit 1');
    expect(report).toContain("Cannot find module 'express'");
    expect(report).toContain('### Failed tool calls');
    expect(report).toContain('The model returned no usable response.');
  });

  it('never leaks a key, even when the model wrote one into a file', () => {
    const report = buildDiagnosticsReport(
      state({
        turns: [
          {
            kind: 'tool',
            id: '1',
            activity: {
              id: '1',
              risk: 'MEDIUM',
              startedAt: 0,
              call: { id: '1', name: 'write_file', arguments: { path: '.env', content: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx' } },
              result: { success: true, tool: 'write_file', callId: '1', summary: 'Wrote .env' }
            }
          }
        ] as any
      }),
      '0.1.0'
    );
    expect(report).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(report).toContain('.env');
  });
});
