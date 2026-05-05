import { describe, expect, test } from "vitest";

import { parseMarkdown } from "../../src/vault/markdown.js";

describe("parseMarkdown", () => {
  test("parses frontmatter and body", () => {
    const parsed = parseMarkdown(`---
title: Daily Note
rank: 2
published: true
tags: [daily, journal]
aliases:
  - Today
  - Daily
source_id: source-123
---
# First Heading

Body with [[Linked Note]] and [[Target|Alias]].
`);

    expect(parsed.frontmatter).toEqual({
      title: "Daily Note",
      rank: 2,
      published: true,
      tags: ["daily", "journal"],
      aliases: ["Today", "Daily"],
      source_id: "source-123"
    });
    expect(parsed.body).toContain("# First Heading");
    expect(parsed.title).toBe("First Heading");
    expect(parsed.tags).toEqual(["daily", "journal"]);
    expect(parsed.aliases).toEqual(["Today", "Daily"]);
    expect(parsed.sourceId).toBe("source-123");
    expect(parsed.outgoingLinks).toEqual(["Linked Note", "Target"]);
  });

  test("uses frontmatter title when there is no H1", () => {
    const parsed = parseMarkdown(`---
title: Frontmatter Title
---
No heading here.`);

    expect(parsed.title).toBe("Frontmatter Title");
  });

  test("parses inline hash tags from the body", () => {
    const parsed = parseMarkdown("Body with #project and #daily/log tags.");

    expect(parsed.tags).toEqual(["project", "daily/log"]);
  });
});
