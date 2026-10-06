#!/usr/bin/env node
/**
 * Bakes a provider credential into the next packaged build.
 *
 * Writes resources/bootstrap.json (git-ignored) with the key obfuscated, so the
 * installer arrives pre-configured. The first launch moves the key into the OS
 * keystore and the UI never displays it.
 *
 * Remember: an embedded credential is readable by anyone determined enough to
 * inspect the binary. Only use this for builds you distribute privately.
 *
 * Usage:
 *   NEXUS_API_KEY=sk-... node scripts/stage-embedded-credential.mjs \
 *     --base-url https://provider.example/v1 --model am/nemotron-3-ultra-550b-a55b
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';

// Mirrors src/core/shared/obfuscate.ts. Kept inline so this script runs on a
// bare Node install with no build step; tests/embeddedCredential.test.ts proves
// the two implementations stay compatible.
const DERIVATION_LABEL = 'NexusCode/embedded-credential/v1';
function obfuscateSecret(plaintext) {
  const key = crypto.createHash('sha256').update(DERIVATION_LABEL).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const apiKey = (process.env.NEXUS_API_KEY ?? arg('api-key') ?? '').trim();
if (!apiKey) {
  console.error('No credential supplied. Set NEXUS_API_KEY or pass --api-key.');
  process.exit(1);
}

const payload = { apiKeyEnc: obfuscateSecret(apiKey) };
const baseUrl = arg('base-url') ?? process.env.NEXUS_BASE_URL;
const model = arg('model') ?? process.env.NEXUS_MODEL;
if (baseUrl) payload.baseUrl = baseUrl;
if (model) payload.model = model;

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const target = arg('out') ? path.resolve(arg('out')) : path.join(root, 'resources', 'bootstrap.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(payload));

console.log(`Staged an obfuscated credential for the next build: ${path.relative(root, target)}`);
console.log(`  endpoint: ${baseUrl ?? '(from settings)'}`);
console.log(`  model:    ${model ?? '(from settings)'}`);
console.log('  the key itself appears nowhere in this output, the repository or the logs.');
