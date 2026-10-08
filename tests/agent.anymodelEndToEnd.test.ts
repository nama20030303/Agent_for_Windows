/**
 * The exact situation reported from anymodel.org, end to end: a real provider
 * talking to an endpoint that has no function calling and answers in prose.
 * The run must still create the file and finish — no mock provider, only the
 * HTTP layer is replaced.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { OpenAICompatibleProvider } from '../src/core/ai/openaiCompatible.js';
import { buildHarness, tempDir, removeTempDir } from './helpers/harness.js';

const realFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  while (cleanups.length) cleanups.pop()!();
});

function reply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function block(call: unknown) {
  return '```tool_call\n' + JSON.stringify(call) + '\n```';
}

describe('a run against an endpoint without function calling', () => {
  it('writes the real file and reports a verified-free completion', async () => {
    const root = tempDir('nexus-anymodel-');
    cleanups.push(() => removeTempDir(root));

    const sent: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      switch (sent.length) {
        case 1:
          // Prose, like the real endpoint: tools were offered and ignored.
          return reply('Sure! Here is a snake game:\n\n```python\nimport pygame\n```\nSave it as snake.py and run it.');
        case 2:
          // The retry arrives in compatibility mode; the model follows the protocol.
          return reply(
            'Creating the file.\n\n' +
              block({ tool: 'write_file', arguments: { path: 'snake.py', content: 'import pygame\npygame.init()\n' } })
          );
        default:
          return reply(block({ tool: 'finish', arguments: { report: 'Created snake.py', success: true, verified: false } }));
      }
    }) as any;

    const provider = new OpenAICompatibleProvider({
      provider: 'openai-compatible',
      baseUrl: 'https://anymodel.invalid/v1',
      model: 'am/nemotron-3-ultra-550b-a55b',
      temperature: 0.2,
      maxTokens: 16384,
      timeoutMs: 5000,
      streaming: false,
      apiKey: 'sk-test'
    } as any);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create snake on python'
    });

    // The whole point: the work actually happened.
    const file = path.join(root, 'snake.py');
    expect(fs.existsSync(file), 'snake.py must exist on disk').toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('pygame.init()');

    // The first attempt used native tools, everything after it did not.
    expect(sent[0].tools).toBeTruthy();
    expect(sent[1].tools).toBeUndefined();
    expect(sent.at(-1).tools).toBeUndefined();
    expect(provider.usesTextToolProtocol).toBe(true);

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
    expect(states).not.toContain('BLOCKED');

    // The user sees the sentence, never the JSON.
    const messages = harness.events.filter((e) => e.type === 'assistant_message') as any[];
    expect(messages.some((m) => m.content.includes('tool_call'))).toBe(false);
    expect(messages.some((m) => m.content.includes('Creating the file.'))).toBe(true);
  }, 30_000);
});
