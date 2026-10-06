import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import type { IndexedFile, ProjectIndex } from '../shared/types.js';
import { walkFiles, extractSymbols } from '../tools/search.js';
import { createLogger } from '../shared/logger.js';
import { nowIso } from '../shared/ids.js';

const log = createLogger('indexer');

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript',
  '.cjs': 'JavaScript', '.py': 'Python', '.cs': 'C#', '.java': 'Java', '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++',
  '.c': 'C', '.h': 'C', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.html': 'HTML', '.css': 'CSS',
  '.scss': 'CSS', '.sql': 'SQL', '.ps1': 'PowerShell', '.sh': 'Shell', '.md': 'Markdown', '.json': 'JSON',
  '.yml': 'YAML', '.yaml': 'YAML', '.toml': 'TOML', '.vue': 'Vue', '.svelte': 'Svelte', '.kt': 'Kotlin', '.swift': 'Swift'
};

const SYMBOL_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.cs', '.go', '.rs', '.java']);

interface FrameworkRule {
  name: string;
  file?: string;
  contains?: RegExp;
}

const FRAMEWORK_RULES: FrameworkRule[] = [
  { name: 'FastAPI', file: 'requirements.txt', contains: /fastapi/i },
  { name: 'FastAPI', file: 'pyproject.toml', contains: /fastapi/i },
  { name: 'Django', file: 'requirements.txt', contains: /^django/im },
  { name: 'Flask', file: 'requirements.txt', contains: /flask/i },
  { name: 'SQLAlchemy', file: 'requirements.txt', contains: /sqlalchemy/i },
  { name: 'pytest', file: 'pyproject.toml', contains: /pytest/i },
  { name: 'React', file: 'package.json', contains: /"react"\s*:/ },
  { name: 'Next.js', file: 'package.json', contains: /"next"\s*:/ },
  { name: 'Vue', file: 'package.json', contains: /"vue"\s*:/ },
  { name: 'Svelte', file: 'package.json', contains: /"svelte"\s*:/ },
  { name: 'Express', file: 'package.json', contains: /"express"\s*:/ },
  { name: 'NestJS', file: 'package.json', contains: /"@nestjs\/core"\s*:/ },
  { name: 'Vite', file: 'package.json', contains: /"vite"\s*:/ },
  { name: 'Electron', file: 'package.json', contains: /"electron"\s*:/ },
  { name: 'Tauri', file: 'package.json', contains: /"@tauri-apps\/api"\s*:/ },
  { name: 'Docker', file: 'docker-compose.yml' },
  { name: 'Docker', file: 'Dockerfile' },
  { name: '.NET', file: 'global.json' },
  { name: 'Spring', file: 'pom.xml', contains: /springframework/i }
];

const MANIFESTS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Cargo.toml', 'go.mod', 'pom.xml',
  'build.gradle', 'docker-compose.yml', 'Dockerfile', 'composer.json', 'Gemfile'
];

export interface IndexOptions {
  maxFiles?: number;
  maxSymbolFiles?: number;
}

export class ProjectIndexer {
  private cache = new Map<string, { index: ProjectIndex; mtimes: Map<string, number> }>();

  async index(root: string, options: IndexOptions = {}): Promise<ProjectIndex> {
    const started = Date.now();
    const maxFiles = options.maxFiles ?? 8000;
    const maxSymbolFiles = options.maxSymbolFiles ?? 400;
    const absFiles = await walkFiles(root, { maxFiles: maxFiles + 1 });
    const truncated = absFiles.length > maxFiles;
    const list = absFiles.slice(0, maxFiles);

    const files: IndexedFile[] = [];
    const languages: Record<string, number> = {};
    let totalBytes = 0;
    let symbolBudget = maxSymbolFiles;

    for (const abs of list) {
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const ext = path.extname(abs).toLowerCase();
      const language = LANGUAGE_BY_EXT[ext];
      if (language) languages[language] = (languages[language] ?? 0) + 1;
      totalBytes += stat.size;

      const file: IndexedFile = { path: rel, ext, size: stat.size, mtimeMs: stat.mtimeMs, language };
      if (symbolBudget > 0 && SYMBOL_EXT.has(ext) && stat.size < 300_000) {
        try {
          const content = await fs.readFile(abs, 'utf8');
          file.lines = content.split('\n').length;
          file.symbols = [...new Set(extractSymbols(content).map((s) => s.name))].slice(0, 40);
          symbolBudget--;
        } catch {
          /* unreadable file */
        }
      }
      files.push(file);
    }

    const frameworks = await this.detectFrameworks(root);
    const packageManagers = MANIFESTS.filter((m) => fssync.existsSync(path.join(root, m)));
    const testFrameworks = await this.detectTestFrameworks(root);

    const index: ProjectIndex = {
      root,
      generatedAt: nowIso(),
      fileCount: files.length,
      totalBytes,
      truncated,
      languages,
      frameworks,
      packageManagers,
      testFrameworks,
      entryPoints: this.detectEntryPoints(files),
      hasGit: fssync.existsSync(path.join(root, '.git')),
      files,
      tree: buildTree(files.map((f) => f.path))
    };

    this.cache.set(root, { index, mtimes: new Map(files.map((f) => [f.path, f.mtimeMs])) });
    log.info('Project indexed', { root, files: files.length, ms: Date.now() - started, truncated });
    return index;
  }

