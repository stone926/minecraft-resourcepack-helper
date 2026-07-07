const defaultCitNamespace = "citresewn:";

export function stripDefaultCitNamespace(key: string): string {
  if (key.startsWith(defaultCitNamespace)) {
    return key.slice(defaultCitNamespace.length);
  }
  if (key.startsWith(":")) {
    return key.slice(1);
  }
  return key;
}
