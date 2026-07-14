export interface SequenceExpansionOptions {
  pad?: number | null;
}

export function expandSequencePattern(pattern: string, options: SequenceExpansionOptions = {}): string[] {
  const match = /\{(-?\d+)\.\.(-?\d+)\}/.exec(pattern);
  if (!match) {
    return [pattern];
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const width = options.pad ?? inferredRangeWidth(match[1], match[2]);
  const step = start <= end ? 1 : -1;
  const itemCount = sequencePatternExpansionCount(pattern);
  if (!Number.isSafeInteger(itemCount)) {
    return [];
  }
  const result = new Array<string>(itemCount);
  for (let index = 0; index < itemCount; index += 1) {
    const value = start + index * step;
    result[index] = pattern.replace(match[0], formatSequenceNumber(value, width));
  }
  return result;
}

/** Returns the first range expansion cardinality without allocating it. */
export function sequencePatternExpansionCount(pattern: string): number {
  const match = /\{(-?\d+)\.\.(-?\d+)\}/.exec(pattern);
  if (!match) {
    return 1;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return Number.POSITIVE_INFINITY;
  }
  const count = Math.abs(end - start) + 1;
  return Number.isSafeInteger(count) ? count : Number.POSITIVE_INFINITY;
}

export function formatSequenceNumber(value: number, width: number | null | undefined): string {
  if (!width || width <= 0) {
    return String(value);
  }
  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(value)).padStart(width, "0")}`;
}

export function sequencePadWidth(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function inferredRangeWidth(start: string, end: string): number {
  const widths = [start, end].map(explicitWidth).filter((width): width is number => width !== null);
  return widths.length > 0 ? Math.max(...widths) : 0;
}

function explicitWidth(value: string): number | null {
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  return /^0\d+$/.test(unsigned) ? unsigned.length : null;
}
