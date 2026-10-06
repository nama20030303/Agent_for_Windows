import { useEffect, useRef, useState } from 'react';
import { api } from '../bridge.js';
import { useStore } from '../state/store.js';

export function TerminalPanel({ onClose }: { onClose: () => void }) {
  const workspace = useStore((s) => s.workspace);
  const processes = useStore((s) => s.processes);
  const [lines, setLines] = useState<string[]>(['Nexus Code integrated terminal. Commands run inside the workspace.']);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState<'terminal' | string>('terminal');
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [lines, tab]);

  const run = async () => {
    const cmd = command.trim();
    if (!cmd || running) return;
    setHistory((h) => [cmd, ...h].slice(0, 50));
    setHistoryIndex(-1);
    setCommand('');
    setLines((l) => [...l, `PS ${workspace?.root ?? ''}> ${cmd}`]);
    setRunning(true);
    try {
      const result = await api.terminal.run(cmd);
      setLines((l) => [...l, result.stdout, result.stderr, `exit ${result.exitCode} · ${result.durationMs} ms`].filter(Boolean));
    } catch (err) {
      setLines((l) => [...l, `error: ${(err as Error).message}`]);
    } finally {
      setRunning(false);
    }
  };

  const active = processes.find((p) => p.id === tab);

  return (
    <div className="drawer">
      <div className="drawer-head">
        <div className="filetabs" style={{ border: 0, padding: 0 }}>
          <button className={`filetab ${tab === 'terminal' ? 'active' : ''}`} onClick={() => setTab('terminal')}>
            Terminal
          </button>
          {processes.map((p) => (
            <button key={p.id} className={`filetab ${tab === p.id ? 'active' : ''}`} onClick={() => setTab(p.id)}>
              {p.name} {p.status === 'running' ? '●' : '○'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {active && (
          <button className="btn btn-sm btn-ghost" onClick={() => void api.processes.stop(active.id)}>
            Stop process
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => setLines([])}>
          Clear
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close terminal">
          ✕
        </button>
      </div>
      <div className="terminal-output" ref={outputRef}>
        {tab === 'terminal' ? lines.join('\n') : (active?.output ?? []).join('\n') || 'No output yet.'}
      </div>
      {tab === 'terminal' && (
        <div className="terminal-input">
          <span className="prompt">{running ? '…' : 'PS >'}</span>
          <input
            type="text"
            value={command}
            disabled={!workspace || running}
            placeholder={workspace ? 'Type a command and press Enter' : 'Open a project first'}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run();
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                const next = Math.min(historyIndex + 1, history.length - 1);
                if (history[next]) {
                  setHistoryIndex(next);
                  setCommand(history[next]);
                }
              }
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = historyIndex - 1;
                setHistoryIndex(next);
                setCommand(next >= 0 ? history[next] ?? '' : '');
              }
            }}
          />
        </div>
      )}
    </div>
  );
}
