import type { ReactNode } from "react";

type Block =
  | { type: "code"; lang: string; text: string }
  | { type: "heading"; text: string }
  | { type: "list"; ordered: boolean; start: number; items: string[] }
  | { type: "rule" }
  | { type: "para"; text: string };

const FENCE = /^\s*```(\S*)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || NUMBERED.test(line) || RULE.test(line);

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      blocks.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
    } else if (!line.trim()) {
      i++;
    } else if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
    } else if (HEADING.test(line)) {
      blocks.push({ type: "heading", text: line.match(HEADING)![1]! });
      i++;
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      const ordered = !BULLET.test(line);
      const pattern = ordered ? NUMBERED : BULLET;
      const itemText = (l: string) => (ordered ? l.match(NUMBERED)![2]! : l.match(BULLET)![1]!);
      const items: string[] = [];
      const start = ordered ? Number(line.match(NUMBERED)![1]) : 1;
      while (i < lines.length) {
        if (pattern.test(lines[i]!)) {
          items.push(itemText(lines[i]!));
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i]!) && !startsBlock(lines[i]!)) {
          items[items.length - 1] += ` ${lines[i]!.trim()}`;
          i++;
        } else if (!lines[i]!.trim()) {
          // A blank line only continues the list when the next item follows it.
          let next = i;
          while (next < lines.length && !lines[next]!.trim()) next++;
          if (next < lines.length && pattern.test(lines[next]!)) i = next;
          else break;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", ordered, start, items });
    } else {
      const para: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!)) para.push(lines[i++]!.trim());
      blocks.push({ type: "para", text: para.join(" ") });
    }
  }
  return blocks;
}

/** Inline code, bold (which may contain code or links) and links. */
function inline(text: string, keyPrefix = "i"): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const key = `${keyPrefix}-${match.index}`;
    if (match[1] !== undefined) parts.push(<code key={key}>{match[1]}</code>);
    else if (match[2] !== undefined) parts.push(<strong key={key}>{inline(match[2], key)}</strong>);
    else
      parts.push(
        <a key={key} href={match[4]} target="_blank" rel="noreferrer">
          {inline(match[3]!, key)}
        </a>,
      );
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** Renders the Markdown agents write (paragraphs, lists, headings, code) without injecting HTML. */
export function Markdown({ text, collapseCodeOver = 12 }: { text: string; collapseCodeOver?: number }) {
  return (
    <div className="md">
      {parseMarkdown(text).map((block, n) => {
        switch (block.type) {
          case "code": {
            const lineCount = block.text.split("\n").length;
            const pre = (
              <pre>
                <code>{block.text}</code>
              </pre>
            );
            return lineCount > collapseCodeOver ? (
              <details key={n}>
                <summary>
                  Show {block.lang || "code"} ({lineCount} lines)
                </summary>
                {pre}
              </details>
            ) : (
              <div key={n}>{pre}</div>
            );
          }
          case "heading":
            return (
              <p key={n} className="md-h">
                {inline(block.text)}
              </p>
            );
          case "list": {
            const items = block.items.map((item, k) => <li key={k}>{inline(item)}</li>);
            return block.ordered ? (
              <ol key={n} start={block.start}>
                {items}
              </ol>
            ) : (
              <ul key={n}>{items}</ul>
            );
          }
          case "rule":
            return <hr key={n} />;
          default:
            return <p key={n}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
