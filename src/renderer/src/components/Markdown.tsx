import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';

export function CodeBlock({ language, code, path }: { language?: string; code: string; path?: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => {
    try {
      return language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language }).value
        : hljs.highlightAuto(code).value;
    } catch {
      return null;
    }
  }, [code, language]);

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span>{path ?? language ?? 'text'}</span>
        <span className="spacer" />
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
}

/** file.py:42 references become clickable. */
function linkifyReferences(text: string, onOpenFile?: (path: string, line?: number) => void) {
  if (!onOpenFile) return text;
  const parts: (string | JSX.Element)[] = [];
  const re = /([\w./\\-]+\.(?:py|ts|tsx|js|jsx|cs|go|rs|java|json|md|yml|yaml|toml|html|css|sql))(?::(\d+))?/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [full, file, line] = match;
    parts.push(
      <a
        key={`ref${key++}`}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          onOpenFile(file, line ? Number(line) : undefined);
        }}
        style={{ color: 'var(--accent)' }}
      >
        {full}
      </a>
    );
    last = match.index + full.length;
  }
  if (!parts.length) return text;
  parts.push(text.slice(last));
  return parts;
}

export function Markdown({ content, onOpenFile }: { content: string; onOpenFile?: (path: string, line?: number) => void }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ inline, className, children, ...props }: any) {
            const text = String(children).replace(/\n$/, '');
            const language = /language-(\w+)/.exec(className ?? '')?.[1];
            if (inline) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return <CodeBlock language={language} code={text} />;
          },
          p({ children }: any) {
            return (
              <p>
                {Array.isArray(children)
                  ? children.map((child, i) => (typeof child === 'string' ? <span key={i}>{linkifyReferences(child, onOpenFile)}</span> : child))
                  : typeof children === 'string'
                    ? linkifyReferences(children, onOpenFile)
                    : children}
              </p>
            );
          },
          a({ href, children }: any) {
            return (
              <a href={href} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>
                {children}
              </a>
            );
          }
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
