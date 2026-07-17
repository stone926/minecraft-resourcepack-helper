import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveRsglCompileConfiguration } from "../../src/compiler";
import { semanticProgramMatchesFiles } from "../../src/compiler/compilerHelpers";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";
import { createTempDir } from "./helpers/fs";

describe("RSGL workspace semantic cache", () => {
  it("reuses the bound program while the source graph is unchanged", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-semantic-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "use cube(minecraft:block/stone)"
      ].join("\n"));
      fs.writeFileSync(templatesFile, [
        "template cube(id: ResourceId) {",
        "  model block id { parent minecraft:block/cube_all }",
        "}",
        "export { cube }"
      ].join("\n"));

      const cache = RsglWorkspaceSemanticCache.create();
      const first = cache.loadProgramFromEntry(mainFile);
      const second = cache.loadProgramFromEntry(mainFile);

      assert.strictEqual(second.program, first.program);
      assert.strictEqual(second.files[0], first.files[0]);
      assert.strictEqual(
        first.program.semanticConfigurationFingerprint,
        resolveRsglCompileConfiguration().semanticFingerprint
      );
      assert.deepStrictEqual(second.program.diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebinds only the program when semantic configuration fingerprints change", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-semantic-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      fs.writeFileSync(mainFile, "model block stone { parent minecraft:block/cube_all }");

      const cache = RsglWorkspaceSemanticCache.create();
      const initial = cache.loadProgramFromEntry(mainFile);
      const configurations = [
        resolveRsglCompileConfiguration({ defaultNamespace: "example" }),
        resolveRsglCompileConfiguration({
          projectTarget: {
            edition: "java",
            packFormat: { major: 50, minor: 0 }
          }
        }),
        resolveRsglCompileConfiguration({ maxEvaluationItems: 500 })
      ];
      let previous = initial;

      for (const configuration of configurations) {
        const options = {
          semanticConfigurationFingerprint: configuration.semanticFingerprint
        };
        const rebound = cache.loadProgramFromEntry(mainFile, options);
        const reused = cache.loadProgramFromEntry(mainFile, options);

        assert.notStrictEqual(rebound.program, previous.program);
        assert.strictEqual(
          rebound.files[0],
          initial.files[0],
          "configuration changes must reuse parsed source files"
        );
        assert.strictEqual(rebound.program.semanticConfigurationFingerprint, configuration.semanticFingerprint);
        assert.strictEqual(reused.program, rebound.program);
        assert.strictEqual(semanticProgramMatchesFiles(
          rebound.program,
          [...rebound.program.files],
          configuration.semanticFingerprint
        ), true);
        assert.strictEqual(semanticProgramMatchesFiles(
          rebound.program,
          [...rebound.program.files],
          previous.program.semanticConfigurationFingerprint
        ), false);
        previous = rebound;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("invalidates dependent semantic programs when an imported file changes", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-semantic-");
    try {
      const mainFile = path.join(root, "main.rsgl");
      const templatesFile = path.join(root, "templates.rsgl");
      let templateText = [
        "template cube(id: ResourceId) {",
        "  model block id { parent minecraft:block/cube_all }",
        "}",
        "export { cube }"
      ].join("\n");
      let templateVersion = 1;
      fs.writeFileSync(mainFile, [
        "import { cube } from \"./templates.rsgl\"",
        "use cube(minecraft:block/stone)"
      ].join("\n"));
      fs.writeFileSync(templatesFile, templateText);

      const cache = RsglWorkspaceSemanticCache.create();
      cache.setOpenTextDocumentProvider(fileName => path.normalize(fileName) === path.normalize(templatesFile)
        ? {
          fileName: templatesFile,
          version: templateVersion,
          getText: () => templateText
        }
        : null);

      const first = cache.loadProgramFromEntry(mainFile);
      assert.deepStrictEqual(first.program.diagnostics.map(diagnostic => diagnostic.code), []);

      templateText = [
        "template cube(id: ResourceId, texture: TextureId) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}",
        "export { cube }"
      ].join("\n");
      templateVersion++;
      cache.invalidatePath(templatesFile);

      const second = cache.loadProgramFromEntry(mainFile);
      assert.notStrictEqual(second.program, first.program);
      assert.ok(second.program.diagnostics.some(diagnostic => diagnostic.code === "rsgl.missingArgument"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses semantic programs across Windows path-case variants without changing display paths", function () {
    if (process.platform !== "win32") {
      this.skip();
    }

    const root = createTempDir("mc-resourcepack-helper-rsgl-semantic-case-");
    try {
      const mainFile = path.join(root, "Main.rsgl");
      fs.writeFileSync(mainFile, "let value = 1");

      const cache = RsglWorkspaceSemanticCache.create();
      const first = cache.loadProgramFromEntry(mainFile);
      const second = cache.loadProgramFromEntry(mainFile.toUpperCase());

      assert.strictEqual(second.program, first.program);
      assert.strictEqual(second.files[0], first.files[0]);
      assert.strictEqual(second.files[0].fileName, path.normalize(mainFile));

      cache.invalidatePath(mainFile.toUpperCase());
      const rebound = cache.loadProgramFromEntry(mainFile);
      assert.notStrictEqual(rebound.program, first.program);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses and refreshes bound directory programs", () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-semantic-");
    try {
      const sourceRoot = path.join(root, "src");
      const firstFile = path.join(sourceRoot, "first.rsgl");
      const secondFile = path.join(sourceRoot, "nested", "second.rsgl");
      fs.mkdirSync(path.dirname(secondFile), { recursive: true });
      fs.writeFileSync(firstFile, "model block stone { parent minecraft:block/cube_all }");

      const cache = RsglWorkspaceSemanticCache.create();
      const first = cache.loadProgramFromDirectory(sourceRoot);
      const second = cache.loadProgramFromDirectory(sourceRoot);

      assert.strictEqual(second.program, first.program);
      assert.strictEqual(second.files[0], first.files[0]);
      assert.deepStrictEqual(second.files.map(file => path.normalize(file.fileName)), [path.normalize(firstFile)]);

      const configuredFingerprint = resolveRsglCompileConfiguration({
        defaultNamespace: "example"
      }).semanticFingerprint;
      const configured = cache.loadProgramFromDirectory(sourceRoot, {
        semanticConfigurationFingerprint: configuredFingerprint
      });
      const configuredAgain = cache.loadProgramFromDirectory(sourceRoot, {
        semanticConfigurationFingerprint: configuredFingerprint
      });
      assert.notStrictEqual(configured.program, first.program);
      assert.strictEqual(configured.files[0], first.files[0]);
      assert.strictEqual(configuredAgain.program, configured.program);

      fs.writeFileSync(secondFile, "model block granite { parent minecraft:block/cube_all }");
      cache.invalidatePath(secondFile);
      const third = cache.loadProgramFromDirectory(sourceRoot);

      assert.notStrictEqual(third.program, first.program);
      assert.deepStrictEqual(third.files.map(file => path.normalize(file.fileName)), [
        path.normalize(firstFile),
        path.normalize(secondFile)
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
