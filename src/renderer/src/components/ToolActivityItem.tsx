import { useState } from 'react';
import type { ToolActivity } from '../state/store.js';
import { DiffView, diffStats } from './DiffView.js';

const ICON: Record<string, string> = {
  read_file: '▸',
  write_file: '✎',
  edit_file: '✎',
  delete_file: '✕',
  list_directory: '▤',
  search_text: '⌕',
  search_files: '⌕',
  find_symbol: '⌕',
  find_references: '⌕',
  execute_command: '›',
  run_tests: '✓',
  run_build: '⚙',
  start_process: '▶',
  git_status: '⑂',
  git_diff: '⑂',
  git_commit: '⑂',
  http_check: '⇄'
};

function label(activity: ToolActivity): string {
  const { call } = activity;
  const a = call.arguments as Record<string, any>;
  switch (call.name) {
    case 'read_file':
      return `Reading ${a.path}`;
    case 'write_file':
      return `Writing ${a.path}`;
    case 'edit_file':
      return `Editing ${a.path}`;
    case 'delete_file':
      return `Deleting ${a.path}`;
    case 'create_directory':
      return `Creating ${a.path}`;
    case 'list_directory':
      return `Listing ${a.path ?? '.'}`;
    case 'search_text':
      return `Searching "${a.query}"`;
    case 'search_files':
      return `Finding files "${a.pattern}"`;
    case 'find_symbol':
      return `Looking up ${a.name}`;
    case 'execute_command':
      return `Running ${a.command}`;
    case 'run_tests':
      return 'Running tests';
    case 'run_build':
      return 'Running build';
    case 'start_process':
      return `Starting ${a.name}`;
    case 'http_check':
      return `Checking ${a.url}`;
    default:
      return call.name.replace(/_/g, ' ');
  }
}

export function ToolActivityItem({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const { result } = activity;
  const pending = !result;
  const diff = (result?.data as any)?.diff as string | undefined;
  const stats = diff ? diffStats(diff) : null;

  return (
    <div className="activity">
      <button className="activity-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="dot" style={{ background: pending ? 'var(--accent)' : result!.success ? 'var(--success)' : result!.denied ? 'var(--warning)' : 'var(--danger)' }} />
        <span>{ICON[activity.call.name] ?? '▸'}</span>
        <span className="tool">{label(activity)}</span>
        <span className="spacer" />
        {stats && <span className="chip">+{stats.added} −{stats.removed}</span>}
        {result?.durationMs !== undefined && <span className="chip">{result.durationMs} ms</span>}
        {activity.risk !== 'SAFE' && <span className={`chip ${activity.risk.toLowerCase()}`}>{activity.risk}</span>}
        <span style={{ color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="activity-body">
          {pending ? (
            <pre>Running…</pre>
          ) : (
            <>
              {result!.summary && <pre style={{ marginBottom: 8 }}>{result!.summary}</pre>}
              {result!.error && <pre style={{ color: 'var(--danger)', marginBottom: 8 }}>{result!.error}</pre>}
              {diff ? <DiffView patch={diff} /> : null}
              {result!.stdout ? <pre>{result!.stdout.slice(-8000)}</pre> : null}
              {result!.stderr ? <pre style={{ color: 'var(--danger)' }}>{result!.stderr.slice(-4000)}</pre> : null}
              {!diff && !result!.stdout && !result!.stderr && result!.data !== undefined ? (
                <pre>{JSON.stringify(result!.data, null, 2).slice(0, 6000)}</pre>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  );
}
