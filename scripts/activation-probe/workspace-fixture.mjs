import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

export function createJsonOnlyWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcres-json-only-pack-"));
  const modelDirectory = path.join(root, "assets", "probe", "models", "block");
  mkdirSync(modelDirectory, { recursive: true });
  writeFileSync(
    path.join(root, "pack.mcmeta"),
    JSON.stringify({ pack: { pack_format: 65, description: "Activation probe" } })
  );
  writeFileSync(
    path.join(modelDirectory, "probe.json"),
    JSON.stringify({ parent: "minecraft:block/cube_all" })
  );
  return root;
}

export function assertJsonOnlyWorkspace(workspaceRoot) {
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".rsgl")) {
        throw new Error(`JSON-only activation workspace contains RSGL source: ${entryPath}`);
      }
    }
  };
  visit(workspaceRoot);
}
