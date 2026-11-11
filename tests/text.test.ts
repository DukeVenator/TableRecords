import { describe, expect, it } from "vitest";
import { csvEscape, decodeHtmlEntities, htmlToText, markdownCell } from "../src/core/text.js";

describe("text helpers", () => {
  it("strips chat HTML and decodes the common entities", () => {
    expect(htmlToText("<p>Hello &amp; <b>world</b></p>")).toBe("Hello & world");
    expect(htmlToText("<div>one<br>two</div>")).toBe("one\ntwo");
    expect(decodeHtmlEntities("&#65;&#x42;&nbsp;&unknown;")).toBe("AB &unknown;");
  });

  it("quotes CSV values and neutralizes spreadsheet formulas in text cells", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
    expect(csvEscape("=HYPERLINK(\"https://example.test\")")).toMatch(/^"'=HYPERLINK/);
    expect(csvEscape("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvEscape(-42)).toBe("-42");
  });

  it("escapes table separators in Markdown cells", () => {
    expect(markdownCell("Alice | Veyra\nSol")).toBe("Alice \\| Veyra Sol");
  });
});
