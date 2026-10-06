import { useEffect, useRef, useState } from 'react';
import type { AgentMode } from '../../../core/shared/types.js';

const SLASH_COMMANDS: { cmd: string; desc: string; prefix: string; mode?: AgentMode }[] = [
  { cmd: '/plan', desc: 'Analyse and plan without changing files', prefix: 'Create an implementation plan for: ', mode: 'plan' },
  { cmd: '/build', desc: 'Implement a feature end to end', prefix: 'Implement and verify: ', mode: 'agent' },
  { cmd: '/debug', desc: 'Find and fix a defect', prefix: 'Debug this problem, find the root cause and fix it: ', mode: 'agent' },
  { cmd: '/review', desc: 'Review the project (read-only)', prefix: 'Review this project: architecture, code quality, security, dependencies, tests, technical debt. Do not modify files. Focus: ', mode: 'plan' },
  { cmd: '/test', desc: 'Run the test suite and fix failures', prefix: 'Run the test suite, analyse failures and fix them: ', mode: 'agent' },
  { cmd: '/refactor', desc: 'Refactor safely with verification', prefix: 'Refactor with minimal safe changes and verify no regressions: ', mode: 'agent' },
  { cmd: '/explain', desc: 'Explain code or architecture', prefix: 'Explain: ', mode: 'chat' },
  { cmd: '/search', desc: 'Search the project', prefix: 'Search the project for: ', mode: 'chat' },
  { cmd: '/git', desc: 'Inspect repository state', prefix: 'Show git status, recent commits and uncommitted changes. ', mode: 'chat' }
];

const MODES: { id: AgentMode; label: string; hint: string }[] = [
  { id: 'chat', label: 'Chat', hint: 'Answer questions. Read-only.' },
  { id: 'plan', label: 'Plan', hint: 'Analyse and plan. Read-only.' },
  { id: 'agent', label: 'Agent', hint: 'Execute changes with approvals.' },
  { id: 'auto', label: 'Auto', hint: 'Autonomous within permission mode.' }
];

export function Composer({
  mode,
  busy,
  disabled,
  disabledReason,
  onModeChange,
  onSend,
  onStop
}: {
  mode: AgentMode;
  busy: boolean;
  disabled: boolean;
  disabledReason?: string;
  onModeChange: (mode: AgentMode) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState('');
  const [slashIndex, setSlashIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const slashQuery = value.startsWith('/') ? value.split(' ')[0] : null;
  const suggestions = slashQuery ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(slashQuery)) : [];
  const showSlash = suggestions.length > 0 && value.trim() === slashQuery;

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  const submit = (raw?: string) => {
    const text = (raw ?? value).trim();
    if (!text || disabled) return;
    const command = SLASH_COMMANDS.find((c) => text.startsWith(`${c.cmd} `) || text === c.cmd);
    if (command) {
      if (command.mode) onModeChange(command.mode);
      const rest = text.slice(command.cmd.length).trim();
      onSend(`${command.prefix}${rest}`);
    } else {
      onSend(text);
    }
    setValue('');
  };

  return (
    <div className="composer-wrap">
      <div className="composer" style={{ position: 'relative' }}>
        {showSlash && (
          <div className="slash-menu">
            {suggestions.map((s, i) => (
              <div
                key={s.cmd}
                className={`slash-item ${i === slashIndex ? 'active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => setValue(`${s.cmd} `)}
              >
                <span className="cmd">{s.cmd}</span>
                <span className="desc">{s.desc}</span>
              </div>
            ))}
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={textarea}
            value={value}
            placeholder={disabled ? disabledReason ?? 'Unavailable' : 'Describe what you want to build…  (/ for commands)'}
            aria-label="Message the agent"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (showSlash && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                setSlashIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % suggestions.length : (i - 1 + suggestions.length) % suggestions.length));
                return;
              }
              if (showSlash && e.key === 'Tab') {
                e.preventDefault();
                setValue(`${suggestions[slashIndex].cmd} `);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-bar">
            <div className="mode-switch" role="tablist" aria-label="Agent mode">
              {MODES.map((m) => (
                <button key={m.id} className={mode === m.id ? 'active' : ''} title={m.hint} onClick={() => onModeChange(m.id)} role="tab" aria-selected={mode === m.id}>
                  {m.label}
                </button>
              ))}
            </div>
            <span className="spacer" />
            {busy ? (
              <button className="btn btn-danger" onClick={onStop} title="Stop the agent (Esc)">
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => submit()} disabled={disabled || !value.trim()}>
                Send ↑
              </button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          {disabled ? disabledReason : 'Enter to send · Shift+Enter for a new line · Esc stops the agent'}
        </div>
      </div>
    </div>
  );
}

export { SLASH_COMMANDS };
