import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { minecraftResourceTarget } from "../../packages/mc-assets/src";
import { topLevelRsglCompletions } from "../../packages/rsgl-core/src/completionData";
import {
  canonicalizeAndValidateResourceUnits,
  compileRsglModule,
  emitRsglFiles
} from "../../packages/rsgl-core/src/compiler";
import { parseRsgl } from "../../packages/rsgl-core/src/parser";
import { resourceKeywords } from "../../packages/rsgl-core/src/parser/keywords";
import {
  externOnlyKinds,
  externResourceKindDescription,
  getExternResourceKind,
  getExternResourceTargetKind,
  isExternResourceKind,
  rsglExternResourceCompletionDescriptors,
  rsglExternResourceKinds,
  rsglGenericJsonResourceKinds,
  rsglResourceCompletionDescriptors,
  rsglResourceKindDescriptors,
  rsglResourceKinds
} from "../../packages/rsgl-core/src/resourceKinds";
import { readGrammar, rsglGrammarPath, tokenizeGrammar } from "./helpers/textMateGrammar";

describe("RSGL resource kind descriptors", () => {
  it("derive parser keywords, generic JSON kinds, and completion snippets from one registry", () => {
    assert.deepStrictEqual(rsglResourceKinds, rsglResourceKindDescriptors.map(descriptor => descriptor.keyword));
    assert.deepStrictEqual(resourceKeywords, rsglResourceKinds);
    assert.deepStrictEqual(
      rsglGenericJsonResourceKinds,
      rsglResourceKindDescriptors
        .filter(descriptor => descriptor.compile.handler === "genericJson")
        .map(descriptor => descriptor.keyword)
    );

    const descriptorCompletions = rsglResourceKindDescriptors
      .flatMap(descriptor => [...descriptor.completions])
      .sort((left, right) => left.order - right.order)
      .map(({ label, insertText, detail }) => ({ label, insertText, detail }));
    assert.deepStrictEqual(rsglResourceCompletionDescriptors, descriptorCompletions);
    for (const completion of descriptorCompletions) {
      assert.ok(topLevelRsglCompletions.some(candidate =>
        candidate.label === completion.label
        && candidate.insertText === completion.insertText
        && candidate.detail === completion.detail
      ), `Expected top-level completion '${completion.label}' to come from the resource descriptor registry.`);
    }
  });

  it("derives extern kinds, validation, diagnostics, and completions from registry metadata", () => {
    const compilableExternKinds = rsglResourceKindDescriptors
      .filter(descriptor => "supportsExtern" in descriptor && descriptor.supportsExtern === true)
      .map(descriptor => descriptor.keyword);
    const expectedKinds = [
      "model",
      "blockstate",
      "item",
      "font",
      "texture",
      "texture_directory",
      "sound",
      "font_file",
      "shader_vertex",
      "shader_fragment"
    ];

    assert.deepStrictEqual(rsglExternResourceKinds, [...compilableExternKinds, ...externOnlyKinds]);
    assert.deepStrictEqual(rsglExternResourceKinds, expectedKinds);
    assert.strictEqual(new Set(rsglExternResourceKinds).size, rsglExternResourceKinds.length);
    assert.strictEqual((rsglResourceKinds as readonly string[]).includes("texture"), false);
    assert.strictEqual(
      externResourceKindDescription,
      "'model', 'blockstate', 'item', 'font', 'texture', 'texture_directory', 'sound', 'font_file', 'shader_vertex', or 'shader_fragment'"
    );

    for (const kind of rsglExternResourceKinds) {
      assert.strictEqual(isExternResourceKind(kind), true);
      assert.strictEqual(getExternResourceKind(kind), kind);
    }
    for (const kind of ["atlas", "particles", "unknown", ""]) {
      assert.strictEqual(isExternResourceKind(kind), false);
      assert.strictEqual(getExternResourceKind(kind), null);
    }
    assert.strictEqual(getExternResourceKind(undefined), null);

    const externGrammar = readGrammar();
    for (const kind of rsglExternResourceKinds) {
      const source = `extern custom ${kind} example`;
      const scopes = tokenizeGrammar(externGrammar, source).scopesAt(source.indexOf(kind));
      assert.ok(scopes.includes("storage.type.rsgl"), `TextMate grammar is missing extern kind '${kind}'.`);
    }

    assert.deepStrictEqual(
      rsglExternResourceCompletionDescriptors.map(completion => completion.label),
      rsglExternResourceKinds.flatMap(kind => [`extern ${kind}`, `extern! ${kind}`])
    );
    for (const completion of rsglExternResourceCompletionDescriptors) {
      assert.ok(topLevelRsglCompletions.some(candidate =>
        candidate.label === completion.label &&
        candidate.insertText === completion.insertText &&
        candidate.detail === completion.detail
      ));
    }
  });

  it("keeps every descriptor complete across parser, compiler, validation, completion, emit, and grammar", () => {
    const fileName = path.join(process.cwd(), "descriptor-contract.rsgl");
    const grammar = readGrammarStorageTypePattern();
    const seenKeywords = new Set<string>();

    for (const descriptor of rsglResourceKindDescriptors) {
      assert.strictEqual(seenKeywords.has(descriptor.keyword), false, `Duplicate resource keyword '${descriptor.keyword}'.`);
      seenKeywords.add(descriptor.keyword);
      assert.ok(descriptor.compile.handler);
      assert.ok(descriptor.validation.handler);
      assert.ok(descriptor.ast.bodyDialect);
      assert.ok(descriptor.completions.length > 0, `Missing completion metadata for '${descriptor.keyword}'.`);
      assert.ok(descriptor.emit.contentKind);
      assert.ok(descriptor.emit.pathStrategy);
      assert.match(descriptor.keyword, grammar, `TextMate grammar is missing resource keyword '${descriptor.keyword}'.`);

      const source = sourceForDescriptor(descriptor.keyword);
      const module = parseRsgl(source);
      assert.deepStrictEqual(module.diagnostics, [], `Parser rejected descriptor source for '${descriptor.keyword}'.`);
      const declaration = module.statements[0];
      assert.strictEqual(declaration.kind, "ResourceDecl");
      if (declaration.kind !== "ResourceDecl") {
        continue;
      }
      assert.strictEqual(declaration.resourceKind, descriptor.keyword);
      assert.strictEqual(Boolean(declaration.id), descriptor.ast.shape !== "anonymous");
      assert.strictEqual(Boolean(declaration.subtype), descriptor.ast.shape === "model");

      const result = compileRsglModule(module, { fileName });
      const unit = result.units.find(candidate => candidate.kind === descriptor.keyword);
      assert.ok(unit, `Compile handler '${descriptor.compile.handler}' did not emit '${descriptor.keyword}'.`);
      assert.doesNotThrow(() => canonicalizeAndValidateResourceUnits(result.units));
      const emitted = emitRsglFiles([unit!]).find(file => file.kind === "resource");
      assert.ok(emitted, `Emit metadata did not produce a resource file for '${descriptor.keyword}'.`);
      assert.strictEqual("copyFrom" in emitted!, descriptor.emit.contentKind === "binaryCopy");
    }
  });

  it("routes every extern kind through the shared Minecraft file target registry", () => {
    const expectedTargets = {
      model: { targetKind: "model", directory: "models", extension: "json", isDirectory: false },
      blockstate: { targetKind: "blockstate", directory: "blockstates", extension: "json", isDirectory: false },
      item: { targetKind: "item", directory: "items", extension: "json", isDirectory: false },
      font: { targetKind: "font", directory: "font", extension: "json", isDirectory: false },
      texture: { targetKind: "texture", directory: "textures", extension: "png", isDirectory: false },
      texture_directory: { targetKind: "textureDirectory", directory: "textures", extension: null, isDirectory: true },
      sound: { targetKind: "sound", directory: "sounds", extension: "ogg", isDirectory: false },
      font_file: { targetKind: "fontFile", directory: "font", extension: null, isDirectory: false },
      shader_vertex: { targetKind: "shaderVertex", directory: "shaders", extension: "vsh", isDirectory: false },
      shader_fragment: { targetKind: "shaderFragment", directory: "shaders", extension: "fsh", isDirectory: false }
    } as const;

    for (const kind of rsglExternResourceKinds) {
      const targetKind = getExternResourceTargetKind(kind);
      const { targetKind: expectedTargetKind, ...expectedTarget } = expectedTargets[kind];
      assert.strictEqual(targetKind, expectedTargetKind);
      assert.deepStrictEqual(minecraftResourceTarget(targetKind), expectedTarget);
    }
  });

  it("routes compiler and validation through descriptor-selected handler tables", () => {
    const compilerSource = readSource("packages", "rsgl-core", "src", "compiler", "compiler.ts");
    const resourceCompilerSource = readSource("packages", "rsgl-core", "src", "compiler", "resourceCompiler.ts");
    const validationSource = readSource("packages", "rsgl-core", "src", "compiler", "validation.ts");
    const parserSource = readSource("packages", "rsgl-core", "src", "parser", "parser.ts");
    const statementParserSource = readSource("packages", "rsgl-core", "src", "parser", "statementParser.ts");
    const bodyContextSource = readSource("packages", "rsgl-core", "src", "parser", "bodyParseContext.ts");

    assert.match(
      compilerSource,
      /compileResourceDeclaration\(\s*statement,\s*resourceContext,\s*this\.resourceBodies\.resourceDeclarationCompilerHost\([^)]*\)\s*\)/
    );
    assert.strictEqual(compilerSource.includes("private compileModel("), false);
    assert.ok(resourceCompilerSource.includes("satisfies Record<RsglResourceCompileHandler, ResourceCompileHandler>"));
    assert.ok(resourceCompilerSource.includes("resourceCompileHandlers[descriptor.compile.handler]"));
    assert.ok(resourceCompilerSource.includes("applyResourceKindOutputPath(statement.resourceKind, unit)"));
    assert.ok(validationSource.includes("resourceValidators[validationHandler]"));
    assert.ok(validationSource.includes("getRsglResourceKindDescriptor(unit.kind)"));
    assert.ok(parserSource.includes("descriptor?.ast.shape"));
    assert.ok(bodyContextSource.includes("getRsglResourceKindDescriptor(resourceKind)"));
    assert.ok(statementParserSource.includes("context.dialect"));
    assert.strictEqual(statementParserSource.includes("getRsglResourceKindDescriptor"), false);
    for (const keyword of rsglResourceKinds) {
      assert.strictEqual(statementParserSource.includes(`owner === "${keyword}"`), false);
    }
  });
});

