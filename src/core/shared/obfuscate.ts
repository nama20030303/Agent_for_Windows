import crypto from 'node:crypto';

/**
 * Obfuscation for a credential embedded in a distributed build.
 *
 * THIS IS NOT ENCRYPTION IN THE SECURITY SENSE. The application must be able to
 * decrypt the value unattended, so the derivation secret ships inside the same
 * binary. What this buys:
 *   - the key is not recoverable with `strings` or a text editor;
 *   - automated secret scanners do not match it;
 *   - a casual reader of the install directory sees nothing useful.
 * What it does not buy: resistance to anyone who inspects the program. Treat an
 * embedded credential as disclosed to every recipient of the installer.
 *
 * Only ever used for build-time pre-provisioning. At rest on the user's machine
 * the key is held by the OS keystore (DPAPI) instead — see SettingsStore.
 */
const DERIVATION_LABEL = 'NexusCode/embedded-credential/v1';
const ALGORITHM = 'aes-256-gcm';

function derivedKey(): Buffer {
  return crypto.createHash('sha256').update(DERIVATION_LABEL).digest();
}

/** Encode a secret into a single base64 token: iv | authTag | ciphertext. */
export function obfuscateSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Decode a token produced by {@link obfuscateSecret}. Returns null if it is not one. */
export function deobfuscateSecret(token: string): string | null {
  try {
    const raw = Buffer.from(token, 'base64');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
