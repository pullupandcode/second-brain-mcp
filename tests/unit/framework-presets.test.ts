import { describe, expect, test } from "vitest";

import {
  FRAMEWORK_PRESET_IDS,
  getFrameworkPreset,
  listFrameworkPresets
} from "../../src/framework/presets.js";

describe("framework presets", () => {
  test("lists the supported framework presets", () => {
    expect(FRAMEWORK_PRESET_IDS).toEqual(["lyt", "para", "zettel"]);
    expect(listFrameworkPresets().map((preset) => preset.id)).toEqual(["lyt", "para", "zettel"]);
  });

  test("defines LYT, PARA, and Zettel record types", () => {
    const lyt = getFrameworkPreset("lyt");
    const para = getFrameworkPreset("para");
    const zettel = getFrameworkPreset("zettel");

    expect(lyt).toBeDefined();
    expect(para).toBeDefined();
    expect(zettel).toBeDefined();
    expect(lyt?.types.map((type) => type.name)).toContain("meeting");
    expect(para?.types.map((type) => type.name)).toEqual([
      "project",
      "area",
      "resource",
      "archive"
    ]);
    expect(zettel?.types.map((type) => type.name)).toEqual([
      "fleeting_note",
      "literature_note",
      "permanent_note"
    ]);
  });

  test("returns undefined for unknown presets", () => {
    expect(getFrameworkPreset("unknown")).toBeUndefined();
  });
});
