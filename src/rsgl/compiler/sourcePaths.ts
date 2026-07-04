export function appendGeneratedPath(path: string, segment: string): string {
  return `${path}/${escapeGeneratedPathSegment(segment)}`;
}

export function joinGeneratedPath(path: string, generatedPath: string): string {
  if (!path) {
    return generatedPath;
  }
  if (!generatedPath) {
    return path;
  }
  return `${path}${generatedPath.startsWith("/") ? generatedPath : `/${generatedPath}`}`;
}

export function prefixGeneratedPath(generatedPath: string, pathPrefix: string): string {
  return generatedPath ? joinGeneratedPath(pathPrefix, generatedPath) : pathPrefix;
}

function escapeGeneratedPathSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
