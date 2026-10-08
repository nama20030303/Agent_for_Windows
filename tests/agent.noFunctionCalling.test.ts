/**
 * Behaviour against an endpoint whose model does not emit native tool calls —
 * the real failure reported from anymodel.org: the agent "finished" a request
 * having changed nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { extractTextToolCalls } from '../src/core/ai/toolCallFallback.js';
import { MockProvider } from './helpers/mockProvider.js';
import { buildHarness, tempDir, removeTempDir } from './helpers/harness.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('textual tool calls', () => {
  it('reads a fenced tool_call block and strips it from the visible answer', () => {
    const { calls, cleaned } = extractTextToolCalls(
      'I will create the file.\n\n```tool_call\n{ "tool": "write_file", "arguments": { "path": "snake.py", "content": "x" } }\n```'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('write_file');
    expect(JSON.parse(calls[0].arguments).path).toBe('snake.py');
    expect(cleaned).toBe('I will create the file.');
  });

  it('accepts the common spellings of the same thing', () => {
    expect(extractTextToolCalls('```json\n{"name":"read_file","arguments":{"path":"a"}}\n```').calls).toHaveLength(1);
    expect(extractTextToolCalls('{"tool":"list_directory","args":{"path":"."}}').calls).toHaveLength(1);
    expect(
      extractTextToolCalls('```\n{"function":{"name":"git_status"},"parameters":{}}\n```').calls[0].name
    ).toBe('git_status');
  });

  it('never mistakes prose or code for a command', () => {
    expect(extractTextToolCalls('Here is the plan: write a file, then run tests.').calls).toHaveLength(0);
    expect(extractTextToolCalls('```python\nprint({"tool": "nope"})\n```').calls).toHaveLength(0);
    expect(extractTextToolCalls('```json\n{ "path": "a.py" }\n```').calls).toHaveLength(0);
    expect(extractTextToolCalls('```json\nnot json at all\n```').calls).toHaveLength(0);
  });
});

describe('agent against a model without function calling', () => {
  it('executes a textual tool call so the work actually happens', async () => {
    const root = tempDir('nexus-textcall-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([
      {
        content: [
          'Creating the game now.',
          '',
          '```tool_call',
          JSON.stringify({ tool: 'write_file', arguments: { path: 'snake.py', content: 'print("snake")\n' } }),
          '```'
        ].join('\n')
      },
      { content: 'Done.', toolCalls: [{ name: 'finish', arguments: { report: 'Created snake.py', verified: false, success: true } }] }
    ]);

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

    expect(fs.existsSync(path.join(root, 'snake.py'))).toBe(true);
    // The raw JSON must not be shown to the user as the assistant's words.
    const messages = harness.events.filter((e) => e.type === 'assistant_message') as any[];
    expect(messages[0].content).toBe('Creating the game now.');
  }, 30_000);

  it('refuses to report completion when the model only talks about the work', async () => {
    const root = tempDir('nexus-prose-only-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([
      { content: 'Here is a snake game:\n\n```python\nimport pygame\n```\nSave this as snake.py and run it.' },
      { content: 'As I said, save the code above into snake.py.' }
    ]);

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

    expect(fs.readdirSync(root)).toHaveLength(0);

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states, 'nothing was done, so this is not a completed task').not.toContain('COMPLETED');
    expect(states).toContain('BLOCKED');

    const error = harness.events.find((e) => e.type === 'error') as any;
    expect(error.message).toMatch(/does not support tool calling/i);
    expect(provider.requests).toHaveLength(2); // nudged exactly once
  }, 30_000);

  it('still lets Chat mode answer in prose', async () => {
    const root = tempDir('nexus-chat-ok-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([{ content: 'This project is a Python game.' }]);
    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'chat',
      shell: 'bash',
      userMessage: 'what is this project?'
    });

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
    expect(harness.events.some((e) => e.type === 'error')).toBe(false);
  }, 30_000);
});
