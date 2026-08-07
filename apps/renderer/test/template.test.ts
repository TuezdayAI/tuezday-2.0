import { describe, expect, it } from "vitest";
import { escapeHtml, substituteTemplate } from "../src/template";

const input = {
  template: {
    html: "<main><h1>{{ title }}</h1><p>{{body}}</p></main>",
    css: "main{color:#111}",
    placeholders: ["title", "body"],
  },
  values: { title: "Hello", body: "World" },
  width: 1080,
  height: 1080,
};

describe("renderer template substitution", () => {
  it("escapes every HTML metacharacter", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });

  it("creates a self-contained document from declared values", () => {
    const document = substituteTemplate({
      ...input,
      values: { title: "<Launch>", body: "safe & sound" },
    });
    expect(document).toContain("<!doctype html>");
    expect(document).toContain("&lt;Launch&gt;");
    expect(document).toContain("safe &amp; sound");
    expect(document).toContain(input.template.css);
  });

  it("rejects missing values before browser work", () => {
    expect(() => substituteTemplate({ ...input, values: { title: "Only" } })).toThrow(
      "Missing placeholder value(s): body",
    );
  });
});
