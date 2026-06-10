import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { htmlToText } from "./html-to-text";

function fixture(name: string): string {
  return readFileSync(resolve(__dirname, "__fixtures__", name), "utf-8");
}

describe("htmlToText", () => {
  it("strips script and style blocks entirely", () => {
    const html = `<html><head><style>body { color: red; }</style></head><body><script>alert('xss')</script><p>Hello</p></body></html>`;
    const result = htmlToText(html);
    expect(result).not.toContain("color: red");
    expect(result).not.toContain("alert");
    expect(result).toContain("Hello");
  });

  it("removes HTML comments", () => {
    const html = `<p>Before</p><!-- This is a comment --><p>After</p>`;
    const result = htmlToText(html);
    expect(result).not.toContain("comment");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("decodes common named HTML entities", () => {
    const html = `&amp; &lt; &gt; &quot; &nbsp;`;
    const result = htmlToText(html);
    expect(result).toBe('& < > "');
  });

  it("decodes Spanish accented named entities", () => {
    const html = `transacci&oacute;n comun&iacute;cate autom&aacute;tico a&uacute;n se&ntilde;or`;
    const result = htmlToText(html);
    expect(result).toBe("transacción comunícate automático aún señor");
  });

  it("decodes uppercase Spanish entities", () => {
    const html = `&Aacute;rea &Eacute;xito &Oacute;ptimo &Ntilde;o&ntilde;o`;
    const result = htmlToText(html);
    expect(result).toBe("Área Éxito Óptimo Ñoño");
  });

  it("decodes decimal numeric entities (&#NNN;)", () => {
    const html = `&#243; &#8221; &#169;`;
    const result = htmlToText(html);
    expect(result).toBe("ó \u201D ©");
  });

  it("decodes hex numeric entities (&#xHHH;)", () => {
    const html = `&#xF3; &#xA9; &#x2019;`;
    const result = htmlToText(html);
    expect(result).toBe("ó © \u2019");
  });

  it("replaces block-level tags with newlines", () => {
    const html = `<p>First</p><p>Second</p><div>Third</div>`;
    const result = htmlToText(html);
    expect(result).toContain("First\n");
    expect(result).toContain("Second\n");
    expect(result).toContain("Third");
  });

  it("replaces <br> with newline", () => {
    const html = `Line 1<br>Line 2<br/>Line 3<br />Line 4`;
    const result = htmlToText(html);
    expect(result).toBe("Line 1\nLine 2\nLine 3\nLine 4");
  });

  it("adds space separator for <td> (table cells not concatenated)", () => {
    const html = `<table><tr><td>Monto</td><td>$88.443</td></tr></table>`;
    const result = htmlToText(html);
    expect(result).toContain("Monto");
    expect(result).toContain("$88.443");
    // They should be separated by space, not concatenated
    expect(result).toMatch(/Monto\s+\$88\.443/);
  });

  it("strips all remaining tags", () => {
    const html = `<span class="bold">text</span> <a href="http://example.com">link</a>`;
    const result = htmlToText(html);
    expect(result).toBe("text link");
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
  });

  it("collapses multiple spaces to single space", () => {
    const html = `<p>Hello     world</p>`;
    const result = htmlToText(html);
    expect(result).toContain("Hello world");
  });

  it("collapses multiple newlines to max 2", () => {
    const html = `<p>A</p><p></p><p></p><p></p><p></p><p>B</p>`;
    const result = htmlToText(html);
    // Should never have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });

  it("trims the result", () => {
    const html = `   <p>   Hello   </p>   `;
    const result = htmlToText(html);
    expect(result).toBe("Hello");
  });

  it("handles empty input", () => {
    expect(htmlToText("")).toBe("");
  });

  it("handles plain text (no HTML)", () => {
    expect(htmlToText("Just plain text")).toBe("Just plain text");
  });

  describe("RappiCard fixture", () => {
    it("extracts Monto, Comercio, and Fecha from the HTML email", () => {
      const html = fixture("rappicard-transaccion.html");
      const text = htmlToText(html);

      // Key fields must be extractable with reasonable spacing
      expect(text).toMatch(/Monto\s+\$88\.443/);
      expect(text).toMatch(/Comercio\s+RAPPI/);
      expect(text).toMatch(/Fecha de la transacci[óo]n\s+09\/06\/2026/);
      // Entities decoded
      expect(text).toContain("transacción");
      expect(text).not.toContain("&oacute;");
    });
  });

  describe("Arriendo fixture", () => {
    it("extracts Estado, Valor total, and Fecha from the HTML email", () => {
      const html = fixture("arriendo-aprobado.html");
      const text = htmlToText(html);

      // Key fields must be extractable
      expect(text).toMatch(/Estado\s+Aprobado/);
      expect(text).toMatch(/Valor total\s+\$\s*1\.900\.000/);
      expect(text).toMatch(/Fecha:\s*01\/06\/2026/);
      // Entities decoded
      expect(text).toContain("transacción");
      expect(text).not.toContain("&oacute;");
    });
  });
});
