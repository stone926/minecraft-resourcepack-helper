import * as path from "node:path";

export function resolveRsglSourceRootFromFileName(fileName: string): string {
  const resolvedFileName = path.resolve(fileName);
  let directory = path.dirname(resolvedFileName);

  while (true) {
    if (path.basename(directory).toLowerCase() === "src") {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return path.dirname(resolvedFileName);
    }
    directory = parent;
  }
}
