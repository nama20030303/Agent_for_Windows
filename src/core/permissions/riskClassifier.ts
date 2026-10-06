import type { RiskLevel } from '../shared/types.js';

export interface CommandClassification {
  risk: RiskLevel;
  blocked: boolean;
  reason: string;
  /** Short label used in the approval card. */
  operation: string;
}

const RISK_ORDER: RiskLevel[] = ['SAFE', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function riskAtLeast(a: RiskLevel, b: RiskLevel): boolean {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b);
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** Commands that are never executed automatically, in any mode. */
const BLOCKED: { re: RegExp; reason: string }[] = [
  { re: /\bformat(\.com)?\s+[a-z]:/i, reason: 'Disk formatting.' },
  { re: /\bdiskpart\b/i, reason: 'Disk partitioning.' },
  { re: /\b(shutdown|restart-computer|stop-computer)\b/i, reason: 'System shutdown / restart.' },
  { re: /\breg(\.exe)?\s+(add|delete|import)\b/i, reason: 'Registry modification.' },
  { re: /\b(new|set|remove)-item(property)?\b[^\n]*\bhk(lm|cu|cr|u|cc):/i, reason: 'Registry modification.' },
  { re: /\bbcdedit\b/i, reason: 'Boot configuration change.' },
  { re: /\bvssadmin\b[^\n]*\bdelete\b/i, reason: 'Shadow copy deletion.' },
  { re: /\bcipher\s+\/w/i, reason: 'Secure disk wipe.' },
  { re: /\bnet\s+user\b[^\n]*\/(add|delete)/i, reason: 'Local account modification.' },
  { re: /\bset-executionpolicy\b/i, reason: 'Security policy change.' },
  { re: /\bnetsh\s+advfirewall\b/i, reason: 'Firewall configuration change.' },
  { re: /\b(mimikatz|lazagne|secretsdump)\b/i, reason: 'Credential extraction tooling.' },
  { re: /get-content[^\n]*\\\.ssh\\id_[a-z0-9]+/i, reason: 'Private key access.' },
  { re: /\brm\s+(-[a-z]*\s+)*-?[a-z]*f?\s*\/(\s|$)/i, reason: 'Recursive delete of filesystem root.' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+~(\/|$)/i, reason: 'Recursive delete of the home directory.' },
  { re: /\bremove-item\b[^\n]*\b-recurse\b[^\n]*\bc:\\(\s|$|")/i, reason: 'Recursive delete of a drive root.' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: 'Fork bomb.' },
  { re: /\bdd\s+if=\S+\s+of=\/dev\/[sh]d/i, reason: 'Raw disk write.' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, reason: 'Filesystem creation (disk wipe).' },
  { re: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(sh|bash|iex|invoke-expression)/i, reason: 'Piping a remote script directly into a shell.' },
  { re: /\binvoke-expression\b[^\n]*\b(downloadstring|invoke-webrequest)\b/i, reason: 'Remote code execution.' }
];

const CRITICAL: { re: RegExp; reason: string }[] = [
  { re: /\bsc(\.exe)?\s+(create|delete|config)\b/i, reason: 'Windows service configuration.' },
  { re: /\bschtasks\b/i, reason: 'Scheduled task modification.' },
  { re: /\bwmic\b/i, reason: 'System management command.' },
  { re: /\bicacls\b|\btakeown\b/i, reason: 'Filesystem permission change.' }
];

const HIGH: { re: RegExp; reason: string }[] = [
  { re: /\b(rm|del|erase|rmdir|rd)\b.*\b-?-?(r|recurse|s)\b/i, reason: 'Recursive deletion.' },
  { re: /\bremove-item\b/i, reason: 'File or directory deletion.' },
  { re: /\brm\b/i, reason: 'File deletion.' },
  { re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/i, reason: 'Destructive or remote Git operation.' },
  { re: /\bdocker\s+(system\s+prune|rm|rmi)\b/i, reason: 'Docker resource deletion.' },
  { re: /\bdrop\s+(table|database)\b/i, reason: 'Destructive database statement.' },
  { re: /\bnpm\s+publish\b|\btwine\s+upload\b/i, reason: 'Package publication.' }
];

const MEDIUM: { re: RegExp; reason: string }[] = [
  { re: /\bgit\s+(commit|checkout|switch|merge|rebase|stash|branch\s+-[dD])\b/i, reason: 'Repository state change.' },
  { re: /\bmv\b|\bmove-item\b|\bren(ame)?\b/i, reason: 'File move / rename.' },
  { re: /\b(uvicorn|flask|node|npm\s+run\s+dev|npm\s+start|dotnet\s+run|python)\b/i, reason: 'Starts a long-running process.' },
  { re: /\bdocker\s+(build|run|compose)\b/i, reason: 'Container operation.' },
  { re: /\bsetx?\b|\$env:/i, reason: 'Environment variable change.' }
];

const LOW: { re: RegExp; reason: string }[] = [
  { re: /\b(npm|pnpm|yarn)\s+(install|i|add|ci)\b/i, reason: 'Installs dependencies from a package registry.' },
  { re: /\bpip3?\s+install\b|\buv\s+(pip\s+)?(install|add|sync)\b|\bpoetry\s+(add|install)\b/i, reason: 'Installs Python dependencies.' },
  { re: /\bdotnet\s+(add|restore)\b|\bcargo\s+(add|fetch)\b|\bgo\s+(get|mod)\b/i, reason: 'Installs dependencies.' },
  { re: /\bmkdir\b|\bnew-item\b/i, reason: 'Creates files or directories.' },
  { re: /\b(curl|wget|invoke-webrequest|iwr)\b/i, reason: 'Network request.' },
  { re: /\bgit\s+(add|init|fetch|pull)\b/i, reason: 'Local repository update.' },
  { re: /\balembic\b|\bprisma\s+migrate\b|\bdjango-admin\b|\bmanage\.py\b/i, reason: 'Database migration.' }
];

const SAFE: RegExp[] = [
  /^\s*(python|python3|node|npm|git|dotnet|java|go|cargo|rustc|pwsh|powershell)\s+(-v|--version|version)\s*$/i,
  /^\s*git\s+(status|diff|log|branch|show|remote\s+-v)\b/i,
  /^\s*(pytest|npm\s+test|npm\s+run\s+test|vitest\s+run|jest|dotnet\s+test|cargo\s+test|go\s+test)\b/i,
  /^\s*(ruff|flake8|eslint|mypy|tsc|black\s+--check|prettier\s+--check)\b/i,
  /^\s*(ls|dir|get-childitem|gci|pwd|cat|type|get-content|echo|where|which|get-command|whoami|hostname)\b/i,
  /^\s*(npm\s+run\s+build|npm\s+run\s+lint|tsc\s+--noemit|dotnet\s+build|cargo\s+build|go\s+build)\b/i
];

/** Chained / obfuscated command detection. */
function splitSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\n|\|)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function classifyCommand(rawCommand: string): CommandClassification {
  const command = (rawCommand ?? '').trim();
  if (!command) {
    return { risk: 'CRITICAL', blocked: true, reason: 'Empty command.', operation: 'execute_command' };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(command)) {
    return { risk: 'CRITICAL', blocked: true, reason: 'Command contains control characters.', operation: 'execute_command' };
  }
  if (/-enc(odedcommand)?\s+[A-Za-z0-9+/=]{20,}/i.test(command)) {
    return { risk: 'CRITICAL', blocked: true, reason: 'Base64-encoded PowerShell command.', operation: 'execute_command' };
  }

  for (const { re, reason } of BLOCKED) {
    if (re.test(command)) {
      return { risk: 'CRITICAL', blocked: true, reason, operation: 'execute_command' };
    }
  }

  const segments = splitSegments(command);
  let risk: RiskLevel = 'SAFE';
  let reason = 'Routine development command.';

  for (const segment of segments) {
    for (const { re, reason: r } of BLOCKED) {
      if (re.test(segment)) {
        return { risk: 'CRITICAL', blocked: true, reason: r, operation: 'execute_command' };
      }
    }
    if (SAFE.some((re) => re.test(segment))) continue;
    let segRisk: RiskLevel = 'SAFE';
    let segReason = reason;
    const table: [RiskLevel, { re: RegExp; reason: string }[]][] = [
      ['CRITICAL', CRITICAL],
      ['HIGH', HIGH],
      ['MEDIUM', MEDIUM],
      ['LOW', LOW]
    ];
    for (const [level, rules] of table) {
      const hit = rules.find((rule) => rule.re.test(segment));
      if (hit) {
        segRisk = level;
        segReason = hit.reason;
        break;
      }
    }
    if (segRisk === 'SAFE') {
      // Unknown command: treat conservatively.
      segRisk = 'MEDIUM';
      segReason = 'Unrecognised command — reviewed as medium risk.';
    }
    if (riskAtLeast(segRisk, risk)) {
      risk = segRisk;
      reason = segReason;
    }
  }

  if (segments.length > 1 && riskAtLeast(risk, 'LOW')) {
    reason += ' (chained command)';
  }

  return { risk, blocked: false, reason, operation: 'execute_command' };
}
