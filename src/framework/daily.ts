import type { ReadNoteResult, VaultReader } from "../vault/reader.js";
import type { VaultWriteTools } from "../vault/tools.js";
import { VaultWriteError } from "../vault/writer.js";

export interface DailyNoteSectionConfig {
  name: string;
  markerName: string;
  writable: boolean;
  defaultForAppend?: boolean;
}

export interface DailyNoteConfig {
  path: string;
  template?: string;
  sections: DailyNoteSectionConfig[];
}

export interface DailyNoteToolsOptions {
  reader: VaultReader;
  writeTools: VaultWriteTools;
  config: DailyNoteConfig;
}

export interface DailyNoteDateInput {
  date?: string;
}

export interface DailyNoteAppendInput extends DailyNoteDateInput {
  section?: string;
  content: string;
  baseSha256: string;
}

export interface DailyNoteRepairMarkersInput extends DailyNoteDateInput {
  baseSha256: string;
}

export interface DailyNoteTools {
  daily_note_get(input?: DailyNoteDateInput): Promise<ReadNoteResult>;
  daily_note_append(input: DailyNoteAppendInput): Promise<ReadNoteResult>;
  daily_note_repair_markers(input: DailyNoteRepairMarkersInput): Promise<ReadNoteResult>;
}

export function createDailyNoteTools(options: DailyNoteToolsOptions): DailyNoteTools {
  return {
    daily_note_get: (input = {}) => dailyNoteGet(options, input),
    daily_note_append: (input) => dailyNoteAppend(options, input),
    daily_note_repair_markers: (input) => dailyNoteRepairMarkers(options, input)
  };
}

async function dailyNoteGet(
  options: DailyNoteToolsOptions,
  input: DailyNoteDateInput
): Promise<ReadNoteResult> {
  const dailyPath = dailyPathFor(options.config, input.date);
  try {
    return await options.reader.readNote(dailyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const template = await readTemplate(options);
  await options.writeTools.create_note(dailyPath, template);
  return options.reader.readNote(dailyPath);
}

async function dailyNoteAppend(
  options: DailyNoteToolsOptions,
  input: DailyNoteAppendInput
): Promise<ReadNoteResult> {
  const dailyPath = dailyPathFor(options.config, input.date);
  const note = await options.reader.readNote(dailyPath);
  const section = findAppendSection(options.config, input.section);
  if (!section.writable) {
    throw new DailyNoteError("section_not_writable", `Daily note section is not writable: ${section.name}`);
  }
  const currentSectionContent = extractMarkerContent(note.content, section.markerName);
  const nextSectionContent = appendContent(currentSectionContent, input.content);
  await options.writeTools.replace_section_by_marker(
    dailyPath,
    section.markerName,
    nextSectionContent,
    input.baseSha256
  );
  return options.reader.readNote(dailyPath);
}

async function dailyNoteRepairMarkers(
  options: DailyNoteToolsOptions,
  input: DailyNoteRepairMarkersInput
): Promise<ReadNoteResult> {
  const dailyPath = dailyPathFor(options.config, input.date);
  const note = await options.reader.readNote(dailyPath);
  const template = await readTemplate(options);
  const missingBlocks = options.config.sections
    .map((section) => section.markerName)
    .filter((markerName) => !hasMarkerBlock(note.content, markerName))
    .map((markerName) => extractMarkerBlock(template, markerName))
    .filter((block): block is string => block !== undefined);

  if (missingBlocks.length === 0) {
    return note;
  }

  const repaired = `${note.content.replace(/\s+$/, "")}\n\n${missingBlocks.join("\n\n")}\n`;
  await options.writeTools.replace_note(dailyPath, repaired, input.baseSha256);
  return options.reader.readNote(dailyPath);
}

function dailyPathFor(config: DailyNoteConfig, rawDate: string | undefined): string {
  const date = rawDate === undefined ? new Date() : new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date must be a valid date");
  }
  return config.path.replaceAll("{date:YYYY-MM-DD}", formatDate(date));
}

async function readTemplate(options: DailyNoteToolsOptions): Promise<string> {
  if (options.config.template === undefined) {
    return "";
  }
  return (await options.reader.readNote(options.config.template)).content;
}

function findAppendSection(
  config: DailyNoteConfig,
  name: string | undefined
): DailyNoteSectionConfig {
  const section =
    name === undefined
      ? config.sections.find((candidate) => candidate.defaultForAppend === true)
      : config.sections.find((candidate) => candidate.name === name);
  if (section === undefined) {
    throw new DailyNoteError("section_missing", `Daily note section is not configured: ${name ?? "default"}`);
  }
  return section;
}

function extractMarkerContent(content: string, markerName: string): string {
  const startMarker = `<!-- mcp:section ${markerName} start -->`;
  const endMarker = `<!-- mcp:section ${markerName} end -->`;
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new VaultWriteError("markers_missing", `Markers missing for section: ${markerName}`);
  }
  return content.slice(start + startMarker.length, end).trim();
}

function appendContent(currentContent: string, nextContent: string): string {
  if (currentContent.length === 0) {
    return nextContent;
  }
  return `${currentContent.replace(/\s+$/, "")}\n${nextContent}`;
}

function hasMarkerBlock(content: string, markerName: string): boolean {
  return (
    content.includes(`<!-- mcp:section ${markerName} start -->`) &&
    content.includes(`<!-- mcp:section ${markerName} end -->`)
  );
}

function extractMarkerBlock(content: string, markerName: string): string | undefined {
  const startMarker = `<!-- mcp:section ${markerName} start -->`;
  const endMarker = `<!-- mcp:section ${markerName} end -->`;
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  return content.slice(start, end + endMarker.length);
}

function formatDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export type DailyNoteErrorCode = "section_missing" | "section_not_writable";

export class DailyNoteError extends Error {
  readonly code: DailyNoteErrorCode;

  constructor(code: DailyNoteErrorCode, message: string) {
    super(message);
    this.name = "DailyNoteError";
    this.code = code;
  }
}
