#!/usr/bin/env node

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const stdlibSource = path.join(repositoryRoot, "packages", "rsgl-core", "src", "stdlib", "rsgl");

const targetDefinitions = {
  main: {
    builds: [
      {
        entryPoint: "src/extension.ts",
        outfile: "bundle/extension.js",
        external: ["vscode"]
      }
    ],
    cleanRoots: ["bundle"]
  },
  rsgl: {
    builds: [
      {
        entryPoint: "extensions/vscode-rsgl/src/extension.ts",
        outfile: "extensions/vscode-rsgl/bundle/extension.js",
        external: ["vscode"]
      },
      {
        entryPoint: "packages/rsgl-lsp/src/server.ts",
        outfile: "extensions/vscode-rsgl/bundle/server.js"
      },
      {
        entryPoint: "extensions/vscode-rsgl/src/commands/buildWorker.ts",
        outfile: "extensions/vscode-rsgl/bundle/worker.js"
      }
    ],
    cleanRoots: ["extensions/vscode-rsgl/bundle"],
    stdlibTargets: ["extensions/vscode-rsgl/bundle/rsgl"]
  },
  cli: {
    builds: [
      {
        entryPoint: "packages/rsgl-cli/src/main.ts",
        outfile: "packages/rsgl-cli/dist/rsgl.js",
        banner: "#!/usr/bin/env node",
        target: "node20"
      }
    ],
    cleanRoots: ["packages/rsgl-cli/dist"],
    stdlibTargets: ["packages/rsgl-cli/dist/rsgl"]
  }
};

const requestedTargets = process.argv.slice(2);
const targetNames = requestedTargets.length > 0 ? requestedTargets : Object.keys(targetDefinitions);
for (const targetName of targetNames) {
  if (!(targetName in targetDefinitions)) {
    throw new Error(`Unknown bundle target '${targetName}'. Expected main, rsgl, or cli.`);
  }
}

for (const targetName of targetNames) {
  const target = targetDefinitions[targetName];
  for (const cleanRoot of target.cleanRoots) {
    rmSync(path.join(repositoryRoot, cleanRoot), { recursive: true, force: true });
  }

  for (const definition of target.builds) {
    const outfile = path.join(repositoryRoot, definition.outfile);
    mkdirSync(path.dirname(outfile), { recursive: true });
    await build({
      absWorkingDir: repositoryRoot,
      entryPoints: [definition.entryPoint],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: definition.target ?? "node22",
      sourcemap: "external",
      sourcesContent: false,
      charset: "utf8",
      legalComments: "none",
      logLevel: "warning",
      external: definition.external ?? [],
      banner: definition.banner ? { js: definition.banner } : undefined
    });
  }

  for (const stdlibTarget of target.stdlibTargets ?? []) {
    const absoluteTarget = path.join(repositoryRoot, stdlibTarget);
    mkdirSync(path.dirname(absoluteTarget), { recursive: true });
    if (existsSync(stdlibSource)) {
      cpSync(stdlibSource, absoluteTarget, { recursive: true });
    } else {
      mkdirSync(absoluteTarget, { recursive: true });
    }
  }
}
