import { GitManager } from '../git/gitManager.js';
import { defineTool, fail, ok, schema, str, num, bool, type Tool, type ToolContext } from './types.js';

function gm(ctx: ToolContext): GitManager {
  return new GitManager(ctx.workspaceRoot);
}

export const gitStatus = defineTool(
  {
    name: 'git_status',
    description: 'Show the Git status of the workspace.',
    category: 'git',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({})
  },
  async (_a, ctx) => {
    const status = await gm(ctx).status();
    return ok('git_status', {
      data: status,
      summary: status.isRepo
        ? `${status.branch ?? 'detached'} — ${status.modified.length} modified, ${status.staged.length} staged, ${status.untracked.length} untracked`
        : 'Not a Git repository.'
    });
  },
  () => 'git status'
);

export const gitDiff = defineTool(
  {
    name: 'git_diff',
    description: 'Show the diff of working-tree or staged changes.',
    category: 'git',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ path: str('Limit the diff to a path.'), staged: bool('Show staged changes.') })
  },
  async (args, ctx) => {
    const res = await gm(ctx).diff(args.path ? String(args.path) : undefined, args.staged === true);
    return res.ok
      ? ok('git_diff', { stdout: res.stdout.slice(0, 40_000), summary: `diff (${res.stdout.split('\n').length} lines)` })
      : fail('git_diff', res.stderr || 'git diff failed');
  },
  () => 'git diff'
);

export const gitLog = defineTool(
  {
    name: 'git_log',
    description: 'Show recent commits.',
    category: 'git',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({ limit: num('Number of commits (default 20).') })
  },
  async (args, ctx) => {
    const res = await gm(ctx).log(Number(args.limit ?? 20));
    return res.ok ? ok('git_log', { stdout: res.stdout, summary: 'Recent commits' }) : fail('git_log', res.stderr);
  },
  () => 'git log'
);

export const gitBranch = defineTool(
  {
    name: 'git_branch',
    description: 'List local branches.',
    category: 'git',
    risk: 'SAFE',
    mutating: false,
    parameters: schema({})
  },
  async (_a, ctx) => {
    const res = await gm(ctx).branches();
    return res.ok ? ok('git_branch', { stdout: res.stdout, summary: 'Branches' }) : fail('git_branch', res.stderr);
  },
  () => 'git branch'
);

export const gitAdd = defineTool(
  {
    name: 'git_add',
    description: 'Stage files.',
    category: 'git',
    risk: 'LOW',
    mutating: true,
    parameters: schema({ paths: { type: 'array', items: { type: 'string' }, description: 'Paths to stage.' } }, ['paths'])
  },
  async (args, ctx) => {
    const paths = (args.paths as string[]) ?? [];
    if (!paths.length) return fail('git_add', 'No paths provided.');
    if (paths.some((p) => typeof p !== 'string' || p.includes('..'))) return fail('git_add', 'Invalid path in list.');
    const res = await gm(ctx).add(paths);
    return res.ok ? ok('git_add', { summary: `Staged ${paths.length} path(s)` }) : fail('git_add', res.stderr);
  },
  (a) => `git add ${(a.paths as string[])?.join(' ')}`
);

export const gitCommit = defineTool(
  {
    name: 'git_commit',
    description: 'Create a commit from staged changes.',
    category: 'git',
    risk: 'MEDIUM',
    mutating: true,
    parameters: schema({ message: str('Commit message.') }, ['message'])
  },
  async (args, ctx) => {
    const res = await gm(ctx).commit(String(args.message));
    return res.ok
      ? ok('git_commit', { stdout: res.stdout, summary: 'Commit created' })
      : fail('git_commit', res.stderr || res.stdout);
  },
  (a) => `git commit -m "${a.message}"`
);

export const gitCheckout = defineTool(
  {
    name: 'git_checkout',
    description: 'Switch to a branch or commit (optionally creating the branch).',
    category: 'git',
    risk: 'MEDIUM',
    mutating: true,
    parameters: schema({ ref: str('Branch or commit.'), create: bool('Create a new branch.') }, ['ref'])
  },
  async (args, ctx) => {
    const res = await gm(ctx).checkout(String(args.ref), args.create === true);
    return res.ok ? ok('git_checkout', { stdout: res.stdout, summary: `Checked out ${args.ref}` }) : fail('git_checkout', res.stderr);
  },
  (a) => `git checkout ${a.ref}`
);

export const gitPull = defineTool(
  {
    name: 'git_pull',
    description: 'Pull from the remote (always requires explicit approval).',
    category: 'git',
    risk: 'HIGH',
    mutating: true,
    parameters: schema({})
  },
  async (_a, ctx) => {
    const res = await gm(ctx).pull();
    return res.ok ? ok('git_pull', { stdout: res.stdout, summary: 'Pulled' }) : fail('git_pull', res.stderr, { errorType: 'NETWORK_ERROR' });
  },
  () => 'git pull'
);

export const gitPush = defineTool(
  {
    name: 'git_push',
    description: 'Push to the remote (always requires explicit approval).',
    category: 'git',
    risk: 'HIGH',
    mutating: true,
    parameters: schema({})
  },
  async (_a, ctx) => {
    const res = await gm(ctx).push();
    return res.ok ? ok('git_push', { stdout: res.stdout, summary: 'Pushed' }) : fail('git_push', res.stderr, { errorType: 'NETWORK_ERROR' });
  },
  () => 'git push'
);

export const gitTools: Tool[] = [gitStatus, gitDiff, gitLog, gitBranch, gitAdd, gitCommit, gitCheckout, gitPull, gitPush];
