import { useEffect, useState } from 'react';
import { api, isDesktop } from '../bridge.js';
import { setState, toast, useStore } from '../state/store.js';
import type { AppSettings, PermissionMode } from '../../../core/shared/types.js';

const PERMISSION_HELP: Record<PermissionMode, string> = {
  safe: 'Read-only. Every modifying operation needs explicit approval.',
  balanced: 'Normal development work runs automatically; medium and high-risk operations ask first.',
  autonomous: 'Minimal interruption. Dangerous and remote operations are still blocked or confirmed.',
  custom: 'You decide the auto-approval ceiling and individual capabilities.'
};

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [finding, setFinding] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; modelAvailable?: boolean } | null>(null);
  const [paths, setPaths] = useState<{ appData: string; logs: string; database: string } | null>(null);

  useEffect(() => {
    setDraft(settings);
    void api.settings.hasApiKey().then(setHasKey).catch(() => undefined);
    void api.app.paths().then(setPaths).catch(() => undefined);
  }, [settings]);

  if (!draft) return null;

  const save = async () => {
    const updated = await api.settings.update(draft);
    if (apiKey.trim()) {
      await api.settings.setApiKey(apiKey.trim());
      setApiKey('');
      setHasKey(true);
    }
    setState({ settings: { ...updated } });
    document.documentElement.dataset.theme = draft.theme;
    toast('ok', 'Settings saved');
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Settings
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close settings">✕</button>
        </div>
        <div className="modal-body">
          {!isDesktop && <div className="banner info">Preview mode — settings cannot be stored without the desktop backend.</div>}

          <div className="section-title" style={{ padding: '0 0 8px' }}>AI provider</div>
          <div className="field">
            <label>Provider</label>
            <select value={draft.ai.provider} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, provider: e.target.value as any } })}>
              <option value="nemotron">Nemotron (OpenAI-compatible)</option>
              <option value="openai-compatible">OpenAI-compatible</option>
              <option value="custom">Custom</option>
            </select>
          </div>
          <div className="field">
            <label>Model</label>
            <input type="text" value={draft.ai.model} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, model: e.target.value } })} />
          </div>
          <div className="field">
            <label>Base URL</label>
            <input type="text" placeholder="https://host/v1" value={draft.ai.baseUrl} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, baseUrl: e.target.value } })} />
          </div>
          <div className="field">
            <label>API key {hasKey && <span style={{ color: 'var(--success)' }}>· stored securely</span>}</label>
            <input type="password" placeholder={hasKey ? '•••••••••••••• (stored)' : 'Paste the API key'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            <div className="help">Encrypted with Windows DPAPI via Electron safeStorage. It is never written to project files, logs or Git.</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Temperature</label>
              <input type="number" step="0.1" min="0" max="2" value={draft.ai.temperature} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, temperature: Number(e.target.value) } })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label title="0 sends no limit at all, so the provider uses the model's maximum.">Max tokens (0 = no limit)</label>
              <input type="number" min="0" value={draft.ai.maxTokens} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, maxTokens: Math.max(0, Number(e.target.value)) } })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Timeout (ms)</label>
              <input type="number" value={draft.ai.timeoutMs} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, timeoutMs: Number(e.target.value) } })} />
            </div>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={draft.ai.streaming} onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, streaming: e.target.checked } })} />
            Stream responses
          </label>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={detecting || (!apiKey.trim() && !hasKey)}
              onClick={async () => {
                setDetecting(true);
                setResult(null);
                try {
                  const found = await api.settings.detectProvider({ apiKey: apiKey.trim() || undefined, model: draft.ai.model });
                  if (found.ok && found.best) {
                    setDraft({ ...draft, ai: { ...draft.ai, baseUrl: found.best.baseUrl, model: found.best.model } });
                    setHasKey(true);
                    setApiKey('');
                  }
                  setResult({ ok: found.ok, message: found.message });
                } catch (err) {
                  setResult({ ok: false, message: (err as Error).message });
                } finally {
                  setDetecting(false);
                }
              }}
            >
              {detecting ? 'Detecting…' : 'Detect endpoint'}
            </button>
            <button
              className="btn"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setResult(null);
                try {
                  if (apiKey.trim()) await api.settings.setApiKey(apiKey.trim());
                  await api.settings.update(draft);
                  setResult(await api.settings.testConnection());
                } catch (err) {
                  setResult({ ok: false, message: (err as Error).message });
                } finally {
                  setTesting(false);
                }
              }}
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button
              className="btn"
              disabled={finding}
              title="Ask the provider which models it really hosts and switch to one that answers."
              onClick={async () => {
                setFinding(true);
                setResult(null);
                try {
                  if (apiKey.trim()) await api.settings.setApiKey(apiKey.trim());
                  await api.settings.update(draft);
                  const found = await api.settings.findWorkingModel();
                  if (found.ok && found.model) setDraft({ ...draft, ai: { ...draft.ai, model: found.model } });
                  setResult({ ok: found.ok, message: found.message });
                } catch (err) {
                  setResult({ ok: false, message: (err as Error).message });
                } finally {
                  setFinding(false);
                }
              }}
            >
              {finding ? 'Searching…' : 'Find a working model'}
            </button>
            {result && (
              <span className={`banner ${result.ok ? 'ok' : 'err'}`} style={{ margin: 0, flex: 1 }}>
                {result.ok ? '✓ ' : '✕ '}
                {result.message}
                {result.modelAvailable === false ? ' · model not listed by the provider' : ''}
              </span>
            )}
          </div>

          <div className="section-title" style={{ padding: '0 0 8px' }}>Permissions</div>
          {(['safe', 'balanced', 'autonomous', 'custom'] as PermissionMode[]).map((mode) => (
            <div key={mode} className={`option ${draft.permissionMode === mode ? 'recommended' : ''}`} onClick={() => setDraft({ ...draft, permissionMode: mode })}>
              <span>{draft.permissionMode === mode ? '◉' : '○'}</span>
              <span>
                <div className="label" style={{ textTransform: 'capitalize' }}>{mode}</div>
                <div className="desc">{PERMISSION_HELP[mode]}</div>
              </span>
            </div>
          ))}
          {draft.permissionMode === 'custom' && (
            <div style={{ marginTop: 8 }}>
              <div className="field">
                <label>Auto-allow risk ceiling</label>
                <select
                  value={draft.customPermissions.autoAllowUpTo}
                  onChange={(e) => setDraft({ ...draft, customPermissions: { ...draft.customPermissions, autoAllowUpTo: e.target.value as any } })}
                >
                  {['SAFE', 'LOW', 'MEDIUM'].map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              {([
                ['allowDelete', 'Allow deletions without asking'],
                ['allowGitRemote', 'Allow remote Git operations without asking'],
                ['allowOutsideWorkspaceRead', 'Allow reads outside the workspace (still needs approval)']
              ] as const).map(([key, label]) => (
                <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={draft.customPermissions[key]}
                    onChange={(e) => setDraft({ ...draft, customPermissions: { ...draft.customPermissions, [key]: e.target.checked } })}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}

          <div className="section-title" style={{ padding: '14px 0 8px' }}>Agent</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={draft.requirePlanApproval} onChange={(e) => setDraft({ ...draft, requirePlanApproval: e.target.checked })} />
            Require plan approval before large changes
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Automatic repair attempts</label>
              <input type="number" min={1} max={10} value={draft.maxRepairAttempts} onChange={(e) => setDraft({ ...draft, maxRepairAttempts: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Max iterations per turn</label>
              <input type="number" min={5} max={200} value={draft.maxAgentIterations} onChange={(e) => setDraft({ ...draft, maxAgentIterations: Number(e.target.value) })} />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Shell</label>
              <select value={draft.shell} onChange={(e) => setDraft({ ...draft, shell: e.target.value as any })}>
                <option value="powershell">PowerShell</option>
                <option value="cmd">CMD</option>
                <option value="bash">Bash</option>
              </select>
            </div>
          </div>

          <div className="section-title" style={{ padding: '14px 0 8px' }}>Appearance</div>
          <div className="field">
            <label>Theme</label>
            <select
              value={draft.theme}
              onChange={(e) => {
                setDraft({ ...draft, theme: e.target.value as any });
                document.documentElement.dataset.theme = e.target.value;
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>

          {paths && (
            <div className="card-sub" style={{ marginTop: 10 }}>
              Data directory: <span className="mono">{paths.appData}</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save().then(onClose)}>Save</button>
        </div>
      </div>
    </div>
  );
}
