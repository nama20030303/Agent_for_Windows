import type { ErrorType } from '../shared/types.js';

interface Rule {
  type: ErrorType;
  re: RegExp;
}

const RULES: Rule[] = [
  { type: 'DEPENDENCY_ERROR', re: /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND|npm ERR! 404|could not find a version|unable to resolve dependency|package .* is not installed/i },
  { type: 'IMPORT_ERROR', re: /ImportError|cannot import name|has no exported member|is not exported from|unresolved import|undefined reference to/i },
  { type: 'SYNTAX_ERROR', re: /SyntaxError|IndentationError|Unexpected token|Parsing error|expected .* but found|TS1\d{3}/i },
  { type: 'BUILD_ERROR', re: /build failed|compilation (failed|error)|error TS\d+|tsc .*error|webpack .*error|MSB\d{4}|cargo build .*error/i },
  { type: 'TEST_FAILURE', re: /\d+ (failed|failing)|AssertionError|Test Failed|FAILED .*::|expect\(.*\)\.to|assert .*==/i },
  { type: 'DATABASE_ERROR', re: /OperationalError|could not connect to server|psycopg2|sqlite3\.|database is locked|relation .* does not exist|ECONNREFUSED.*5432/i },
  { type: 'NETWORK_ERROR', re: /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|network is unreachable|SSL.*certificate|proxy/i },
  { type: 'PERMISSION_ERROR', re: /EACCES|EPERM|Permission denied|Access is denied|UnauthorizedAccessException/i },
  { type: 'CONFIGURATION_ERROR', re: /config(uration)? (error|invalid)|missing environment variable|KeyError: '[A-Z_]+'|\.env|invalid .*config/i },
  { type: 'ENVIRONMENT_ERROR', re: /command not found|is not recognized as (an internal|the name)|CommandNotFoundException|No such file or directory|python was not found|address already in use|EADDRINUSE/i },
  { type: 'RUNTIME_ERROR', re: /Traceback \(most recent call last\)|Unhandled exception|TypeError|ValueError|NullReferenceException|panicked at|segmentation fault/i }
];

/** Best-effort classification of a command output into a known error category. */
export function classifyErrorFromOutput(output: string, timedOut = false): ErrorType {
  if (timedOut) return 'ENVIRONMENT_ERROR';
  const text = output ?? '';
  for (const rule of RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return 'UNKNOWN_ERROR';
}

/** Short, actionable hint used to steer the repair loop. */
export function repairHint(type: ErrorType): string {
  switch (type) {
    case 'DEPENDENCY_ERROR':
      return 'A package is missing. Check the dependency manifest, then install the dependency with the project package manager (requires approval).';
    case 'IMPORT_ERROR':
      return 'An import target is wrong or missing. Inspect the importing file and the module it references.';
    case 'SYNTAX_ERROR':
      return 'Open the reported file and line and fix the syntax.';
    case 'BUILD_ERROR':
      return 'Read the first compiler error; later errors are often cascading.';
    case 'TEST_FAILURE':
      return 'Read the failing assertion, inspect the code under test, then fix the implementation or the test if the expectation is wrong.';
    case 'DATABASE_ERROR':
      return 'Check the connection string, whether the database file/server exists, and whether migrations were applied.';
    case 'NETWORK_ERROR':
      return 'Check whether the target service is running and reachable; distinguish registry failures from application failures.';
    case 'PERMISSION_ERROR':
      return 'The operation was denied by the OS or by the permission system; do not retry blindly.';
    case 'CONFIGURATION_ERROR':
      return 'A configuration value or environment variable is missing or invalid.';
    case 'ENVIRONMENT_ERROR':
      return 'A required tool is missing from PATH, or a port is occupied. Verify the environment before retrying.';
    case 'ARCHITECTURE_ERROR':
      return 'The failure reflects a design conflict — this usually needs a user decision.';
    default:
      return 'Cause unknown. Inspect the command output, relevant files, logs and environment before changing code.';
  }
}
