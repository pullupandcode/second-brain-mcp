import { describe, expect, test } from "vitest";

import { composeFrameworkSchemas, parseFrameworkSchema } from "../../src/framework/schema.js";

describe("parseFrameworkSchema", () => {
  test("parses a custom schema without requiring a preset", () => {
    const schema = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: custom
name: my-system
description: "My custom system"

types:
  decision:
    description: "A decision record."
    folder: Decisions
    filename: "{date:YYYY-MM-DD} {title}.md"
    template: Templates/Decision.md
`);

    expect(schema.framework).toBe("custom");
    expect(schema.name).toBe("my-system");
    expect(schema.types.decision).toMatchObject({
      description: "A decision record.",
      folder: "Decisions",
      filename: "{date:YYYY-MM-DD} {title}.md",
      template: "Templates/Decision.md"
    });
  });

  test("rejects unknown frameworks", () => {
    expect(() =>
      parseFrameworkSchema(`
version: 1
schema_kind: base
framework: unknown
types: {}
`)
    ).toThrow(/framework must be one of/);
  });
});

describe("composeFrameworkSchemas", () => {
  test("composes preset schema metadata with custom type definitions", () => {
    const base = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: para
types:
  project:
    folder: Projects
    filename: "{title}.md"
`);

    const effective = composeFrameworkSchemas(base);

    expect(effective.framework).toBe("para");
    expect(effective.types.project?.folder).toBe("Projects");
    expect(effective.preset?.name).toBe("PARA");
  });

  test("appends overlay types", () => {
    const base = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: custom
types:
  decision:
    folder: Decisions
`);
    const overlay = parseFrameworkSchema(`
version: 1
schema_kind: overlay
name: work
types:
  meeting:
    folder: Meetings
`);

    const effective = composeFrameworkSchemas(base, [overlay]);

    expect(Object.keys(effective.types)).toEqual(["decision", "meeting"]);
  });

  test("rejects overlay type collisions unless override is explicit", () => {
    const base = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: custom
types:
  decision:
    folder: Decisions
`);
    const overlay = parseFrameworkSchema(`
version: 1
schema_kind: overlay
name: work
types:
  decision:
    folder: Work Decisions
`);

    expect(() => composeFrameworkSchemas(base, [overlay])).toThrow(/already exists/);
  });

  test("allows explicit overlay type overrides", () => {
    const base = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: custom
types:
  decision:
    folder: Decisions
`);
    const overlay = parseFrameworkSchema(`
version: 1
schema_kind: overlay
name: work
override: true
types:
  decision:
    folder: Work Decisions
`);

    expect(composeFrameworkSchemas(base, [overlay]).types.decision?.folder).toBe("Work Decisions");
  });

  test("rejects overlays that change identity fields", () => {
    const base = parseFrameworkSchema(`
version: 1
schema_kind: base
framework: custom
inbox:
  folder: "+"
types:
  note:
    folder: Notes
`);
    const overlay = parseFrameworkSchema(`
version: 1
schema_kind: overlay
name: unsafe
inbox:
  folder: Inbox
types:
  task:
    folder: Tasks
`);

    expect(() => composeFrameworkSchemas(base, [overlay])).toThrow(/cannot change inbox.folder/);
  });
});
