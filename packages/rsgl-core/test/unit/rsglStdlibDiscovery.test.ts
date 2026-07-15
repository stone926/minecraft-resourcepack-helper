import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { compileRsglFile, compileRsglProgram, loadRsglSourceFilesFromFile } from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { createAllRsglStdlibSourceFiles } from "../../src/stdlib";
import { expectNoDiagnostics, withUncheckedExterns } from "./helpers/compile";
import { createTempDir, withTempDir } from "./helpers/fs";

describe("RSGL stdlib discovery", () => {
  it("discovers bundled stdlib files from disk without a TypeScript list", () => {
    withTempDir(stdlibRoot => {
      fs.writeFileSync(path.join(stdlibRoot, "__dynamic_test.rsgl"), [
        "template dynamicStdlibCube(id: ResourceId) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "  }",
        "}",
        "export { dynamicStdlibCube }"
      ].join("\n"));

      const stdlibFiles = createAllRsglStdlibSourceFiles({ stdlibRoot });
      assert.ok(stdlibFiles.some(file => file.fileName === path.join("<rsgl-stdlib>", "__dynamic_test.rsgl")));

      const mainFile = path.resolve("pack", "main.rsgl");
      const result = compileRsglProgram([
        {
          fileName: mainFile,
          module: parseRsgl([
            "import { dynamicStdlibCube } from \"rsgl:__dynamic_test.rsgl\"",
            "use dynamicStdlibCube(stone)"
          ].join("\n"))
        }
      ], withUncheckedExterns({ entryFileName: mainFile, stdlibRoot }));

      expectNoDiagnostics(result);
      assert.deepStrictEqual(result.units.filter(unit => !unit.external).map(unit => unit.outputPath), [
        "assets/minecraft/models/block/stone.json"
      ]);
    });
  });

  it("creates stdlib prelude templates once per program compile", () => {
    const pipelineSource = fs.readFileSync(
      path.join(process.cwd(), "packages", "rsgl-core", "src", "compiler", "compilePipeline.ts"),
      "utf8"
    );
    const compilerSource = fs.readFileSync(
      path.join(process.cwd(), "packages", "rsgl-core", "src", "compiler", "compiler.ts"),
      "utf8"
    );

    const preludeCreation = pipelineSource.indexOf("const stdlibTemplates = createRsglStdlibPreludeTemplates");
    const modelLoop = pipelineSource.indexOf("for (const model of selectedModels)");
    assert.ok(preludeCreation >= 0, "compileRsglProgram should precompute stdlib templates");
    assert.ok(modelLoop > preludeCreation, "stdlib templates must be created outside the per-model compile loop");
    assert.ok(pipelineSource.includes("stdlibTemplates,"));
    assert.ok(compilerSource.includes("this.options.stdlibTemplates ?? createRsglStdlibPreludeTemplates"));
  });

  it("does not load project rsgl-std modules for rsgl imports", () => {
    const root = createTempDir();
    const mainFile = path.join(root, "main.rsgl");
    const projectStdlibFile = path.join(root, "rsgl-std", "project-only", "template.rsgl");
    fs.mkdirSync(path.dirname(projectStdlibFile), { recursive: true });
    fs.writeFileSync(mainFile, [
      "import { projectOnly } from \"rsgl:project-only/template.rsgl\"",
      "blockstate variants custom_state {",
      "  use projectOnly(model: minecraft:block/custom)",
      "}"
    ].join("\n"));
    fs.writeFileSync(projectStdlibFile, [
      "template projectOnly(model: ModelId) -> variants {",
      "  case { custom: \"project\" } => model",
      "}",
      "export { projectOnly }"
    ].join("\n"));

    const loadedFiles = loadRsglSourceFilesFromFile(mainFile);
    const result = compileRsglFile(mainFile);

    assert.deepStrictEqual(loadedFiles.map(file => file.fileName), [path.normalize(path.resolve(mainFile))]);
    assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingImport"));
    assert.strictEqual(result.units.some(unit =>
      unit.sourceMap.mappings.some(mapping => mapping.sourceFile === path.normalize(projectStdlibFile))
    ), false);
  });
});
