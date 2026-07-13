import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CompletionItemKind, DiagnosticSeverity, InsertTextFormat } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  RsglWorkspaceSemanticCache,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  type RsglSemanticToken,
  type RsglSymbol
} from "../../../rsgl-core/src";
import {
  clampOffset,
  completionItemsForContent,
  computeDocumentDiagnostics,
  computeDocumentSemanticTokens,
  dependencyPathsForDocument,
  dependencyPathsForDocuments,
  documentsDependingOnPath,
  encodeSemanticTokens,
  handleSemanticWatchedFileBatch,
  identifierAtOffset,
  normalizeDependencyPath,
  toLspDiagnostic,
  toLspSeverity,
  toValidationSettings,
  workspaceValidationOptionsFor,
  type RsglValidationSettings
} from "../../src/serverCore";

const emptySettings: RsglValidationSettings = { defaultAssetsPath: null, resourcePackRoots: [] };

function documentOf(text: string): TextDocument {
  return TextDocument.create("file:///virtual/test.rsgl", "rsgl", 1, text);
}

function templateSymbol(name: string): RsglSymbol {
  return {
    name,
    kind: "template",
    type: { kind: "Function" },
    signature: { parameters: [], returnType: { kind: "Unknown" } }
  };
}

describe("RSGL LSP server core", () => {
  it("maps every RSGL severity onto the LSP severity scale", () => {
    assert.strictEqual(toLspSeverity("error"), DiagnosticSeverity.Error);
    assert.strictEqual(toLspSeverity("warning"), DiagnosticSeverity.Warning);
    assert.strictEqual(toLspSeverity("info"), DiagnosticSeverity.Information);
  });

  it("clamps offsets to the document text range", () => {
    const document = documentOf("model");
    assert.strictEqual(clampOffset(document, -3), 0);
    assert.strictEqual(clampOffset(document, 2), 2);
    assert.strictEqual(clampOffset(document, 99), 5);
  });

  it("converts diagnostics with out-of-range offsets to positions at the document edges", () => {
    const document = documentOf("model");
    const diagnostic = toLspDiagnostic(document, {
      code: "rsgl.test",
      message: "boom",
      severity: "error",
      range: { start: -5, end: 999 }
    });

    assert.deepStrictEqual(diagnostic.range, {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 }
    });
    assert.strictEqual(diagnostic.severity, DiagnosticSeverity.Error);
    assert.strictEqual(diagnostic.code, "rsgl.test");
    assert.strictEqual(diagnostic.source, "RSGL");
    assert.strictEqual(diagnostic.message, "boom");
  });

  it("widens zero-length diagnostic ranges by one character", () => {
    const document = documentOf("model x");
    const diagnostic = toLspDiagnostic(document, {
      code: "rsgl.test",
      message: "empty range",
      severity: "warning",
      range: { start: 2, end: 2 }
    });

    assert.deepStrictEqual(diagnostic.range, {
      start: { line: 0, character: 2 },
      end: { line: 0, character: 3 }
    });
  });

  it("accepts well-formed settings payloads", () => {
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: "E:/assets", resourcePackRoots: ["a", "b"] }),
      { defaultAssetsPath: "E:/assets", resourcePackRoots: ["a", "b"] }
    );
  });

  it("falls back to safe defaults for garbage settings payloads", () => {
    const fallback = { defaultAssetsPath: null, resourcePackRoots: [] };
    assert.deepStrictEqual(toValidationSettings(undefined), fallback);
    assert.deepStrictEqual(toValidationSettings(null), fallback);
    assert.deepStrictEqual(toValidationSettings(42), fallback);
    assert.deepStrictEqual(toValidationSettings("nope"), fallback);
    assert.deepStrictEqual(toValidationSettings({}), fallback);
  });

  it("drops blank asset paths and non-string resource pack roots", () => {
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: "   ", resourcePackRoots: ["kept", 5, null, {}] }),
      { defaultAssetsPath: null, resourcePackRoots: ["kept"] }
    );
    assert.deepStrictEqual(
      toValidationSettings({ defaultAssetsPath: 7, resourcePackRoots: "not-an-array" }),
      { defaultAssetsPath: null, resourcePackRoots: [] }
    );
  });

  it("filters program diagnostics to the requested file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-"));
    try {
      const entryFile = path.join(root, "entry.rsgl");
      const brokenFile = path.join(root, "broken.rsgl");
      const entryText = [
        "extern! custom texture minecraft:block/stone",
        "import { cube } from \"./broken.rsgl\"",
        "use cube(stone, texture: minecraft:block/stone)"
      ].join("\n");
      const brokenText = [
        "extern! vanilla model minecraft:block/cube_all",
        "template cube(id: ResourceId, texture: TextureId = id) {",
        "  model block id {",
        "    parent minecraft:block/cube_all",
        "    textures { all: texture }",
        "  }",
        "}",
        "use missingTemplate()"
      ].join("\n");
      fs.writeFileSync(entryFile, entryText);
      fs.writeFileSync(brokenFile, brokenText);

      const cache = RsglWorkspaceSemanticCache.create();
      const deps = {
        loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName),
        settings: emptySettings
      };

      const entryDiagnostics = computeDocumentDiagnostics(documentOf(entryText), entryFile, deps);
      assert.deepStrictEqual(entryDiagnostics.map(diagnostic => diagnostic.code), []);

      const brokenDiagnostics = computeDocumentDiagnostics(documentOf(brokenText), brokenFile, deps);
      assert.ok(brokenDiagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to single-module compilation when the entry cannot be loaded", () => {
    const missingFile = path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-missing", "untracked.rsgl");
    const text = "use missingTemplate()";
    const cache = RsglWorkspaceSemanticCache.create();
    const diagnostics = computeDocumentDiagnostics(documentOf(text), missingFile, {
      loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
      settings: emptySettings
    });

    assert.ok(diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"));
    assert.ok(diagnostics.every(diagnostic => diagnostic.source === "RSGL"));
  });

  it("reports unsupported default imports consistently through program and fallback paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-default-import-"));
    try {
      const entryFile = path.join(root, "main.rsgl");
      const commonFile = path.join(root, "common.rsgl");
      const text = [
        "import common from \"./common.rsgl\"",
        "model block default_import { textures { all: common.stone } }"
      ].join("\n");
      fs.writeFileSync(entryFile, text);
      fs.writeFileSync(commonFile, "let stone = minecraft:block/stone\nexport { stone }");

      const cache = RsglWorkspaceSemanticCache.create();
      const programDiagnostics = computeDocumentDiagnostics(documentOf(text), entryFile, {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        settings: emptySettings
      });
      const fallbackFile = path.join(root, "missing", "untracked.rsgl");
      const fallbackDiagnostics = computeDocumentDiagnostics(documentOf(text), fallbackFile, {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        settings: emptySettings
      });

      for (const diagnostics of [programDiagnostics, fallbackDiagnostics]) {
        assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
          "rsgl.unsupportedDefaultImport"
        ]);
        assert.deepStrictEqual(diagnostics[0].range, {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 13 }
        });
        assert.strictEqual(diagnostics[0].source, "RSGL");
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports base-document dependencies from the diagnostics pipeline", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-deps-"));
    try {
      const entryFile = path.join(root, "entry.rsgl");
      const baseFile = path.join(root, "base.json");
      const entryText = [
        "extern! vanilla model minecraft:block/cube_all",
        "model block imported {",
        "  base \"./base.json\"",
        "}"
      ].join("\n");
      fs.writeFileSync(entryFile, entryText);
      fs.writeFileSync(baseFile, JSON.stringify({ parent: "minecraft:block/cube_all" }));

      const cache = RsglWorkspaceSemanticCache.create();
      let dependencies: readonly { path: string }[] = [];
      const diagnostics = computeDocumentDiagnostics(documentOf(entryText), entryFile, {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        onDependencies: nextDependencies => {
          dependencies = nextDependencies;
        },
        settings: emptySettings
      });

      assert.ok(!diagnostics.some(diagnostic => String(diagnostic.code).startsWith("rsgl.base")));
      assert.deepStrictEqual(dependencies.map(dependency => normalizeDependencyPath(dependency.path)), [
        normalizeDependencyPath(baseFile)
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the nearest ancestor rsgl.config.json global extern for diagnostics", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-nearest-"));
    const projectRoot = path.join(root, "nested project");
    const sourceFile = path.join(projectRoot, "src", "main.rsgl");
    const text = blockstateUsingExternalModel("minecraft:block/configured");

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({ unexpected: true }));
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), JSON.stringify({
        extern: [{
          source: "vanilla",
          kind: "model",
          patterns: ["minecraft:block/configured"],
          checkExistence: false
        }]
      }));
      fs.writeFileSync(sourceFile, text);

      const diagnostics = diagnosticsForFile(sourceFile, text);

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors checkExternExistence=false from rsgl.config.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-unchecked-"));
    const sourceFile = path.join(root, "src", "main.rsgl");
    const text = blockstateUsingExternalModel("minecraft:block/intentionally_missing");

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        checkExternExistence: false,
        extern: [{
          source: "custom",
          kind: "model",
          patterns: ["minecraft:block/intentionally_missing"]
        }]
      }));
      fs.writeFileSync(sourceFile, text);

      const diagnostics = diagnosticsForFile(sourceFile, text);

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves relative defaultAssetsPath and resourcePackRoots from the config directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-paths-"));
    const projectRoot = path.join(root, "project 配置");
    const sourceFile = path.join(projectRoot, "src", "main.rsgl");
    const defaultAssets = path.join(root, "vanilla assets 原版");
    const customPack = path.join(root, "custom packs", "资源 包");
    const vanillaTexture = path.join(defaultAssets, "assets", "example", "textures", "item", "vanilla.png");
    const customTexture = path.join(customPack, "assets", "example", "textures", "item", "custom.png");
    const text = [
      "model item configured_paths {",
      "  textures {",
      "    vanilla: example:item/vanilla",
      "    custom: example:item/custom",
      "  }",
      "}"
    ].join("\n");

    try {
      for (const fileName of [sourceFile, vanillaTexture, customTexture]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, fileName.endsWith(".png") ? Buffer.alloc(0) : text);
      }
      fs.writeFileSync(path.join(customPack, "pack.mcmeta"), "{}");
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), JSON.stringify({
        defaultAssetsPath: path.relative(projectRoot, defaultAssets),
        resourcePackRoots: [path.relative(projectRoot, customPack)],
        extern: [
          { source: "vanilla", kind: "texture", patterns: ["example:item/vanilla"] },
          { source: "custom", kind: "texture", patterns: ["example:item/custom"] }
        ]
      }));

      const diagnostics = diagnosticsForFile(sourceFile, text);

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("treats project defaultAssetsPath null as explicit disable and falls back only for undefined", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-precedence-"));
    const settingsAssets = path.join(root, "settings-assets");
    const texture = path.join(settingsAssets, "assets", "example", "textures", "item", "fallback.png");
    const disabledSource = path.join(root, "disabled", "src", "main.rsgl");
    const fallbackSource = path.join(root, "fallback", "src", "main.rsgl");
    const settings: RsglValidationSettings = {
      defaultAssetsPath: settingsAssets,
      resourcePackRoots: []
    };

    try {
      for (const fileName of [texture, disabledSource, fallbackSource]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, "");
      }
      fs.writeFileSync(path.join(root, "disabled", "rsgl.config.json"), JSON.stringify({
        defaultAssetsPath: null
      }));
      fs.writeFileSync(path.join(root, "fallback", "rsgl.config.json"), "{}");

      const disabled = workspaceValidationOptionsFor(disabledSource, settings);
      const fallback = workspaceValidationOptionsFor(fallbackSource, settings);

      assert.strictEqual(disabled.externResourceExists("vanilla", "texture", "example:item/fallback"), false);
      assert.strictEqual(fallback.externResourceExists("vanilla", "texture", "example:item/fallback"), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps project namespace, target, and evaluation budget into LSP compile options", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-compile-config-"));
    const sourceFile = path.join(root, "src", "main.rsgl");
    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, "model block sample {}");
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        namespace: "project_ns",
        target: { edition: "java", format: [75, 0] },
        maxEvaluationItems: 45678
      }));

      const options = workspaceValidationOptionsFor(sourceFile, emptySettings);

      assert.strictEqual(options.namespace, undefined);
      assert.strictEqual(options.defaultNamespace, "project_ns");
      assert.deepStrictEqual(options.projectTarget, {
        edition: "java",
        packFormat: { major: 75, minor: 0 }
      });
      assert.strictEqual(options.maxEvaluationItems, 45678);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rebinds the semantic program when project compile configuration changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-cache-"));
    const sourceFile = path.join(root, "src", "main.rsgl");
    const configFile = path.join(root, "rsgl.config.json");
    const text = [
      "model block rotated {}",
      "blockstate variants rotated {",
      "  {}: { model: project_ns:block/rotated, z: 90 }",
      "}"
    ].join("\n");
    const cache = RsglWorkspaceSemanticCache.create();
    const programs: ReturnType<typeof cache.loadProgramFromEntry>[] = [];
    const diagnostics = () => computeDocumentDiagnostics(documentOf(text), sourceFile, {
      loadProgramFromEntry: (entryFileName, fingerprint) => {
        const program = cache.loadProgramFromEntry(entryFileName, {
          semanticConfigurationFingerprint: fingerprint
        });
        programs.push(program);
        return program;
      },
      settings: emptySettings
    });

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(sourceFile, text);
      fs.writeFileSync(configFile, JSON.stringify({
        namespace: "project_ns",
        target: { edition: "java", format: [75, 0] }
      }));

      assert.strictEqual(diagnostics().some(item => item.code === "rsgl.unsupportedBlockstateZRotation"), false);
      fs.writeFileSync(configFile, JSON.stringify({
        namespace: "project_ns",
        target: { edition: "java", format: [74, 0] }
      }));
      assert.strictEqual(diagnostics().some(item => item.code === "rsgl.unsupportedBlockstateZRotation"), true);

      assert.notStrictEqual(programs[0], programs[1]);
      assert.strictEqual(programs[0].files[0], programs[1].files[0], "config edits should reuse parsed source files");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps VS Code build payload precedence aligned with project config semantics", () => {
    const buildSource = fs.readFileSync(path.join(
      process.cwd(),
      "extensions",
      "vscode-rsgl",
      "src",
      "commands",
      "build.ts"
    ), "utf8");

    assert.ok(buildSource.includes("defaultAssetsPath: projectDefaultAssetsPath === undefined"));
    assert.ok(buildSource.includes("? configuredDefaultAssetsPath()"));
    assert.strictEqual(
      buildSource.includes("projectConfig?.defaultAssetsPath ?? configuredDefaultAssetsPath()"),
      false
    );
    assert.ok(buildSource.includes("const validationAnchor = isDirectoryBuildContext(context)"));
    assert.ok(buildSource.includes("loadRsglProjectConfigForSource(validationAnchor)"));
    assert.ok(buildSource.includes("validationAnchor,"));
  });

  it("preserves rsgl.invalidExternConfiguration for invalid legacy config fields", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-invalid-"));
    const root = path.join(tempRoot, "project.target.data");
    const sourceFile = path.join(root, "src", "main.rsgl");
    const text = "model block valid {}";

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        extern: [{ source: "other", kind: "model", patterns: ["minecraft:block/stone"] }]
      }));
      fs.writeFileSync(sourceFile, text);

      const cache = RsglWorkspaceSemanticCache.create();
      let projectConfigWatchPaths: readonly string[] = [];
      const diagnostics = computeDocumentDiagnostics(documentOf(text), sourceFile, {
        loadProgramFromEntry: entryFileName => cache.loadProgramFromEntry(entryFileName),
        onProjectConfigWatchPaths: paths => {
          projectConfigWatchPaths = paths;
        },
        settings: emptySettings
      });

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
        "rsgl.invalidExternConfiguration"
      ]);
      assert.ok(diagnostics[0].message.includes(".extern[0].source"));
      assert.deepStrictEqual(projectConfigWatchPaths.map(normalizeDependencyPath), [
        normalizeDependencyPath(path.join(root, "src", "rsgl.config.json")),
        normalizeDependencyPath(path.join(root, "rsgl.config.json"))
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns rsgl.invalidProjectConfiguration for invalid project compile fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-new-config-invalid-"));
    const sourceFile = path.join(root, "src", "main.rsgl");
    const text = "model block valid {}";

    try {
      fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
      fs.writeFileSync(path.join(root, "rsgl.config.json"), JSON.stringify({
        namespace: "Invalid Namespace"
      }));
      fs.writeFileSync(sourceFile, text);

      const diagnostics = diagnosticsForFile(sourceFile, text);

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
        "rsgl.invalidProjectConfiguration"
      ]);
      assert.ok(diagnostics[0].message.includes(".namespace"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires an extern declaration for typed external references when no config exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-absent-"));
    const sourceFile = path.join(root, "main.rsgl");
    const text = blockstateUsingExternalModel("minecraft:block/undeclared");

    try {
      fs.writeFileSync(sourceFile, text);

      const diagnostics = diagnosticsForFile(sourceFile, text);

      assert.deepStrictEqual(diagnostics.map(diagnostic => diagnostic.code), [
        "rsgl.undeclaredExternalResource"
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects only documents that depend on a changed JSON path", () => {
    const root = path.join(os.tmpdir(), "rsgl-dependency-index");
    const shared = path.join(root, "shared.json");
    const other = path.join(root, "other.json");
    const index = new Map<string, ReadonlySet<string>>([
      ["file:///one.rsgl", new Set([normalizeDependencyPath(shared)])],
      ["file:///two.rsgl", new Set([normalizeDependencyPath(other)])],
      ["file:///three.rsgl", new Set([normalizeDependencyPath(shared), normalizeDependencyPath(other)])]
    ]);

    assert.deepStrictEqual(documentsDependingOnPath(index, path.join(root, ".", "shared.json")), [
      "file:///one.rsgl",
      "file:///three.rsgl"
    ]);
    assert.deepStrictEqual(documentsDependingOnPath(index, path.join(root, "unrelated.json")), []);
  });

  it("publishes a stable dependency union across all open documents", () => {
    const root = path.join(os.tmpdir(), "rsgl-dependency-union");
    const first = normalizeDependencyPath(path.join(root, "first.json"));
    const shared = normalizeDependencyPath(path.join(root, "shared.json"));
    const index = new Map<string, ReadonlySet<string>>([
      ["file:///one.rsgl", new Set([shared, first])],
      ["file:///two.rsgl", new Set([shared])]
    ]);

    assert.deepStrictEqual(dependencyPathsForDocuments(index), [first, shared].sort());
  });

  it("merges compile dependencies with exact project-config watch candidates", () => {
    const root = path.join(os.tmpdir(), "rsgl-document-dependency-paths");
    const baseFile = path.join(root, "base.json");
    const configCandidate = path.join(root, "nested", "rsgl.config.json");
    const paths = dependencyPathsForDocument([{
      path: baseFile,
      reason: "base-import",
      sourceFile: path.join(root, "main.rsgl"),
      sourceRange: { start: 0, end: 1 }
    }], [configCandidate, baseFile]);

    assert.deepStrictEqual([...paths].sort(), [
      normalizeDependencyPath(baseFile),
      normalizeDependencyPath(configCandidate)
    ].sort());
  });

  it("invalidates every RSGL source before refreshing a mixed config watcher batch", () => {
    const root = path.join(os.tmpdir(), "rsgl-semantic-watch-batch");
    const first = path.join(root, "first.rsgl");
    const second = path.join(root, "nested", "SECOND.RSGL");
    const events: string[] = [];

    const handled = handleSemanticWatchedFileBatch([
      path.join(root, "rsgl.config.json"),
      first,
      path.join(root, "base.json"),
      second,
      first
    ], {
      invalidatePath: fileName => events.push(`invalidate:${fileName}`),
      refresh: () => events.push("refresh")
    });

    assert.strictEqual(handled, true);
    assert.deepStrictEqual(events, [
      `invalidate:${first}`,
      `invalidate:${second}`,
      "refresh"
    ]);
  });

  it("leaves JSON-only watcher batches for dependency-specific validation", () => {
    const events: string[] = [];
    const handled = handleSemanticWatchedFileBatch([path.join("pack", "base.json")], {
      invalidatePath: fileName => events.push(`invalidate:${fileName}`),
      refresh: () => events.push("refresh")
    });

    assert.strictEqual(handled, false);
    assert.deepStrictEqual(events, []);
  });

  it("maps completion candidates and workspace symbols to completion items", () => {
    const items = completionItemsForContent("", 0, [
      templateSymbol("myCube"),
      { name: "tex", kind: "variable", type: { kind: "TextureId" } }
    ]);

    const target = items.find(item => item.label === "target");
    assert.strictEqual(target?.kind, CompletionItemKind.Snippet);
    assert.strictEqual(typeof target?.insertText, "string");
    assert.strictEqual(target?.insertTextFormat, InsertTextFormat.Snippet);
    assert.strictEqual(typeof target?.detail, "string");

    const seq = items.find(item => item.label === "seq");
    assert.strictEqual(seq?.kind, CompletionItemKind.Function);

    const myCube = items.find(item => item.label === "myCube");
    assert.deepStrictEqual(myCube, {
      label: "myCube",
      kind: CompletionItemKind.Function,
      detail: "template: function"
    });

    const tex = items.find(item => item.label === "tex");
    assert.deepStrictEqual(tex, {
      label: "tex",
      kind: CompletionItemKind.Variable,
      detail: "variable: TextureId"
    });
  });

  it("prefers syntactic candidates over workspace symbols with the same label", () => {
    const items = completionItemsForContent("", 0, [templateSymbol("target")]);
    const matches = items.filter(item => item.label === "target");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].kind, CompletionItemKind.Snippet);
  });

  it("resolves the complete hover identifier at its start, middle, and end", () => {
    const text = "use stateSequence()";
    const start = text.indexOf("stateSequence");

    assert.strictEqual(identifierAtOffset(text, start), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, start + 5), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, start + "stateSequence".length), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, text.length), null);
  });

  it("encodes semantic tokens relative to the previous token across lines", () => {
    const document = documentOf("let aa = bb\nuse aa bb");
    const token = (start: number): RsglSemanticToken =>
      ({ start, length: 2, tokenType: 3, tokenModifiers: 1 });

    const data = encodeSemanticTokens([token(4), token(9), token(16), token(19)], document);

    assert.deepStrictEqual(data, [
      0, 4, 2, 3, 1,
      0, 5, 2, 3, 1,
      1, 4, 2, 3, 1,
      0, 3, 2, 3, 1
    ]);
  });

  it("encodes an empty token list as an empty data array", () => {
    assert.deepStrictEqual(encodeSemanticTokens([], documentOf("let a = 1")), []);
  });

  it("computes encoded semantic tokens for a document via the single-module fallback", () => {
    const missingFile = path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-missing", "untracked.rsgl");
    const text = "template cube() {}\nuse cube()";
    const cache = RsglWorkspaceSemanticCache.create();

    const data = computeDocumentSemanticTokens(documentOf(text), missingFile, {
      loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName)
    });

    const functionType = rsglSemanticTokenTypes.indexOf("function");
    const declaration = 1 << rsglSemanticTokenModifiers.indexOf("declaration");
    assert.deepStrictEqual(data, [
      0, 9, 4, functionType, declaration,
      1, 4, 4, functionType, 0
    ]);
  });
});

function diagnosticsForFile(fileName: string, text: string) {
  const cache = RsglWorkspaceSemanticCache.create();
  return computeDocumentDiagnostics(documentOf(text), fileName, {
    loadProgramFromEntry: entryFileName => cache.loadProgramFromEntry(entryFileName),
    settings: emptySettings
  });
}

function blockstateUsingExternalModel(modelId: string): string {
  return [
    "blockstate variants configured {",
    `  {}: { model: ${modelId} }`,
    "}"
  ].join("\n");
}
