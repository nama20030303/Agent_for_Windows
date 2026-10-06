export function DiffView({ patch }: { patch: string }) {
  const lines = patch.split('\n').filter((l, i) => !(i < 4 && (l.startsWith('---') || l.startsWith('+++') || l.startsWith('Index:') || l === '===================================================================')));
  return (
    <div className="diff">
      {lines.map((line, i) => {
        const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
        return (
          <div key={i} className={`line ${cls}`}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

export function diffStats(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
