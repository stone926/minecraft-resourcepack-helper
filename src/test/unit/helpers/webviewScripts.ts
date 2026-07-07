import * as fs from "node:fs";
import * as path from "node:path";

export interface WebviewScript {
  fileName: string;
  source: string;
}

export function readModelPreviewScripts(): WebviewScript[] {
  const root = path.join(process.cwd(), "webviews", "modelPreview");
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => ({
      fileName: entry.name,
      source: fs.readFileSync(path.join(root, entry.name), "utf8")
    }));
}

export function readCombinedModelPreviewScript(): string {
  return readModelPreviewScripts().map(script => script.source).join("\n");
}
