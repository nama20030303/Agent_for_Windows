import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './secrets.js';
import { deobfuscateSecret } from './obfuscate.js';

/**
 * First-run credential bootstrap.
 *
 * Lets a machine be pre-provisioned with a provider key without ever putting
 * that key in source control: the key arrives from the environment or from a
 * local file, is imported into the OS-encrypted credential store on first
 * launch, and the plaintext source is then wiped.
 */
export interface BootstrapCredentials {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  provider?: string;
  /** Where it came from, for logging. Never contains the key itself. */
  source: string;
  /** True when the plaintext source should be wiped after a successful import. */
  wipeAfterImport: boolean;
  filePath?: string;
}

const ENV_KEYS = ['NEXUS_CODE_API_KEY', 'NEXUS_API_KEY'] as const;
const ENV_BASE_URL = ['NEXUS_CODE_BASE_URL', 'NEXUS_BASE_URL'] as const;
const ENV_MODEL = ['NEXUS_CODE_MODEL', 'NEXUS_MODEL'] as const;

function firstEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function readBootstrapFile(file: string, wipeAfterImport: boolean): BootstrapCredentials | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    // `apiKeyEnc` is an obfuscated credential baked into a distributed build;
    // `apiKey` is a plaintext one staged locally by an administrator.
    const encoded = typeof parsed.apiKeyEnc === 'string' ? deobfuscateSecret(parsed.apiKeyEnc) : null;
    const apiKey = (encoded ?? (typeof parsed.apiKey === 'string' ? parsed.apiKey : '')).trim();
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl: typeof parsed.baseUrl === 'string' ? parsed.baseUrl : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      source: `file ${path.basename(file)}`,
      wipeAfterImport,
      filePath: file
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a pre-provisioned credential, highest precedence first:
 *   1. environment variable (CI, corporate deployment, `set` before launch)
 *   2. `bootstrap.json` in the user's config directory (dropped there by an admin)
 *   3. `bootstrap.json` shipped next to the application resources (keyed build)
 */
export function resolveBootstrapCredentials(options: {
  configDir: string;
  resourcesDir?: string;
  env?: NodeJS.ProcessEnv;
}): BootstrapCredentials | null {
  const env = options.env ?? process.env;

  const envKey = firstEnv(env, ENV_KEYS);
  if (envKey) {
    return {
      apiKey: envKey,
      baseUrl: firstEnv(env, ENV_BASE_URL),
      model: firstEnv(env, ENV_MODEL),
      source: 'environment',
      wipeAfterImport: false
    };
  }

  return (
    readBootstrapFile(path.join(options.configDir, 'bootstrap.json'), true) ??
    (options.resourcesDir ? readBootstrapFile(path.join(options.resourcesDir, 'bootstrap.json'), false) : null)
  );
}

/** Overwrite then remove a plaintext credential file so it cannot be recovered casually. */
export function wipeBootstrapFile(file: string): void {
  try {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    fs.writeFileSync(file, '0'.repeat(Math.max(size, 1)));
    fs.rmSync(file, { force: true });
  } catch {
    /* best effort — the key is already in the encrypted store */
  }
}

/** A log line describing an import, guaranteed never to contain the key. */
export function describeBootstrap(credentials: BootstrapCredentials): string {
  return redactSecrets(
    `imported provider credentials from ${credentials.source}` +
      (credentials.model ? `, model ${credentials.model}` : '') +
      (credentials.baseUrl ? `, endpoint ${credentials.baseUrl}` : '')
  );
}
