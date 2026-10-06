import { useEffect, useMemo, useRef, useState } from 'react';
import hljs from 'highlight.js/lib/common';

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', py: 'python', cs: 'csharp',
  rs: 'rust', go: 'go', java: 'java', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml',
  html: 'xml', css: 'css', sql: 'sql', ps1: 'powershell', sh: 'bash', toml: 'ini'
};

export function CodeViewer({ path, content, line, onClose }: { path: string; content: string; line?: number; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const container = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => {
    const language = EXT_LANG[path.split('.').pop()?.toLowerCase() ?? ''];
    let html: string;
    try {
      html = language && hljs.getLanguage(language) ? hljs.highlight(content, { language }).value : hljs.highlightAuto(content).value;
    } catch {
      html = content.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
    }
    return html.split('\n');
  }, [content, path]);

  useEffect(() => {
    if (!line) return;
    const el = container.current?.querySelector(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [line, lines]);

  const matches = query ? lines.map((l, i) => ({ i: i + 1, text: l })).filter((l) => l.text.toLowerCase().includes(query.toLowerCase())) : [];

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 'min(1000px, 94vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="mono" style={{ fontSize: 13 }}>{path}</span>
          <span className="spacer" />
          <input type="text" placeholder="Find…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: 180, marginRight: 8 }} />
          <button className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(content)}>
            Copy
          </button>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {query && <div className="card-sub" style={{ padding: '6px 18px', margin: 0 }}>{matches.length} matches</div>}
        <div className="code-viewer" ref={container}>
          {lines.map((html, i) => {
            const n = i + 1;
            const highlighted = n === line || (query && html.toLowerCase().includes(query.toLowerCase()));
            return (
              <div key={n} data-line={n} className={`code-line ${highlighted ? 'highlight' : ''}`}>
                <span className="ln">{n}</span>
                <span className="src" dangerouslySetInnerHTML={{ __html: html || ' ' }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
