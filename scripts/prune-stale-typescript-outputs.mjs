#!/usr/bin/env node

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/moduleIdentity.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const outputRoot = path.join(repositoryRoot, "out");
const emittedSuffixes = Object.freeze([".d.ts.map", ".js.map", ".d.ts", ".js"]);

export function sourcePathForTypeScriptOutput(fileName, options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const out = options.outputRoot ?? path.join(root, "out");
  const relative = path.relative(out, fileName);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  const suffix = emittedSuffixes.find(candidate => relative.endsWith(candidate));
  if (!suffix) {
    return null;
  }
  return path.join(root, `${relative.slice(0, -suffix.length)}.ts`);
}

export function pruneStaleTypeScriptOutputs(options = {}) {
  const root = options.repositoryRoot ?? repositoryRoot;
  const out = options.outputRoot ?? path.join(root, "out");
  if (!existsSync(out)) {
    return Object.freeze({ removedFiles: 0, removedDirectories: 0 });
  }

  let removedFiles = 0;
  let removedDirectories = 0;
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fileName = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fileName);
        if (readdirSync(fileName).length === 0) {
          rmSync(fileName, { recursive: false });
          removedDirectories++;
        }
        continue;
      }
      const sourcePath = sourcePathForTypeScriptOutput(fileName, {
        repositoryRoot: root,
        outputRoot: out
      });
      const declarationInput = fileName.endsWith(".d.ts")
        ? path.join(root, path.relative(out, fileName))
        : null;
      if (sourcePath && !existsSync(sourcePath)
        && (!declarationInput || !existsSync(declarationInput))) {
        rmSync(fileName);
        removedFiles++;
      }
    }
  };
  visit(out);
  return Object.freeze({ removedFiles, removedDirectories });
}

if (isMainModule(import.meta.url)) {
  const result = pruneStaleTypeScriptOutputs();
  console.log(
    `Pruned ${result.removedFiles} stale TypeScript outputs and `
      + `${result.removedDirectories} empty directories.`
  );
}
