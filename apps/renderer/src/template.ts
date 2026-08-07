import type { RenderRequest } from "@tuezday/contracts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

export function substituteTemplate(input: RenderRequest): string {
  const missing = input.template.placeholders.filter((name) => input.values[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`Missing placeholder value(s): ${missing.join(", ")}`);
  }

  const html = input.template.html.replace(
    /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (token, name: string) =>
      input.values[name] === undefined ? token : escapeHtml(input.values[name]),
  );

  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8"><style>',
    "html,body{margin:0;padding:0;overflow:hidden;}",
    input.template.css,
    "</style></head><body>",
    html,
    "</body></html>",
  ].join("\n");
}
