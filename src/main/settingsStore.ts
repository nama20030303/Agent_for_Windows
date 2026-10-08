import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import type { AppSettings } from '../core/shared/types.js';
import { DEFAULT_AI_SETTINGS } from '../core/ai/nemotron.js';
import { DEFAULT_CUSTOM_RULES } from '../core/permissions/permissionManager.js';
import { createLogger } from '../core/shared/logger.js';
import { describeBootstrap, resolveBootstrapCredentials, wipeBootstrapFile } from '../core/shared/bootstrap.js';

const log = createLogger('settings');

export const DEFAULT_SETTINGS: AppSettings = {
  ai: { ...DEFAULT_AI_SETTINGS },
  permissionMode: 'balanced',
  customPermissions: { ...DEFAULT_CUSTOM_RULES },
  requirePlanApproval: true,
  maxRepairAttempts: 5,
  maxAgentIterations: 40,
  theme: 'dark',
  shell: process.platform === 'win32' ? 'powershell' : 'bash',
  onboardingComplete: false
};

/**
 * Settings live in a plain JSON file; the API key never does.
 * The key is encrypted with Electron safeStorage (DPAPI on Windows) and stored
 * in a separate file. It is never returned to the renderer.
 */
export class SettingsStore {
  private settings: AppSettings;
  /** Names of the one-off corrections already applied to the stored file. */
  private migrations: string[] = [];
  private readonly file: string;
  private readonly keyFile: string;

  constructor(configDir: string) {
    this.file = path.join(configDir, 'settings.json');
    this.keyFile = path.join(configDir, 'credentials.bin');
    this.settings = this.load();
  }

  private load(): AppSettings {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        const settings: AppSettings = {
          ...DEFAULT_SETTINGS,
          ...parsed,
          ai: { ...DEFAULT_SETTINGS.ai, ...(parsed.ai ?? {}), apiKey: undefined },
          customPermissions: { ...DEFAULT_SETTINGS.customPermissions, ...(parsed.customPermissions ?? {}) }
        };
        this.migrations = Array.isArray(parsed.migrations) ? [...parsed.migrations] : [];
        return SettingsStore.migrateOnce(settings, this.migrations);
      }
    } catch (err) {
      log.warn('Could not read settings, using defaults', { reason: (err as Error).message });
    }
    return { ...DEFAULT_SETTINGS };
  }

  /**
   * One-off corrections applied to settings written by an older build. Each
   * one records itself so a deliberate choice by the user is never overridden
   * twice.
   */
  private static migrateOnce(settings: AppSettings, applied: string[]): AppSettings {
    // Reasoning models spend an unpredictable share of their budget thinking,
    // and some gateways answer with nothing when max_tokens exceeds the
    // model's own limit. The old default of 8192/16384 caused both. 0 removes
    // the field from the request entirely.
    if (!applied.includes('unlimited-tokens') && settings.ai.maxTokens > 0) {
      settings = { ...settings, ai: { ...settings.ai, maxTokens: 0 } };
      applied.push('unlimited-tokens');
    }
    return settings;
  }

  private persist(): void {
    const { ai, ...rest } = this.settings;
    const safe = { ...rest, ai: { ...ai, apiKey: undefined }, migrations: this.migrations };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(safe, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /** Settings without the API key — safe to send to the renderer. */
  public(): AppSettings {
    return { ...this.settings, ai: { ...this.settings.ai, apiKey: undefined } };
  }

  /** Settings including the decrypted API key — main process only. */
  withSecrets(): AppSettings {
    return { ...this.settings, ai: { ...this.settings.ai, apiKey: this.getApiKey() ?? undefined } };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const { apiKey, ...aiRest } = patch.ai ?? {};
    this.settings = {
      ...this.settings,
      ...patch,
      ai: { ...this.settings.ai, ...aiRest },
      customPermissions: { ...this.settings.customPermissions, ...(patch.customPermissions ?? {}) }
    };
    if (apiKey) this.setApiKey(apiKey);
    this.persist();
    return this.public();
  }

  setApiKey(key: string): boolean {
    try {
      if (!key) {
        if (fs.existsSync(this.keyFile)) fs.unlinkSync(this.keyFile);
        return true;
      }
      const payload = safeStorage.isEncryptionAvailable()
        ? safeStorage.encryptString(key)
        : Buffer.from(`plain:${key}`, 'utf8');
      fs.writeFileSync(this.keyFile, payload, { mode: 0o600 });
      if (!safeStorage.isEncryptionAvailable()) {
        log.warn('OS encryption is unavailable; the API key is stored with file permissions only.');
      }
      return true;
    } catch (err) {
      log.error('Failed to store API key', { reason: (err as Error).message });
      return false;
    }
  }

  getApiKey(): string | null {
    try {
      if (!fs.existsSync(this.keyFile)) return process.env.NEXUS_API_KEY ?? null;
      const buf = fs.readFileSync(this.keyFile);
      if (buf.subarray(0, 6).toString() === 'plain:') return buf.subarray(6).toString('utf8');
      return safeStorage.decryptString(buf);
    } catch (err) {
      log.error('Failed to read API key', { reason: (err as Error).message });
      return null;
    }
  }

  hasApiKey(): boolean {
    return !!this.getApiKey();
  }

  /** True when a key is present in the encrypted store (not merely in the environment). */
  hasStoredApiKey(): boolean {
    return fs.existsSync(this.keyFile);
  }

  /**
   * Import a pre-provisioned credential on first launch so a deployed machine is
   * ready to work without anyone typing a key into the UI.
   *
   * The key is moved into the OS-encrypted store and the plaintext source is wiped.
   * An existing stored key is never overwritten.
   */
  bootstrapCredentials(resourcesDir?: string): boolean {
    if (this.hasStoredApiKey()) return false;

    const found = resolveBootstrapCredentials({ configDir: path.dirname(this.file), resourcesDir });
    if (!found) return false;

    if (!this.setApiKey(found.apiKey)) return false;

    const ai = { ...this.settings.ai };
    if (found.baseUrl) ai.baseUrl = found.baseUrl;
    if (found.model) ai.model = found.model;
    if (found.provider) ai.provider = found.provider as AppSettings['ai']['provider'];
    this.settings = { ...this.settings, ai, onboardingComplete: true };
    this.persist();

    if (found.wipeAfterImport && found.filePath) wipeBootstrapFile(found.filePath);
    log.info(describeBootstrap(found));
    return true;
  }
}
