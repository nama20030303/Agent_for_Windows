import { useState } from 'react';
import type {
  AgentQuestion,
  PermissionRequest,
  Plan,
  RequirementAnalysis,
  VerificationReport
} from '../../../core/shared/types.js';
import { Markdown } from './Markdown.js';

export function QuestionCard({
  questions,
  answered,
  onAnswer
}: {
  questions: AgentQuestion[];
  answered?: string;
  onAnswer: (answer: string) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});

  if (answered) {
    return (
      <div className="card">
        <div className="card-title">Decisions provided</div>
        <div className="card-sub">{answered}</div>
      </div>
    );
  }

  const submit = () => {
    const lines = questions.map((q) => {
      const chosen = choices[q.id] ?? q.recommendedOptionId;
      const option = q.options.find((o) => o.id === chosen);
      return `${q.topic}: ${option?.label ?? chosen ?? 'use your recommendation'}`;
    });
    onAnswer(lines.join('\n'));
  };

  return (
    <div className="card">
      <div className="card-title">
        Before implementation I need {questions.length} decision{questions.length > 1 ? 's' : ''}
      </div>
      <div className="card-sub">Pick an option or accept the recommendations.</div>
      {questions.map((q, i) => (
        <div key={q.id} style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>
            <span className={`chip ${q.priority.toLowerCase()}`} style={{ marginRight: 8 }}>
              {q.priority}
            </span>
            {i + 1}. {q.question}
          </div>
          {q.options.map((o) => {
            const selected = (choices[q.id] ?? q.recommendedOptionId) === o.id;
            return (
              <div
                key={o.id}
                className={`option ${selected ? 'recommended' : ''}`}
                onClick={() => setChoices((c) => ({ ...c, [q.id]: o.id }))}
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setChoices((c) => ({ ...c, [q.id]: o.id }))}
              >
                <span>{selected ? '◉' : '○'}</span>
                <span>
                  <div className="label">
                    {o.label}
                    {o.id === q.recommendedOptionId ? ' — recommended' : ''}
                  </div>
                  {o.description && <div className="desc">{o.description}</div>}
                </span>
              </div>
            );
          })}
          {q.recommendationReason && <div className="card-sub" style={{ marginTop: 4 }}>Why: {q.recommendationReason}</div>}
        </div>
      ))}
      <div className="card-actions">
        <button className="btn btn-primary" onClick={submit}>
          Send answers
        </button>
        <button className="btn" onClick={() => onAnswer('Use your recommended defaults for all questions and continue.')}>
          Use recommended defaults
        </button>
      </div>
    </div>
  );
}

