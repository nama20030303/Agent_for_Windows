import { useState } from 'react';
import { api } from '../bridge.js';
import { refreshGit, setState, toast, useStore } from '../state/store.js';
import type { PermissionMode } from '../../../core/shared/types.js';

export function Onboarding({ onDone }: { onDone: () => void }) {
  const settings = useStore((s) => s.settings);
  const [step, setStep] = useState(0);
  const [baseUrl, setBaseUrl] = useState(settings?.ai.baseUrl ?? '');
  const [model, setModel] = useState(settings?.ai.model ?? 'am/nemotron-3-ultra-550b-a55b');
  const [apiKey, setApiKey] = useState('');
  const [mode, setMode] = useState<PermissionMode>('balanced');
  const [testing, setTesting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [attempts, setAttempts] = useState<{ label: string; baseUrl: string; status: string }[]>([]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Finding the right endpoint is the step people get stuck on: ask every known
  // host whether it accepts this key, then fill the form from the answer.
  const detect = async () => {
    setDetecting(true);
    setResult(null);
    setAttempts([]);
    try {
      const found = await api.settings.detectProvider({ apiKey: apiKey.trim(), model });
      setAttempts(found.attempts);
      if (found.ok && found.best) {
        setBaseUrl(found.best.baseUrl);
        setModel(found.best.model);
      }
      setResult({ ok: found.ok, message: found.message });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setDetecting(false);
    }
  };

  const steps = ['AI provider', 'Workspace', 'Permissions'];

  return (
    <div className="overlay" style={{ paddingTop: '8vh' }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          Welcome to Nexus Code
          <span className="spacer" />
          <span className="card-sub" style={{ margin: 0 }}>
            Step {step + 1} of 3 — {steps[step]}
          </span>
        </div>
        <div className="modal-body">
          {step === 0 && (
            <>
              <p className="card-sub">
                Nexus Code uses an external reasoning model through an OpenAI-compatible API. Nothing runs locally except the agent runtime.
              </p>
              <div className="field">
                <label>Model</label>
                <input type="text" value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://your-provider.example/v1"
                />
                <div className="help">
                  The OpenAI-compatible endpoint of the host serving this model — the URL its documentation
                  shows for /chat/completions, without the path.
                </div>
              </div>
              <div className="field">
                <label>API key</label>
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Stored encrypted with Windows DPAPI" />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={detecting || !apiKey.trim()} onClick={() => void detect()}>
                {detecting ? 'Looking for your provider…' : 'Find my provider automatically'}
              </button>
              <button
                className="btn"
                disabled={testing || !apiKey.trim() || !baseUrl.trim()}
                onClick={async () => {
                  setTesting(true);
                  try {
                    await api.settings.update({ ai: { ...(settings?.ai as any), baseUrl, model } });
                    await api.settings.setApiKey(apiKey.trim());
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
              </div>
              {result && <div className={`banner ${result.ok ? 'ok' : 'err'}`} style={{ marginTop: 12 }}>{result.message}</div>}
              {attempts.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary className="card-sub" style={{ cursor: 'pointer' }}>What each provider answered</summary>
                  <div className="mono" style={{ fontSize: 12, marginTop: 6 }}>
                    {attempts.map((a) => (
                      <div key={a.baseUrl} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span>{a.label}</span>
                        <span className="card-sub" style={{ margin: 0 }}>{a.status}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
              <div className="help" style={{ marginTop: 8 }}>
                Detection sends the key to the hosts listed above, one at a time, only to ask which models
                they serve. Skip it and fill the Base URL in by hand if you prefer.
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <p className="card-sub">Choose the project the agent may work in. Everything outside this folder stays off-limits.</p>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  const picked = await api.workspace.pick();
                  if (!picked) return;
                  const info = await api.workspace.open(picked);
                  setState({ workspace: info, index: info.index });
                  void refreshGit();
                  toast('ok', `Indexed ${info.index.fileCount} files`);
                }}
              >
                Select project folder
              </button>
              <div className="card-sub" style={{ marginTop: 10 }}>
                You can create a new empty folder in the picker to start a brand-new project.
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="card-sub">How autonomous should the agent be? You can change this at any time.</p>
              {(
                [
                  ['safe', 'Safe', 'Read-only. Every change needs approval.'],
                  ['balanced', 'Balanced', 'Routine development runs automatically; risky actions ask first.'],
                  ['autonomous', 'Autonomous', 'Minimal interruption. Dangerous operations are still blocked.'],
                  ['custom', 'Custom', 'Configure the exact capabilities yourself.']
                ] as [PermissionMode, string, string][]
              ).map(([id, label, desc]) => (
                <div key={id} className={`option ${mode === id ? 'recommended' : ''}`} onClick={() => setMode(id)}>
                  <span>{mode === id ? '◉' : '○'}</span>
                  <span>
                    <div className="label">{label}</div>
                    <div className="desc">{desc}</div>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="modal-foot">
          {step > 0 && (
            <button className="btn" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          <button className="btn btn-ghost" onClick={onDone}>
            Skip
          </button>
          <button
            className="btn btn-primary"
            onClick={async () => {
              if (step < 2) return setStep((s) => s + 1);
              await api.settings.update({ permissionMode: mode, onboardingComplete: true });
              setState({ settings: await api.settings.get() });
              onDone();
            }}
          >
            {step < 2 ? 'Continue' : 'Start coding'}
          </button>
        </div>
      </div>
    </div>
  );
}
