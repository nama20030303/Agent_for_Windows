import { useEffect, useMemo, useState } from 'react';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);

  const filtered = useMemo(
    () => commands.filter((c) => c.title.toLowerCase().includes(query.toLowerCase())),
    [commands, query]
  );

  useEffect(() => setIndex(0), [query]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            }
            if (e.key === 'Enter' && filtered[index]) {
              onClose();
              void filtered[index].run();
            }
            if (e.key === 'Escape') onClose();
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="empty">No matching command</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === index ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => {
                onClose();
                void c.run();
              }}
            >
              <span>{c.title}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
