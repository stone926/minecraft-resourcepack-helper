import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRsglWritePlan, emitRsglFiles, parseResourceId, stableJsonStringify, type JsonValue, writeRsglFiles } from "../../src/compiler";
import { compileSource, emittedContent, expectDiagnosticCodes, expectNoDiagnostics } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL compiler emit and write pipeline", () => {
  it("uses shared Minecraft resource id rules for compiler ids", () => {
    assert.deepStrictEqual(parseResourceId("example:block//stone"), {
      namespace: "example",
      path: "block/stone"
    });
    assert.deepStrictEqual(parseResourceId("block\\stone", "example"), {
      namespace: "example",
      path: "block/stone"
    });
    assert.strictEqual(parseResourceId("example:../outside"), null);
    assert.strictEqual(parseResourceId("example:block/Stone"), null);
    assert.strictEqual(parseResourceId("example:block:name"), null);
  });

  it("emits explicit model, item, and blockstate resources", () => {
    const result = compileSource([
      "namespace minecraft",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/stone }",
      "}",
      "item diamond {",
      "  model minecraft:item/diamond",
      "}",
      "blockstate stone {",
      "  variants {",
      "    {} -> { model: minecraft:block/stone }",
      "  }",
      "}"
    ], { fileName: "pack/rsgl/main.rsgl" });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/blockstates/stone.json",
      "assets/minecraft/items/diamond.json",
      "assets/minecraft/models/block/stone.json"
    ]);

    const model = result.units.find(unit => unit.kind === "model");
    assert.ok(model);
    assert.strictEqual(stableJsonStringify(model.content as JsonValue, model.kind), [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const item = result.units.find(unit => unit.kind === "item");
    assert.deepStrictEqual(item?.content, {
      model: {
        type: "minecraft:model",
        model: "minecraft:item/diamond"
      }
    });
  });

  it("emits numeric and quoted model texture keys", () => {
    const result = compileSource([
      "model block numbered_textures {",
      "  parent minecraft:block/cube_all",
      "  textures {",
      "    0: minecraft:block/zero",
      "    \"1\": minecraft:block/one",
      "    particle: minecraft:block/particle",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        "0": "minecraft:block/zero",
        "1": "minecraft:block/one",
        particle: "minecraft:block/particle"
      }
    });
  });

  it("emits deterministic files with source maps and manifest", () => {
    const result = compileSource([
      "namespace minecraft",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/stone }",
      "}"
    ], { fileName: path.resolve("pack", "main.rsgl") });

    expectNoDiagnostics(result);
    const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
    assert.deepStrictEqual(files.map(file => file.outputPath), [
      "assets/minecraft/models/block/stone.json",
      "assets/minecraft/models/block/stone.json.rsgl.map",
      "rsgl.manifest.json"
    ]);

    assert.strictEqual(emittedContent(files[0]), [
      "{",
      "  \"parent\": \"minecraft:block/cube_all\",",
      "  \"textures\": {",
      "    \"all\": \"minecraft:block/stone\"",
      "  }",
      "}",
      ""
    ].join("\n"));

    const sourceMap = JSON.parse(emittedContent(files[1])) as {
      version?: number;
      generatedFile?: string;
      mappings?: Array<{ generatedPath?: string; sourceFile?: string; reason?: string }>;
    };
    assert.strictEqual(sourceMap.version, 1);
    assert.strictEqual(sourceMap.generatedFile, "assets/minecraft/models/block/stone.json");
    assert.deepStrictEqual(sourceMap.mappings?.map(mapping => mapping.generatedPath), [
      "",
      "/parent",
      "/textures",
      "/textures/all"
    ]);
    assert.strictEqual(sourceMap.mappings?.[0]?.sourceFile, path.resolve("pack", "main.rsgl"));
    assert.strictEqual(sourceMap.mappings?.[0]?.reason, "direct");

    const manifest = JSON.parse(emittedContent(files[2])) as {
      files?: Array<{ outputPath?: string; sourceMap?: string }>;
    };
    assert.deepStrictEqual(manifest.files, [{
      outputPath: "assets/minecraft/models/block/stone.json",
      kind: "model",
      id: "minecraft:block/stone",
      sourceMap: "assets/minecraft/models/block/stone.json.rsgl.map"
    }]);
  });

  it("emits text resources without JSON stringification", () => {
    const result = compileSource([
      "namespace minecraft",
      "let player = \"PLAYERNAME\"",
      "text texts/end {",
      "  content `Good luck, ${player}\\n`",
      "}",
      "text \"assets/minecraft/texts/splashes.txt\" {",
      "  content \"Generated splash\"",
      "}"
    ], { fileName: path.resolve("pack", "main.rsgl") });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
      "assets/minecraft/texts/end.txt",
      "assets/minecraft/texts/splashes.txt"
    ]);

    const endText = result.units.find(unit => unit.outputPath.endsWith("end.txt"));
    assert.deepStrictEqual(endText?.content, {
      kind: "text",
      text: "Good luck, PLAYERNAME\\n"
    });
    const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
    assert.strictEqual(emittedContent(files.find(file => file.outputPath.endsWith("end.txt"))), "Good luck, PLAYERNAME\\n");

    const sourceMap = JSON.parse(emittedContent(files.find(file => file.outputPath.endsWith("end.txt.rsgl.map")))) as {
      mappings?: Array<{ generatedPath?: string; sourceFile?: string }>;
    };
    assert.deepStrictEqual(sourceMap.mappings?.map(mapping => mapping.generatedPath), ["", ""]);
    assert.strictEqual(sourceMap.mappings?.[0]?.sourceFile, path.resolve("pack", "main.rsgl"));

    const manifest = JSON.parse(emittedContent(files.find(file => file.outputPath === "rsgl.manifest.json"))) as {
      files?: Array<{ outputPath?: string; kind?: string; id?: string }>;
    };
    assert.ok(manifest.files?.some(file =>
      file.outputPath === "assets/minecraft/texts/end.txt" &&
      file.kind === "text" &&
      file.id === "minecraft:texts/end"
    ));
  });

  it("reports invalid text resource bodies", () => {
    const result = compileSource([
      "text \"../outside.txt\" { content \"bad\" }",
      "text valid {",
      "  content [1, 2]",
      "  extra true",
      "}"
    ]);
    const codes = result.diagnostics.map(diagnostic => diagnostic.code);

    assert.ok(codes.includes("rsgl.compileInvalidTextTarget"));
    assert.ok(codes.includes("rsgl.invalidTextContent"));
    assert.ok(codes.includes("rsgl.invalidTextResourceField"));
  });

  it("keeps copy-shaped JSON content on the JSON emit path", () => {
    const result = compileSource([
      "model block copy_shape {",
      "  kind \"copy\"",
      "  sourcePath \"textures/source.png\"",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.strictEqual(emittedContent(emitRsglFiles(result.units)[0]), [
      "{",
      "  \"kind\": \"copy\",",
      "  \"sourcePath\": \"textures/source.png\"",
      "}",
      ""
    ].join("\n"));
  });

  it("emits and writes binary copy resources", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "source.png");
      const entryFile = path.join(root, "main.rsgl");
      const outputRoot = path.join(root, "out");
      const sourceBytes = Buffer.from([0, 1, 2, 255]);
      fs.writeFileSync(sourceFile, sourceBytes);

      const result = compileSource([
        "namespace minecraft",
        "copy \"pack.png\" {",
        "  from \"source.png\"",
        "}",
        "copy minecraft:textures/block/copied.png {",
        "  from \"source.png\"",
        "}"
      ], { fileName: entryFile });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(result.units.map(unit => unit.outputPath).sort(), [
        "assets/minecraft/textures/block/copied.png",
        "pack.png"
      ]);
      assert.deepStrictEqual(result.units.find(unit => unit.outputPath === "pack.png")?.content, {
        kind: "copy",
        sourcePath: sourceFile
      });

      const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
      const copyFile = files.find(file => file.outputPath === "pack.png");
      assert.ok(copyFile && "copyFrom" in copyFile);
      assert.strictEqual(copyFile.copyFrom, sourceFile);

      const written = writeRsglFiles(files, outputRoot);
      assert.deepStrictEqual(written.summary, { create: 5, update: 0, unchanged: 0 });
      assert.deepStrictEqual(fs.readFileSync(path.join(outputRoot, "pack.png")), sourceBytes);
      assert.deepStrictEqual(fs.readFileSync(path.join(outputRoot, "assets", "minecraft", "textures", "block", "copied.png")), sourceBytes);

      const unchanged = createRsglWritePlan(files, outputRoot);
      assert.deepStrictEqual(unchanged.summary, { create: 0, update: 0, unchanged: 5 });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports invalid binary copy resources", () => {
    const root = createTempDir();
    try {
      const result = compileSource([
        "copy \"bad:name\" { from \"missing.bin\" }",
        "copy \"pack.png\" {",
        "  from [1]",
        "  extra true",
        "}",
        "copy \"assets/minecraft/textures/block/missing.png\" {",
        "  from \"missing.bin\"",
        "}"
      ], { fileName: path.join(root, "main.rsgl") });
      const codes = result.diagnostics.map(diagnostic => diagnostic.code);

      assert.ok(codes.includes("rsgl.compileInvalidCopyTarget"));
      assert.ok(codes.includes("rsgl.invalidCopySource"));
      assert.ok(codes.includes("rsgl.invalidCopyResourceField"));
      assert.ok(codes.includes("rsgl.copySourceNotFound"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("references external resources without emitting files", () => {
    const result = compileSource([
      "extern model(id: minecraft:block/stone)",
      "extern blockstate(id: minecraft:stone)",
      "extern item(id: minecraft:stone)"
    ], {
      resourceExists: () => true
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(result.units.map(unit => ({
      kind: unit.kind,
      outputPath: unit.outputPath,
      external: unit.external
    })), [
      {
        kind: "model",
        outputPath: "assets/minecraft/models/block/stone.json",
        external: { kind: "external", resourceKind: "model", id: "minecraft:block/stone" }
      },
      {
        kind: "blockstate",
        outputPath: "assets/minecraft/blockstates/stone.json",
        external: { kind: "external", resourceKind: "blockstate", id: "minecraft:stone" }
      },
      {
        kind: "item",
        outputPath: "assets/minecraft/items/stone.json",
        external: { kind: "external", resourceKind: "item", id: "minecraft:stone" }
      }
    ]);

    const files = emitRsglFiles(result.units, { sourceMaps: true, manifest: true });
    assert.deepStrictEqual(files.map(file => file.outputPath), ["rsgl.manifest.json"]);
    const manifest = JSON.parse(emittedContent(files[0])) as {
      files?: unknown[];
      externalResources?: Array<{ outputPath?: string; kind?: string; id?: string; source?: { kind?: string; id?: string } }>;
    };
    assert.deepStrictEqual(manifest.files, []);
    assert.deepStrictEqual(manifest.externalResources, [
      {
        outputPath: "assets/minecraft/blockstates/stone.json",
        kind: "blockstate",
        id: "minecraft:stone",
        source: { kind: "blockstate", id: "minecraft:stone" }
      },
      {
        outputPath: "assets/minecraft/items/stone.json",
        kind: "item",
        id: "minecraft:stone",
        source: { kind: "item", id: "minecraft:stone" }
      },
      {
        outputPath: "assets/minecraft/models/block/stone.json",
        kind: "model",
        id: "minecraft:block/stone",
        source: { kind: "model", id: "minecraft:block/stone" }
      }
    ]);
  });

  it("validates missing external resource references", () => {
    const result = compileSource([
      "extern model(id: minecraft:block/missing_model)",
      "extern blockstate(id: minecraft:missing_block)",
      "extern item(id: minecraft:missing_item)"
    ], {
      resourceExists: () => false
    });

    expectDiagnosticCodes(result, [
      "rsgl.modelNotFound",
      "rsgl.blockstateNotFound",
      "rsgl.itemNotFound"
    ]);
    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.severity), ["warning", "warning", "warning"]);
  });

  it("lets generated resources override external references", () => {
    const result = compileSource([
      "extern model(id: minecraft:block/stone)",
      "model block stone {",
      "  parent minecraft:block/cube_all",
      "  textures { all: minecraft:block/custom_stone }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.strictEqual(result.units.length, 1);
    assert.strictEqual(result.units[0].external, undefined);
    assert.deepStrictEqual(result.units[0].content, {
      parent: "minecraft:block/cube_all",
      textures: {
        all: "minecraft:block/custom_stone"
      }
    });
  });

  it("plans and writes emitted files to a pack directory", () => {
    const root = createTempDir();
    try {
      const files = [
        {
          outputPath: "assets/minecraft/models/block/stone.json",
          content: "{\n  \"parent\": \"minecraft:block/cube_all\"\n}\n",
          kind: "resource" as const
        },
        {
          outputPath: "assets/minecraft/models/block/stone.json.rsgl.map",
          content: "{\n  \"version\": 1\n}\n",
          kind: "sourceMap" as const
        }
      ];

      const dryRun = createRsglWritePlan(files, root);
      assert.deepStrictEqual(dryRun.summary, { create: 2, update: 0, unchanged: 0 });
      assert.strictEqual(fs.existsSync(path.join(root, files[0].outputPath)), false);

      const written = writeRsglFiles(files, root);
      assert.deepStrictEqual(written.summary, { create: 2, update: 0, unchanged: 0 });
      assert.strictEqual(fs.readFileSync(path.join(root, files[0].outputPath), "utf8"), files[0].content);

      const unchanged = createRsglWritePlan(files, root);
      assert.deepStrictEqual(unchanged.summary, { create: 0, update: 0, unchanged: 2 });

      const updatedFiles = [{ ...files[0], content: `${files[0].content}\n` }];
      const update = createRsglWritePlan(updatedFiles, root, { includePreviousContent: true });
      assert.deepStrictEqual(update.summary, { create: 0, update: 1, unchanged: 0 });
      assert.strictEqual(update.entries[0].previousContent, files[0].content);
      assert.deepStrictEqual(update.entries[0].diff, { addedLines: 1, removedLines: 0 });

      assert.throws(
        () => createRsglWritePlan([{ ...files[0], outputPath: "../outside.json" }], root),
        /Unsafe RSGL output path/
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
