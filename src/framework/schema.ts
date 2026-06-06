import { FRAMEWORK_PRESET_IDS, getFrameworkPreset, type FrameworkPreset, type FrameworkPresetId } from "./presets.js";

export type FrameworkKind = FrameworkPresetId | "custom";
export type SchemaKind = "base" | "overlay";

export interface FrameworkTypeDefinition {
  description?: string;
  folder: string;
  filename?: string;
  template?: string;
  frontmatter?: Record<string, FrameworkFrontmatterDefinition>;
}

export type FrameworkFrontmatterDefaultValue = string | number | boolean | string[];

export interface FrameworkFrontmatterDefinition {
  required?: boolean;
  type?: string;
  format?: string;
  defaultValue?: FrameworkFrontmatterDefaultValue;
}

export interface FrameworkSchema {
  version: 1;
  schemaKind: SchemaKind;
  framework?: FrameworkKind;
  name?: string;
  description?: string;
  extends?: string;
  override: boolean;
  inbox?: {
    folder?: string;
  };
  types: Record<string, FrameworkTypeDefinition>;
}

export interface EffectiveFrameworkSchema extends FrameworkSchema {
  framework: FrameworkKind;
  preset?: FrameworkPreset;
}

type ParsedYamlValue = string | number | boolean | string[] | ParsedYamlObject;
type ParsedYamlObject = { [key: string]: ParsedYamlValue };

const VALID_FRAMEWORKS = [...FRAMEWORK_PRESET_IDS, "custom"] as const;

export function parseFrameworkSchema(source: string): FrameworkSchema {
  const raw = parseYamlSubset(source);
  const version = raw.version;
  if (version !== 1) {
    throw new Error("version must be 1");
  }

  const schemaKind = readSchemaKind(raw.schema_kind);
  const framework = raw.framework === undefined ? undefined : readFramework(raw.framework);
  const types = readTypes(raw.types);

  return withoutUndefined({
    version,
    schemaKind,
    framework,
    name: readOptionalString(raw.name, "name"),
    description: readOptionalString(raw.description, "description"),
    extends: readOptionalString(raw.extends, "extends"),
    override: raw.override === true,
    inbox: readInbox(raw.inbox),
    types
  }) as FrameworkSchema;
}

export function composeFrameworkSchemas(
  base: FrameworkSchema,
  overlays: FrameworkSchema[] = []
): EffectiveFrameworkSchema {
  if (base.schemaKind !== "base") {
    throw new Error("base schema must have schema_kind: base");
  }

  const framework = base.framework ?? "custom";
  const effective: EffectiveFrameworkSchema = withoutUndefined({
    ...base,
    framework,
    preset: framework === "custom" ? undefined : getFrameworkPreset(framework),
    types: cloneTypes(base.types)
  }) as EffectiveFrameworkSchema;

  for (const overlay of overlays) {
    if (overlay.schemaKind !== "overlay") {
      throw new Error("overlay schema must have schema_kind: overlay");
    }
    if (overlay.inbox?.folder !== undefined && overlay.inbox.folder !== base.inbox?.folder) {
      throw new Error("overlay cannot change inbox.folder");
    }

    for (const [name, type] of Object.entries(overlay.types)) {
      if (effective.types[name] !== undefined && !overlay.override) {
        throw new Error(`framework type already exists: ${name}`);
      }
      effective.types[name] = { ...type };
    }
  }

  return effective;
}

function readSchemaKind(value: ParsedYamlValue | undefined): SchemaKind {
  if (value === "base" || value === "overlay") {
    return value;
  }
  throw new Error("schema_kind must be base or overlay");
}

function readFramework(value: ParsedYamlValue): FrameworkKind {
  if (typeof value === "string" && VALID_FRAMEWORKS.includes(value as FrameworkKind)) {
    return value as FrameworkKind;
  }
  throw new Error(`framework must be one of: ${VALID_FRAMEWORKS.join(", ")}`);
}