export function PlanCard({ plan, resolved, onApprove, onCancel }: { plan: Plan; resolved?: string; onApprove: () => void; onCancel: () => void }) {
  return (
    <div className="card">
      <div className="card-title">Implementation plan — {plan.title}</div>
      {plan.technology.length > 0 && <div className="card-sub">Technology: {plan.technology.join(' · ')}</div>}
      {plan.steps.map((step, i) => (
        <div key={step.id} className="plan-step">
          <span className="n">{i + 1}</span>
          <span>
            {step.title}
            {step.detail && <div className="card-sub" style={{ marginBottom: 0 }}>{step.detail}</div>}
          </span>
        </div>
      ))}
      <div className="card-sub" style={{ marginTop: 10, marginBottom: 0 }}>
        {plan.estimatedFiles ? `Estimated files: ${plan.estimatedFiles} · ` : ''}
        Tests: {plan.includesTests ? 'included' : 'not included'}
        {plan.notes ? ` · ${plan.notes}` : ''}
      </div>
      {plan.requiresApproval && !resolved && (
        <div className="card-actions">
          <button className="btn btn-primary" onClick={onApprove}>
            Start
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
      {resolved && <div className="card-sub" style={{ marginTop: 8, marginBottom: 0 }}>Plan {resolved}.</div>}
    </div>
  );
}

export function ApprovalCard({
  request,
  decision,
  onDecide
}: {
  request: PermissionRequest;
  decision?: string;
  onDecide: (decision: 'allow_once' | 'allow_session' | 'allow_project' | 'deny') => void;
}) {
  const risk = request.risk.toLowerCase();
  return (
    <div className={`card approval ${risk}`}>
      <div className="card-title">
        <span className={`chip ${risk}`}>{request.risk} RISK</span>
        Approval required
      </div>
      <div className="card-sub">{request.reason}</div>
      <div className="mono" style={{ background: 'var(--code-bg)', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)' }}>
        {request.command ?? `${request.operation} → ${request.target}`}
      </div>
      {decision ? (
        <div className="card-sub" style={{ marginTop: 10, marginBottom: 0 }}>Decision: {decision.replace(/_/g, ' ')}</div>
      ) : (
        <div className="card-actions">
          <button className="btn btn-primary" onClick={() => onDecide('allow_once')}>Allow once</button>
          <button className="btn" onClick={() => onDecide('allow_session')}>Allow for session</button>
          <button className="btn" onClick={() => onDecide('allow_project')}>Allow for project</button>
          <button className="btn btn-danger" onClick={() => onDecide('deny')}>Deny</button>
        </div>
      )}
    </div>
  );
}

export function VerificationCard({ report }: { report: VerificationReport }) {
  const [open, setOpen] = useState(!report.passed);
  return (
    <div className="card">
      <div className="card-title">
        <span className="dot" style={{ background: report.passed ? 'var(--success)' : 'var(--danger)' }} />
        Verification {report.passed ? 'passed' : 'failed'}
      </div>
      {report.checks.map((check, i) => (
        <div key={i} className="kv">
          <span>
            {check.outcome === 'passed' ? '✓' : '✕'} {check.level} — <span className="mono">{check.command}</span>
          </span>
          <b style={{ color: check.outcome === 'passed' ? 'var(--success)' : 'var(--danger)' }}>
            {check.outcome}
            {check.errorType ? ` · ${check.errorType}` : ''}
          </b>
        </div>
      ))}
      {report.unverified.map((u, i) => (
        <div key={`u${i}`} className="kv">
          <span>— {u.level}</span>
          <b style={{ color: 'var(--text-faint)' }}>not verified</b>
        </div>
      ))}
      {report.unverified.length > 0 && (
        <div className="card-sub" style={{ marginTop: 8, marginBottom: 0 }}>
          {report.unverified.map((u) => `${u.level}: ${u.reason}`).join(' · ')}
        </div>
      )}
      {report.checks.some((c) => c.outcome === 'failed') && (
        <>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide output' : 'Show output'}
          </button>
          {open && (
            <pre className="mono" style={{ marginTop: 8, maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
              {report.checks.filter((c) => c.outcome === 'failed').map((c) => c.detail).join('\n\n')}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

export function RequirementsCard({ analysis }: { analysis: RequirementAnalysis }) {
  const [open, setOpen] = useState(false);
  const groups = ['missing', 'conflicting', 'explicit', 'implicit', 'optional'] as const;
  return (
    <div className="card">
      <button className="card-title" style={{ width: '100%', justifyContent: 'flex-start' }} onClick={() => setOpen((v) => !v)}>
        Requirement analysis <span className="chip">{analysis.requirements.length} items</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>
      </button>
      <div className="card-sub" style={{ marginBottom: open ? 10 : 0 }}>{analysis.summary}</div>
      {open && (
        <>
          {groups.map((group) => {
            const items = analysis.requirements.filter((r) => r.kind === group);
            if (!items.length) return null;
            return (
              <div key={group} style={{ marginBottom: 8 }}>
                <div className="section-title" style={{ padding: '4px 0' }}>{group}</div>
                {items.map((r) => (
                  <div key={r.id} className="kv">
                    <span>{r.statement}</span>
                    <b>{Math.round(r.confidence * 100)}%</b>
                  </div>
                ))}
              </div>
            );
          })}
          {analysis.assumptions.length > 0 && (
            <>
              <div className="section-title" style={{ padding: '4px 0' }}>assumed defaults</div>
              {analysis.assumptions.map((a, i) => (
                <div key={i} className="card-sub" style={{ marginBottom: 2 }}>• {a}</div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

export function CompletionCard({ report, verified, onOpenFile }: { report: string; verified: boolean; onOpenFile?: (p: string, l?: number) => void }) {
  return (
    <div className="card">
      <div className="card-title">
        <span className="dot" style={{ background: verified ? 'var(--success)' : 'var(--warning)' }} />
        {verified ? 'Task completed — verified' : 'Task completed — not fully verified'}
      </div>
      <Markdown content={report} onOpenFile={onOpenFile} />
    </div>
  );
}
