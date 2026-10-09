/**
 * Secret detection and redaction.
 * Applied to logs, UI output and model context.
 */

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    name: 'assignment',
    re: /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|ACCESS[_-]?KEY|CLIENT[_-]?SECRET)[A-Z0-9_]*)\s*[:=]\s*["']?([^\s"';,]{6,})["']?/gi
  }
];

export const REDACTION = '************';

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    out =
      name === 'assignment'
        ? out.replace(re, (match, key: string, value: string) =>
            // A plain number is a count, not a credential. Without this, a
            // line like "Tokens: 184203 in" was redacted in the diagnostics
            // report and the reader lost real information for nothing.
            /^[0-9]+$/.test(value) ? match : `${key}=${REDACTION}`
          )
        : out.replace(re, REDACTION);
  }
  return out;
}

export function containsSecret(input: string): boolean {
  if (!input) return false;
  return PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(input);
  });
}

/** File names that are never sent to the model unless the user explicitly opens them. */
const SENSITIVE_FILE_RE =
  /(^|[\\/])(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.pfx|.*\.key|credentials|\.npmrc|\.pypirc|secrets?\.(json|ya?ml|toml))$/i;

export function isSensitiveFile(path: string): boolean {
  return SENSITIVE_FILE_RE.test(path.replace(/\\/g, '/'));
}