function readTypes(value: ParsedYamlValue | undefined): Record<string, FrameworkTypeDefinition> {
  if (!isObject(value)) {
    throw new Error("types must be an object");
  }

  const types: Record<string, FrameworkTypeDefinition> = {};
  for (const [name, rawType] of Object.entries(value)) {
    if (!isObject(rawType)) {
      throw new Error(`types.${name} must be an object`);
    }
    const folder = readRequiredString(rawType.folder, `types.${name}.folder`);
    types[name] = withoutUndefined({
      folder,
      description: readOptionalString(rawType.description, `types.${name}.description`),
      filename: readOptionalString(rawType.filename, `types.${name}.filename`),
      template: readOptionalString(rawType.template, `types.${name}.template`),
      frontmatter: readFrontmatter(rawType.frontmatter, `types.${name}.frontmatter`)
    }) as FrameworkTypeDefinition;
  }
  return types;
}

function readFrontmatter(
  value: ParsedYamlValue | undefined,
  name: string
): Record<string, FrameworkFrontmatterDefinition> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error(`${name} must be an object`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([fieldName, rawDefinition]) => [
      fieldName,
      readFrontmatterDefinition(rawDefinition, `${name}.${fieldName}`)
    ])
  );
}

function readFrontmatterDefinition(
  value: ParsedYamlValue,
  name: string
): FrameworkFrontmatterDefinition {
  if (isObject(value)) {
    return withoutUndefined({
      required: readOptionalBoolean(value.required, `${name}.required`),
      type: readOptionalString(value.type, `${name}.type`),
      format: readOptionalString(value.format, `${name}.format`)
    }) as FrameworkFrontmatterDefinition;
  }
  if (isDefaultValue(value)) {
    return { defaultValue: value };
  }
  throw new Error(`${name} must be a field declaration or default value`);
}

function readInbox(value: ParsedYamlValue | undefined): FrameworkSchema["inbox"] {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new Error("inbox must be an object");
  }
  return withoutUndefined({
    folder: readOptionalString(value.folder, "inbox.folder")
  }) as { folder?: string };
}

function readRequiredString(value: ParsedYamlValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: ParsedYamlValue | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value;
}

function readOptionalBoolean(value: ParsedYamlValue | undefined, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function cloneTypes(
  types: Record<string, FrameworkTypeDefinition>
): Record<string, FrameworkTypeDefinition> {
  return Object.fromEntries(Object.entries(types).map(([name, type]) => [name, { ...type }]));
}

function parseYamlSubset(source: string): ParsedYamlObject {
  const root: ParsedYamlObject = {};
  const stack: Array<{ indent: number; object: ParsedYamlObject }> = [{ indent: -1, object: root }];

  for (const rawLine of source.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const trimmed = rawLine.trim();
    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(trimmed);
    if (match === null || match[1] === undefined) {
      continue;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!.object;
    const key = match[1];
    const rawValue = match[2] ?? "";
    if (rawValue.length === 0) {
      const child: ParsedYamlObject = {};
      parent[key] = child;
      stack.push({ indent, object: child });
    } else {
      parent[key] = parseScalar(stripInlineComment(rawValue));
    }
  }

  return root;
}

function stripInlineComment(raw: string): string {
  return raw.replace(/\s+#.*$/, "");
}

function parseScalar(raw: string): string | number | boolean | string[] | ParsedYamlObject {
  const trimmed = raw.trim();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return parseInlineArray(trimmed);
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return parseInlineObject(trimmed);
  }
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && String(asNumber) === trimmed) {
    return asNumber;
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function parseInlineArray(raw: string): string[] {
  const body = raw.slice(1, -1).trim();
  if (body.length === 0) {
    return [];
  }
  return body.split(",").map((item) => item.trim().replace(/^["']|["']$/g, ""));
}

function parseInlineObject(raw: string): ParsedYamlObject {
  const body = raw.slice(1, -1).trim();
  if (body.length === 0) {
    return {};
  }

  const object: ParsedYamlObject = {};
  for (const entry of body.split(",")) {
    const separator = entry.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = entry.slice(0, separator).trim();
    const value = entry.slice(separator + 1).trim();
    object[key] = parseScalar(value);
  }
  return object;
}

function isObject(value: unknown): value is ParsedYamlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefaultValue(value: ParsedYamlValue): value is FrameworkFrontmatterDefaultValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function withoutUndefined<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}
