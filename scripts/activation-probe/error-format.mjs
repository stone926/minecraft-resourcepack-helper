export function formatErrorWithCauses(value) {
  const rendered = [];
  const seen = new Set();
  let current = value;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const details = current instanceof Error
      ? current.stack ?? `${current.name}: ${current.message}`
      : String(current);
    rendered.push(rendered.length === 0 ? details : `Caused by:\n${details}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  return rendered.join("\n");
}
