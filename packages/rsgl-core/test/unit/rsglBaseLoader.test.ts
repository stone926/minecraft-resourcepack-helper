import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BaseDocumentLoadError,
  compileBaseStatement,
  compileRsglFile,
  compileRsglModule,
  createCachedBaseDocumentLoader,
  createFileBaseDocumentLoader,
  type BaseDocument,
  type CompileDependency
} from "../../src/compiler";
import { type EvaluationContext } from "../../src/compiler/evaluate";
import { parseRsgl, type ExprNode } from "../../src/parser";
import { createTempDir } from "./helpers/fs";

describe("RSGL base document loader", () => {
  it("loads relative JSON and records recursive JSON pointer source ranges", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "src", "main.rsgl");
      const baseFile = path.join(root, "src", "data", "base.json");
      const text = [
        "{",
        "  \"plain\": 1,",
        "  \"nested\": {",
        "    \"slash/key\": true,",
        "    \"tilde~key\": [{ \"value\": \"x\" }]",
        "  }",
        "}"
      ].join("\n");
      fs.mkdirSync(path.dirname(baseFile), { recursive: true });
      fs.writeFileSync(baseFile, text);

      const document = createFileBaseDocumentLoader().load(
        "./data/base.json",
        sourceFile,
        { start: 10, end: 28 }
      );

      assert.strictEqual(document.sourceFile, path.normalize(baseFile));
      assert.deepStrictEqual(document.content, {
        plain: 1,
        nested: {
          "slash/key": true,
          "tilde~key": [{ value: "x" }]
        }
      });
      assert.strictEqual(sourceTextAt(text, document, "/plain"), "\"plain\": 1");
      assert.strictEqual(sourceTextAt(text, document, "/nested/slash~1key"), "\"slash/key\": true");
      assert.strictEqual(sourceTextAt(text, document, "/nested/tilde~0key/0/value"), "\"value\": \"x\"");
      assert.deepStrictEqual(document.sourceRange, { start: 0, end: text.length });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("caches successful loads and failures by resolved path", () => {
    const root = createTempDir();
    const sourceFile = path.join(root, "main.rsgl");
    const document = emptyDocument(path.join(root, "base.json"));
    let successLoads = 0;
    const successful = createCachedBaseDocumentLoader({
      load: () => {
        successLoads++;
        return document;
      }
    });
    assert.strictEqual(successful.load("./base.json", sourceFile, { start: 0, end: 1 }), document);
    assert.strictEqual(successful.load(path.join(root, "base.json"), sourceFile, { start: 2, end: 3 }), document);
    assert.strictEqual(successLoads, 1);

    let failedLoads = 0;
    const failing = createCachedBaseDocumentLoader({
      load: () => {
        failedLoads++;
        throw new BaseDocumentLoadError("rsgl.baseLoadFailed", "missing");
      }
    });
    assert.throws(() => failing.load("./missing.json", sourceFile, { start: 0, end: 1 }), /missing/);
    assert.throws(() => failing.load("./missing.json", sourceFile, { start: 2, end: 3 }), /missing/);
    assert.strictEqual(failedLoads, 1);
  });

  it("records dependencies for load, parse, and root-type failures", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      fs.writeFileSync(path.join(root, "valid.json"), "{\"value\":1}");
      fs.writeFileSync(path.join(root, "invalid.json"), "{");
      fs.writeFileSync(path.join(root, "array.json"), "[]");
      const dependencies: CompileDependency[] = [];
      const errors: string[] = [];
      const context: EvaluationContext = {
        namespace: "minecraft",
        variables: new Map(),
        sourceFile,
        baseDocumentLoader: createFileBaseDocumentLoader(),
        onDependency: dependency => dependencies.push(dependency),
        onError: code => errors.push(code)
      };

      const valid = compileBaseStatement(baseStatement("\"./valid.json\""), context);
      assert.deepStrictEqual(valid?.content, { value: 1 });
      assert.strictEqual(compileBaseStatement(baseStatement("\"./missing.json\""), context), undefined);
      assert.strictEqual(compileBaseStatement(baseStatement("\"./invalid.json\""), context), undefined);
      assert.strictEqual(compileBaseStatement(baseStatement("\"./array.json\""), context), undefined);

      assert.deepStrictEqual(
        dependencies.map(dependency => path.basename(dependency.path)),
        ["valid.json", "missing.json", "invalid.json", "array.json"]
      );
      assert.ok(dependencies.every(dependency => dependency.reason === "base-import"));
      assert.ok(errors.includes("rsgl.baseLoadFailed"));
      assert.ok(errors.includes("rsgl.baseParseFailed"));
      assert.ok(errors.includes("rsgl.baseMustBeObject"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves nested loader dependencies when the base root is invalid", () => {
    const sourceFile = path.resolve("virtual", "main.rsgl");
    const nestedFile = path.resolve("virtual", "nested.json");
    const dependencies: CompileDependency[] = [];
    const errors: string[] = [];
    const context: EvaluationContext = {
      namespace: "minecraft",
      variables: new Map(),
      sourceFile,
      baseDocumentLoader: {
        load(basePath, nestedSourceFile, sourceRange) {
          return {
            content: [],
            sourceFile: basePath,
            sourceRange: { start: 0, end: 2 },
            sourceRanges: new Map([["", { start: 0, end: 2 }]]),
            dependencies: [{
              path: nestedFile,
              reason: "base-import",
              sourceFile: nestedSourceFile,
              sourceRange
            }]
          };
        }
      },
      onDependency: dependency => dependencies.push(dependency),
      onError: code => errors.push(code)
    };

    assert.strictEqual(compileBaseStatement(baseStatement("\"./base.json\""), context), undefined);
    assert.deepStrictEqual(dependencies.map(dependency => dependency.path), [
      path.resolve("virtual", "base.json"),
      nestedFile
    ]);
    assert.deepStrictEqual(errors, ["rsgl.baseMustBeObject"]);
  });

  it("rejects non-string and empty paths without recording dependencies", () => {
    const dependencies: CompileDependency[] = [];
    const errors: string[] = [];
    const context: EvaluationContext = {
      namespace: "minecraft",
      variables: new Map(),
      onDependency: dependency => dependencies.push(dependency),
      onError: code => errors.push(code)
    };

    assert.strictEqual(compileBaseStatement(baseStatement("1"), context), undefined);
    assert.strictEqual(compileBaseStatement(baseStatement("\"   \""), context), undefined);
    assert.deepStrictEqual(dependencies, []);
    assert.deepStrictEqual(errors, ["rsgl.basePathMustBeStaticString", "rsgl.baseInvalidPath"]);
  });

  it("propagates loader dependencies even when the base root is not an object", () => {
    const sourceFile = path.resolve("virtual", "main.rsgl");
    const nestedPath = path.resolve("virtual", "nested.json");
    const dependencies: CompileDependency[] = [];
    const errors: string[] = [];
    const context: EvaluationContext = {
      namespace: "minecraft",
      variables: new Map(),
      sourceFile,
      baseDocumentLoader: {
        load(request) {
          return {
            content: [],
            sourceFile: request,
            sourceRange: { start: 0, end: 2 },
            sourceRanges: new Map(),
            dependencies: [{
              path: nestedPath,
              reason: "base-import",
              sourceFile: request,
              sourceRange: { start: 0, end: 2 }
            }]
          };
        }
      },
      onDependency: dependency => dependencies.push(dependency),
      onError: code => errors.push(code)
    };

    assert.strictEqual(compileBaseStatement(baseStatement("\"./invalid.json\""), context), undefined);
    assert.deepStrictEqual(dependencies.map(dependency => dependency.path), [
      path.resolve("virtual", "invalid.json"),
      nestedPath
    ]);
    assert.deepStrictEqual(errors, ["rsgl.baseMustBeObject"]);
  });

  it("exposes an empty dependency list for compilations without external inputs", () => {
    const result = compileRsglModule(parseRsgl("model block stone {}"));
    assert.deepStrictEqual(result.dependencies, []);
  });

  it("uses an injected base loader through the public compile options", () => {
    const sourceFile = path.resolve("virtual", "main.rsgl");
    const expectedBaseFile = path.resolve("virtual", "base.json");
    const requests: string[] = [];
    const result = compileRsglModule(parseRsgl([
      "model block injected {",
      "  base \"./base.json\"",
      "}"
    ].join("\n")), {
      fileName: sourceFile,
      baseDocumentLoader: {
        load(request) {
          requests.push(request);
          return {
            content: { parent: "minecraft:block/cube_all" },
            sourceFile: request,
            sourceRange: { start: 0, end: 42 },
            sourceRanges: new Map([
              ["", { start: 0, end: 42 }],
              ["/parent", { start: 2, end: 40 }]
            ]),
            dependencies: []
          };
        }
      }
    });

    assert.deepStrictEqual(requests, [expectedBaseFile]);
    assert.deepStrictEqual(result.units[0].content, { parent: "minecraft:block/cube_all" });
    assert.deepStrictEqual(result.dependencies.map(dependency => dependency.path), [expectedBaseFile]);
  });

  it("initializes resource content, dependencies, and field source mappings from base", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      const baseFile = path.join(root, "model.json");
      fs.writeFileSync(baseFile, JSON.stringify({
        parent: "minecraft:block/cube_all",
        textures: { all: "minecraft:block/stone" }
      }, null, 2));
      fs.writeFileSync(sourceFile, [
        "extern! vanilla model minecraft:block/cube_column",
        "extern! vanilla texture minecraft:block/stone, minecraft:block/particle",
        "model block imported {",
        "  base \"./model.json\"",
        "  merge deep { textures: { particle: minecraft:block/particle } }",
        "  merge { parent: minecraft:block/cube_column }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);

      assert.deepStrictEqual(result.diagnostics, []);
      assert.deepStrictEqual(result.units[0].content, {
        parent: "minecraft:block/cube_column",
        textures: {
          all: "minecraft:block/stone",
          particle: "minecraft:block/particle"
        }
      });
      assert.deepStrictEqual(result.dependencies.map(dependency => dependency.path), [path.resolve(baseFile)]);
      const mappings = result.units[0].sourceMap.mappings;
      assert.strictEqual(mappings.find(mapping => mapping.generatedPath === "/textures/all")?.sourceFile, path.resolve(baseFile));
      assert.strictEqual(mappings.findLast(mapping => mapping.generatedPath === "/parent")?.sourceFile, path.resolve(sourceFile));
      assert.strictEqual(mappings.findLast(mapping => mapping.generatedPath === "/textures/particle")?.reason, "direct");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("records a missing base dependency so creating the file can invalidate the build", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      const missingFile = path.join(root, "later.json");
      fs.writeFileSync(sourceFile, [
        "model block imported {",
        "  base \"./later.json\"",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);

      assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.baseLoadFailed"));
      assert.deepStrictEqual(result.dependencies.map(dependency => dependency.path), [path.resolve(missingFile)]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("anchors base-content validation diagnostics to the RSGL base statement", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      const baseFile = path.join(root, "model.json");
      fs.writeFileSync(baseFile, JSON.stringify({
        textures: { all: "#missing" }
      }));
      fs.writeFileSync(sourceFile, [
        "model block imported {",
        "  base \"./model.json\"",
        "  merge deep { textures: { particle: minecraft:block/particle } }",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);
      const diagnostic = result.diagnostics.find(item => item.code === "rsgl.unresolvedTextureVariable");
      const baseStatementMapping = result.units[0].sourceMap.mappings.findLast(mapping =>
        mapping.generatedPath === "" && mapping.reason === "direct"
      );

      assert.ok(diagnostic);
      assert.deepStrictEqual(diagnostic.range, baseStatementMapping?.sourceRange);
      assert.strictEqual(diagnostic.fileName, path.resolve(sourceFile));
      assert.ok(result.units[0].sourceMap.mappings.some(mapping =>
        mapping.generatedPath === "/textures/all"
        && mapping.reason === "base"
        && mapping.sourceFile === path.resolve(baseFile)
      ));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the current model extern var to base content without disturbing source mappings", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      const baseFile = path.join(root, "model.json");
      const baseText = JSON.stringify({
        textures: { all: "#missing" }
      }, null, 2);
      const sourceText = [
        "model block imported {",
        "  base \"./model.json\"",
        "  extern var #missing",
        "}"
      ].join("\n");
      fs.writeFileSync(baseFile, baseText);
      fs.writeFileSync(sourceFile, sourceText);

      const result = compileRsglFile(sourceFile);
      assert.strictEqual(result.diagnostics.some(diagnostic =>
        diagnostic.code === "rsgl.unresolvedTextureVariable"
      ), false);

      const unit = result.units[0];
      assert.deepStrictEqual(unit.content, {
        textures: { all: "#missing" }
      });
      assert.strictEqual(JSON.stringify(unit.content).includes("extern"), false);

      const baseFieldMapping = unit.sourceMap.mappings.find(mapping =>
        mapping.generatedPath === "/textures/all"
        && mapping.reason === "base"
      );
      assert.ok(baseFieldMapping);
      assert.strictEqual(baseFieldMapping.sourceFile, path.resolve(baseFile));
      assert.strictEqual(
        baseText.slice(baseFieldMapping.sourceRange.start, baseFieldMapping.sourceRange.end),
        "\"all\": \"#missing\""
      );

      const baseStatementMapping = unit.sourceMap.mappings.findLast(mapping =>
        mapping.generatedPath === "" && mapping.reason === "direct"
      );
      assert.ok(baseStatementMapping);
      assert.strictEqual(
        sourceText.slice(baseStatementMapping.sourceRange.start, baseStatementMapping.sourceRange.end),
        "base \"./model.json\""
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("anchors mcmeta base validation diagnostics to the RSGL base statement", () => {
    const root = createTempDir();
    try {
      const sourceFile = path.join(root, "main.rsgl");
      const baseFile = path.join(root, "animation.json");
      fs.writeFileSync(baseFile, JSON.stringify({ animation: { frametime: 0 } }));
      fs.writeFileSync(sourceFile, [
        "mcmeta \"assets/minecraft/textures/block/animated.png\" {",
        "  base \"./animation.json\"",
        "}"
      ].join("\n"));

      const result = compileRsglFile(sourceFile);
      const unit = result.units[0];
      const diagnostic = result.diagnostics.find(item => item.code === "rsgl.invalidMcmetaFrameTime");
      const baseStatementMapping = unit.sourceMap.mappings.findLast(mapping =>
        mapping.generatedPath === "" && mapping.reason === "direct"
      );

      assert.ok(diagnostic);
      assert.deepStrictEqual(diagnostic.range, baseStatementMapping?.sourceRange);
      assert.strictEqual(diagnostic.fileName, path.resolve(sourceFile));
      assert.ok(unit.sourceMap.mappings.some(mapping =>
        mapping.generatedPath === "/animation/frametime"
        && mapping.reason === "base"
        && mapping.sourceFile === path.resolve(baseFile)
      ));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("deduplicates identical dependencies reported by an injected loader", () => {
    const fileName = path.resolve("pack", "main.rsgl");
    const module = parseRsgl([
      "model block imported {",
      "  base \"./base.json\"",
      "}"
    ].join("\n"));
    const result = compileRsglModule(module, {
      fileName,
      baseDocumentLoader: {
        load(basePath, sourceFile, sourceRange) {
          return {
            content: {},
            sourceFile: basePath,
            sourceRange: { start: 0, end: 2 },
            sourceRanges: new Map([["", { start: 0, end: 2 }]]),
            dependencies: [{
              path: basePath,
              reason: "base-import",
              sourceFile,
              sourceRange
            }]
          };
        }
      }
    });

    assert.deepStrictEqual(result.diagnostics, []);
    assert.strictEqual(result.dependencies.length, 1);
  });
});

function baseStatement(expressionSource: string): { path: ExprNode; range: { start: number; end: number } } {
  const module = parseRsgl(`let basePath = ${expressionSource}`);
  const statement = module.statements[0];
  if (statement.kind !== "LetDecl") {
    throw new Error("Expected a let declaration fixture.");
  }
  return { path: statement.value, range: statement.range };
}

function emptyDocument(sourceFile: string): BaseDocument {
  return {
    content: {},
    sourceFile,
    sourceRange: { start: 0, end: 2 },
    sourceRanges: new Map([["", { start: 0, end: 2 }]]),
    dependencies: []
  };
}

function sourceTextAt(text: string, document: BaseDocument, pointer: string): string {
  const range = document.sourceRanges.get(pointer);
  assert.ok(range, `Missing source range for ${pointer}`);
  return text.slice(range.start, range.end);
}
