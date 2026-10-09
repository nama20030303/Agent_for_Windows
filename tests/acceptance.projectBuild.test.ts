/**
 * The whole point of the application, exercised end to end: a cloud model that
 * can only produce text drives the app through a real multi-file project -
 * directory, several files, a file too long for one reply, running it, and a
 * verified report. Only the network is simulated.
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

const call = (tool: string, args: Record<string, unknown>) =>
  '```tool_call\n' + JSON.stringify({ tool, arguments: args }) + '\n```';

function reply(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('building a project with a text-only model', () => {
  it('creates the layout, writes a long file in parts, runs it and reports', async () => {
    const root = tempDir('nexus-project-');
    cleanups.push(() => removeTempDir(root));

    // A module long enough that no sane output budget would carry it in one
    // call, built the way the prompt instructs: write_file then append_file.
    // Node is the one runtime guaranteed on every machine that runs this
    // suite, including the Windows job that builds the installer.
    const partOne = ['function area(width, height) {', '  return width * height;', '}', ''].join('\n');
    const partTwo = [
      'function perimeter(width, height) {',
      '  return 2 * (width + height);',
      '}',
      '',
      'module.exports = { area, perimeter };',
      ''
    ].join('\n');
    const main = [
      'const { area, perimeter } = require("./geometry");',
      '',
      'console.log(`area=${area(3, 4)} perimeter=${perimeter(3, 4)}`);',
      ''
    ].join('\n');

    const script = [
      'I will start with the package directory.\n\n' + call('create_directory', { path: 'shapes' }),
      'First half of the module.\n\n' + call('write_file', { path: 'shapes/geometry.js', content: partOne }),
      'Second half.\n\n' + call('append_file', { path: 'shapes/geometry.js', content: partTwo }),
      // The entry point contains quotes and braces, the shape that used to break the parser.
      'Now the entry point.\n\n' + call('write_file', { path: 'shapes/main.js', content: main }),
      'Running it.\n\n' + call('execute_command', { command: 'node main.js', cwd: 'shapes' }),
      'All good.\n\n' +
        call('finish', { report: 'Created shapes/ with geometry.js and main.js; ran it successfully.', success: true, verified: true })
    ];

    let turn = 0;
    globalThis.fetch = vi.fn(async () => reply(script[Math.min(turn++, script.length - 1)])) as any;

    const provider = new OpenAICompatibleProvider({
      provider: 'openai-compatible',
      baseUrl: 'https://cloud.invalid/v1',
      model: 'text-only-model',
      temperature: 0.2,
      maxTokens: 0,
      timeoutMs: 10_000,
      streaming: false,
      apiKey: 'sk'
    } as any);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
      userMessage: 'build a small python package that computes area and perimeter, and run it'
    });

    // The project exists on disk, assembled from several calls.
    const geometry = fs.readFileSync(path.join(root, 'shapes', 'geometry.js'), 'utf8');
    expect(geometry).toBe(partOne + partTwo);
    expect(geometry).toContain('function area');
    expect(geometry).toContain('function perimeter');
    expect(fs.readFileSync(path.join(root, 'shapes', 'main.js'), 'utf8')).toBe(main);

    // And it really ran: the command tool produced the program's own output.
    const toolEvents = harness.events.filter((e: any) => e.type === 'tool_result') as any[];
    const run = toolEvents.find((e) => e.result?.tool === 'execute_command');
    expect(run, 'the agent must actually execute the program').toBeTruthy();
    expect(JSON.stringify(run.result)).toContain('area=12 perimeter=14');

    const states = harness.events.filter((e) => e.type === 'agent_state_change').map((e: any) => e.state);
    expect(states).toContain('COMPLETED');
    expect(states).not.toContain('BLOCKED');

    // No retry was ever spent: the textual call was usable on the first
    // attempt, so the provider never had to go looking for another shape.
    expect(provider.describe().nativeToolCalls).toBe('unknown');
    expect(provider.describe().payloadReduced).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(script.length);
  }, 60_000);
});
