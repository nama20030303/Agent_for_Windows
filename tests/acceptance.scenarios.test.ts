/**
 * Acceptance scenarios from the product specification, executed for real:
 * real files, real commands, real test runs, real HTTP checks.
 * The model is replaced by a scripted provider so the test is deterministic —
 * everything below the model boundary is the production code path.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MockProvider } from './helpers/mockProvider.js';
import { buildHarness, tempDir } from './helpers/harness.js';
import type { AgentEvent } from '../src/core/shared/types.js';

const shell = (process.platform === 'win32' ? 'powershell' : 'bash') as 'powershell' | 'bash';
const python = process.platform === 'win32' ? 'python' : 'python3';
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const APP_PY = `"""Tiny stdlib HTTP service with a SQLite-backed users table."""
import json
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "app.db"


def init_db(path=DB_PATH):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL)")
    conn.commit()
    return conn


def health_payload():
    return {"status": "ok", "service": "demo-api"}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body = json.dumps(health_payload()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


def main(port=8077):
    init_db()
    print(f"demo-api listening on http://127.0.0.1:{port}", flush=True)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
`;

const TEST_PY = `import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.main import health_payload, init_db


class TestApi(unittest.TestCase):
    def test_health(self):
        self.assertEqual(health_payload()["status"], "ok")

    def test_users_table_exists(self):
        conn = init_db(Path(__file__).resolve().parents[1] / "data" / "test.db")
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").fetchall()
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
`;

describe('acceptance scenario 1 — build, test, run and verify a new project', () => {
  it('creates a real application, runs its tests, starts it and verifies /health', async () => {
    const root = tempDir('nexus-accept-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    const provider = new MockProvider([
      {
        content: 'Creating the project structure.',
        toolCalls: [
          { name: 'update_task', arguments: { title: 'Create demo API', goal: 'HTTP service with SQLite and tests', steps: [{ description: 'Scaffold', status: 'in_progress' }, { description: 'Tests', status: 'pending' }, { description: 'Run', status: 'pending' }] } },
          { name: 'create_directory', arguments: { path: 'app' } },
          { name: 'write_file', arguments: { path: 'app/main.py', content: APP_PY } },
          { name: 'write_file', arguments: { path: 'app/__init__.py', content: '' } },
          { name: 'write_file', arguments: { path: 'tests/test_api.py', content: TEST_PY } },
          { name: 'write_file', arguments: { path: 'pyproject.toml', content: '[project]\nname = "demo-api"\nversion = "0.1.0"\n' } }
        ]
      },
      {
        content: 'Running the test suite.',
        toolCalls: [{ name: 'execute_command', arguments: { command: `${python} -m unittest discover -s tests -q` } }]
      },
      {
        content: 'Starting the service and checking the health endpoint.',
        toolCalls: [{ name: 'start_process', arguments: { name: 'API', command: `${python} app/main.py`, port: 8077 } }]
      },
      { content: 'Verifying the endpoint.', toolCalls: [{ name: 'http_check', arguments: { url: 'http://127.0.0.1:8077/health' } }] },
      {
        content: 'Reporting.',
        toolCalls: [
          { name: 'finish', arguments: { report: 'Created the demo API, ran the unit tests and verified /health.', verified: false, success: true } }
        ]
      }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell,
      userMessage: 'Create a small Python HTTP application with a health endpoint, a SQLite database, a users table and automated tests.'
    });

    // Real files on disk.
    expect(fs.existsSync(path.join(root, 'app/main.py'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tests/test_api.py'))).toBe(true);

    const results = harness.events.filter((e) => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>[];
    const tests = results.find((r) => r.result.tool === 'execute_command')!;
    expect(tests.result.success).toBe(true);
    expect(`${tests.result.stdout}${tests.result.stderr}`).toMatch(/OK|Ran 2 tests/);

    // Real database file created by the real application code.
    expect(fs.existsSync(path.join(root, 'data/app.db'))).toBe(true);

    const started = results.find((r) => r.result.tool === 'start_process')!;
    expect(started.result.success).toBe(true);

    const health = results.find((r) => r.result.tool === 'http_check')!;
    expect(health.result.success).toBe(true);
    expect(health.result.stdout).toContain('"status": "ok"');

    harness.processes.stopAll();
  }, 180_000);
});

describe('acceptance scenario 2 — diagnose and fix a broken project', () => {
  it('finds the real cause of a startup failure, fixes it and verifies', async () => {
    const root = tempDir('nexus-broken-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'broken', scripts: { test: 'node src/app.js' } }));
    fs.writeFileSync(path.join(root, 'src/app.js'), "const { greet } = require('./helpers/greeter.js');\nconsole.log(greet('world'));\n");

    const provider = new MockProvider([
      { content: 'Reproducing the failure.', toolCalls: [{ name: 'execute_command', arguments: { command: 'node src/app.js' } }] },
      { content: 'Inspecting the import.', toolCalls: [{ name: 'read_file', arguments: { path: 'src/app.js' } }, { name: 'search_files', arguments: { pattern: 'src/**/*.js' } }] },
      {
        content: 'The required module does not exist. Creating it.',
        toolCalls: [{ name: 'write_file', arguments: { path: 'src/helpers/greeter.js', content: "function greet(name) {\n  return `Hello, ${name}!`;\n}\nmodule.exports = { greet };\n" } }, { name: 'verify_work', arguments: {} }]
      },
      { content: 'Fixed.', toolCalls: [{ name: 'finish', arguments: { report: 'Missing module src/helpers/greeter.js was the root cause. Created it and the app now starts.', verified: true, success: true } }] }
    ]);

    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'autonomous', autoApprove: true });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell,
      userMessage: 'Find why this application fails to start and fix it.'
    });

    const results = harness.events.filter((e) => e.type === 'tool_result') as any[];
    const reproduction = results[0].result;
    expect(reproduction.success).toBe(false);
    expect(reproduction.errorType).toBe('DEPENDENCY_ERROR');

    const verification = harness.events.find((e) => e.type === 'verification') as any;
    expect(verification.report.passed).toBe(true);

    const completion = harness.events.find((e) => e.type === 'completion') as any;
    expect(completion.verified).toBe(true);
  }, 120_000);
});

