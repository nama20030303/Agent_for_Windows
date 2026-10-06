import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from '../permissions/pathGuard.js';
import { defineTool, fail, ok, schema, str, num, type Tool } from './types.js';
import { isIgnoredDir } from './filesystem.js';
import { isSensitiveFile, redactSecrets } from '../shared/secrets.js';

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.c', '.h', '.hpp',
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.md', '.txt', '.html', '.css', '.scss', '.sql', '.ps1', '.sh',
  '.xml', '.csproj', '.gradle', '.env.example', '.vue', '.svelte', '.php'
]);

export async function walkFiles(
  root: string,
  options: { maxFiles?: number; includeExt?: Set<string> } = {}
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 20000;
  const result: string[] = [];
  const stack: string[] = [root];
  while (stack.length && result.length < maxFiles) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        stack.push(abs);
      } else if (entry.isFile()) {
        if (options.includeExt && !options.includeExt.has(path.extname(entry.name).toLowerCase())) continue;
        result.push(abs);
        if (result.length >= maxFiles) break;
      }
    }
  }
  return result;
}

/** Minimal glob → RegExp translation supporting *, ** and ?. */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        out += slashAfter ? '(?:[^/]*/)*' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

export const searchFiles = defineTool(
  {
    name: 'search_files',
    description: 'Find files by glob pattern (for example "src/**/*.py").',
    category: 'search',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ pattern: str('Glob pattern relative to the workspace root.'), max_results: num('Maximum results (default 200).') }, ['pattern'])
  },
  async (args, ctx) => {
    const pattern = String(args.pattern);
    const limit = typeof args.max_results === 'number' ? args.max_results : 200;
    const re = globToRegExp(pattern.replace(/\\/g, '/'));
    const files = await walkFiles(ctx.workspaceRoot);
    const matches = files
      .map((abs) => path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/'))
      .filter((rel) => re.test(rel) || re.test(path.basename(rel)))
      .slice(0, limit);
    return ok('search_files', { data: matches, summary: `${matches.length} files match ${pattern}` });
  },
  (a) => `Search files "${a.pattern}"`
);

export const searchText = defineTool(
  {
    name: 'search_text',
    description: 'Search file contents for a regular expression and return matching lines with file:line references.',
    category: 'search',
    risk: 'SAFE',
    mutating: false,
    parameters: schema(
      {
        query: str('Regular expression or literal text.'),
        path: str('Optional sub-directory to search.'),
        max_results: num('Maximum matches (default 100).')
      },
      ['query']
    )
  },
  async (args, ctx) => {
    const base = resolveWorkspacePath(ctx.workspaceRoot, String(args.path ?? '.'));
    if (!base.ok) return fail('search_text', base.reason!);
    const limit = typeof args.max_results === 'number' ? args.max_results : 100;
    let re: RegExp;
    try {
      re = new RegExp(String(args.query), 'i');
    } catch {
      re = new RegExp(String(args.query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }
    const files = await walkFiles(base.absolute, { includeExt: TEXT_EXT });
    const matches: { path: string; line: number; text: string }[] = [];
    for (const abs of files) {
      if (matches.length >= limit) break;
      let content: string;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > 2_000_000) continue;
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const rel = path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < limit; i++) {
        if (re.test(lines[i])) {
          const text = isSensitiveFile(rel) ? redactSecrets(lines[i]) : lines[i];
          matches.push({ path: rel, line: i + 1, text: text.trim().slice(0, 300) });
        }
      }
    }
    return ok('search_text', {
      data: matches,
      summary: `${matches.length} matches for /${args.query}/`,
      stdout: matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n')
    });
  },
  (a) => `Search "${a.query}"`
);

const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
  /^\s*def\s+([A-Za-z_][\w]*)/,
  /^\s*class\s+([A-Za-z_][\w]*)/,
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?[\w<>,\[\]]+\s+([A-Za-z_][\w]*)\s*\(/,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/
];

export function extractSymbols(content: string): { name: string; line: number }[] {
  const out: { name: string; line: number }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of SYMBOL_PATTERNS) {
      const m = re.exec(lines[i]);
      if (m?.[1]) {
        out.push({ name: m[1], line: i + 1 });
        break;
      }
    }
  }
  return out;
}

export const findSymbol = defineTool(
  {
    name: 'find_symbol',
    description: 'Find where a function, class, type or method is defined.',
    category: 'search',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ name: str('Symbol name.') }, ['name'])
  },
  async (args, ctx) => {
    const name = String(args.name);
    const files = await walkFiles(ctx.workspaceRoot, { includeExt: TEXT_EXT });
    const hits: { path: string; line: number; text: string }[] = [];
    for (const abs of files) {
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (!content.includes(name)) continue;
      const rel = path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/');
      for (const sym of extractSymbols(content)) {
        if (sym.name === name) {
          hits.push({ path: rel, line: sym.line, text: content.split('\n')[sym.line - 1].trim().slice(0, 200) });
        }
      }
    }
    return ok('find_symbol', {
      data: hits,
      summary: `${hits.length} definitions of ${name}`,
      stdout: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
    });
  },
  (a) => `Find symbol ${a.name}`
);

export const findReferences = defineTool(
  {
    name: 'find_references',
    description: 'Find usages of a symbol across the workspace.',
    category: 'search',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ name: str('Symbol name.'), max_results: num('Maximum matches (default 100).') }, ['name'])
  },
  async (args, ctx) => {
    const name = String(args.name);
    const limit = typeof args.max_results === 'number' ? args.max_results : 100;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const files = await walkFiles(ctx.workspaceRoot, { includeExt: TEXT_EXT });
    const hits: { path: string; line: number; text: string }[] = [];
    for (const abs of files) {
      if (hits.length >= limit) break;
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (!re.test(content)) continue;
      const rel = path.relative(ctx.workspaceRoot, abs).split(path.sep).join('/');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && hits.length < limit; i++) {
        if (re.test(lines[i])) hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
    return ok('find_references', {
      data: hits,
      summary: `${hits.length} references to ${name}`,
      stdout: hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
    });
  },
  (a) => `Find references to ${a.name}`
);

export const searchTools: Tool[] = [searchFiles, searchText, findSymbol, findReferences];
