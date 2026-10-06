import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';

export interface DetectedCommands {
  test?: string;
  build?: string;
  lint?: string;
  format?: string;
  typecheck?: string;
  syntax?: string;
  run?: string;
  framework: string;
  cwd: string;
}

async function readJson(file: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function pythonPrefix(root: string): string {
  if (process.platform === 'win32') {
    if (fssync.existsSync(path.join(root, '.venv', 'Scripts', 'python.exe'))) return '.venv\\Scripts\\python.exe';
    if (fssync.existsSync(path.join(root, 'venv', 'Scripts', 'python.exe'))) return 'venv\\Scripts\\python.exe';
    return 'python';
  }
  if (fssync.existsSync(path.join(root, '.venv', 'bin', 'python'))) return '.venv/bin/python';
  if (fssync.existsSync(path.join(root, 'venv', 'bin', 'python'))) return 'venv/bin/python';
  return 'python3';
}

/**
 * Inspect a project directory and derive the real verification commands.
 * Nothing is invented: a command is only returned when the corresponding
 * manifest / configuration actually exists.
 */
export async function detectProjectCommands(root: string): Promise<DetectedCommands[]> {
  const found: DetectedCommands[] = [];
  const exists = (p: string) => fssync.existsSync(path.join(root, p));

  // Node / TypeScript
  const pkg = await readJson(path.join(root, 'package.json'));
  if (pkg) {
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const pm = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : 'npm';
    const runner = pm === 'npm' ? 'npm run' : pm;
    found.push({
      framework: `node (${pm})`,
      cwd: '.',
      test: scripts.test ? `${runner} test` : undefined,
      build: scripts.build ? `${runner} build` : undefined,
      lint: scripts.lint ? `${runner} lint` : undefined,
      format: scripts.format ? `${runner} format` : undefined,
      typecheck: scripts.typecheck
        ? `${runner} typecheck`
        : exists('tsconfig.json')
          ? 'npx --no-install tsc --noEmit'
          : undefined,
      run: scripts.dev ? `${runner} dev` : scripts.start ? `${runner} start` : undefined
    });
  }

  // Python
  if (exists('pyproject.toml') || exists('requirements.txt') || exists('setup.py') || exists('tests') || exists('manage.py')) {
    const py = pythonPrefix(root);
    const pyproject = exists('pyproject.toml') ? await fs.readFile(path.join(root, 'pyproject.toml'), 'utf8') : '';
    found.push({
      framework: 'python',
      cwd: '.',
      test: `${py} -m pytest -q`,
      syntax: `${py} -m compileall -q .`,
      lint: /ruff/.test(pyproject) || exists('ruff.toml') || exists('.ruff.toml') ? `${py} -m ruff check .` : undefined,
      typecheck: /mypy/.test(pyproject) || exists('mypy.ini') ? `${py} -m mypy .` : undefined,
      format: /black/.test(pyproject) ? `${py} -m black --check .` : undefined,
      run: exists('manage.py') ? `${py} manage.py runserver` : exists('main.py') ? `${py} main.py` : undefined
    });
  }

  // .NET
  const csproj = fssync.existsSync(root)
    ? (await fs.readdir(root).catch(() => [] as string[])).filter((f) => f.endsWith('.csproj') || f.endsWith('.sln'))
    : [];
  if (csproj.length) {
    found.push({ framework: 'dotnet', cwd: '.', build: 'dotnet build', test: 'dotnet test', run: 'dotnet run' });
  }

  // Rust
  if (exists('Cargo.toml')) {
    found.push({ framework: 'rust', cwd: '.', build: 'cargo build', test: 'cargo test', lint: 'cargo clippy', format: 'cargo fmt --check', run: 'cargo run' });
  }

  // Go
  if (exists('go.mod')) {
    found.push({ framework: 'go', cwd: '.', build: 'go build ./...', test: 'go test ./...', format: 'gofmt -l .', run: 'go run .' });
  }

  // Java
  if (exists('pom.xml')) found.push({ framework: 'maven', cwd: '.', build: 'mvn -q compile', test: 'mvn -q test' });
  if (exists('build.gradle') || exists('build.gradle.kts')) found.push({ framework: 'gradle', cwd: '.', build: 'gradle build', test: 'gradle test' });

  // Nested common layouts (backend/, frontend/, server/, client/, api/, web/)
  for (const sub of ['backend', 'frontend', 'server', 'client', 'api', 'web', 'src']) {
    const dir = path.join(root, sub);
    if (!fssync.existsSync(dir)) continue;
    const hasManifest =
      fssync.existsSync(path.join(dir, 'package.json')) ||
      fssync.existsSync(path.join(dir, 'pyproject.toml')) ||
      fssync.existsSync(path.join(dir, 'requirements.txt'));
    if (!hasManifest) continue;
    const nested = await detectProjectCommands(dir);
    for (const n of nested) found.push({ ...n, cwd: sub, framework: `${n.framework} @ ${sub}` });
  }

  return found;
}
