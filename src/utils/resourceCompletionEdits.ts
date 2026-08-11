export type ResourceCompletionValueSyntax = "jsonString" | "plain";

export interface ResourceCompletionInsertion {
  text: string;
  snippet: boolean;
}

/** Produces syntax-safe completion text before the VS Code adapter wraps snippets. */
export function buildResourceCompletionInsertion(
  value: string,
  syntax: ResourceCompletionValueSyntax,
  insertPrefix: string,
  insertSuffix: string,
  keepCursorBeforeSuffix: boolean
): ResourceCompletionInsertion {
  const encodedValue = syntax === "jsonString" ? encodeJsonStringContent(value) : value;
  if (insertPrefix.length === 0 && insertSuffix.length === 0) {
    return { text: encodedValue, snippet: false };
  }

  const prefix = escapeSnippet(insertPrefix);
  const content = escapeSnippet(encodedValue);
  const suffix = escapeSnippet(insertSuffix);
  return {
    text: keepCursorBeforeSuffix
      ? `${prefix}${content}$0${suffix}`
      : `${prefix}${content}${suffix}$0`,
    snippet: true
  };
}

export function decodeJsonStringContent(value: string): string | null {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return null;
  }
}

function encodeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, "\\$&");
}
