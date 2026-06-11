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

  test("accepts delete scope claims", () => {
    expect([...parseScopes("vault:delete vault:delete:hard")]).toEqual([
      "vault:delete",
      "vault:delete:hard"
    ]);
  });
});

describe("tool registry", () => {
  test("filters tools by granted scopes", () => {
    const tools = listToolsForScopes(parseScopes("vault:read daily:append"));
    const names = tools.map((tool) => tool.name);

    expect(names).toContain("read_note");
    expect(names).toContain("search");
    expect(names).toContain("find_maps");
    expect(names).toContain("daily_note_append");
    expect(names).not.toContain("find_mocs");
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("framework_reload");
  });

  test("returns write tools for vault write scope", () => {
    const names = listToolsForScopes(parseScopes("vault:write")).map((tool) => tool.name);

    expect(names).toContain("create_note");
    expect(names).toContain("replace_note");
    expect(names).toContain("create_record");
    expect(names).not.toContain("create_lyt_record");
    expect(names).not.toContain("daily_note_append");
  });

  test("returns soft delete tools for vault delete scope", () => {
    const names = listToolsForScopes(parseScopes("vault:delete")).map((tool) => tool.name);

    expect(names).toContain("delete_note");
    expect(names).not.toContain("create_note");
    expect(names).not.toContain("hard_delete_note");
  });

  test("returns hard delete tools for vault hard delete scope", () => {
    const names = listToolsForScopes(parseScopes("vault:delete:hard")).map((tool) => tool.name);

    expect(names).toContain("hard_delete_note");
    expect(names).not.toContain("delete_note");
    expect(names).not.toContain("create_note");
  });

  test("hides OCR tools when OCR is disabled", () => {
    const withoutOcr = createToolRegistry({ ocrEnabled: false }).map((tool) => tool.name);
    const withOcr = createToolRegistry({ ocrEnabled: true }).map((tool) => tool.name);

    expect(withoutOcr).not.toContain("ocr_notebook");
    expect(withOcr).toContain("ocr_notebook");
  });

  test("exposes write recovery diagnostics to admin scope only", () => {
    const adminNames = listToolsForScopes(parseScopes("admin")).map((tool) => tool.name);
    const writeNames = listToolsForScopes(parseScopes("vault:write")).map((tool) => tool.name);

    expect(adminNames).toContain("list_write_recovery_diagnostics");
    expect(adminNames).toContain("skills_list");
    expect(adminNames).toContain("skills_reload");
    expect(writeNames).not.toContain("list_write_recovery_diagnostics");
    expect(writeNames).not.toContain("skills_list");
    expect(writeNames).not.toContain("skills_reload");
  });
});
