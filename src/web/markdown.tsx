import { Fragment, type ReactNode } from "react";

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\))/g;

export interface MarkdownHeading {
  id: string;
  level: number;
  text: string;
}

function headingId(index: number): string {
  return `md-heading-${index}`;
}

export function markdownHeadings(text: string): MarkdownHeading[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headings: MarkdownHeading[] = [];
  let inCode = false;
  let index = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const match = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;
    headings.push({
      id: headingId(index++),
      level: match[1]!.length,
      text: match[2]!.replace(/\s+#+\s*$/, "").trim()
    });
  }
  return headings;
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (url.startsWith("#") || url.startsWith("/")) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  const pattern = new RegExp(INLINE_PATTERN.source, "g");
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("~~")) {
      nodes.push(<del key={key}>{renderInline(token.slice(2, -2), key)}</del>);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      const label = token.slice(1, split);
      const href = safeHref(token.slice(split + 2, -1));
      if (href) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {renderInline(label, key)}
          </a>
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(token);
    }
    cursor = at + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/.test(line) ||
    /^\s*#{1,6}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    /^\s*(---+|\*\*\*+|___+)\s*$/.test(line)
  );
}

interface HeadingCounter {
  index: number;
}

function renderBlocks(lines: string[], keyPrefix: string, headings: HeadingCounter): ReactNode[] {
  const nodes: ReactNode[] = [];
  let index = 0;
  let block = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const key = `${keyPrefix}-b${block++}`;

    const fence = /^\s*```(.*)$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre className="md-code" key={key}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const id = headingId(headings.index++);
      const content = renderInline(heading[2]!.replace(/\s+#+\s*$/, ""), key);
      if (level === 1) nodes.push(<h1 id={id} key={key}>{content}</h1>);
      else if (level === 2) nodes.push(<h2 id={id} key={key}>{content}</h2>);
      else if (level === 3) nodes.push(<h3 id={id} key={key}>{content}</h3>);
      else if (level === 4) nodes.push(<h4 id={id} key={key}>{content}</h4>);
      else if (level === 5) nodes.push(<h5 id={id} key={key}>{content}</h5>);
      else nodes.push(<h6 id={id} key={key}>{content}</h6>);
      index += 1;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      nodes.push(<hr key={key} />);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      nodes.push(<blockquote key={key}>{renderBlocks(quoted, key, headings)}</blockquote>);
      continue;
    }

    if (line.trim().startsWith("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const header = tableCells(line);
      const aligns = tableCells(lines[index + 1] ?? "").map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : undefined;
      });
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && (lines[index] ?? "").trim().startsWith("|")) {
        rows.push(tableCells(lines[index] ?? ""));
        index += 1;
      }
      nodes.push(
        <div className="md-table-wrap" key={key}>
          <table>
            <thead>
              <tr>
                {header.map((cell, cellIndex) => (
                  <th key={`${key}-h${cellIndex}`} style={{ textAlign: aligns[cellIndex] }}>
                    {renderInline(cell, `${key}-h${cellIndex}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${key}-r${rowIndex}`}>
                  {header.map((_cell, cellIndex) => (
                    <td key={`${key}-r${rowIndex}-c${cellIndex}`} style={{ textAlign: aligns[cellIndex] }}>
                      {renderInline(row[cellIndex] ?? "", `${key}-r${rowIndex}-c${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    const listMatch = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? "");
        if (!item || /^\d/.test(item[1]!) !== ordered) break;
        items.push(item[2]!);
        index += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={`${key}-l${itemIndex}`}>{renderInline(item, `${key}-l${itemIndex}`)}</li>
      ));
      nodes.push(ordered ? <ol key={key}>{children}</ol> : <ul key={key}>{children}</ul>);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      const tableHere = current.trim().startsWith("|") && isTableSeparator(lines[index + 1] ?? "");
      if (!current.trim() || isBlockStart(current) || (paragraph.length > 0 && tableHere)) break;
      paragraph.push(current);
      index += 1;
    }
    const content: ReactNode[] = [];
    paragraph.forEach((text, lineIndex) => {
      if (lineIndex > 0) content.push(<br key={`${key}-br${lineIndex}`} />);
      content.push(<Fragment key={`${key}-p${lineIndex}`}>{renderInline(text, `${key}-p${lineIndex}`)}</Fragment>);
    });
    nodes.push(<p key={key}>{content}</p>);
  }
  return nodes;
}

/** Safe, dependency-free Markdown renderer for local notes and reports. */
export function MarkdownView({ text }: { text: string }) {
  const headings: HeadingCounter = { index: 0 };
  return <div className="markdown-body">{renderBlocks(text.replace(/\r\n?/g, "\n").split("\n"), "md", headings)}</div>;
}
