import * as assert from "node:assert";
import * as path from "node:path";
import { RsglCompiler } from "../../src/compiler/compiler";
import { compileRsglProgram } from "../../src/compiler";
import {
  compileBlockstateResource,
  type BlockstateCompileOptions
} from "../../src/compiler/blockstateCompiler";
import {
  createTemplateDefinition,
  refreshTemplateDefinitionFingerprint
} from "../../src/compiler/environment";
import type { RsglMapping } from "../../src/compiler/ir";
import type { RsglCompileContext } from "../../src/compiler/templateExpansion";
import {
  parseRsgl,
  type BlockstateResourceDeclNode,
  type TemplateDeclNode
} from "../../src/parser";
import type { RsglTemplateCallerContext } from "../../src/templateOutput";
import {
  generatedResourceUnits,
  unitByPath,
  withUncheckedExterns
} from "./helpers/compile";

describe("RSGL compiler template dispatch guards", () => {
  it("tracks recursion by definition identity rather than repeated import aliases", () => {
    const mainFile = path.resolve("template-dispatch", "main.rsgl");
    const outerFile = path.resolve("template-dispatch", "outer.rsgl");
    const middleFile = path.resolve("template-dispatch", "middle.rsgl");
    const leafFile = path.resolve("template-dispatch", "leaf.rsgl");
    const files = [
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { wrapper } from \"./outer.rsgl\"",
          "model block test { use wrapper() }"
        ].join("\n"))
      },
      {
        fileName: outerFile,
        module: parseRsgl([
          "import { middle as helper } from \"./middle.rsgl\"",
          "export { wrapper }",
          "template wrapper() -> model { use helper() }"
        ].join("\n"))
      },
      {
        fileName: middleFile,
        module: parseRsgl([
          "import { leaf as helper } from \"./leaf.rsgl\"",
          "export { middle }",
          "template middle() -> model { use helper() }"
        ].join("\n"))
      },
      {
        fileName: leafFile,
        module: parseRsgl([
          "export { leaf }",
          "template leaf() -> model {",
          "  element from [0, 0, 0] to [1, 1, 1] {",
          "    all texture minecraft:block/stone",
          "  }",
          "}"
        ].join("\n"))
      }
    ];

    const result = compileRsglProgram(files, withUncheckedExterns({ entryFileName: mainFile }));

    assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.templateRecursion"));
    const content = generatedResourceUnits(result)[0]?.content as { elements?: unknown[] };
    assert.strictEqual(content.elements?.length, 1);
  });

  it("uses caller namespace for explicit typed strings and definition namespace for defaults", () => {
    const mainFile = path.resolve("template-namespace", "main.rsgl");
    const definitionFile = path.resolve("template-namespace", "definitions.rsgl");
    const files = [
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace caller",
          "import { layer } from \"./definitions.rsgl\"",
          "model block explicit { use layer(\"block/caller\") }",
          "model block defaulted { use layer() }"
        ].join("\n"))
      },
      {
        fileName: definitionFile,
        module: parseRsgl([
          "namespace definition",
          "export { layer }",
          "template layer(tex: TextureRef = \"block/default\") -> model { texture all tex }"
        ].join("\n"))
      }
    ];

    const result = compileRsglProgram(files, withUncheckedExterns({ entryFileName: mainFile }));
    const explicit = unitByPath(result, "assets/caller/models/block/explicit.json").content as {
      textures: { all: string };
    };
    const defaulted = unitByPath(result, "assets/caller/models/block/defaulted.json").content as {
      textures: { all: string };
    };

    assert.strictEqual(explicit.textures.all, "caller:block/caller");
    assert.strictEqual(defaulted.textures.all, "definition:block/default");
  });

  it("attributes item_model cardinality to both cross-file call sites and template bodies", () => {
    const mainFile = path.resolve("item-model-cardinality", "main.rsgl");
    const definitionFile = path.resolve("item-model-cardinality", "definitions.rsgl");
    const mainSource = [
      "import { none, many } from \"./definitions.rsgl\"",
      "item zero { use none() }",
      "item multiple { use many() }"
    ].join("\n");
    const definitionSource = [
      "export { none, many }",
      "template none() -> item_model {}",
      "template many() -> item_model {",
      "  model minecraft:item/one",
      "  model minecraft:item/two",
      "}"
    ].join("\n");
    const result = compileRsglProgram([
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: definitionFile, module: parseRsgl(definitionSource) }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    const callDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.itemModelTemplateCardinality"
    );
    const bodyDiagnostics = result.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.itemModelTemplateCardinalityDefinition"
    );
    assert.strictEqual(callDiagnostics.length, 2);
    assert.strictEqual(bodyDiagnostics.length, 2);
    assert.ok(callDiagnostics.every(diagnostic => diagnostic.fileName === mainFile));
    assert.ok(bodyDiagnostics.every(diagnostic => diagnostic.fileName === definitionFile));
    assert.deepStrictEqual(
      callDiagnostics.map(diagnostic => mainSource.slice(diagnostic.range.start, diagnostic.range.end)),
      ["use none()", "use many()"]
    );
    assert.ok(bodyDiagnostics.some(diagnostic =>
      definitionSource.slice(diagnostic.range.start, diagnostic.range.end) === "{}"
    ));
    assert.ok(bodyDiagnostics.some(diagnostic =>
      definitionSource.slice(diagnostic.range.start, diagnostic.range.end).includes("model minecraft:item/two")
    ));
  });

  it("closes blockstate root base capability inside nested control flow", () => {
    const module = parseRsgl([
      "template fragment() -> variants { case { nested: true } => minecraft:block/stone }",
      "blockstate variants test {",
      "  for value in [0] {",
      "    use fragment()",
      "  }",
      "}"
    ].join("\n"));
    const templateNode = module.statements[0] as TemplateDeclNode;
    const resourceNode = module.statements[1] as BlockstateResourceDeclNode;
    const templates = new Map();
    const definition = createTemplateDefinition(
      "fragment",
      templateNode,
      "main.rsgl",
      "minecraft",
      new Map(),
      templates,
      { outputSource: "explicitArrow", outputDialect: "variants" }
    );
    templates.set("fragment", definition);
    const callerContexts: RsglTemplateCallerContext[] = [];
    const context: RsglCompileContext = {
      namespace: "minecraft",
      variables: new Map(),
      templates,
      sourceFile: "main.rsgl",
      expansionStack: []
    };
    const mapping = (generatedPath: string, sourceRange: { start: number; end: number }): RsglMapping => ({
      generatedPath,
      sourceFile: "main.rsgl",
      sourceRange,
      reason: "direct",
      expansionStack: []
    });
    const options: BlockstateCompileOptions = {
      resolveTemplate: () => definition,
      expandUse: (_statement, expansionContext, resolvedDefinition) => ({
        definition: resolvedDefinition,
        context: expansionContext
      }),
      resolveTemplateDispatch: (_definition, callerContext) => {
        callerContexts.push(callerContext);
        return {
          compatible: true,
          selectedDialect: "variants"
        };
      },
      onError: () => { },
      sourceMap: (generatedFile, node, _sourceContext, mappings) => ({
        generatedFile,
        mappings: [mapping("", node.range), ...mappings]
      }),
      sourceMapping: (generatedPath, sourceRange) => mapping(generatedPath, sourceRange)
    };

    compileBlockstateResource(resourceNode, context, options);

    assert.strictEqual(callerContexts.length, 1);
    const caller = callerContexts[0];
    assert.strictEqual(caller.kind, "blockstateRoot");
    if (caller.kind === "blockstateRoot") {
      assert.strictEqual(caller.allowRootMerge, true);
      assert.strictEqual(caller.allowBase, false);
    }
  });

  it("fingerprints the recursive callee closure without caller-side mutation", () => {
    const leafNode = parseRsgl(
      "template leaf() -> model { texture all minecraft:block/stone }"
    ).statements[0] as TemplateDeclNode;
    const middleNode = parseRsgl(
      "template middle() -> model { use leaf() }"
    ).statements[0] as TemplateDeclNode;
    const parentNode = parseRsgl(
      "template parent() -> model { use middle() }"
    ).statements[0] as TemplateDeclNode;
    const leaf = createTemplateDefinition(
      "leaf",
      leafNode,
      "leaf.rsgl",
      "library",
      new Map(),
      new Map(),
      { outputSource: "explicitArrow", outputDialect: "model" },
      "target-a",
      "project-config"
    );
    const middleTemplates = new Map([["leaf", leaf]]);
    const middle = createTemplateDefinition(
      "middle",
      middleNode,
      "middle.rsgl",
      "library",
      new Map(),
      middleTemplates,
      { outputSource: "explicitArrow", outputDialect: "model" },
      "middle-target",
      "project-config"
    );
    const parentTemplates = new Map([["middle", middle]]);
    const parent = createTemplateDefinition(
      "parent",
      parentNode,
      "parent.rsgl",
      "library",
      new Map(),
      parentTemplates,
      { outputSource: "explicitArrow", outputDialect: "model" },
      "parent-target",
      "project-config"
    );
    const beforeTargetChange = refreshTemplateDefinitionFingerprint(parent, "project-config");
    leaf.definitionTargetFingerprint = "target-b";
    const afterTargetChange = refreshTemplateDefinitionFingerprint(parent, "project-config");
    assert.notStrictEqual(afterTargetChange, beforeTargetChange);

    const beforeCallers = parent.definitionFingerprint;
    for (const namespace of ["caller_a", "caller_b"]) {
      new RsglCompiler(parseRsgl(""), {
        fileName: `${namespace}.rsgl`,
        namespace,
        stdlibTemplates: [],
        externalTemplates: [parent]
      }).compile();
    }
    assert.strictEqual(parent.definitionFingerprint, beforeCallers);
  });

  it("dispatches all use contexts before evaluating incompatible arguments or defaults", () => {
    const loaderCalls: string[] = [];
    const compiler = new RsglCompiler(parseRsgl([
      "template modelOnly(value: Json = glob(\"default/*.png\")) -> model { texture all minecraft:block/stone }",
      "use modelOnly(glob(\"top/*.png\"))",
      "json \"assets/minecraft/custom/value.json\" { use modelOnly() }",
      "blockstate variants test {",
      "  use modelOnly(glob(\"blockstate/*.png\"))",
      "}"
    ].join("\n")), {
      fileName: "main.rsgl",
      namespace: "minecraft",
      stdlibTemplates: [],
      globLoader: pattern => {
        loaderCalls.push(pattern);
        return [];
      }
    });

    const result = compiler.compile();

    assert.deepStrictEqual(loaderCalls, []);
    assert.deepStrictEqual(result.dependencies, []);
  });

});
