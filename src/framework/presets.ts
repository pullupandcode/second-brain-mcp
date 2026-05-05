export const FRAMEWORK_PRESET_IDS = ["lyt", "para", "zettel"] as const;

export type FrameworkPresetId = (typeof FRAMEWORK_PRESET_IDS)[number];

export interface FrameworkRecordType {
  name: string;
  description: string;
  defaultFolder: string;
}

export interface FrameworkPreset {
  id: FrameworkPresetId;
  name: string;
  description: string;
  types: FrameworkRecordType[];
}

const PRESETS = [
  {
    id: "lyt",
    name: "Linking Your Thinking",
    description: "Ideaverse-style maps, sources, dots, efforts, records, and daily notes.",
    types: [
      recordType("meeting", "A time-based meeting record.", "Calendar/Records/Meetings"),
      recordType("capture", "An agent or inbox capture record.", "Calendar/Records/Captures"),
      recordType("person", "A person or contact note.", "Atlas/Dots/People"),
      recordType("project", "An active effort or project.", "Efforts/Projects/Active"),
      recordType("map", "A map of content or collection hub.", "Atlas/Maps")
    ]
  },
  {
    id: "para",
    name: "PARA",
    description: "Projects, Areas, Resources, and Archives.",
    types: [
      recordType("project", "A finite outcome with active work.", "Projects"),
      recordType("area", "A long-running responsibility or standard.", "Areas"),
      recordType("resource", "Reference material grouped by topic.", "Resources"),
      recordType("archive", "Inactive material retained for reference.", "Archives")
    ]
  },
  {
    id: "zettel",
    name: "Zettelkasten",
    description: "Fleeting, literature, and permanent notes.",
    types: [
      recordType("fleeting_note", "A quick temporary thought or capture.", "Fleeting"),
      recordType("literature_note", "A source-grounded note from reading or research.", "Literature"),
      recordType("permanent_note", "An atomic durable knowledge note.", "Permanent")
    ]
  }
] satisfies FrameworkPreset[];

export function listFrameworkPresets(): FrameworkPreset[] {
  return PRESETS.map(clonePreset);
}

export function getFrameworkPreset(id: string): FrameworkPreset | undefined {
  const preset = PRESETS.find((candidate) => candidate.id === id);
  return preset === undefined ? undefined : clonePreset(preset);
}

function recordType(
  name: string,
  description: string,
  defaultFolder: string
): FrameworkRecordType {
  return { name, description, defaultFolder };
}

function clonePreset(preset: FrameworkPreset): FrameworkPreset {
  return {
    ...preset,
    types: preset.types.map((type) => ({ ...type }))
  };
}
