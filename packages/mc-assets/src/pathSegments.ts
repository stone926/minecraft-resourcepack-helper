/**
 * Tests whether a relative path begins with the requested complete segment.
 * Both Windows and POSIX separators are accepted so resource paths remain
 * portable when they originate in configuration or document text.
 */
export function startsWithPathSegment(value: string, segment: string): boolean {
  const separator = value.search(/[\\/]/);
  const firstSegment = separator < 0 ? value : value.slice(0, separator);
  return firstSegment.length > 0 && firstSegment.toLowerCase() === segment.toLowerCase();
}
