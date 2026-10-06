import { useStore } from '../state/store.js';
import { api } from '../bridge.js';

const STATE_TONE: Record<string, string> = {
  IDLE: 'var(--text-faint)',
  COMPLETED: 'var(--success)',
  FAILED: 'var(--danger)',
  BLOCKED: 'var(--warning)',
  WAITING_FOR_USER: 'var(--warning)',
  WAITING_FOR_APPROVAL: 'var(--warning)',
  STOPPED: 'var(--text-faint)'
};

export function ContextPanel() {
  const agentState = useStore((s) => s.agentState);
  const detail = useStore((s) => s.agentDetail);
  const tasks = useStore((s) => s.tasks);
  const timeline = useStore((s) => s.timeline);
  const processes = useStore((s) => s.processes);
  const usage = useStore((s) => s.usage);
  const git = useStore((s) => s.git);
  const filesCreated = useStore((s) => s.filesCreated);
  const filesModified = useStore((s) => s.filesModified);
  const index = useStore((s) => s.index);

  const current = tasks.find((t) => !['completed', 'failed', 'stopped'].includes(t.status)) ?? tasks.at(-1);
  const steps = current?.steps ?? [];
  const done = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
  const percent = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const busy = !['IDLE', 'COMPLETED', 'FAILED', 'STOPPED', 'BLOCKED', 'WAITING_FOR_USER', 'WAITING_FOR_APPROVAL'].includes(agentState);

  return (
    <aside className="panel right">
      <div className="agent-state">
        <div className="state-label">
          <span className="dot" style={{ background: busy ? 'var(--accent)' : STATE_TONE[agentState] ?? 'var(--text-faint)' }} />
          {agentState.replace(/_/g, ' ')}
        </div>
        {detail && <div className="card-sub" style={{ marginTop: 4, marginBottom: 0 }}>{detail}</div>}
        {steps.length > 0 && (
          <>
            <div className="progress">
              <div style={{ width: `${percent}%` }} />
            </div>
            <div className="card-sub" style={{ marginTop: 6, marginBottom: 0 }}>
              {done}/{steps.length} steps · {percent}%
            </div>
          </>
        )}
      </div>

      <div className="panel-scroll">
        <div className="section-title">Tasks</div>
        {steps.length === 0 && <div className="empty">No active task</div>}
        {steps.map((s) => (
          <div key={s.id} className={`task-step ${s.status}`}>
            <span className="mark">{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '◉' : s.status === 'failed' ? '✕' : '○'}</span>
            <span>{s.description}</span>
          </div>
        ))}

        <div className="section-title">Changes</div>
        <div className="kv">
          <span>Files created</span>
          <b>{filesCreated}</b>
        </div>
        <div className="kv">
          <span>Files modified</span>
          <b>{filesModified}</b>
        </div>
        {index && (
          <div className="kv">
            <span>Indexed files</span>
            <b>{index.fileCount}</b>
          </div>
        )}

        <div className="section-title">Git</div>
        {git.isRepo ? (
          <>
            <div className="kv">
              <span>Branch</span>
              <b>{git.branch ?? '—'}</b>
            </div>
            <div className="kv">
              <span>Modified / staged</span>
              <b>
                {git.modified} / {git.staged}
              </b>
            </div>
          </>
        ) : (
          <div className="empty">Not a repository</div>
        )}

        <div className="section-title">Running services</div>
        {processes.length === 0 && <div className="empty">None</div>}
        {processes.map((p) => (
          <div key={p.id} style={{ marginBottom: 6 }}>
            <div className="kv">
              <span>
                <span className="dot" style={{ background: p.status === 'running' ? 'var(--success)' : p.status === 'failed' ? 'var(--danger)' : 'var(--text-faint)', display: 'inline-block', marginRight: 6 }} />
                {p.name}
              </span>
              <b>{p.port ? `:${p.port}` : p.status}</b>
            </div>
            <div className="card-sub" style={{ marginBottom: 2 }}>
              pid {p.pid ?? '—'} · {p.status}
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 6 }} onClick={() => void api.processes.stop(p.id)}>
                stop
              </button>
            </div>
          </div>
        ))}

        <div className="section-title">Model usage</div>
        <div className="kv">
          <span>Requests</span>
          <b>{usage.requests}</b>
        </div>
        <div className="kv">
          <span>Input tokens</span>
          <b>{usage.inputTokens.toLocaleString()}</b>
        </div>
        <div className="kv">
          <span>Output tokens</span>
          <b>{usage.outputTokens.toLocaleString()}</b>
        </div>

        <div className="section-title">Activity timeline</div>
        {timeline.length === 0 && <div className="empty">Nothing yet</div>}
        {timeline.slice(-40).reverse().map((entry, i) => (
          <div key={i} className="timeline-row">
            <span className="t">{new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <span>{entry.message}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
