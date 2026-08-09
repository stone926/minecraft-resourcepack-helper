export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

/** Selects a direct CommonJS-shaped export or its ESM default wrapper. */
export function moduleExportWithFunction(
  value: unknown,
  functionName: string
): Record<string, unknown> | undefined {
  const direct = asRecord(value);
  if (typeof direct?.[functionName] === "function") {
    return direct;
  }
  const defaultExport = asRecord(direct?.default);
  return typeof defaultExport?.[functionName] === "function" ? defaultExport : undefined;
}
