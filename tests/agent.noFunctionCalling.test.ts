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
    expect(error.message).toMatch(/compatibility mode/i);
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

describe('forgiving parsing of a sloppy model', () => {
  const tools = ['write_file', 'read_file', 'run_command', 'finish'];

  it('recovers a call whose JSON has raw newlines in the file content', () => {
    // Exactly what models produce when writing code: the content string is not escaped.
    const raw = '```tool_call\n{ "tool": "write_file", "arguments": { "path": "snake.py", "content": "import pygame\npygame.init()\n" } }\n```';
    const { calls } = extractTextToolCalls(raw, tools);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].arguments).content).toBe('import pygame\npygame.init()\n');
  });

  it('tolerates a trailing comma, a wrapper object and a missing language tag', () => {
    expect(extractTextToolCalls('```\n{"tool_call":{"tool":"read_file","arguments":{"path":"a.py",}}}\n```', tools).calls[0].name).toBe(
      'read_file'
    );
  });

  it('accepts arguments passed as a JSON string', () => {
    const { calls } = extractTextToolCalls('```tool_call\n{"name":"run_command","arguments":"{\\"command\\":\\"ls\\"}"}\n```', tools);
    expect(JSON.parse(calls[0].arguments).command).toBe('ls');
  });

  it('finds a call written without any fence at all', () => {
    const { calls, cleaned } = extractTextToolCalls(
      'Okay, doing it.\n{"tool": "read_file", "arguments": {"path": "main.py"}}\nThen I will check the result.',
      tools
    );
    expect(calls).toHaveLength(1);
    expect(cleaned).not.toContain('read_file');
  });

  it('still refuses code, prose and unknown tool names', () => {
    expect(extractTextToolCalls('```python\nprint({"tool": "write_file"})\n```', tools).calls).toHaveLength(0);
    expect(extractTextToolCalls('I will write_file to disk and then finish.', tools).calls).toHaveLength(0);
    expect(extractTextToolCalls('```tool_call\n{"tool":"rm_minus_rf","arguments":{}}\n```', tools).calls).toHaveLength(0);
    expect(extractTextToolCalls('```json\n{"path":"a.py","content":"x"}\n```', tools).calls).toHaveLength(0);
  });
});

describe('meeting the model halfway', () => {
  const tools = ['write_file', 'read_file', 'execute_command', 'list_directory', 'finish'];

  it('accepts the names models reach for instead of the real ones', () => {
    const alias = (name: string) =>
      extractTextToolCalls('```tool_call\n' + JSON.stringify({ tool: name, arguments: {} }) + '\n```', tools).calls[0]?.name;
    expect(alias('create_file')).toBe('write_file');
    expect(alias('run_command')).toBe('execute_command');
    expect(alias('ls')).toBe('list_directory');
    expect(alias('done')).toBe('finish');
    // An alias is never preferred over a real tool of that name.
    expect(alias('read_file')).toBe('read_file');
  });

  it('reads a block the model never closed', () => {
    const { calls } = extractTextToolCalls(
      'Writing it now.\n```tool_call\n{"tool": "write_file", "arguments": {"path": "a.py", "content": "x"}}',
      tools
    );
    expect(calls[0].name).toBe('write_file');
  });

  it('reports an invented tool name instead of silently dropping the call', () => {
    const result = extractTextToolCalls('```tool_call\n{"tool": "summon_dragon", "arguments": {}}\n```', tools);
    expect(result.calls).toHaveLength(0);
    expect(result.unknownTools).toEqual(['summon_dragon']);
  });
});

describe('a model that invents a tool name mid-run', () => {
  it('is told the real names and the run still succeeds', async () => {
    const root = tempDir('nexus-unknown-tool-');
    cleanups.push(() => removeTempDir(root));

    const block = (call: unknown) => '```tool_call\n' + JSON.stringify(call) + '\n```';
    const provider = new MockProvider([
      { content: 'Writing it.\n\n' + block({ tool: 'file_creator_9000', arguments: { path: 'a.py' } }) },
      { content: 'Sorry.\n\n' + block({ tool: 'write_file', arguments: { path: 'a.py', content: 'print(1)\n' } }) },
      { content: 'Done.\n\n' + block({ tool: 'finish', arguments: { report: 'Created a.py', success: true, verified: false } }) }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create a.py'
    });

    expect(fs.existsSync(path.join(root, 'a.py'))).toBe(true);
    // The mock keeps a reference to the live history array, so inspect all of it.
    const history = provider.requests[0].messages;
    const correction = history.find((m) => m.content.includes('There is no tool called'));
    expect(correction, 'the model must be told which tools exist').toBeTruthy();
    expect(correction!.content).toContain('`file_creator_9000`');
    expect(correction!.content).toContain('write_file');
    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
  }, 30_000);
});

