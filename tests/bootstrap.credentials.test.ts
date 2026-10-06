import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { describeBootstrap, resolveBootstrapCredentials, wipeBootstrapFile } from '../src/core/shared/bootstrap.js';
import { tempDir, removeTempDir } from './helpers/harness.js';

const KEY = 'sk-test-0123456789abcdef0123456789abcdef';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeTempDir(dirs.pop()!);
});

function dir(): string {
  const d = tempDir('nexus-bootstrap-');
  dirs.push(d);
  return d;
}

describe('credential bootstrap', () => {
  it('reads a key from the environment', () => {
    const found = resolveBootstrapCredentials({
      configDir: dir(),
      env: { NEXUS_CODE_API_KEY: KEY, NEXUS_CODE_MODEL: 'am/nemotron-3-ultra-550b-a55b' }
    });
    expect(found?.apiKey).toBe(KEY);
    expect(found?.model).toBe('am/nemotron-3-ultra-550b-a55b');
    expect(found?.wipeAfterImport).toBe(false);
  });

  it('reads a bootstrap file from the config directory and marks it for wiping', () => {
    const configDir = dir();
    fs.writeFileSync(path.join(configDir, 'bootstrap.json'), JSON.stringify({ apiKey: KEY, baseUrl: 'https://example.invalid/v1' }));
    const found = resolveBootstrapCredentials({ configDir, env: {} });
    expect(found?.apiKey).toBe(KEY);
    expect(found?.baseUrl).toBe('https://example.invalid/v1');
    expect(found?.wipeAfterImport).toBe(true);
  });

  it('prefers the environment over a packaged file', () => {
    const configDir = dir();
    const resourcesDir = dir();
    fs.writeFileSync(path.join(resourcesDir, 'bootstrap.json'), JSON.stringify({ apiKey: 'sk-packaged-key-should-lose' }));
    const found = resolveBootstrapCredentials({ configDir, resourcesDir, env: { NEXUS_API_KEY: KEY } });
    expect(found?.apiKey).toBe(KEY);
    expect(found?.source).toBe('environment');
  });

  it('ignores missing, empty and malformed files', () => {
    const configDir = dir();
    expect(resolveBootstrapCredentials({ configDir, env: {} })).toBeNull();
    fs.writeFileSync(path.join(configDir, 'bootstrap.json'), '{ not json');
    expect(resolveBootstrapCredentials({ configDir, env: {} })).toBeNull();
    fs.writeFileSync(path.join(configDir, 'bootstrap.json'), JSON.stringify({ apiKey: '   ' }));
    expect(resolveBootstrapCredentials({ configDir, env: {} })).toBeNull();
  });

  it('wipes the plaintext file so the key cannot be recovered from it', () => {
    const configDir = dir();
    const file = path.join(configDir, 'bootstrap.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: KEY }));
    wipeBootstrapFile(file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('never puts the key in a log line', () => {
    const line = describeBootstrap({ apiKey: KEY, model: 'm', baseUrl: 'https://example.invalid/v1', source: 'environment', wipeAfterImport: false });
    expect(line).not.toContain(KEY);
    expect(line).toContain('environment');
  });
});
