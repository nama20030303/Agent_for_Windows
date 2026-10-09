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
  http_check: '⇄',
  append_file: '✎',
  create_directory: '▤',
  move_file: '→',
  copy_file: '⧉',
  record_requirements: '☰',
  present_plan: '☰',
  verify_work: '✓',
  create_checkpoint: '⎙',
  update_task: '☰',
  remember: '☰',
  finish: '■',
  ask_user: '?'
};

/**
 * What the line says in the conversation. While a call runs it is written in
 * the present tense, and once it is done in the past tense with the outcome,
 * so the transcript reads as a record of what happened: "Created src/app.py",
 * "Ran npm test". The call's JSON is never shown here; it is in the body.
 */
function label(activity: ToolActivity): string {
  const { call, result } = activity;
  const a = call.arguments as Record<string, any>;
  const done = !!result;
  const failed = done && !result!.success;
  const data = (result?.data ?? {}) as Record<string, any>;

  // A failed call never claims the thing happened.
  const past = (verb: string, present: string) => (!done ? present : failed ? `${present} — failed` : verb);

  switch (call.name) {
    case 'read_file':
      return past(`Read ${a.path}`, `Reading ${a.path}`);
    case 'write_file':
      return past(data.created === false ? `Rewrote ${a.path}` : `Created ${a.path}`, `Writing ${a.path}`);
    case 'append_file':
      return past(data.created ? `Created ${a.path}` : `Extended ${a.path}`, `Extending ${a.path}`);
    case 'edit_file':
      return past(`Edited ${a.path}`, `Editing ${a.path}`);
    case 'delete_file':
      return past(`Deleted ${a.path}`, `Deleting ${a.path}`);
    case 'move_file':
      return past(`Moved ${a.from ?? a.source} to ${a.to ?? a.destination}`, `Moving ${a.from ?? a.source}`);
    case 'copy_file':
      return past(`Copied ${a.from ?? a.source} to ${a.to ?? a.destination}`, `Copying ${a.from ?? a.source}`);
    case 'create_directory':
      return past(`Created folder ${a.path}`, `Creating folder ${a.path}`);
    case 'list_directory':
      return past(`Listed ${a.path ?? '.'}`, `Listing ${a.path ?? '.'}`);
    case 'file_exists':
    case 'get_file_info':
      return past(`Checked ${a.path}`, `Checking ${a.path}`);
    case 'search_text':
      return past(`Searched for "${a.query}"`, `Searching for "${a.query}"`);
    case 'search_files':
      return past(`Looked for files "${a.pattern}"`, `Looking for files "${a.pattern}"`);
    case 'find_symbol':
      return past(`Looked up ${a.name}`, `Looking up ${a.name}`);
    case 'find_references':
      return past(`Found references to ${a.name}`, `Finding references to ${a.name}`);
    case 'execute_command':
      return past(`Ran ${a.command}`, `Running ${a.command}`);
    case 'run_tests':
      return past('Ran the tests', 'Running the tests');
    case 'run_build':
      return past('Ran the build', 'Running the build');
    case 'detect_test_framework':
      return past('Detected the test framework', 'Detecting the test framework');
    case 'start_process':
      return past(`Started ${a.name ?? a.command}`, `Starting ${a.name ?? a.command}`);
    case 'stop_process':
      return past(`Stopped ${a.name ?? a.id}`, `Stopping ${a.name ?? a.id}`);
    case 'http_check':
      return past(`Checked ${a.url}`, `Checking ${a.url}`);
    case 'git_commit':
      return past('Committed the changes', 'Committing the changes');
    case 'record_requirements':
      return past('Analysed the requirements', 'Analysing the requirements');
    case 'present_plan':
      return past('Prepared a plan', 'Preparing a plan');
    case 'update_task':
      return `Task: ${a.title ?? a.id ?? 'updated'}`;
    case 'verify_work':
      return past('Verified the work', 'Verifying the work');
    case 'create_checkpoint':
      return past('Saved a checkpoint', 'Saving a checkpoint');
    case 'remember':
      return 'Noted something about the project';
    case 'finish':
      return failed ? 'Tried to finish too early' : 'Finished';
    case 'ask_user':
      return 'Asked a question';
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
