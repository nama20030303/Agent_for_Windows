import os from 'node:os';
import fssync from 'node:fs';
import path from 'node:path';
import { runCommand, defaultShell } from '../process/shell.js';

export interface EnvironmentInfo {
  platform: string;
  release: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  tools: Record<string, string | null>;
  virtualEnvs: string[];
}

const PROBES: { name: string; command: string }[] = [
  { name: 'python', command: 'python --version' },
  { name: 'node', command: 'node --version' },
  { name: 'npm', command: 'npm --version' },
  { name: 'git', command: 'git --version' },
  { name: 'dotnet', command: 'dotnet --version' },
  { name: 'java', command: 'java -version' },
  { name: 'docker', command: 'docker --version' },
  { name: 'go', command: 'go version' },
  { name: 'cargo', command: 'cargo --version' }
];

export async function detectEnvironment(workspaceRoot?: string): Promise<EnvironmentInfo> {
  const shell = defaultShell();
  const tools: Record<string, string | null> = {};
  await Promise.all(
    PROBES.map(async (probe) => {
      const res = await runCommand(probe.command, { cwd: workspaceRoot ?? os.homedir(), shell, timeoutMs: 8000 });
      const output = `${res.stdout}${res.stderr}`.trim().split('\n')[0];
      tools[probe.name] = res.exitCode === 0 && output ? output.slice(0, 80) : null;
    })
  );

  const virtualEnvs: string[] = [];
  if (workspaceRoot) {
    for (const dir of ['.venv', 'venv', 'env', 'node_modules', '.conda']) {
      if (fssync.existsSync(path.join(workspaceRoot, dir))) virtualEnvs.push(dir);
    }
  }

  return {
    platform: `${os.type()} ${os.release()}`,
    release: os.version?.() ?? os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    tools,
    virtualEnvs
  };
}
