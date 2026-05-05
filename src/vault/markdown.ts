export type FrontmatterValue = string | number | boolean | string[];

export interface ParsedMarkdown {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
  title: string | undefined;
  tags: string[];
  aliases: string[];
  sourceId: string | undefined;
  outgoingLinks: string[];
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const { frontmatter, body } = splitFrontmatter(source);
  const title = extractTitle(body) ?? stringValue(frontmatter.title);
  const tags = unique([
    ...arrayValue(frontmatter.tags),
    ...arrayValue(frontmatter.tag),
    ...extractBodyTags(body)
  ]);
  const aliases = arrayValue(frontmatter.aliases);
  const sourceId = stringValue(frontmatter.source_id);

  return {
    frontmatter,
    body,
    title,
    tags,
    aliases,
    sourceId,
    outgoingLinks: extractOutgoingLinks(body)
  };
}

function splitFrontmatter(source: string): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  if (!source.startsWith("---\n")) {
    return { frontmatter: {}, body: source };
  }

  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    return { frontmatter: {}, body: source };
  }

  const frontmatterSource = source.slice(4, end);
  const body = source.slice(end + "\n---".length).replace(/^\n/, "");
  return {
    frontmatter: parseFrontmatter(frontmatterSource),
    body
  };
}

function parseFrontmatter(source: string): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  const lines = source.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (match === null) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2] ?? "";
    if (key === undefined) {
      continue;
    }

    if (rawValue.length === 0) {
      const items: string[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const itemMatch = /^\s*-\s+(.+)$/.exec(lines[cursor] ?? "");
        if (itemMatch === null) {
          break;
        }
        const item = itemMatch[1];
        if (item !== undefined) {
          items.push(stripQuotes(item));
        }
        cursor += 1;
      }
      if (items.length > 0) {
        result[key] = items;
        index = cursor - 1;
      } else {
        result[key] = "";
      }
      continue;
    }

    result[key] = parseScalarOrInlineArray(rawValue);
  }

  return result;
}

function parseScalarOrInlineArray(rawValue: string): FrontmatterValue {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) {
      return [];
    }
    return inner.split(",").map((item) => stripQuotes(item.trim()));
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  const asNumber = Number(trimmed);
  if (trimmed.length > 0 && Number.isFinite(asNumber) && String(asNumber) === trimmed) {
    return asNumber;
  }
  return stripQuotes(trimmed);
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function extractTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined) {
      return match[1].trim();
    }
  }
  return undefined;
}

function extractBodyTags(body: string): string[] {
  return [...body.matchAll(/(?:^|\s)#([A-Za-z0-9_/-]+)/g)]
    .map((match) => match[1])
    .filter((tag): tag is string => tag !== undefined);
}

function extractOutgoingLinks(body: string): string[] {
  return unique(
    [...body.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)]
      .map((match) => match[1])
      .filter((link): link is string => link !== undefined)
      .map((link) => link.trim())
  );
}

function stringValue(value: FrontmatterValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayValue(value: FrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  return [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
