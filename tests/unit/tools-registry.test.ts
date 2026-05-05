import { describe, expect, test } from "vitest";

import { parseScopes } from "../../src/auth/scopes.js";
import { createToolRegistry, listToolsForScopes } from "../../src/tools/registry.js";

describe("parseScopes", () => {
  test("keeps only known scopes from a space-delimited claim", () => {
    expect([...parseScopes("vault:read daily:append unknown")]).toEqual([
      "vault:read",
      "daily:append"
    ]);
  });

  test("accepts array scope claims", () => {
    expect([...parseScopes(["vault:write", "admin"])]).toEqual(["vault:write", "admin"]);
  });
});

describe("tool registry", () => {
  test("filters tools by granted scopes", () => {
    const tools = listToolsForScopes(parseScopes("vault:read daily:append"));
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("read_note");
    expect(names).toContain("search");
    expect(names).toContain("daily_note_append");
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("schema_reload");
  });

  test("returns write tools for vault write scope", () => {
    const names = listToolsForScopes(parseScopes("vault:write")).map((tool) => tool.name);

    expect(names).toContain("create_note");
    expect(names).toContain("replace_note");
    expect(names).toContain("create_lyt_record");
    expect(names).not.toContain("daily_note_append");
  });

  test("hides OCR tools when OCR is disabled", () => {
    const withoutOcr = createToolRegistry({ ocrEnabled: false }).map((tool) => tool.name);
    const withOcr = createToolRegistry({ ocrEnabled: true }).map((tool) => tool.name);

    expect(withoutOcr).not.toContain("ocr_notebook");
    expect(withOcr).toContain("ocr_notebook");
  });
});