  /** Incremental refresh: only re-reads files whose mtime changed. */
  async refresh(root: string): Promise<ProjectIndex> {
    const cached = this.cache.get(root);
    if (!cached) return this.index(root);
    const absFiles = await walkFiles(root, { maxFiles: 8000 });
    let changed = absFiles.length !== cached.index.fileCount;
    if (!changed) {
      for (const abs of absFiles) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        const previous = cached.mtimes.get(rel);
        let stat;
        try {
          stat = await fs.stat(abs);
        } catch {
          continue;
        }
        if (previous === undefined || previous !== stat.mtimeMs) {
          changed = true;
          break;
        }
      }
    }
    return changed ? this.index(root) : cached.index;
  }

  get(root: string): ProjectIndex | undefined {
    return this.cache.get(root)?.index;
  }

  private async detectFrameworks(root: string): Promise<string[]> {
    const found = new Set<string>();
    for (const rule of FRAMEWORK_RULES) {
      const file = path.join(root, rule.file ?? '');
      if (!rule.file || !fssync.existsSync(file)) continue;
      if (!rule.contains) {
        found.add(rule.name);
        continue;
      }
      try {
        const content = await fs.readFile(file, 'utf8');
        if (rule.contains.test(content)) found.add(rule.name);
      } catch {
        /* ignore */
      }
    }
    return [...found];
  }

  private async detectTestFrameworks(root: string): Promise<string[]> {
    const found = new Set<string>();
    const pkgPath = path.join(root, 'package.json');
    if (fssync.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const name of ['vitest', 'jest', 'mocha', 'playwright', '@playwright/test', 'cypress']) {
          if (deps[name]) found.add(name);
        }
        if (pkg.scripts?.test) found.add('npm test');
      } catch {
        /* ignore */
      }
    }
    for (const f of ['pytest.ini', 'tox.ini', 'conftest.py']) {
      if (fssync.existsSync(path.join(root, f))) found.add('pytest');
    }
    if (fssync.existsSync(path.join(root, 'pyproject.toml'))) {
      const content = await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8').catch(() => '');
      if (/pytest/.test(content)) found.add('pytest');
    }
    if (fssync.existsSync(path.join(root, 'tests')) || fssync.existsSync(path.join(root, 'test'))) found.add('tests directory');
    return [...found];
  }

  private detectEntryPoints(files: IndexedFile[]): string[] {
    const candidates = [
      'main.py', 'app.py', 'manage.py', 'src/main.ts', 'src/index.ts', 'src/main.tsx', 'index.js', 'server.js',
      'src/main.rs', 'main.go', 'Program.cs', 'app/main.py', 'backend/main.py'
    ];
    return files.filter((f) => candidates.includes(f.path)).map((f) => f.path);
  }
}

/** Compact ASCII tree, directories first, truncated per level. */
export function buildTree(paths: string[], maxEntriesPerDir = 25): string {
  interface Node {
    children: Map<string, Node>;
    isFile: boolean;
  }
  const root: Node = { children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { children: new Map(), isFile: i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  const lines: string[] = [];
  const render = (node: Node, prefix: string, depth: number) => {
    if (depth > 4) return;
    const entries = [...node.children.entries()].sort((a, b) => {
      const aDir = a[1].children.size > 0 ? 0 : 1;
      const bDir = b[1].children.size > 0 ? 0 : 1;
      return aDir - bDir || a[0].localeCompare(b[0]);
    });
    const shown = entries.slice(0, maxEntriesPerDir);
    shown.forEach(([name, child], i) => {
      const last = i === shown.length - 1 && entries.length <= maxEntriesPerDir;
      lines.push(`${prefix}${last ? '└── ' : '├── '}${name}${child.children.size ? '/' : ''}`);
      if (child.children.size) render(child, `${prefix}${last ? '    ' : '│   '}`, depth + 1);
    });
    if (entries.length > maxEntriesPerDir) {
      lines.push(`${prefix}└── … ${entries.length - maxEntriesPerDir} more`);
    }
  };
  render(root, '', 0);
  return lines.join('\n');
}
