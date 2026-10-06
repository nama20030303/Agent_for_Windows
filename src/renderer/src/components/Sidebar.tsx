import { useEffect, useMemo, useState } from 'react';
import { api } from '../bridge.js';
import { getState, refreshGit, setState, toast, useStore } from '../state/store.js';
import type { CheckpointDTO } from '../../../core/shared/ipc.js';
import type { ProjectMemory } from '../../../core/shared/types.js';

type Tab = 'files' | 'search' | 'git' | 'tasks' | 'checkpoints' | 'memory';

const TABS: { id: Tab; label: string }[] = [
  { id: 'files', label: 'Files' },
  { id: 'search', label: 'Search' },
  { id: 'git', label: 'Git' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'memory', label: 'Memory' }
];

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map(), isFile: false };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map(), isFile: i === parts.length - 1 };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

function TreeView({ node, depth, onOpen }: { node: TreeNode; depth: number; onOpen: (p: string) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const entries = [...node.children.values()].sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.name.localeCompare(b.name));
  return (
    <>
      {entries.map((child) => {
        const isOpen = expanded.has(child.path);
        return (
          <div key={child.path}>
            <div
              className="tree-row"
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => {
                if (child.isFile) onOpen(child.path);
                else
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    next.has(child.path) ? next.delete(child.path) : next.add(child.path);
                    return next;
                  });
              }}
              title={child.path}
            >
              <span className="glyph">{child.isFile ? '·' : isOpen ? '▾' : '▸'}</span>
              <span className="name">{child.name}</span>
            </div>
            {!child.isFile && isOpen && <TreeView node={child} depth={depth + 1} onOpen={onOpen} />}
          </div>
        );
      })}
    </>
  );
}

