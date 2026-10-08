/**
 * Conversation context must survive a restart, a release() and a return to an
 * older session. Without this the model answers each message as if it were the
 * first thing ever said.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockProvider } from './helpers/mockProvider.js';
import { buildHarness, tempDir, removeTempDir } from './helpers/harness.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function prompt(provider: MockProvider, turn: number): string {
  return provider.requests[turn].messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

describe('conversation context across turns', () => {
  it('replays earlier turns and actions after the runtime is discarded', async () => {
    const root = tempDir('nexus-ctx-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([
      // Turn 1: the agent does something and answers.
      { content: 'Creating the game.', toolCalls: [{ name: 'write_file', arguments: { path: 'snake.py', content: 'print("snake")\n' } }] },
      // A real agent turn ends by reporting through finish, not with bare prose:
      // prose alone in agent mode is now treated as "nothing was done".
      {
        content: 'Created snake.py with the game loop.',
        toolCalls: [{ name: 'finish', arguments: { report: 'Created snake.py', verified: false, success: true } }]
      },
      // Turn 2 happens after the runtime has been thrown away.
      {
        content: 'Added the score counter to the existing game.',
        toolCalls: [{ name: 'finish', arguments: { report: 'Score counter added', verified: false, success: true } }]
      }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    const base = {
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent' as const,
      shell: 'bash' as const
    };

    await harness.agent.run({ ...base, userMessage: 'create snake on python' });
    expect(fs.existsSync(path.join(root, 'snake.py'))).toBe(true);

    // Simulate closing the app: the in-memory runtime is gone, the database is not.
    harness.agent.release(harness.sessionId);

    await harness.agent.run({ ...base, userMessage: 'now add a score counter' });

    const second = prompt(provider, 2);
    expect(second, 'the first request must be visible in the new turn').toContain('create snake on python');
    expect(second, 'the previous answer must be visible').toContain('Created snake.py with the game loop.');
    expect(second, 'earlier tool activity must be visible').toContain('write_file snake.py → ok');
    expect(second).toContain('EARLIER TURNS IN THIS SESSION');
  }, 30_000);

  it('keeps context within a session without reloading it twice', async () => {
    const root = tempDir('nexus-ctx2-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([{ content: 'First answer.' }, { content: 'Second answer.' }]);
    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    const base = {
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'chat' as const,
      shell: 'bash' as const
    };

    await harness.agent.run({ ...base, userMessage: 'what is this project?' });
    await harness.agent.run({ ...base, userMessage: 'and what language is it in?' });

    const second = prompt(provider, 1);
    expect(second).toContain('what is this project?');
    expect(second).toContain('First answer.');
    // The live runtime already holds the turns, so the recovery block is not added.
    expect(second).not.toContain('EARLIER TURNS IN THIS SESSION');
  }, 30_000);

  it('starts a different session with no bleed-through from the first', async () => {
    const root = tempDir('nexus-ctx3-');
    cleanups.push(() => removeTempDir(root));

    const provider = new MockProvider([{ content: 'Answer A.' }, { content: 'Answer B.' }]);
    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    const other = harness.sessions.createSession(harness.projectId, 'second session');

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'chat',
      shell: 'bash',
      userMessage: 'secret topic of session one'
    });

    await harness.agent.run({
      sessionId: other.id,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'chat',
      shell: 'bash',
      userMessage: 'unrelated question'
    });

    expect(prompt(provider, 1)).not.toContain('secret topic of session one');
  }, 30_000);
});
