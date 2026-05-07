import type { EffectiveFrameworkSchema, FrameworkTypeDefinition } from "./schema.js";
import type { FrontmatterValue } from "../vault/markdown.js";
import type { VaultReader } from "../vault/reader.js";
import type { VaultWriteTools } from "../vault/tools.js";
import type { WriteResult } from "../vault/writer.js";

export interface FrameworkRecordToolsOptions {
  schema: EffectiveFrameworkSchema;
  reader: VaultReader;
  writeTools: VaultWriteTools;
}

export interface CreateRecordInput {
  type: string;
  title: string;
  date?: string;
  body?: string;
  fields?: Record<string, FrontmatterValue>;
}

export interface RecordTypeSummary {
  name: string;
  folder: string;
  description?: string;
}

export interface FrameworkRecordTools {
  create_record(input: CreateRecordInput): Promise<WriteResult>;
  list_record_types(): RecordTypeSummary[];
}

export function createFrameworkRecordTools(
  options: FrameworkRecordToolsOptions
): FrameworkRecordTools {
  return {
    create_record: (input) => createRecord(options, input),
    list_record_types: () => listRecordTypes(options.schema)
  };
}

async function createRecord(
  options: FrameworkRecordToolsOptions,
  input: CreateRecordInput
): Promise<WriteResult> {
  const definition = options.schema.types[input.type];
  if (definition === undefined) {
    throw new Error(`Unknown framework record type: ${input.type}`);
  }

  const date = input.date === undefined ? new Date() : new Date(input.date);
  if (Number.isNaN(date.getTime())) {
    throw new Error("date must be a valid date");
  }

  const path = expandRecordPath(definition, input.title, date);
  const templateBody = await readTemplateBody(options.reader, definition);
  const content = joinBody(templateBody, input.body);
  return options.writeTools.create_note(path, content, {
    type: input.type,
    title: input.title,
    date: formatDate(date, "YYYY-MM-DD"),
    ...(input.fields ?? {})
  });
}

function listRecordTypes(schema: EffectiveFrameworkSchema): RecordTypeSummary[] {
  return Object.entries(schema.types)
    .map(([name, definition]) => {
      const summary: RecordTypeSummary = {
        name,
        folder: definition.folder
      };
      if (definition.description !== undefined) {
        summary.description = definition.description;
      }
      return summary;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function expandRecordPath(
  definition: FrameworkTypeDefinition,
  title: string,
  date: Date
): string {
  const filenamePattern = definition.filename ?? "{title}.md";
  const filename = expandPattern(filenamePattern, title, date);
  return `${definition.folder.replace(/\/$/, "")}/${filename}`;
}

function expandPattern(pattern: string, title: string, date: Date): string {
  return pattern
    .replaceAll("{title}", sanitizeTitle(title))
    .replaceAll("{date:YYYY-MM-DD}", formatDate(date, "YYYY-MM-DD"))
    .replaceAll("{date:YYYY-MM-DD HH-mm}", formatDate(date, "YYYY-MM-DD HH-mm"));
}

function sanitizeTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, "-").trim();
}

async function readTemplateBody(
  reader: VaultReader,
  definition: FrameworkTypeDefinition
): Promise<string> {
  if (definition.template === undefined) {
    return "";
  }
  try {
    return (await reader.readNote(definition.template)).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function joinBody(templateBody: string, body: string | undefined): string {
  if (body === undefined || body.length === 0) {
    return templateBody;
  }
  if (templateBody.length === 0) {
    return body;
  }
  return `${templateBody.replace(/\s+$/, "")}\n\n${body}`;
}

function formatDate(date: Date, format: "YYYY-MM-DD" | "YYYY-MM-DD HH-mm"): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  if (format === "YYYY-MM-DD") {
    return `${year}-${month}-${day}`;
  }
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}-${minute}`;
}
