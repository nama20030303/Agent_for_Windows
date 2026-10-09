/**
 * Regression tests for the "nothing happened" failure: a provider reply that
 * carries no answer must never be presented as a finished turn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { diagnoseEmptyResponse } from '../src/core/agent/agentController.js';
import { OpenAICompatibleProvider } from '../src/core/ai/openaiCompatible.js';
import { MockProvider } from './helpers/mockProvider.js';
import { buildHarness, tempDir, removeTempDir } from './helpers/harness.js';
import type { AgentEvent } from '../src/core/shared/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function provider(settings: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: 'test-model',
    temperature: 0.2,
    maxTokens: 1024,
    timeoutMs: 5000,
    streaming: false,
    apiKey: 'sk-test',
    ...settings
  } as any);
}

describe('reasoning-model responses', () => {
  it('captures reasoning_content instead of losing the reply', async () => {
    const p = provider();
    (globalThis as any).fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: 'I should greet the user.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    const response = await p.sendMessage({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.content).toBe('');
    expect(response.reasoning).toBe('I should greet the user.');
  });

  it('collects streamed reasoning deltas without emitting them to the UI', async () => {
    const p = provider({ streaming: true });
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"harder"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    (globalThis as any).fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          }
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      );

    const deltas: string[] = [];
    const response = await p.streamMessage({ messages: [{ role: 'user', content: 'hi' }] }, { onDelta: (d) => deltas.push(d) });
    expect(response.content).toBe('');
    expect(response.reasoning).toBe('thinking harder');
    expect(deltas).toHaveLength(0); // internal reasoning is never surfaced
  });
});

describe('empty-response diagnosis', () => {
  const where = { model: 'am/nemotron-3-ultra-550b-a55b', baseUrl: 'https://host/v1' };

  it('explains a token-limit cut-off', () => {
    const msg = diagnoseEmptyResponse({ content: '', finishReason: 'length' }, where);
    expect(msg).toMatch(/token limit/i);
    expect(msg).toMatch(/Max tokens/);
  });

  it('explains a reasoning-only reply', () => {
    const msg = diagnoseEmptyResponse({ content: '', reasoning: 'hmm', finishReason: 'stop' }, where);
    expect(msg).toMatch(/internal reasoning only/i);
    expect(msg).toMatch(/function calling/i);
  });

  it('explains an otherwise empty reply and names the endpoint', () => {
    const msg = diagnoseEmptyResponse({ content: '', finishReason: 'stop' }, where);
    expect(msg).toContain('https://host/v1');
    expect(msg).toMatch(/Find a working model/);
  });

  it('never leaks the API key into the diagnosis', () => {
    const msg = diagnoseEmptyResponse({ content: '', finishReason: 'stop' }, where);
    expect(msg).not.toMatch(/sk-/);
  });
});

describe('agent behaviour on an empty model reply', () => {
  it('retries once, then reports the problem instead of finishing silently', async () => {
    const root = tempDir('nexus-empty-');
    cleanups.push(() => removeTempDir(root));

    // Two consecutive empty replies, exactly what a misconfigured endpoint produces.
    const p = new MockProvider([
      { content: '', reasoning: 'thinking' },
      { content: '', reasoning: 'thinking again' }
    ]);
    const harness = await buildHarness({ provider: p, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create plz snake on python'
    });

    expect(p.requests).toHaveLength(2); // nudged exactly once

    const error = harness.events.find((e) => e.type === 'error') as Extract<AgentEvent, { type: 'error' }> | undefined;
    expect(error, 'the user must be told why nothing happened').toBeDefined();
    expect(error!.message).toMatch(/internal reasoning only/i);

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('FAILED');
    expect(states).not.toContain('COMPLETED');
  }, 30_000);

  it('accepts a prose answer as a complete turn', async () => {
    const root = tempDir('nexus-prose-');
    cleanups.push(() => removeTempDir(root));

    const p = new MockProvider([{ content: 'Snake needs a window size and a framework. Which do you prefer?' }]);
    const harness = await buildHarness({ provider: p, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create plz snake on python'
    });

    expect(harness.events.some((e) => e.type === 'error')).toBe(false);
    expect(harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state)).toContain('COMPLETED');
  }, 30_000);
});
