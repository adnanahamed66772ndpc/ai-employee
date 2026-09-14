interface DiffFile {
  path: string;
  lines: string[];
  added: number;
  removed: number;
}

const HEADER = /^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to) |old mode|new mode)/;

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = { path: line.match(/ b\/(.+)$/)?.[1] ?? line.slice(11), lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (!current || HEADER.test(line)) continue;
    if (line.startsWith("+")) current.added++;
    else if (line.startsWith("-")) current.removed++;
    current.lines.push(line);
  }
  return files;
}

export function DiffView({ diff }: { diff: string }) {
  const files = parseDiff(diff);
  if (files.length === 0) return <pre className="pre">{diff}</pre>;
  return (
    <div className="diff">
      {files.map((file) => (
        <details key={file.path} className="diff-file" open={files.length <= 4}>
          <summary>
            <span className="diff-path">{file.path}</span>
            <span className="diff-count">
              <span className="add">+{file.added}</span> <span className="del">−{file.removed}</span>
            </span>
          </summary>
          <pre className="diff-body">
            <code className="diff-lines">
              {file.lines.map((line, i) => (
                <span key={i} className={line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}>
                  {line || " "}
                </span>
              ))}
            </code>
          </pre>
        </details>
      ))}
    </div>
  );
}