describe('a model whose call is cut off by the output limit', () => {
  it('is asked for smaller pieces instead of writing half a file', async () => {
    const root = tempDir('nexus-truncated-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([
      // Cut off in the middle of the JSON, exactly as a long file arrives.
      { content: '```tool_call\n{"tool": "write_file", "arguments": {"path": "main.rs", "content": "//! Nexus\nfn main() { println!("start");' },
      {
        content:
          'Shorter now.\n\n```tool_call\n' +
          JSON.stringify({ tool: 'write_file', arguments: { path: 'main.rs', content: 'fn main() {}\n' } }) +
          '\n```'
      },
      {
        content: 'Done.\n\n```tool_call\n' + JSON.stringify({ tool: 'finish', arguments: { report: 'Created main.rs', success: true, verified: false } }) + '\n```'
      }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create main.rs'
    });

    // The half-written content must never have reached the disk.
    const written = fs.readFileSync(path.join(root, 'main.rs'), 'utf8');
    expect(written).toBe('fn main() {}\n');

    const history = provider.requests[0].messages;
    const nudge = history.find((m) => m.content.includes('cut off in the middle of the JSON'));
    expect(nudge, 'the model must be told why nothing ran').toBeTruthy();
    expect(nudge!.content).toContain('150 lines');

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
    expect(states).not.toContain('BLOCKED');
  }, 30_000);
});

describe('a model whose JSON will not parse', () => {
  it('is asked to escape it, and the run continues', async () => {
    const root = tempDir('nexus-malformed-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([
      { content: '```tool_call\n{"tool": write_file, path: main.rs}\n```' },
      {
        content:
          '```tool_call\n' +
          JSON.stringify({ tool: 'write_file', arguments: { path: 'main.rs', content: 'fn main() {}\n' } }) +
          '\n```'
      },
      {
        content:
          '```tool_call\n' +
          JSON.stringify({ tool: 'finish', arguments: { report: 'Created main.rs', success: true, verified: false } }) +
          '\n```'
      }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'create main.rs'
    });

    expect(fs.existsSync(path.join(root, 'main.rs'))).toBe(true);
    const nudge = provider.requests[0].messages.find((m) => m.content.includes('not valid JSON'));
    expect(nudge, 'the model must be told its JSON was broken').toBeTruthy();
    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
  }, 30_000);
});

describe('the requirements-then-nothing session from the report', () => {
  it('runs the call with the Windows path and refuses to call it done', async () => {
    const root = tempDir('nexus-requirements-');
    cleanups.push(() => removeTempDir(root));

    const block = (call: unknown) => '```tool_call\n' + JSON.stringify(call) + '\n```';
    // Written by hand, exactly as the model sent it: the backslashes in the
    // Windows path are not escaped, which makes the JSON invalid.
    const requirements =
      '{"tool": "record_requirements", "arguments": {"summary": "Build Nexus Code.", ' +
      '"requirements": [{"id": "req-001", "description": "Windows desktop application", ' +
      '"type": "explicit", "priority": "critical", "confidence": 1.0}], ' +
      '"assumptions": ["Configuration via %APPDATA%\\NexusCode\\ with secure API key storage"]}}';

    const provider = new MockProvider([
      { content: requirements },
      // The old failure mode: straight from analysis to "all done".
      { content: 'All set.\n\n' + block({ tool: 'finish', arguments: { report: 'Implementation complete.', success: true, verified: true } }) },
      { content: 'You are right.\n\n' + block({ tool: 'write_file', arguments: { path: 'main.py', content: 'print("hi")\n' } }) },
      { content: 'Done.\n\n' + block({ tool: 'finish', arguments: { report: 'Created main.py.', success: true, verified: false } }) }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: 'bash',
      userMessage: 'build nexus code'
    });

    // The requirements call must not be thrown away over a backslash.
    const calls = harness.events.filter((e: any) => e.type === 'tool_call').map((e: any) => e.call.name);
    expect(calls).toContain('record_requirements');

    // And "finished" with an empty folder must not be accepted.
    const history = provider.requests[0].messages;
    expect(history.some((m) => m.content.includes('not created, modified or deleted a single file'))).toBe(true);

    // After the push-back, real work happened.
    expect(fs.readFileSync(path.join(root, 'main.py'), 'utf8')).toBe('print("hi")\n');
    const completion = harness.events.find((e: any) => e.type === 'completion') as any;
    expect(completion.report).not.toMatch(/Nothing on disk has changed/i);
  }, 30_000);
});
