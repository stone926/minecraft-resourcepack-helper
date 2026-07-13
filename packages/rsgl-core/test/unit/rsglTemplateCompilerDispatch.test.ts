import * as assert from "node:assert";
import * as path from "node:path";
import {
  compileRsglProgram,
  RsglCompiler
} from "../../src/compiler/compiler";
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
  type ResourceDeclNode,
  type TemplateDeclNode
} from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
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

  it("closes blockstate root base capability inside nested control flow", () => {
    const module = parseRsgl([
      "template fragment() { custom true }",
      "blockstate test {",
      "  for value in [0] {",
      "    use fragment()",
      "  }",
      "}"
    ].join("\n"));
    const templateNode = module.statements[0] as TemplateDeclNode;
    const resourceNode = module.statements[1] as ResourceDeclNode;
    const templates = new Map();
    const definition = createTemplateDefinition(
      "fragment",
      templateNode,
      "main.rsgl",
      "minecraft",
      new Map(),
      templates,
      { outputSource: "legacyContextualAdapter", bodyNodeKind: "ResourceBody" }
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
          selectedDialect: callerContext.kind === "resources" ? undefined : callerContext,
          compatibilityWarning: true
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

    const beforeConflict = parent.definitionFingerprint;
    leaf.outputConflict = { evidence: ["resourceBody:model", "blockstateEntries:variants"] };
    const afterConflict = refreshTemplateDefinitionFingerprint(parent, "project-config");
    assert.notStrictEqual(afterConflict, beforeConflict);

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
      "blockstate test {",
      "  variants { use modelOnly(glob(\"blockstate/*.png\")) }",
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

  it("rejects conflicting template definitions before evaluating any use context", () => {
    const loaderCalls: string[] = [];
    const compiler = new RsglCompiler(parseRsgl([
      "template modelPart() -> model { leaked true }",
      "template states() -> variants { [other=true] -> { model: minecraft:block/stone } }",
      "template mixed(value: Json = glob(\"default/*.png\")) {",
      "  use modelPart()",
      "  use states()",
      "}",
      "use mixed(glob(\"top/*.png\"))",
      "model block retained {",
      "  marker true",
      "  use mixed()",
      "}",
      "blockstate retained {",
      "  variants { [base=true] -> { model: minecraft:block/stone } }",
      "  use mixed(glob(\"blockstate/*.png\"))",
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
    assert.deepStrictEqual(result.units.map(unit => unit.content), [
      { marker: true },
      {
        variants: {
          "base=true": { model: "minecraft:block/stone" }
        }
      }
    ]);
  });

  it("does not classify, validate, or compile shadowed resource-body helpers as builtins", () => {
    const cases = [
      {
        source: [
          "template wrapper(atlasDirectory: Function) { use atlasDirectory(\"block\") }",
          "atlas test { use wrapper(value => value) }"
        ].join("\n"),
        templateName: "wrapper"
      },
      {
        source: [
          "atlas test {",
          "  let atlasDirectory = value => value",
          "  use atlasDirectory(\"block\")",
          "}"
        ].join("\n")
      },
      {
        source: [
          "template wrapper() {",
          "  use atlasDirectory(\"block\")",
          "  let atlasDirectory = value => value",
          "}",
          "atlas test { use wrapper() }"
        ].join("\n"),
        templateName: "wrapper"
      }
    ];

    for (const testCase of cases) {
      const module = parseRsgl(testCase.source);
      const model = bindRsglModule(module);
      assert.ok(model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.functionValueCannotUse"));
      if (testCase.templateName) {
        assert.strictEqual(
          model.scope.symbols.get(testCase.templateName)?.signature?.templateOutput?.outputSource,
          "legacyContextualAdapter"
        );
      }

      const result = new RsglCompiler(module, {
        fileName: "main.rsgl",
        namespace: "minecraft",
        stdlibTemplates: []
      }).compile();
      assert.deepStrictEqual(result.units.map(unit => unit.content), [{}]);
    }
  });

  it("preserves linked conflict carriers through re-exports without evaluating defaults", () => {
    const mainFile = path.resolve("template-conflict", "main.rsgl");
    const barrelFile = path.resolve("template-conflict", "barrel.rsgl");
    const definitionsFile = path.resolve("template-conflict", "definitions.rsgl");
    const result = compileRsglProgram([
      {
        fileName: mainFile,
        module: parseRsgl([
          "namespace caller",
          "import { mixed as linked } from \"./barrel.rsgl\"",
          "model block retained {",
          "  marker true",
          "  use linked()",
          "}"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { mixed } from \"./definitions.rsgl\"")
      },
      {
        fileName: definitionsFile,
        module: parseRsgl([
          "export { mixed }",
          "template modelPart() -> model { leaked true }",
          "template states() -> variants { [other=true] -> { model: minecraft:block/stone } }",
          "template mixed(value: Json = glob(\"\")) {",
          "  use modelPart()",
          "  use states()",
          "}"
        ].join("\n"))
      }
    ], withUncheckedExterns({ entryFileName: mainFile }));

    assert.ok(result.diagnostics.some(diagnostic =>
      diagnostic.code === "rsgl.conflictingResolvedTemplateOutputDialects"
      && diagnostic.fileName === definitionsFile
    ));
    assert.ok(!result.diagnostics.some(diagnostic => diagnostic.code === "rsgl.globInvalidPattern"));
    assert.deepStrictEqual(
      unitByPath(result, "assets/caller/models/block/retained.json").content,
      { marker: true }
    );
  });
});
