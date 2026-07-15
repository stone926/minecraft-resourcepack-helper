import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CodeActionKind, CompletionItemKind, DiagnosticSeverity, InsertTextFormat } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  RsglWorkspaceSemanticCache,
  parseRsgl,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  type RsglSemanticToken,
  type RsglSymbol
} from "../../../rsgl-core/src";
import {
  clampOffset,
  codeActionsForDiagnostics,
  completionItemsForContent,
  completionItemsForDocument,
  computeDocumentHover,
  computeDocumentSignatureHelp,
  computeDocumentDiagnostics,
  computeDocumentSemanticTokens,
  definitionLocationForDocument,
  dependencyPathsForDocument,
  dependencyPathsForDocuments,
  documentsDependingOnPath,
  encodeSemanticTokens,
  formattingEditsForDocument,
  handleSemanticWatchedFileBatch,
  identifierAtOffset,
  normalizeDependencyPath,
  prepareRenameForDocument,
  renameEditsForDocument,
  toLspDefinitionLocation,
  toLspDiagnostic,
  toLspSeverity,
  toLspWorkspaceEdit,
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

  it("creates preferred token-sized quick fixes for both wrong-arrow diagnostics", () => {
    const source = [
      "/*😀*/ let identity = value -> value",
      "type Mapper = (Json) => ModelId"
    ].join("\n");
    const document = documentOf(source);
    const diagnostics = parseRsgl(source).diagnostics.map(diagnostic =>
      toLspDiagnostic(document, diagnostic)
    );
    const actions = codeActionsForDiagnostics(document, document.uri, [
      ...diagnostics,
      {
        range: diagnostics[0].range,
        message: "unrelated",
        code: "rsgl.expectedMappingArrow",
        source: "RSGL"
      },
      { ...diagnostics[0], source: "another-language" },
      { ...diagnostics[0], range: diagnostics[1].range }
    ]);

    assert.strictEqual(actions.length, 2);
    assert.ok(actions.every(action => action.kind === CodeActionKind.QuickFix));
    assert.ok(actions.every(action => action.isPreferred));
    assert.ok(actions.every(action => action.diagnostics?.length === 1));
    const documentChanges = actions.flatMap(action => action.edit?.documentChanges ?? []);
    assert.ok(documentChanges.every(change =>
      "textDocument" in change
      && change.textDocument.uri === document.uri
      && change.textDocument.version === document.version
    ));
    const edits = documentChanges.flatMap(change => "edits" in change ? change.edits : []);
    assert.deepStrictEqual(edits.map(edit => document.getText(edit.range)), ["->", "=>"]);
    assert.deepStrictEqual(edits.map(edit => edit.newText), ["=>", "->"]);

    const fixed = [...edits]
      .sort((left, right) => document.offsetAt(right.range.start) - document.offsetAt(left.range.start))
      .reduce((text, edit) => {
        const start = document.offsetAt(edit.range.start);
        const end = document.offsetAt(edit.range.end);
        return text.slice(0, start) + edit.newText + text.slice(end);
      }, source);
    assert.deepStrictEqual(parseRsgl(fixed).diagnostics, []);
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
        "export { cube }",
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
      "  case * => project_ns:block/rotated with { z: 90 }",
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

  it("reports invalid extern configuration with its dedicated diagnostic code", () => {
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
      { name: "tex", kind: "variable", type: { kind: "TextureId" } },
      {
        name: "common",
        kind: "namespace",
        type: { kind: "ModuleNamespace", moduleNamespaceId: "common.rsgl" }
      },
      {
        name: "mapper",
        kind: "variable",
        type: {
          kind: "Function",
          parameters: [{ kind: "Number" }],
          returnType: { kind: "String" }
        }
      }
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
      detail: "template: myCube(): Unknown"
    });

    const tex = items.find(item => item.label === "tex");
    assert.deepStrictEqual(tex, {
      label: "tex",
      kind: CompletionItemKind.Variable,
      detail: "variable: TextureId"
    });

    const common = items.find(item => item.label === "common");
    assert.deepStrictEqual(common, {
      label: "common",
      kind: CompletionItemKind.Module,
      detail: "namespace: module namespace"
    });

    const mapper = items.find(item => item.label === "mapper");
    assert.deepStrictEqual(mapper, {
      label: "mapper",
      kind: CompletionItemKind.Function,
      detail: "variable: mapper(arg1: Number): String"
    });
  });

  it("prefers syntactic candidates over workspace symbols with the same label", () => {
    const items = completionItemsForContent("", 0, [templateSymbol("target")]);
    const matches = items.filter(item => item.label === "target");
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].kind, CompletionItemKind.Snippet);
  });

  it("maps model transform completion and formatting through the LSP protocol surface", () => {
    const completionSource = "template rotated() -> model {\n  ";
    const items = completionItemsForContent(completionSource, completionSource.length, []);
    const transform = items.find(item => item.label === "transform");

    assert.strictEqual(transform?.kind, CompletionItemKind.Snippet);
    assert.strictEqual(transform?.insertTextFormat, InsertTextFormat.Snippet);
    assert.strictEqual(
      transform?.insertText,
      "transform ${1|rotate_x,rotate_y,rotate_z|}(${2:90}) around [${3:8, 8, 8}] {\n  ${4}\n}"
    );

    const unformatted = [
      "template rotated() -> model {",
      "transform rotate_y(90) around [8, 8, 8] {",
      "element from [0, 0, 0] to [4, 8, 4] {",
      "north texture \"#side\"",
      "}",
      "}",
      "}"
    ].join("\n");
    const document = documentOf(unformatted);
    const edits = formattingEditsForDocument(document, 2);

    assert.deepStrictEqual(edits, [{
      range: {
        start: { line: 0, character: 0 },
        end: document.positionAt(unformatted.length)
      },
      newText: [
        "template rotated() -> model {",
        "  transform rotate_y(90) around [8, 8, 8] {",
        "    element from [0, 0, 0] to [4, 8, 4] {",
        "      north texture \"#side\"",
        "    }",
        "  }",
        "}"
      ].join("\n")
    }]);
    assert.deepStrictEqual(formattingEditsForDocument(documentOf(edits[0].newText), 2), []);
  });

  it("resolves the complete hover identifier at its start, middle, and end", () => {
    const text = "use stateSequence()";
    const start = text.indexOf("stateSequence");

    assert.strictEqual(identifierAtOffset(text, start), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, start + 5), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, start + "stateSequence".length), "stateSequence");
    assert.strictEqual(identifierAtOffset(text, text.length), null);
  });

  it("converts linked hover, signatures, and cross-file definitions with UTF-16 positions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-lsp-intelligence-"));
    try {
      const mainFile = path.join(root, "main.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const templatesFile = path.join(root, "模板.rsgl");
      const mainText = [
        "/*😀*/ import { forwardedCube as buildCube } from \"./barrel.rsgl\"",
        "model block example {",
        "  use buildCube(minecraft:block/example, texture: minecraft:block/stone)",
        "}"
      ].join("\n");
      const barrelText = "export { exportedCube as forwardedCube } from \"./模板.rsgl\"";
      const templatesText = [
        "/*😀*/ template cube(id: ResourceId, texture: TextureId = id) -> model {",
        "}",
        "export { cube as exportedCube }"
      ].join("\n");
      fs.writeFileSync(mainFile, mainText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(templatesFile, templatesText);

      const mainDocument = TextDocument.create(pathToFileURL(mainFile).toString(), "rsgl", 1, mainText);
      const targetDocument = TextDocument.create(pathToFileURL(templatesFile).toString(), "rsgl", 1, templatesText);
      const cache = RsglWorkspaceSemanticCache.create();
      const deps = { loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName) };
      const referenceOffset = mainText.lastIndexOf("buildCube");

      const hover = computeDocumentHover(mainDocument, mainFile, referenceOffset + 2, deps);
      assert.ok(hover);
      assert.deepStrictEqual(hover.range, {
        start: mainDocument.positionAt(referenceOffset),
        end: mainDocument.positionAt(referenceOffset + "buildCube".length)
      });
      assert.ok((hover.contents as { value: string }).value.includes("template buildCube"));
      assert.ok((hover.contents as { value: string }).value.includes("template -> model"));

      const signatureOffset = mainText.lastIndexOf("minecraft:block/stone") + 5;
      const signature = computeDocumentSignatureHelp(mainDocument, mainFile, signatureOffset, deps);
      assert.strictEqual(signature?.activeParameter, 1);
      assert.strictEqual(signature?.signatures[0].parameters?.[1].label, "texture: TextureId = ...");

      const definition = definitionLocationForDocument(mainDocument, mainFile, referenceOffset + 2, deps);
      assert.ok(definition);
      const location = toLspDefinitionLocation(targetDocument, targetDocument.uri, definition);
      const definitionStart = templatesText.indexOf("cube");
      assert.deepStrictEqual(location, {
        uri: targetDocument.uri,
        range: {
          start: targetDocument.positionAt(definitionStart),
          end: targetDocument.positionAt(definitionStart + "cube".length)
        }
      });
      assert.strictEqual(location.range.start.character, "/*😀*/ template ".length);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepares namespace renames and converts cross-file member edits with UTF-16 positions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-rename-lsp-"));
    try {
      const mainFile = path.join(root, "入口.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const commonFile = path.join(root, "共享.rsgl");
      const mainText = [
        "/*😀*/ import * as common from \"./barrel.rsgl\"",
        "let selected = common.VALUE"
      ].join("\n");
      const barrelText = [
        "import { VALUE as V } from \"./共享.rsgl\"",
        "export { V as VALUE }"
      ].join("\n");
      const commonText = [
        "/*😀*/ let VALUE = \"stone\"",
        "export { VALUE }"
      ].join("\n");
      fs.writeFileSync(mainFile, mainText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(commonFile, commonText);

      const documentsByFile = new Map([
        [path.normalize(mainFile), TextDocument.create(pathToFileURL(mainFile).toString(), "rsgl", 1, mainText)],
        [path.normalize(barrelFile), TextDocument.create(pathToFileURL(barrelFile).toString(), "rsgl", 1, barrelText)],
        [path.normalize(commonFile), TextDocument.create(pathToFileURL(commonFile).toString(), "rsgl", 1, commonText)]
      ]);
      const mainDocument = documentsByFile.get(path.normalize(mainFile))!;
      const cache = RsglWorkspaceSemanticCache.create();
      const deps = { loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName) };
      const aliasOffset = mainText.indexOf("common");
      const memberOffset = mainText.lastIndexOf("VALUE");

      assert.deepStrictEqual(
        prepareRenameForDocument(mainDocument, mainFile, aliasOffset + 1, deps),
        {
          range: {
            start: mainDocument.positionAt(aliasOffset),
            end: mainDocument.positionAt(aliasOffset + "common".length)
          },
          placeholder: "common"
        }
      );
      assert.strictEqual(
        mainDocument.positionAt(aliasOffset).character,
        mainText.slice(0, aliasOffset).length,
        "LSP positions must count the astral emoji as two UTF-16 code units"
      );

      const aliasEdits = renameEditsForDocument(
        mainDocument,
        mainFile,
        aliasOffset + 1,
        "shared",
        deps
      );
      assert.ok(aliasEdits);
      const aliasWorkspaceEdit = await toLspWorkspaceEdit(aliasEdits, async fileName =>
        documentsByFile.get(path.normalize(fileName)) ?? null
      );
      assert.deepStrictEqual(Object.keys(aliasWorkspaceEdit?.changes ?? {}), [mainDocument.uri]);
      assert.strictEqual(aliasWorkspaceEdit?.changes?.[mainDocument.uri].length, 2);
      assert.ok(aliasWorkspaceEdit?.changes?.[mainDocument.uri].every(edit => edit.newText === "shared"));

      assert.deepStrictEqual(
        prepareRenameForDocument(mainDocument, mainFile, memberOffset + 1, deps),
        {
          range: {
            start: mainDocument.positionAt(memberOffset),
            end: mainDocument.positionAt(memberOffset + "VALUE".length)
          },
          placeholder: "VALUE"
        }
      );
      const memberEdits = renameEditsForDocument(
        mainDocument,
        mainFile,
        memberOffset + 1,
        "RENAMED",
        deps
      );
      assert.ok(memberEdits);
      assert.strictEqual(memberEdits.length, 5);
      const loadedFiles: string[] = [];
      const memberWorkspaceEdit = await toLspWorkspaceEdit(memberEdits, async fileName => {
        loadedFiles.push(path.normalize(fileName));
        return documentsByFile.get(path.normalize(fileName)) ?? null;
      });
      assert.deepStrictEqual(new Set(Object.keys(memberWorkspaceEdit?.changes ?? {})), new Set([
        documentsByFile.get(path.normalize(mainFile))!.uri,
        documentsByFile.get(path.normalize(barrelFile))!.uri,
        documentsByFile.get(path.normalize(commonFile))!.uri
      ]));
      assert.strictEqual(new Set(loadedFiles).size, 3, "each target document should load once");

      const commonDocument = documentsByFile.get(path.normalize(commonFile))!;
      const definitionOffset = commonText.indexOf("VALUE");
      const definitionEdit = memberWorkspaceEdit?.changes?.[commonDocument.uri].find(edit =>
        edit.range.start.line === commonDocument.positionAt(definitionOffset).line
        && edit.range.start.character === commonDocument.positionAt(definitionOffset).character
      );
      assert.ok(definitionEdit);
      assert.strictEqual(definitionEdit.newText, "RENAMED");
      assert.strictEqual(
        definitionEdit.range.start.character,
        commonText.slice(0, definitionOffset).length
      );
      assert.notStrictEqual(
        definitionEdit.range.start.character,
        Array.from(commonText.slice(0, definitionOffset)).length
      );
      assert.strictEqual(
        renameEditsForDocument(mainDocument, mainFile, memberOffset + 1, "not-valid!", deps),
        null
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("advertises prepare rename and quick fixes and registers their handlers", () => {
    const serverSource = fs.readFileSync(path.join(
      process.cwd(),
      "packages",
      "rsgl-lsp",
      "src",
      "server.ts"
    ), "utf8");

    assert.ok(serverSource.includes("renameProvider: { prepareProvider: true }"));
    assert.ok(serverSource.includes("connection.onPrepareRename"));
    assert.ok(serverSource.includes("connection.onRenameRequest"));
    assert.ok(serverSource.includes("codeActionKinds: [CodeActionKind.QuickFix]"));
    assert.ok(serverSource.includes("connection.onCodeAction"));
  });

  it("converts imported record member tooling and field definitions with UTF-16 positions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-member-lsp-"));
    try {
      const sourceFile = path.join(root, "原始字段.rsgl");
      const barrelFile = path.join(root, "barrel.rsgl");
      const mainFile = path.join(root, "入口.rsgl");
      const sourceText = [
        "/*😀*/ type Original = { name: String; top?: TextureId }",
        "export { Original as Public }"
      ].join("\n");
      const barrelText = "export { Public as Forwarded } from \"./原始字段.rsgl\"";
      const mainText = [
        "import { Forwarded as Local } from \"./barrel.rsgl\"",
        "let entry: Local = { name: \"wheat\" }",
        "let title = entry.name"
      ].join("\n");
      fs.writeFileSync(sourceFile, sourceText);
      fs.writeFileSync(barrelFile, barrelText);
      fs.writeFileSync(mainFile, mainText);

      const mainDocument = TextDocument.create(pathToFileURL(mainFile).toString(), "rsgl", 1, mainText);
      const targetDocument = TextDocument.create(pathToFileURL(sourceFile).toString(), "rsgl", 1, sourceText);
      const cache = RsglWorkspaceSemanticCache.create();
      const deps = { loadProgramFromEntry: (fileName: string) => cache.loadProgramFromEntry(fileName) };
      const memberStart = mainText.lastIndexOf("name");
      const completionOffset = mainText.lastIndexOf("entry.name") + "entry.".length;

      assert.deepStrictEqual(completionItemsForDocument(mainDocument, mainFile, completionOffset, deps), [
        { label: "name", kind: CompletionItemKind.Property, detail: "property: String" },
        { label: "top", kind: CompletionItemKind.Property, detail: "optional property: TextureId" }
      ]);
      const hover = computeDocumentHover(mainDocument, mainFile, memberStart + 1, deps);
      assert.ok((hover?.contents as { value: string }).value.includes("property name: String"));

      const definition = definitionLocationForDocument(mainDocument, mainFile, memberStart + 1, deps);
      assert.ok(definition);
      const location = toLspDefinitionLocation(targetDocument, targetDocument.uri, definition);
      const fieldStart = sourceText.indexOf("name");
      assert.deepStrictEqual(location.range, {
        start: targetDocument.positionAt(fieldStart),
        end: targetDocument.positionAt(fieldStart + "name".length)
      });
      assert.strictEqual(location.range.start.character, sourceText.slice(0, fieldStart).length);
      assert.notStrictEqual(
        location.range.start.character,
        Array.from(sourceText.slice(0, fieldStart)).length,
        "the astral emoji should occupy two UTF-16 code units"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    `  case * => ${modelId}`,
    "}"
  ].join("\n");
}
