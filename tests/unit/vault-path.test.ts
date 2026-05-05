import { describe, expect, test } from "vitest";

import { isMarkdownPath, normalizeVaultPath, resolveVaultPath } from "../../src/vault/path.js";

describe("normalizeVaultPath", () => {
  test("normalizes relative vault paths", () => {
    expect(normalizeVaultPath("Calendar//Days/2026-05-05.md")).toBe(
      "Calendar/Days/2026-05-05.md"
    );
  });

  test("normalizes Windows separators", () => {
    expect(normalizeVaultPath("Calendar\\Days\\2026-05-05.md")).toBe(
      "Calendar/Days/2026-05-05.md"
    );
  });

  test("rejects leading slashes", () => {
    expect(() => normalizeVaultPath("/Calendar/Days/2026-05-05.md")).toThrow(
      /must be relative/
    );
  });

  test("rejects traversal segments", () => {
    expect(() => normalizeVaultPath("Calendar/../secret.md")).toThrow(/must not contain/);
  });
});

describe("resolveVaultPath", () => {
  test("resolves paths under the vault root", () => {
    expect(resolveVaultPath("/tmp/vault", "Atlas/Maps/Home.md")).toBe(
      "/tmp/vault/Atlas/Maps/Home.md"
    );
  });
});

describe("isMarkdownPath", () => {
  test("detects markdown notes case-insensitively", () => {
    expect(isMarkdownPath("A/B.md")).toBe(true);
    expect(isMarkdownPath("A/B.MD")).toBe(true);
    expect(isMarkdownPath("A/B.txt")).toBe(false);
  });
});
