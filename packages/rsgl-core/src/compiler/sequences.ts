export function expandSequencePattern(pattern: string): string[] {
  const match = /\{(-?\d+)\.\.(-?\d+)\}/.exec(pattern);
  if (!match) {
    return [pattern];
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const width = match[1].startsWith("0") || match[2].startsWith("0")
    ? Math.max(match[1].length, match[2].length)
    : 0;
  const step = start <= end ? 1 : -1;
  const result: string[] = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) {
    result.push(pattern.replace(match[0], String(value).padStart(width, "0")));
  }
  return result;
}
