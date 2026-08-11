import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglProgram,
  type JsonValue,
  type ResourceUnit,
  type RsglCompileResult
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import { parseRsglProjectConfig } from "../../src/rsglConfig";
import { compileSource, expectNoDiagnostics } from "./helpers/compile";
import { createTempDir } from "./helpers/fs";

describe("RSGL extern declarations", () => {
  it("matches exact, listed, shallow, recursive, and namespace-wildcard patterns lazily", () => {
    const existenceChecks: Array<[string, string, string]> = [];
    const result = compileSource([
      "extern custom texture minecraft:block/exact, minecraft:item/listed",
      "extern custom texture minecraft:block/wood/*",
      "extern custom texture minecraft:entity/**",
      "extern custom texture *:shared",
      "model block references {",
      "  textures {",
      "    exact: minecraft:block/exact",
      "    listed: minecraft:item/listed",
      "    shallow: minecraft:block/wood/oak",
      "    recursive_one: minecraft:entity/zombie",
      "    recursive_deep: minecraft:entity/zombie/outer/layer",
      "    any_namespace: example:shared",
      "  }",
      "}"
    ], {
      externResourceExists: (source, kind, id) => {
        existenceChecks.push([source, kind, id]);
        return true;
      }
    });

    expectNoDiagnostics(result);
    const expectedIds = [
      "example:shared",
      "minecraft:block/exact",
      "minecraft:block/wood/oak",
      "minecraft:entity/zombie",
      "minecraft:entity/zombie/outer/layer",
      "minecraft:item/listed"
    ];
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id).sort(),
      expectedIds
    );
    assert.deepStrictEqual(
      existenceChecks.sort((left, right) => left[2].localeCompare(right[2])),
      expectedIds.map(id => ["custom", "texture", id])
    );
  });

  it("keeps a single-segment wildcard from matching nested paths", () => {
    const result = compileSource([
      "extern! custom texture minecraft:block/wood/*",
      "model block references {",
      "  textures {",
      "    shallow: minecraft:block/wood/oak",
      "    nested: minecraft:block/wood/oak/planks",
      "  }",
      "}"
    ]);

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id),
      ["minecraft:block/wood/oak"]
    );
  });

  it("skips existence resolution for extern! and the global existence switch", () => {
    const unchecked = compileSource([
      "extern! vanilla model minecraft:block/unchecked",
      ...blockstateUsing("unchecked", "minecraft:block/unchecked")
    ]);
    const globallyUnchecked = compileSource([
      "extern custom model minecraft:block/globally_unchecked",
      ...blockstateUsing("globally_unchecked", "minecraft:block/globally_unchecked")
    ], { checkExternExistence: false });

    for (const result of [unchecked, globallyUnchecked]) {
      expectNoDiagnostics(result);
      assert.strictEqual(externalUnits(result).length, 1);
      assert.strictEqual(externalUnits(result)[0].external?.skipExistenceCheck, true);
    }
  });

  it("lets a global extern entry opt back into checks when the top-level switch is off", () => {
    let checks = 0;
    const result = compileSource(blockstateUsing("checked_override", "minecraft:block/checked_override"), {
      checkExternExistence: false,
      globalExterns: [{
        source: "custom",
        kind: "model",
        patterns: ["minecraft:block/checked_override"],
        checkExistence: true
      }],
      externResourceExists: () => {
        checks++;
        return false;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), ["rsgl.modelNotFound"]);
    assert.strictEqual(checks, 1);
    assert.strictEqual(externalUnits(result)[0].external?.skipExistenceCheck, false);
  });

  it("resolves repeated extern references once per validation pass and refreshes the next compile", () => {
    const textureId = "minecraft:block/repeated_resolution";
    const candidatePath = path.resolve("extern-resolution", "repeated_resolution.png");
    const source = [
      `extern custom texture ${textureId}`,
      "model block repeated_resolution {",
      "  textures {",
      ...Array.from({ length: 64 }, (_, index) => `    slot_${index}: ${textureId}`),
      "  }",
      "}"
    ];
    let resolvedPath: string | null = null;
    let resolutionCalls = 0;
    let usages: Array<{ resolvedPath?: string; range: string }> = [];
    const compile = (): RsglCompileResult => compileSource(source, {
      externResourceResolution: (resourceSource, kind, id) => {
        resolutionCalls++;
        assert.deepStrictEqual([resourceSource, kind, id], ["custom", "texture", textureId]);
        return {
          resolvedPath,
          candidatePaths: [candidatePath]
        };
      },
      onExternResourceUsed: usage => {
        usages.push({
          resolvedPath: usage.resolvedPath,
          range: `${usage.range.start}:${usage.range.end}`
        });
      }
    });

    const missing = compile();

    assert.strictEqual(resolutionCalls, 1);
    assert.strictEqual(
      missing.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.textureNotFound").length,
      64
    );
    assert.strictEqual(usages.length, 64);
    assert.strictEqual(new Set(usages.map(usage => usage.range)).size, 64);
    assert.ok(usages.every(usage => usage.resolvedPath === undefined));

    resolvedPath = candidatePath;
    usages = [];
    const present = compile();

    expectNoDiagnostics(present);
    assert.strictEqual(resolutionCalls, 2);
    assert.strictEqual(usages.length, 64);
    assert.strictEqual(new Set(usages.map(usage => usage.range)).size, 64);
    assert.ok(usages.every(usage => usage.resolvedPath === candidatePath));
  });

  it("rejects a physically available resource that has no matching extern declaration", () => {
    let physicalResolverCalls = 0;
    const result = compileSource(blockstateUsing("stone", "minecraft:block/stone"), {
      resourceExists: () => {
        physicalResolverCalls++;
        return true;
      },
      externResourceExists: () => {
        physicalResolverCalls++;
        return true;
      }
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity
    })), [{
      code: "rsgl.undeclaredExternalResource",
      severity: "error"
    }]);
    assert.strictEqual(physicalResolverCalls, 0);
    assert.deepStrictEqual(externalUnits(result), []);
  });

  it("treats generated target-path resources as internal without extern declarations", () => {
    const root = createTempDir("rsgl-generated-extern-");
    try {
      fs.writeFileSync(path.join(root, "generated.png"), Buffer.from([1, 2, 3]));
      const result = compileSource([
        "copy \"assets/minecraft/textures/block/generated.png\" {",
        "  from \"generated.png\"",
        "}",
        "model block generated_reference {",
        "  textures { all: minecraft:block/generated }",
        "}"
      ], { fileName: path.join(root, "main.rsgl") });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(externalUnits(result), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records concrete transitive external model dependencies without expanding declarations", () => {
    const dependencyRoot = path.resolve("external-dependencies");
    const externalModels = new Map<string, Record<string, JsonValue>>([
      ["minecraft:block/external_child", {
        parent: "minecraft:block/external_root",
        textures: { alias: "#root" }
      }],
      ["minecraft:block/external_root", {
        textures: { root: "minecraft:block/external_texture" }
      }]
    ]);
    const result = compileSource([
      "extern custom model minecraft:block/external_child",
      "model block local_child {",
      "  parent minecraft:block/external_child",
      "  textures { all: \"#alias\" }",
      "}"
    ], {
      externResourcePath: (_source, kind, id) =>
        path.join(dependencyRoot, kind, id.replace(":", "_")),
      externResourceContent: (_source, kind, id) => {
        assert.strictEqual(kind, "model");
        return externalModels.get(id);
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => unit.external!.id).sort(),
      [
        "minecraft:block/external_child",
        "minecraft:block/external_root",
        "minecraft:block/external_texture"
      ]
    );
    assert.deepStrictEqual(
      result.dependencies.map(dependency => dependency.reason),
      ["extern", "extern", "extern", "extern"]
    );
    assert.strictEqual(
      result.dependencies.filter(dependency => dependency.path.includes("external_texture")).length,
      2,
      "the inherited definition and local texture-variable use retain separate source origins"
    );
  });

  it("prefers file-local declarations and falls back to global declarations", () => {
    const fileName = path.resolve("pack", "scope.rsgl");
    const local = compileSource([
      "extern custom model minecraft:block/stone",
      ...blockstateUsing("local", "minecraft:block/stone")
    ], {
      fileName,
      globalExterns: [{
        source: "vanilla",
        kind: "model",
        patterns: ["minecraft:block/stone"],
        checkExistence: false
      }],
      externResourceExists: source => source === "custom"
    });
    const global = compileSource(blockstateUsing("global", "minecraft:block/stone"), {
      fileName,
      globalExterns: [{
        source: "vanilla",
        kind: "model",
        patterns: ["minecraft:block/stone"]
      }],
      externResourceExists: source => source === "vanilla"
    });

    expectNoDiagnostics(local);
    expectNoDiagnostics(global);
    assert.strictEqual(externalUnits(local)[0].external?.source, "custom");
    assert.strictEqual(externalUnits(local)[0].external?.skipExistenceCheck, false);
    assert.strictEqual(externalUnits(global)[0].external?.source, "vanilla");
  });

  it("compiles checked local declarations from parsed global config", () => {
    const config = parseRsglProjectConfig({
      extern: [{
        source: "local",
        kind: "model",
        patterns: ["minecraft:block/handwritten"]
      }]
    });
    const existenceChecks: string[] = [];
    const compile = (exists: boolean): RsglCompileResult => compileSource(
      blockstateUsing("global_local", "minecraft:block/handwritten"),
      {
        globalExterns: config.extern,
        externResourceExists: (source, kind, id) => {
          existenceChecks.push(`${source}:${kind}:${id}`);
          return exists;
        }
      }
    );

    const present = compile(true);
    const missing = compile(false);

    expectNoDiagnostics(present);
    assert.deepStrictEqual(missing.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.modelNotFound"
    ]);
    assert.deepStrictEqual(existenceChecks, [
      "local:model:minecraft:block/handwritten",
      "local:model:minecraft:block/handwritten"
    ]);
    assert.strictEqual(externalUnits(present)[0].external?.source, "local");
    assert.strictEqual(externalUnits(present)[0].external?.skipExistenceCheck, false);
  });

  it("prefers local, then custom, then vanilla for equally specific declarations", () => {
    const existenceChecks: string[] = [];
    const result = compileSource([
      "extern vanilla model minecraft:block/stone",
      "extern custom model minecraft:block/stone",
      "extern local model minecraft:block/stone",
      ...blockstateUsing("overridden", "minecraft:block/stone")
    ], {
      externResourceExists: source => {
        existenceChecks.push(source);
        return source === "local";
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(existenceChecks, ["local"]);
    assert.strictEqual(externalUnits(result)[0].external?.source, "local");
  });

  it("selects the most specific matching declaration", () => {
    const existenceChecks: string[] = [];
    const result = compileSource([
      "extern custom model minecraft:block/**",
      "extern vanilla model minecraft:block/stone",
      ...blockstateUsing("specific", "minecraft:block/stone")
    ], {
      externResourceExists: source => {
        existenceChecks.push(source);
        return true;
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(existenceChecks, ["vanilla"]);
    assert.strictEqual(externalUnits(result)[0].external?.source, "vanilla");
  });

  it("uses the effective Minecraft pack winner instead of cross-source pattern specificity", () => {
    const textureId = "minecraft:block/effective_winner";
    const localTexture = path.resolve("local", "textures", "block", "effective_winner.png");
    const customTexture = path.resolve("custom", "textures", "block", "effective_winner.png");
    const vanillaTexture = path.resolve("vanilla", "textures", "block", "effective_winner.png");
    const usages: Array<{ source: string; resolutionScope?: string; resolvedPath?: string }> = [];
    let effectiveResolutionCalls = 0;
    const result = compileSource([
      "extern local texture minecraft:block/**",
      "extern custom texture minecraft:block/*",
      `extern vanilla texture ${textureId}`,
      "model block effective_winner {",
      `  textures { all: ${textureId} }`,
      "}"
    ], {
      resourceResolution: (kind, id) => {
        effectiveResolutionCalls++;
        assert.deepStrictEqual([kind, id], ["texture", textureId]);
        return {
          resolvedPath: localTexture,
          candidatePaths: [localTexture, customTexture, vanillaTexture],
          source: "local"
        };
      },
      externResourceResolution: () => {
        throw new Error("source-scoped extern resolution must not choose an effective winner");
      },
      onExternResourceUsed: usage => usages.push({
        source: usage.source,
        resolutionScope: usage.resolutionScope,
        resolvedPath: usage.resolvedPath
      })
    });

    expectNoDiagnostics(result);
    assert.strictEqual(effectiveResolutionCalls, 1);
    assert.strictEqual(externalUnits(result)[0].external?.source, "local");
    assert.deepStrictEqual(usages, [{
      source: "local",
      resolutionScope: "effective",
      resolvedPath: localTexture
    }]);
    assert.deepStrictEqual(
      result.dependencies.map(dependency => dependency.path),
      [localTexture, customTexture, vanillaTexture]
    );
  });

  it("rejects an effective winner whose physical source is not declared", () => {
    const textureId = "minecraft:block/undeclared_local_override";
    const localTexture = path.resolve("local", "textures", "block", "undeclared_local_override.png");
    const result = compileSource([
      `extern vanilla texture ${textureId}`,
      "model block undeclared_local_override {",
      `  textures { all: ${textureId} }`,
      "}"
    ], {
      resourceResolution: () => ({
        resolvedPath: localTexture,
        candidatePaths: [localTexture],
        source: "local"
      })
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    assert.match(result.diagnostics[0].message, /no matching extern local declaration/);
    assert.deepStrictEqual(externalUnits(result), []);
  });

  it("falls back to a checked higher pack layer when the preferred source is missing", () => {
    const textureId = "minecraft:block/note_block_0";
    const vanillaCandidate = path.resolve("vanilla", "textures", "block", "note_block_0.png");
    const localTexture = path.resolve("local", "textures", "block", "note_block_0.png");
    const vanillaMetadata = path.resolve("vanilla", "pack.mcmeta");
    const localMetadata = path.resolve("local", "pack.mcmeta");
    const resolutionSources: string[] = [];
    const usages: Array<{
      source: string;
      resolvedPath?: string;
      candidatePaths?: readonly string[];
      metadataPaths?: readonly string[];
    }> = [];
    const result = compileSource([
      "extern local texture minecraft:block/**",
      "extern vanilla texture minecraft:block/*",
      "model block note_overlay {",
      `  textures { all: ${textureId} }`,
      "}"
    ], {
      externResourceResolution: (source, kind, id) => {
        assert.deepStrictEqual([kind, id], ["texture", textureId]);
        resolutionSources.push(source);
        return source === "local"
          ? {
              resolvedPath: localTexture,
              candidatePaths: [localTexture],
              metadataPaths: [localMetadata]
            }
          : {
              resolvedPath: null,
              candidatePaths: [vanillaCandidate],
              metadataPaths: [vanillaMetadata]
            };
      },
      onExternResourceUsed: usage => usages.push(usage)
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(resolutionSources, ["vanilla", "local"]);
    assert.strictEqual(externalUnits(result)[0].external?.source, "local");
    assert.strictEqual(usages.length, 1);
    assert.strictEqual(usages[0].source, "local");
    assert.strictEqual(usages[0].resolvedPath, localTexture);
    assert.deepStrictEqual(usages[0].candidatePaths, [vanillaCandidate, localTexture]);
    assert.deepStrictEqual(usages[0].metadataPaths, [vanillaMetadata, localMetadata]);
    assert.deepStrictEqual(
      result.dependencies.map(dependency => dependency.path),
      [vanillaCandidate, localTexture, vanillaMetadata, localMetadata]
    );
  });

  it("does not weaken a checked preferred declaration with an unchecked fallback", () => {
    const result = compileSource([
      "extern! local texture minecraft:block/**",
      "extern vanilla texture minecraft:block/*",
      "model block checked_preference {",
      "  textures { all: minecraft:block/missing_checked }",
      "}"
    ], {
      externResourceExists: source => source === "local"
    });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.textureNotFound"
    ]);
    assert.strictEqual(externalUnits(result)[0].external?.source, "vanilla");
    assert.strictEqual(externalUnits(result)[0].external?.skipExistenceCheck, false);
  });

  it("does not propagate a file-local extern through imports", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const libraryFile = path.resolve("pack", "library.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import \"./library.rsgl\"",
          ...blockstateUsing("stolen", "minecraft:block/library_only")
        ].join("\n"))
      },
      {
        fileName: libraryFile,
        module: parseRsgl("extern! vanilla model minecraft:block/library_only")
      }
    ], { entryFileName: mainFile });

    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "rsgl.undeclaredExternalResource"
    ]);
    assert.deepStrictEqual(externalUnits(result), []);
  });

  it("treats declarations nested in top-level template blocks as file-scoped", () => {
    const mainFile = path.resolve("pack", "nested-main.rsgl");
    const templatesFile = path.resolve("pack", "nested-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { generatedBlockstate } from \"./nested-templates.rsgl\"",
          "use generatedBlockstate()"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template generatedBlockstate() {",
          "  extern! vanilla model minecraft:block/template_model",
          "  blockstate variants generated {",
          "    case * => minecraft:block/template_model",
          "  }",
          "}",
          "export { generatedBlockstate }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.strictEqual(externalUnits(result)[0].external?.source, "vanilla");
  });

  it("attributes imported fixed-reference diagnostics to definitions and argument diagnostics to callers", () => {
    const mainFile = path.resolve("pack", "diagnostic-main.rsgl");
    const templatesFile = path.resolve("pack", "diagnostic-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { scopedModels } from \"./diagnostic-templates.rsgl\"",
          "blockstate variants scoped { use scopedModels(minecraft:block/caller_missing) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template scopedModels(callerModel: ModelId) -> variants {",
          "    case * => random {",
          "      option minecraft:block/fixed_missing",
          "      option callerModel",
          "    }",
          "}",
          "export { scopedModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    const externDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.undeclaredExternalResource"
    );
    assert.strictEqual(externDiagnostics.length, 2);
    assert.strictEqual(
      externDiagnostics.find(diagnostic => diagnostic.message.includes("fixed_missing"))?.fileName,
      templatesFile
    );
    assert.strictEqual(
      externDiagnostics.find(diagnostic => diagnostic.message.includes("caller_missing"))?.fileName,
      mainFile
    );
  });

  it("uses definition-file externs for fixed template references and caller externs for arguments", () => {
    const mainFile = path.resolve("pack", "main.rsgl");
    const templatesFile = path.resolve("pack", "templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { modelVariant } from \"./templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "blockstate variants fixed_reference { use modelVariant() }",
          "blockstate variants caller_argument { use modelVariant(minecraft:block/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:block/library_model",
          "template modelVariant(modelId: ModelId = minecraft:block/library_model) -> variants {",
          "  case * => modelId",
          "}",
          "export { modelVariant }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:block/caller_model", "custom"],
        ["minecraft:block/library_model", "vanilla"]
      ]
    );
  });

  it("preserves caller extern scope when a template argument is assigned to a local", () => {
    const mainFile = path.resolve("pack", "alias-main.rsgl");
    const templatesFile = path.resolve("pack", "alias-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { aliasedModel } from \"./alias-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "use aliasedModel(minecraft:block/caller_model)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template aliasedModel(callerModel: ModelId) {",
          "  blockstate variants aliased {",
          "    let alias = callerModel",
          "    case * => alias",
          "  }",
          "}",
          "export { aliasedModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]),
      [["minecraft:block/caller_model", "custom"]]
    );
  });

  it("keeps mixed fixed and argument references in their respective lexical extern scopes", () => {
    const mainFile = path.resolve("pack", "mixed-main.rsgl");
    const templatesFile = path.resolve("pack", "mixed-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { mixedModels } from \"./mixed-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_model",
          "blockstate variants mixed { use mixedModels(minecraft:block/caller_model) }"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:block/library_model",
          "template mixedModels(callerModel: ModelId) -> variants {",
          "    case * => random {",
          "      option minecraft:block/library_model",
          "      option callerModel",
          "    }",
          "}",
          "export { mixedModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:block/caller_model", "custom"],
        ["minecraft:block/library_model", "vanilla"]
      ]
    );
    const blockstate = result.units.find(unit => !unit.external && unit.kind === "blockstate");
    assert.ok(blockstate?.sourceMap.mappings
      .filter(mapping => mapping.generatedPath.startsWith("/variants/"))
      .every(mapping => mapping.sourceFile === templatesFile));
  });

  it("preserves lexical extern scopes inside mixed merge expressions", () => {
    const mainFile = path.resolve("pack", "merge-main.rsgl");
    const templatesFile = path.resolve("pack", "merge-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { mixedItemModels } from \"./merge-templates.rsgl\"",
          "extern! custom model minecraft:item/caller_model",
          "use mixedItemModels(minecraft:item/caller_model)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_model",
          "template mixedItemModels(callerModel: ModelId) {",
          "  item mixed {",
          "    merge {",
          "      model: {",
          "        type: minecraft:composite,",
          "        models: [",
          "          { type: minecraft:model, model: minecraft:item/library_model },",
          "          { type: minecraft:model, model: callerModel }",
          "        ]",
          "      }",
          "    }",
          "  }",
          "}",
          "export { mixedItemModels }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:item/caller_model", "custom"],
        ["minecraft:item/library_model", "vanilla"]
      ]
    );
  });

  it("uses caller extern scope for imported specialized item statements", () => {
    const mainFile = path.resolve("pack", "item-main.rsgl");
    const templatesFile = path.resolve("pack", "item-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { layeredItem } from \"./item-templates.rsgl\"",
          "extern! custom model minecraft:item/caller_layer",
          "use layeredItem(minecraft:item/caller_layer)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla model minecraft:item/library_layer",
          "template layeredItem(callerModel: ModelId) {",
          "  item layered {",
          "    composite {",
          "      model minecraft:item/library_layer",
          "      model callerModel",
          "    }",
          "  }",
          "}",
          "export { layeredItem }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result)
        .map(unit => [unit.external!.id, unit.external!.source])
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["minecraft:item/caller_layer", "custom"],
        ["minecraft:item/library_layer", "vanilla"]
      ]
    );
  });

  it("uses caller extern scope for imported model impl arguments", () => {
    const mainFile = path.resolve("pack", "impl-main.rsgl");
    const templatesFile = path.resolve("pack", "impl-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { implModel } from \"./impl-templates.rsgl\"",
          "extern! custom model minecraft:block/caller_parent",
          "extern! custom texture minecraft:block/caller_texture",
          "use implModel(test, minecraft:block/caller_parent, minecraft:block/caller_texture)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template implModel(id: ResourceId, parentModel: ModelId, texture: TextureId) {",
          "  model block id impl parentModel(all: texture) {}",
          "}",
          "export { implModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]).sort(),
      [
        ["minecraft:block/caller_parent", "custom"],
        ["minecraft:block/caller_texture", "custom"]
      ]
    );
    const model = result.units.find(unit => !unit.external && unit.kind === "model");
    assert.ok(model?.sourceMap.mappings
      .filter(mapping => mapping.generatedPath === "/parent" || mapping.generatedPath === "/textures/all")
      .every(mapping => mapping.sourceFile === templatesFile));
  });

  it("preserves caller extern scope through dependent defaults and local aliases", () => {
    const mainFile = path.resolve("pack", "derived-main.rsgl");
    const templatesFile = path.resolve("pack", "derived-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { derivedModel } from \"./derived-templates.rsgl\"",
          "extern! custom texture minecraft:block/caller_texture",
          "use derivedModel(test, minecraft:block/caller_texture)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "template derivedModel(id: ResourceId, texture: TextureId, inherited: TextureId = texture) {",
          "  let alias = inherited",
          "  model block id { textures { all: alias } }",
          "}",
          "export { derivedModel }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(externalUnits(result).map(unit => unit.external), [{
      kind: "external",
      resourceKind: "texture",
      id: "minecraft:block/caller_texture",
      source: "custom",
      skipExistenceCheck: true
    }]);
  });

  it("uses a generated parent model's definition-file extern scope", () => {
    const mainFile = path.resolve("pack", "parent-main.rsgl");
    const templatesFile = path.resolve("pack", "parent-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { makeParent } from \"./parent-templates.rsgl\"",
          "use makeParent()",
          "model block child {",
          "  parent minecraft:block/generated_parent",
          "  textures { particle: \"#all\" }",
          "}"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla texture minecraft:block/library_texture",
          "template makeParent() {",
          "  model block generated_parent {",
          "    textures { all: minecraft:block/library_texture }",
          "  }",
          "}",
          "export { makeParent }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.source]),
      [["minecraft:block/library_texture", "vanilla"]]
    );
  });

  it("treats generated textures reached through external model variables as internal", () => {
    const root = createTempDir("rsgl-generated-inherited-texture-");
    try {
      fs.writeFileSync(path.join(root, "generated.png"), Buffer.from([1, 2, 3]));
      const externalModelPath = path.join(root, "external_parent.json");
      const result = compileSource([
        "extern custom model minecraft:block/external_parent",
        "copy \"assets/minecraft/textures/block/generated.png\" {",
        "  from \"generated.png\"",
        "}",
        "model block child {",
        "  parent minecraft:block/external_parent",
        "  textures { all: \"#inherited\" }",
        "}"
      ], {
        fileName: path.join(root, "main.rsgl"),
        externResourcePath: (_source, kind, id) =>
          kind === "model" && id === "minecraft:block/external_parent"
            ? externalModelPath
            : null,
        externResourceContent: (_source, kind, id) =>
          kind === "model" && id === "minecraft:block/external_parent"
            ? { textures: { inherited: "minecraft:block/generated" } }
            : undefined
      });

      expectNoDiagnostics(result);
      assert.deepStrictEqual(
        externalUnits(result).map(unit => [unit.external!.resourceKind, unit.external!.id]),
        [["model", "minecraft:block/external_parent"]]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves fixed and caller extern scopes for generic typed-resource validators", () => {
    const mainFile = path.resolve("pack", "generic-scope-main.rsgl");
    const templatesFile = path.resolve("pack", "generic-scope-templates.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { fontResource, soundsResource, waypointResource, postResource } from \"./generic-scope-templates.rsgl\"",
          "extern! custom font_file minecraft:font/caller.ttf",
          "extern! custom sound minecraft:caller/sound",
          "extern! custom texture minecraft:gui/sprites/hud/locator_bar_dot/caller_sprite, minecraft:effect/caller_mask",
          "extern! custom shader_vertex minecraft:caller/vertex",
          "extern! custom shader_fragment minecraft:caller/fragment",
          "use fontResource(minecraft:font/caller.ttf)",
          "use soundsResource(minecraft:caller/sound)",
          "use waypointResource(minecraft:caller_sprite)",
          "use postResource(minecraft:caller/vertex, minecraft:caller/fragment, minecraft:caller_mask)"
        ].join("\n"))
      },
      {
        fileName: templatesFile,
        module: parseRsgl([
          "extern! vanilla font_file minecraft:font/library.ttf",
          "extern! vanilla sound minecraft:library/sound",
          "extern! vanilla texture minecraft:gui/sprites/hud/locator_bar_dot/library_sprite, minecraft:effect/library_mask",
          "extern! vanilla shader_vertex minecraft:library/vertex",
          "extern! vanilla shader_fragment minecraft:library/fragment",
          "template fontResource(file: ResourceId) {",
          "  font scoped_font {",
          "    providers [{ type: ttf, file: minecraft:font/library.ttf }, { type: ttf, file: file }]",
          "  }",
          "}",
          "template soundsResource(sound: ResourceId) {",
          "  sounds minecraft {",
          "    \"scope.event\" { sounds: [minecraft:library/sound, sound] }",
          "  }",
          "}",
          "template waypointResource(sprite: TextureId) {",
          "  waypoint_style scoped_waypoint {",
          "    sprites [minecraft:library_sprite, sprite]",
          "  }",
          "}",
          "template postResource(vertex: ResourceId, fragment: ResourceId, mask: TextureId) {",
          "  post_effect scoped_post {",
          "    passes [",
          "      { vertex_shader: minecraft:library/vertex, fragment_shader: minecraft:library/fragment, inputs: [{ sampler_name: \"Fixed\", location: minecraft:library_mask }] },",
          "      { vertex_shader: vertex, fragment_shader: fragment, inputs: [{ sampler_name: \"Caller\", location: mask }] }",
          "    ]",
          "  }",
          "}",
          "export { fontResource, soundsResource, waypointResource, postResource }"
        ].join("\n"))
      }
    ], { entryFileName: mainFile });

    expectNoDiagnostics(result);
    const resources = externalUnits(result).map(unit => unit.external!);
    assert.strictEqual(resources.length, 12);
    assert.ok(resources
      .filter(resource => resource.id.includes("library"))
      .every(resource => resource.source === "vanilla"));
    assert.ok(resources
      .filter(resource => resource.id.includes("caller"))
      .every(resource => resource.source === "custom"));
  });

  it("keeps extension-bearing bitmap texture ids canonical in extern and generated resources", () => {
    const external = compileSource([
      "extern! custom texture minecraft:font/ascii.png",
      "font default {",
      "  providers [{ type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }]",
      "}"
    ]);

    expectNoDiagnostics(external);
    assert.deepStrictEqual(
      externalUnits(external).map(unit => [unit.external!.id, unit.outputPath]),
      [["minecraft:font/ascii.png", "assets/minecraft/textures/font/ascii.png"]]
    );

    const root = createTempDir("rsgl-generated-font-bitmap-");
    try {
      fs.writeFileSync(path.join(root, "ascii.png"), Buffer.from([1, 2, 3]));
      const generated = compileSource([
        "copy \"assets/minecraft/textures/font/ascii.png\" { from \"ascii.png\" }",
        "font default {",
        "  providers [{ type: bitmap, file: minecraft:font/ascii.png, ascent: 7, chars: [\"abc\"] }]",
        "}"
      ], { fileName: path.join(root, "main.rsgl") });

      expectNoDiagnostics(generated);
      assert.deepStrictEqual(externalUnits(generated), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the global existence switch to inherited external model dependencies", () => {
    const existenceChecks: string[] = [];
    const result = compileSource([
      "extern custom model minecraft:block/external_child",
      "model block local_child { parent minecraft:block/external_child }"
    ], {
      checkExternExistence: false,
      resourceContent: (_kind, id) => id === "minecraft:block/external_child"
        ? { parent: "minecraft:block/transitive_parent" }
        : undefined,
      resourceExists: (kind, id) => {
        existenceChecks.push(`${kind}:${id}`);
        return false;
      }
    });

    expectNoDiagnostics(result);
    assert.deepStrictEqual(existenceChecks, []);
    assert.deepStrictEqual(
      externalUnits(result).map(unit => [unit.external!.id, unit.external!.skipExistenceCheck]),
      [
        ["minecraft:block/external_child", true],
        ["minecraft:block/transitive_parent", true]
      ]
    );
  });
});

function externalUnits(result: RsglCompileResult): ResourceUnit[] {
  return result.units.filter(unit => unit.external !== undefined);
}

function blockstateUsing(id: string, model: string): string[] {
  return [
    `blockstate variants ${id} {`,
    `  case * => ${model}`,
    "}"
  ];
}