export function Sidebar({ onOpenFile, onNewSession }: { onOpenFile: (path: string, line?: number) => void; onNewSession: () => void }) {
  const [tab, setTab] = useState<Tab>('files');
  const workspace = useStore((s) => s.workspace);
  const index = useStore((s) => s.index);
  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  const tasks = useStore((s) => s.tasks);
  const git = useStore((s) => s.git);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ path: string; line: number; text: string }[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointDTO[]>([]);
  const [memory, setMemory] = useState<ProjectMemory | null>(null);
  const [gitLog, setGitLog] = useState('');

  const tree = useMemo(() => buildTree((index?.files ?? []).map((f) => f.path).slice(0, 4000)), [index]);

  useEffect(() => {
    if (tab === 'checkpoints' && workspace) void api.checkpoints.list().then(setCheckpoints).catch(() => undefined);
    if (tab === 'memory' && workspace) void api.memory.get().then(setMemory).catch(() => undefined);
    if (tab === 'git' && workspace) {
      void refreshGit();
      void api.git.log(12).then(setGitLog).catch(() => undefined);
    }
  }, [tab, workspace]);

  const runSearch = async (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) return setResults([]);
    try {
      setResults(await api.workspace.search(value));
    } catch {
      setResults([]);
    }
  };

  return (
    <aside className="panel left">
      <div className="panel-scroll">
        <div className="section-title">Workspace</div>
        {workspace ? (
          <div className="list-item active" title={workspace.root}>
            <span>▾</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{workspace.name}</span>
          </div>
        ) : (
          <div className="empty">No project open</div>
        )}
        <div style={{ display: 'flex', gap: 6, padding: '6px 4px' }}>
          <button
            className="btn btn-sm"
            onClick={async () => {
              const picked = await api.workspace.pick();
              if (!picked) return;
              const info = await api.workspace.open(picked);
              setState({ workspace: info, index: info.index, sessions: await api.session.list(info.projectId) });
              void refreshGit();
              toast('ok', `Opened ${info.name} — ${info.index.fileCount} files indexed`);
            }}
          >
            Open project
          </button>
          <button className="btn btn-sm" onClick={onNewSession} disabled={!workspace}>
            New session
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, padding: '8px 4px' }}>
          {TABS.map((t) => (
            <button key={t.id} className={`btn btn-sm ${tab === t.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'files' &&
          (index ? (
            <>
              <div className="section-title">
                {index.fileCount} files{index.truncated ? ' (truncated)' : ''}
              </div>
              <TreeView node={tree} depth={0} onOpen={(p) => onOpenFile(p)} />
            </>
          ) : (
            <div className="empty">Open a project to browse files.</div>
          ))}

        {tab === 'search' && (
          <>
            <input
              type="text"
              placeholder="Search file contents…"
              value={query}
              onChange={(e) => void runSearch(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            {results.length === 0 && <div className="empty">{query ? 'No matches' : 'Type at least 2 characters'}</div>}
            {results.map((r, i) => (
              <div key={i} className="tree-row" onClick={() => onOpenFile(r.path, r.line)} title={r.text}>
                <span className="name">
                  {r.path}:{r.line}
                </span>
              </div>
            ))}
          </>
        )}

        {tab === 'git' && (
          <>
            {!git.isRepo && <div className="empty">This project is not a Git repository.</div>}
            {git.isRepo && (
              <>
                <div className="kv">
                  <span>Branch</span>
                  <b>{git.branch ?? 'detached'}</b>
                </div>
                <div className="kv">
                  <span>Modified</span>
                  <b>{git.modified}</b>
                </div>
                <div className="kv">
                  <span>Staged</span>
                  <b>{git.staged}</b>
                </div>
                <div className="kv">
                  <span>Untracked</span>
                  <b>{git.untracked}</b>
                </div>
                <div className="section-title">Recent commits</div>
                <pre className="mono" style={{ fontSize: 11.5, whiteSpace: 'pre-wrap', color: 'var(--text-muted)' }}>
                  {gitLog || '—'}
                </pre>
              </>
            )}
          </>
        )}

        {tab === 'tasks' && (
          <>
            {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
            {tasks.map((task) => (
              <div key={task.id} style={{ marginBottom: 10 }}>
                <div className="list-item" style={{ fontWeight: 500 }}>
                  {task.title}
                  <span className="meta">{task.status}</span>
                </div>
                {task.steps.map((s) => (
                  <div key={s.id} className={`task-step ${s.status}`} style={{ paddingLeft: 12 }}>
                    <span className="mark">{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◉' : s.status === 'failed' ? '✕' : '○'}</span>
                    <span>{s.description}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}

        {tab === 'checkpoints' && (
          <>
            <button
              className="btn btn-sm"
              style={{ marginBottom: 8 }}
              disabled={!workspace}
              onClick={async () => {
                try {
                  const created = await api.checkpoints.create(`Manual checkpoint ${new Date().toLocaleTimeString()}`);
                  setCheckpoints(await api.checkpoints.list());
                  toast('ok', `Checkpoint created (${created.fileCount} files)`);
                } catch (err) {
                  toast('err', (err as Error).message);
                }
              }}
            >
              Create checkpoint
            </button>
            {checkpoints.length === 0 && <div className="empty">No checkpoints yet.</div>}
            {checkpoints.map((c) => (
              <div key={c.id} style={{ borderBottom: '1px solid var(--border)', padding: '6px 4px' }}>
                <div style={{ fontSize: 13 }}>{c.label}</div>
                <div className="card-sub" style={{ marginBottom: 4 }}>
                  {new Date(c.createdAt).toLocaleString()} · {c.fileCount} files
                  {c.gitCommit ? ` · ${c.gitCommit.slice(0, 7)}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      const result = await api.checkpoints.restore(c.id);
                      toast('ok', `Restored ${result.restored} files${result.extraFiles.length ? ` · ${result.extraFiles.length} newer files left in place` : ''}`);
                      const workspace = getState().workspace;
                      if (workspace) setState({ index: await api.workspace.reindex() });
                    }}
                  >
                    Restore
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      await api.checkpoints.remove(c.id);
                      setCheckpoints(await api.checkpoints.list());
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </>
        )}

        {tab === 'memory' && (
          <>
            {!memory && <div className="empty">Open a project to view its memory.</div>}
            {memory && (
              <div style={{ fontSize: 12.5 }}>
                {memory.projectGoal && (
                  <>
                    <div className="section-title">Goal</div>
                    <div>{memory.projectGoal}</div>
                  </>
                )}
                {memory.architecture && (
                  <>
                    <div className="section-title">Architecture</div>
                    <div>{memory.architecture}</div>
                  </>
                )}
                {memory.stack.length > 0 && (
                  <>
                    <div className="section-title">Stack</div>
                    <div>{memory.stack.join(', ')}</div>
                  </>
                )}
                {memory.decisions.length > 0 && (
                  <>
                    <div className="section-title">Decisions</div>
                    {memory.decisions.map((d, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>• {d.decision}</div>
                    ))}
                  </>
                )}
                {memory.constraints.length > 0 && (
                  <>
                    <div className="section-title">Constraints</div>
                    {memory.constraints.map((c, i) => (
                      <div key={i}>• {c}</div>
                    ))}
                  </>
                )}
                {memory.knownProblems.length > 0 && (
                  <>
                    <div className="section-title">Known problems</div>
                    {memory.knownProblems.map((c, i) => (
                      <div key={i}>• {c}</div>
                    ))}
                  </>
                )}
              </div>
            )}
          </>
        )}

        <div className="section-title">Recent sessions</div>
        {sessions.length === 0 && <div className="empty">No sessions yet.</div>}
        {sessions.slice(0, 12).map((s) => (
          <button
            key={s.id}
            className={`list-item ${s.id === sessionId ? 'active' : ''}`}
            onClick={async () => {
              setState({ sessionId: s.id, turns: [], tasks: await api.session.tasks(s.id), agentState: s.state as any });
              const messages = await api.session.messages(s.id);
              setState({
                turns: messages.map((m, i) => ({ kind: m.role === 'user' ? 'user' : 'assistant', id: `h${i}`, content: m.content }) as any)
              });
            }}
            title={s.title}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>
            <span className="meta">{new Date(s.updatedAt).toLocaleDateString()}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
