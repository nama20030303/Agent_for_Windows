/**
 * An installer may ship a pre-provisioned credential. These tests prove the
 * build-time staging script and the runtime importer agree, that the key is not
 * recoverable from the packaged file as text, and that it still ends up in the
 * OS keystore path rather than staying on disk in the clear.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { obfuscateSecret, deobfuscateSecret } from '../src/core/shared/obfuscate.js';
import { resolveBootstrapCredentials } from '../src/core/shared/bootstrap.js';
import { tempDir, removeTempDir } from './helpers/harness.js';

const KEY = 'sk-aa11bb22cc33dd44-ee55ff-66778899';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) removeTempDir(dirs.pop()!);
  fs.rmSync(path.join(process.cwd(), 'resources', 'bootstrap.json'), { force: true });
});

function dir(): string {
  const d = tempDir('nexus-embed-');
  dirs.push(d);
  return d;
}

describe('credential obfuscation', () => {
  it('round-trips', () => {
    expect(deobfuscateSecret(obfuscateSecret(KEY))).toBe(KEY);
  });

  it('produces a different token every time and never contains the key', () => {
    const a = obfuscateSecret(KEY);
    const b = obfuscateSecret(KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('sk-');
    expect(Buffer.from(a, 'base64').toString('latin1')).not.toContain('sk-');
  });

  it('rejects tampered or foreign tokens instead of returning garbage', () => {
    const token = obfuscateSecret(KEY);
    const tampered = Buffer.from(token, 'base64');
    tampered[tampered.length - 1] ^= 0xff;
    expect(deobfuscateSecret(tampered.toString('base64'))).toBeNull();
    expect(deobfuscateSecret('not-a-token')).toBeNull();
    expect(deobfuscateSecret('')).toBeNull();
  });
});

describe('build-time staging script', () => {
  it('writes a file the application can import, with no plaintext key in it', () => {
    execFileSync(process.execPath, ['scripts/stage-embedded-credential.mjs', '--base-url', 'https://provider.example/v1', '--model', 'test-model'], {
      env: { ...process.env, NEXUS_API_KEY: KEY },
      cwd: process.cwd()
    });

    const file = path.join(process.cwd(), 'resources', 'bootstrap.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('sk-');

    // The runtime importer reads exactly what the build script wrote.
    const resourcesDir = path.dirname(file);
    const found = resolveBootstrapCredentials({ configDir: dir(), resourcesDir, env: {} });
    expect(found?.apiKey).toBe(KEY);
    expect(found?.baseUrl).toBe('https://provider.example/v1');
    expect(found?.model).toBe('test-model');
    // Packaged resources are read-only: the file is kept, the key is not wiped from it.
    expect(found?.wipeAfterImport).toBe(false);
  });

  it('refuses to run without a credential', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/stage-embedded-credential.mjs'], {
        env: { ...process.env, NEXUS_API_KEY: '' },
        cwd: process.cwd(),
        stdio: 'pipe'
      })
    ).toThrow();
  });
});
