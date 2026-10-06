import { describe, it, expect } from 'vitest';
import { redactSecrets, containsSecret, isSensitiveFile, REDACTION } from '../src/core/shared/secrets.js';

describe('secret protection', () => {
  it('redacts assignments', () => {
    const out = redactSecrets('API_KEY=super-secret-value-123\nDB_PASSWORD: hunter2hunter2');
    expect(out).not.toContain('super-secret-value-123');
    expect(out).toContain(REDACTION);
  });

  it('redacts common token formats', () => {
    const samples = [
      'sk-abcdefghijklmnopqrstuvwxyz0123',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'AKIAIOSFODNN7EXAMPLE',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.signature123'
    ];
    for (const sample of samples) {
      expect(containsSecret(sample)).toBe(true);
      expect(redactSecrets(sample)).not.toContain(sample.split(/\s+/).pop());
    }
  });

  it('redacts private keys', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----';
    expect(redactSecrets(key)).toBe(REDACTION);
  });

  it('leaves normal text untouched', () => {
    const text = 'def login(user): return user.is_active';
    expect(redactSecrets(text)).toBe(text);
  });

  it('flags sensitive file names', () => {
    expect(isSensitiveFile('.env')).toBe(true);
    expect(isSensitiveFile('config/.env.production')).toBe(true);
    expect(isSensitiveFile('certs/server.pem')).toBe(true);
    expect(isSensitiveFile('src/app.py')).toBe(false);
  });
});