function sourceForDescriptor(keyword: string): string {
  if (keyword === "model") {
    return "model block descriptor_contract {}";
  }
  if (keyword === "blockstate") {
    return "blockstate variants minecraft:descriptor_contract {}";
  }
  if (keyword === "pack") {
    return "pack {}";
  }
  if (keyword === "json") {
    return "json \"descriptor-contract.json\" {}";
  }
  if (keyword === "text") {
    return "text \"descriptor-contract.txt\" { content \"descriptor\" }";
  }
  if (keyword === "copy") {
    return "copy \"descriptor-contract-copy.json\" { from \"package.json\" }";
  }
  if (keyword === "mcmeta") {
    return "mcmeta \"assets/minecraft/textures/block/descriptor.png\" { animation { frametime 1 } }";
  }
  return `${keyword} minecraft:descriptor_contract {}`;
}

function readGrammarStorageTypePattern(): RegExp {
  const grammar = JSON.parse(fs.readFileSync(rsglGrammarPath(), "utf8")) as {
    repository?: { keywords?: { patterns?: Array<{ name?: string; match?: string }> } };
  };
  const match = grammar.repository?.keywords?.patterns?.find(pattern => pattern.name === "storage.type.rsgl")?.match;
  assert.ok(match, "Expected TextMate storage.type.rsgl pattern.");
  return new RegExp(match);
}

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}