describe('acceptance scenario 3 — incomplete request triggers bundled questions', () => {
  it('does not start coding and asks high-impact questions with recommendations', async () => {
    const root = tempDir('nexus-vague-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // The deterministic pre-analysis alone must already identify the decisions.
    const { analyzeRequirements } = await import('../src/core/agent/requirementAnalyzer.js');
    const analysis = analyzeRequirements({ request: 'Create me an online marketplace.', index: null });
    const topics = analysis.questions.map((q) => q.topic);
    expect(topics).toContain('persistence');
    expect(analysis.questions.length).toBeGreaterThanOrEqual(2);
    expect(analysis.questions.length).toBeLessThanOrEqual(4);
    expect(analysis.requirements.filter((r) => r.kind === 'implicit').map((r) => r.statement).join(' ')).toMatch(/order|payment|data model|authorization/i);

    const provider = new MockProvider([
      {
        content: 'I need a few decisions first.',
        toolCalls: [
          {
            name: 'ask_user',
            arguments: {
              questions: analysis.questions.map((q) => ({
                topic: q.topic,
                question: q.question,
                priority: q.priority,
                options: q.options,
                recommended_option_id: q.recommendedOptionId,
                recommendation_reason: q.recommendationReason
              }))
            }
          }
        ]
      }
    ]);
    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'agent',
      shell,
      userMessage: 'Create me an online marketplace.'
    });

    expect(harness.agent.getState(harness.sessionId)).toBe('WAITING_FOR_USER');
    expect(fs.readdirSync(root)).toHaveLength(0);
  }, 60_000);
});

describe('acceptance scenario 8 — large projects are not sent to the model', () => {
  it('indexes thousands of files and sends only an index plus selected context', async () => {
    const root = tempDir('nexus-large-');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    for (let d = 0; d < 20; d++) {
      const dir = path.join(root, `module_${d}`);
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 60; f++) {
        fs.writeFileSync(path.join(dir, `file_${f}.ts`), `export function fn_${d}_${f}() {\n  return ${f};\n}\n`.repeat(8));
      }
    }

    const provider = new MockProvider([{ content: 'Understood.' }]);
    const harness = await buildHarness({ provider, workspaceRoot: root, permissionMode: 'balanced' });
    cleanups.push(harness.cleanup);

    await harness.agent.run({
      sessionId: harness.sessionId,
      projectId: harness.projectId,
      workspaceRoot: root,
      mode: 'chat',
      shell,
      userMessage: 'Explain the structure of this project.'
    });

    const prompt = provider.requests[0].messages.map((m) => m.content).join('\n');
    const totalProjectBytes = 20 * 60 * 8 * 50;
    expect(prompt).toContain('PROJECT INDEX');
    expect(prompt).toContain('files: 1200');
    expect(prompt.length).toBeLessThan(totalProjectBytes / 4);
    expect(prompt).not.toContain('fn_19_59');
  }, 180_000);
});
