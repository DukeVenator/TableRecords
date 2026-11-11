import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView, markdownHeadings } from "../src/web/markdown.js";

function render(text: string): string {
  return renderToStaticMarkup(createElement(MarkdownView, { text }));
}

describe("MarkdownView", () => {
  it("renders headings, emphasis, lists, tables, and code fences", () => {
    const html = render(
      [
        "# Session notes",
        "",
        "A **bold** statement and a [link](https://example.com).",
        "",
        "- one",
        "- two",
        "",
        "| Metric | Value |",
        "|---|---:|",
        "| Events | 4,947 |",
        "",
        "```",
        "npm run demo",
        "```"
      ].join("\n")
    );
    expect(html).toContain('<h1 id="md-heading-0">Session notes</h1>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<table>");
    expect(html).toContain("<th");
    expect(html).toContain("4,947");
    expect(html).toContain("<pre class=\"md-code\">");
    expect(html).toContain("npm run demo");
  });

  it("escapes raw HTML and refuses script links", () => {
    const html = render(
      ["<script>alert('x')</script>", "", "<img src=x onerror=alert(1)>", "", "[click](javascript:alert(1))"].join("\n")
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("[click](javascript:alert(1))");
  });

  it("extracts navigation headings and ignores fenced code", () => {
    const headings = markdownHeadings(
      ["# Session notes", "", "## Cast", "", "```", "# not a heading", "```", "### Timeline"].join("\n")
    );
    expect(headings.map((heading) => [heading.id, heading.level, heading.text])).toEqual([
      ["md-heading-0", 1, "Session notes"],
      ["md-heading-1", 2, "Cast"],
      ["md-heading-2", 3, "Timeline"]
    ]);
  });
});
