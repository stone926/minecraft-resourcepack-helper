import * as assert from "node:assert/strict";
import * as path from "node:path";
import { parseRsgl, type MemberExprNode } from "../../src/parser";
import {
  bindRsglProgram,
  moduleNamespaceMembers,
  resolveModuleNamespaceExpressionMember,
  resolveModuleNamespaceMember
} from "../../src/semantic";

describe("RSGL module namespace semantics", () => {
  it("retains value, Function-value, and template member identities", () => {
    const root = path.resolve("module-namespace-basic");
    const mainFile = path.join(root, "main.rsgl");
    const commonFile = path.join(root, "common.rsgl");
    const mainModule = parseRsgl([
      "import * as common from \"./common.rsgl\"",
      "let answer = common.VALUE",
      "let doubled = common.twice(2)",
      "model block result { use common.part() }"
    ].join("\n"));
    const program = bindRsglProgram([
      { fileName: mainFile, module: mainModule },
      { fileName: commonFile, module: parseRsgl([
        "let VALUE: Number = 42",
        "let twice: (Number) -> Number = value => value * 2",
        "template part() -> model { parent minecraft:block/cube_all }",
        "export { VALUE, twice, part }"
      ].join("\n")) }
    ]);

    assert.deepStrictEqual(program.fileDiagnostics, []);
    const main = program.models.find(model => model.fileName === mainFile)!;
    const namespace = main.scope.symbols.get("common")!;
    assert.strictEqual(namespace.kind, "namespace");
    assert.strictEqual(namespace.type.kind, "ModuleNamespace");
    assert.deepStrictEqual(
      moduleNamespaceMembers(namespace.type).map(member => [member.name, member.category]),
      [["VALUE", "value"], ["twice", "value"], ["part", "template"]]
    );
    assert.strictEqual(resolveModuleNamespaceMember(namespace.type, "twice")?.symbol.signature?.valueFunction, true);
    assert.strictEqual(resolveModuleNamespaceMember(namespace.type, "part")?.symbol.signature?.templateOutput?.outputSource, "explicitArrow");

    const answerMember = findMember(mainModule, "VALUE");
    const resolved = resolveModuleNamespaceExpressionMember(main, answerMember);
    assert.strictEqual(resolved?.member.symbol.type.kind, "Number");
    assert.strictEqual(resolved?.member.sourceFile, commonFile);
    assert.strictEqual(main.scope.symbols.get("answer")?.type.kind, "Number");
    assert.strictEqual(main.scope.symbols.get("doubled")?.type.kind, "Number");
  });

  it("checks missing members, member category, and namespace serialization", () => {
    const root = path.resolve("module-namespace-errors");
    const mainFile = path.join(root, "main.rsgl");
    const commonFile = path.join(root, "common.rsgl");
    const source = [
      "import * as common from \"./common.rsgl\"",
      "let missing = common.absent",
      "let badTemplateCall = common.part()",
      "model block result { use common.fn(1) }",
      "let serialized: Json = common",
      "let nestedObject: Json = { namespace: common }",
      "let nestedList: Json = [common]"
    ].join("\n");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl(source) },
      { fileName: commonFile, module: parseRsgl([
        "let fn: (Number) -> Number = value => value",
        "template part() -> model { parent minecraft:block/cube_all }",
        "export { fn, part }"
      ].join("\n")) }
    ]);
    const codes = program.fileDiagnostics
      .filter(item => item.fileName === mainFile)
      .map(item => item.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.missingImportedMember").length, 1);
    assert.strictEqual(codes.filter(code => code === "rsgl.invalidImportedMemberKind").length, 2);
    assert.strictEqual(codes.filter(code => code === "rsgl.moduleNamespaceValueNotSerializable").length, 3);
    assert.strictEqual(codes.includes("rsgl.templateRequiresUse"), false);
    assert.strictEqual(codes.includes("rsgl.functionValueCannotUse"), false);
  });

  it("prelinks derived member types through re-exports without leaving Any", () => {
    const root = path.resolve("module-namespace-fixed-point");
    const leafFile = path.join(root, "leaf.rsgl");
    const middleFile = path.join(root, "middle.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl([
        "import * as middle from \"./middle.rsgl\"",
        "let finalValue = middle.COPIED",
        "model block result { use middle.part() }"
      ].join("\n")) },
      { fileName: middleFile, module: parseRsgl([
        "import * as leaf from \"./leaf.rsgl\"",
        "let COPIED = leaf.VALUE",
        "export { COPIED }",
        "export { part } from \"./leaf.rsgl\""
      ].join("\n")) },
      { fileName: leafFile, module: parseRsgl([
        "let VALUE: Number = 7",
        "template part() -> model { parent minecraft:block/cube_all }",
        "export { VALUE, part }"
      ].join("\n")) }
    ]);

    assert.deepStrictEqual(program.fileDiagnostics, []);
    const middle = program.models.find(model => model.fileName === middleFile)!;
    const main = program.models.find(model => model.fileName === mainFile)!;
    assert.strictEqual(middle.scope.symbols.get("COPIED")?.type.kind, "Number");
    assert.strictEqual(main.scope.symbols.get("finalValue")?.type.kind, "Number");
    const namespace = main.scope.symbols.get("middle")!.type;
    assert.strictEqual(resolveModuleNamespaceMember(namespace, "part")?.category, "template");
  });

  it("reaches a stable derived-type state across namespace import cycles", () => {
    const root = path.resolve("module-namespace-cycle");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const program = bindRsglProgram([
      { fileName: aFile, module: parseRsgl([
        "import * as b from \"./b.rsgl\"",
        "let ROOT: Number = 1",
        "let FROM_B = b.FROM_A",
        "export { ROOT, FROM_B }"
      ].join("\n")) },
      { fileName: bFile, module: parseRsgl([
        "import * as a from \"./a.rsgl\"",
        "let FROM_A = a.ROOT",
        "export { FROM_A }"
      ].join("\n")) }
    ]);

    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.importCycle"), true);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.missingImportedMember"), false);
    assert.strictEqual(program.models.find(model => model.fileName === aFile)?.scope.symbols.get("FROM_B")?.type.kind, "Number");
    assert.strictEqual(program.models.find(model => model.fileName === bFile)?.scope.symbols.get("FROM_A")?.type.kind, "Number");
  });

  it("does not classify late acyclic value convergence as recursive namespace inference", () => {
    const root = path.resolve("module-namespace-late-acyclic-value");
    const chainFile = (index: number) => path.join(root, `value-${index}.rsgl`);
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const valueChain = [
      {
        fileName: chainFile(0),
        module: parseRsgl("let VALUE_0: Number = 1\nexport { VALUE_0 }")
      },
      ...Array.from({ length: 10 }, (_, offset) => {
        const index = offset + 1;
        return {
          fileName: chainFile(index),
          module: parseRsgl([
            `import { VALUE_${index - 1} } from "./value-${index - 1}.rsgl"`,
            `let VALUE_${index} = VALUE_${index - 1}`,
            `export { VALUE_${index} }`
          ].join("\n"))
        };
      })
    ];
    const program = bindRsglProgram([
      ...valueChain,
      {
        fileName: aFile,
        module: parseRsgl([
          "import * as b from \"./b.rsgl\"",
          "import { VALUE_10 } from \"./value-10.rsgl\"",
          "let A_VALUE = VALUE_10",
          "let FROM_B = b.B_VALUE",
          "export { A_VALUE, FROM_B }"
        ].join("\n"))
      },
      {
        fileName: bFile,
        module: parseRsgl([
          "import * as a from \"./a.rsgl\"",
          "let B_VALUE: Number = 2",
          "let FROM_A = a.A_VALUE",
          "export { B_VALUE, FROM_A }"
        ].join("\n"))
      }
    ]);

    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.importCycle"), true);
    assert.strictEqual(
      program.fileDiagnostics.some(item => item.code === "rsgl.cyclicNamespaceTypeInference"),
      false
    );
    const a = program.models.find(model => model.fileName === aFile)!;
    const b = program.models.find(model => model.fileName === bFile)!;
    assert.strictEqual(a.scope.symbols.get("A_VALUE")?.type.kind, "Number");
    assert.strictEqual(b.scope.symbols.get("FROM_A")?.type.kind, "Number");
    assert.strictEqual(
      resolveModuleNamespaceMember(b.scope.symbols.get("a")!.type, "A_VALUE")?.symbol.type.kind,
      "Number"
    );
  });

  it("accounts for finite downstream namespace SCC latency before widening an upstream SCC", () => {
    const root = path.resolve("module-namespace-dependent-scc-latency");
    const ringSize = 12;
    const ringFile = (index: number) => path.join(root, `ring-${index}.rsgl`);
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const finiteRing = Array.from({ length: ringSize }, (_, index) => {
      const next = (index + 1) % ringSize;
      return {
        fileName: ringFile(index),
        module: parseRsgl([
          `import * as next from "./ring-${next}.rsgl"`,
          index === ringSize - 1
            ? `let VALUE_${index}: Number = 1`
            : `let VALUE_${index} = next.VALUE_${next}`,
          `export { VALUE_${index} }`
        ].join("\n"))
      };
    });
    const program = bindRsglProgram([
      ...finiteRing,
      {
        fileName: aFile,
        module: parseRsgl([
          "import * as b from \"./b.rsgl\"",
          "import { VALUE_0 } from \"./ring-0.rsgl\"",
          "let A_VALUE = VALUE_0",
          "let FROM_B = b.B_VALUE",
          "export { A_VALUE, FROM_B }"
        ].join("\n"))
      },
      {
        fileName: bFile,
        module: parseRsgl([
          "import * as a from \"./a.rsgl\"",
          "let B_VALUE: Number = 2",
          "let FROM_A = a.A_VALUE",
          "export { B_VALUE, FROM_A }"
        ].join("\n"))
      }
    ]);

    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.importCycle"), true);
    assert.strictEqual(
      program.fileDiagnostics.some(item => item.code === "rsgl.cyclicNamespaceTypeInference"),
      false
    );
    const ringEntry = program.models.find(model => model.fileName === ringFile(0))!;
    const a = program.models.find(model => model.fileName === aFile)!;
    const b = program.models.find(model => model.fileName === bFile)!;
    assert.strictEqual(ringEntry.scope.symbols.get("VALUE_0")?.type.kind, "Number");
    assert.strictEqual(a.scope.symbols.get("A_VALUE")?.type.kind, "Number");
    assert.strictEqual(b.scope.symbols.get("FROM_A")?.type.kind, "Number");
    assert.strictEqual(
      resolveModuleNamespaceMember(b.scope.symbols.get("a")!.type, "A_VALUE")?.symbol.type.kind,
      "Number"
    );
  });

  it("widens recursive namespace self imports within the global pass budget", () => {
    const root = path.resolve("module-namespace-self-cycle");
    const selfFile = path.join(root, "self.rsgl");
    const program = bindRsglProgram([{
      fileName: selfFile,
      module: parseRsgl([
        "import * as self from \"./self.rsgl\"",
        "let A = [self.A]",
        "export { A }"
      ].join("\n"))
    }]);

    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.importCycle"), true);
    assert.strictEqual(program.fileDiagnostics.filter(item =>
      item.code === "rsgl.cyclicNamespaceTypeInference"
    ).length, 1);
    assert.strictEqual(listDepth(program.models[0].scope.symbols.get("A")!.type), 1);
  });

  it("budgets widening across a dependency chain of namespace self-cycle SCCs", () => {
    const root = path.resolve("module-namespace-self-cycle-chain");
    const file = (index: number) => path.join(root, `cycle-${index}.rsgl`);
    const cycleCount = 3;
    const program = bindRsglProgram(Array.from({ length: cycleCount }, (_, index) => ({
      fileName: file(index),
      module: parseRsgl([
        `import * as self from "./cycle-${index}.rsgl"`,
        ...(index + 1 < cycleCount
          ? [`import * as downstream from "./cycle-${index + 1}.rsgl"`]
          : []),
        "let A = [self.A]",
        "export { A }"
      ].join("\n"))
    })));

    const inferenceDiagnostics = program.fileDiagnostics.filter(item =>
      item.code === "rsgl.cyclicNamespaceTypeInference"
    );
    assert.deepStrictEqual(
      new Set(inferenceDiagnostics.map(item => item.fileName)),
      new Set(Array.from({ length: cycleCount }, (_, index) => file(index)))
    );
    assert.strictEqual(inferenceDiagnostics.length, cycleCount);
    for (const model of program.models) {
      assert.strictEqual(listDepth(model.scope.symbols.get("A")!.type), 1, model.fileName);
    }
  });

  it("does not count duplicate namespace aliases as repeated non-convergence passes", () => {
    const root = path.resolve("module-namespace-duplicate-self-alias");
    const selfFile = path.join(root, "self.rsgl");
    const program = bindRsglProgram([{
      fileName: selfFile,
      module: parseRsgl([
        ...Array.from({ length: 8 }, () => "import * as self from \"./self.rsgl\""),
        "let A = [self.B]",
        "let B: Number = 1",
        "export { A, B }"
      ].join("\n"))
    }]);

    assert.strictEqual(
      program.fileDiagnostics.some(item => item.code === "rsgl.cyclicNamespaceTypeInference"),
      false
    );
    const type = program.models[0].scope.symbols.get("A")!.type;
    assert.strictEqual(type.kind, "List");
    assert.strictEqual(type.elementType?.kind, "Number");
  });

  it("keeps an unresolved first namespace binding ahead of a duplicate self import", () => {
    const root = path.resolve("module-namespace-unresolved-first-alias");
    const selfFile = path.join(root, "self.rsgl");
    const program = bindRsglProgram([{
      fileName: selfFile,
      module: parseRsgl([
        "import * as duplicate from \"./missing.rsgl\"",
        "import * as duplicate from \"./self.rsgl\"",
        "let A = [duplicate.A]",
        "export { A }"
      ].join("\n"))
    }]);

    const model = program.models[0];
    const namespaceType = model.scope.symbols.get("duplicate")!.type;
    assert.strictEqual(namespaceType.kind, "ModuleNamespace");
    assert.strictEqual(namespaceType.moduleNamespaceId, "./missing.rsgl");
    assert.notStrictEqual(namespaceType.moduleNamespaceId, selfFile);
    assert.strictEqual(listDepth(model.scope.symbols.get("A")!.type), 1);
    assert.strictEqual(
      program.fileDiagnostics.some(item => item.code === "rsgl.cyclicNamespaceTypeInference"),
      false
    );
  });

  it("widens non-converging recursive namespace types independently of unrelated files", () => {
    const root = path.resolve("module-namespace-recursive-type-cycle");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const bindWithUnrelatedFiles = (count: number) => bindRsglProgram([
      {
        fileName: aFile,
        module: parseRsgl([
          "import * as b from \"./b.rsgl\"",
          "let A = [b.B]",
          "export { A }"
        ].join("\n"))
      },
      {
        fileName: bFile,
        module: parseRsgl([
          "import * as a from \"./a.rsgl\"",
          "let B = [a.A]",
          "export { B }"
        ].join("\n"))
      },
      ...Array.from({ length: count }, (_, index) => ({
        fileName: path.join(root, `unrelated-${index}.rsgl`),
        module: parseRsgl(`let VALUE_${index} = ${index}`)
      }))
    ]);

    const small = bindWithUnrelatedFiles(0);
    const large = bindWithUnrelatedFiles(50);
    for (const program of [small, large]) {
      assert.strictEqual(program.fileDiagnostics.filter(item =>
        item.code === "rsgl.cyclicNamespaceTypeInference"
      ).length, 2);
      assert.strictEqual(listDepth(
        program.models.find(model => model.fileName === aFile)!.scope.symbols.get("A")!.type
      ), 1);
      assert.strictEqual(listDepth(
        program.models.find(model => model.fileName === bFile)!.scope.symbols.get("B")!.type
      ), 1);
    }
  });

  it("diagnoses one export name shared by a value and template", () => {
    const root = path.resolve("module-namespace-duplicate-export");
    const sourceFile = path.join(root, "source.rsgl");
    const program = bindRsglProgram([{
      fileName: sourceFile,
      module: parseRsgl([
        "let value = 1",
        "template body() -> model { parent minecraft:block/cube_all }",
        "export { value as same, body as same }"
      ].join("\n"))
    }]);

    const duplicates = program.fileDiagnostics.filter(item => item.code === "rsgl.duplicateExportName");
    assert.strictEqual(duplicates.length, 2);
    assert.notDeepStrictEqual(duplicates[0].range, duplicates[1].range);
  });

  it("diagnoses repeated local export names even when they retain the same symbol", () => {
    const root = path.resolve("module-namespace-repeated-local-export");
    for (const [fileName, exportSource] of [
      ["separate.rsgl", "export { value }\nexport { value }"],
      ["same-record.rsgl", "export { value as shared, value as shared }"]
    ] as const) {
      const fullPath = path.join(root, fileName);
      const program = bindRsglProgram([{
        fileName: fullPath,
        module: parseRsgl(`let value = 1\n${exportSource}`)
      }]);
      const duplicates = program.fileDiagnostics.filter(item =>
        item.fileName === fullPath && item.code === "rsgl.duplicateExportName"
      );

      assert.strictEqual(duplicates.length, 2, fileName);
      assert.notDeepStrictEqual(duplicates[0].range, duplicates[1].range, fileName);
    }
  });

  it("diagnoses diamond export-star paths while preserving the first export", () => {
    const root = path.resolve("module-namespace-diamond-export");
    const baseFile = path.join(root, "base.rsgl");
    const leftFile = path.join(root, "left.rsgl");
    const rightFile = path.join(root, "right.rsgl");
    const barrelFile = path.join(root, "barrel.rsgl");
    const program = bindRsglProgram([
      {
        fileName: baseFile,
        module: parseRsgl("let VALUE = 1\nexport { VALUE }")
      },
      { fileName: leftFile, module: parseRsgl("export * from \"./base.rsgl\"") },
      { fileName: rightFile, module: parseRsgl("export * from \"./base.rsgl\"") },
      {
        fileName: barrelFile,
        module: parseRsgl([
          "export * from \"./left.rsgl\"",
          "export * from \"./right.rsgl\""
        ].join("\n"))
      }
    ]);
    const duplicates = program.fileDiagnostics.filter(item =>
      item.fileName === barrelFile && item.code === "rsgl.duplicateExportName"
    );

    assert.strictEqual(duplicates.length, 2);
    assert.notDeepStrictEqual(duplicates[0].range, duplicates[1].range);
  });

  it("propagates qualified template output metadata and validates signatures", () => {
    const root = path.resolve("module-namespace-template-output");
    const leafFile = path.join(root, "leaf.rsgl");
    const adapterFile = path.join(root, "adapter.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl([
        "import * as adapter from \"./adapter.rsgl\"",
        "let invalid = adapter.scale(\"two\")",
        "model block result { use adapter.wrapper() }"
      ].join("\n")) },
      { fileName: adapterFile, module: parseRsgl([
        "import * as leaf from \"./leaf.rsgl\"",
        "let scale: (Number) -> Number = value => value * 2",
        "template wrapper() -> model { use leaf.part() }",
        "export { scale, wrapper }"
      ].join("\n")) },
      { fileName: leafFile, module: parseRsgl([
        "template part() -> model { parent minecraft:block/cube_all }",
        "export { part }"
      ].join("\n")) }
    ]);

    const adapter = program.models.find(model => model.fileName === adapterFile)!;
    const wrapper = adapter.scope.symbols.get("wrapper")!;
    assert.strictEqual(wrapper.signature?.templateOutput?.outputSource, "explicitArrow");
    assert.strictEqual(program.fileDiagnostics.filter(item =>
      item.fileName === mainFile && item.code === "rsgl.lambdaArgumentTypeMismatch"
    ).length, 1);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"), false);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.templateOutputDialectMismatch"), false);
  });

  it("finds recursive template edges through qualified namespace calls", () => {
    const root = path.resolve("module-namespace-template-recursion");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const program = bindRsglProgram([
      { fileName: aFile, module: parseRsgl([
        "import * as b from \"./b.rsgl\"",
        "template a() -> model { use b.b() }",
        "export { a }"
      ].join("\n")) },
      { fileName: bFile, module: parseRsgl([
        "import * as a from \"./a.rsgl\"",
        "template b() -> model { use a.a() }",
        "export { b }"
      ].join("\n")) }
    ]);

    assert.strictEqual(program.fileDiagnostics.filter(item => item.code === "rsgl.templateRecursion").length, 2);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.missingImportedMember"), false);
  });

  it("keeps namespace aliases in the ordinary single-name conflict domain", () => {
    const root = path.resolve("module-namespace-local-conflict");
    const mainFile = path.join(root, "main.rsgl");
    const commonFile = path.join(root, "common.rsgl");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl([
        "import * as common from \"./common.rsgl\"",
        "let common = 1"
      ].join("\n")) },
      { fileName: commonFile, module: parseRsgl("let VALUE = 1\nexport { VALUE }") }
    ]);

    assert.strictEqual(program.fileDiagnostics.filter(item =>
      item.fileName === mainFile && item.code === "rsgl.duplicateSymbol"
    ).length, 1);
    assert.strictEqual(program.models.find(model => model.fileName === mainFile)?.scope.symbols.get("common")?.kind, "namespace");
  });

  it("resolves export-star cycles independently of source-file order", () => {
    const root = path.resolve("module-namespace-reexport-cycle");
    const mainFile = path.join(root, "main.rsgl");
    const aFile = path.join(root, "a.rsgl");
    const bFile = path.join(root, "b.rsgl");
    const program = bindRsglProgram([
      { fileName: mainFile, module: parseRsgl([
        "import * as barrel from \"./b.rsgl\"",
        "let imported = barrel.ROOT"
      ].join("\n")) },
      { fileName: bFile, module: parseRsgl("export * from \"./a.rsgl\"") },
      { fileName: aFile, module: parseRsgl([
        "let ROOT: Number = 1",
        "export { ROOT }",
        "export * from \"./b.rsgl\""
      ].join("\n")) }
    ]);

    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.importCycle"), true);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.missingImportedMember"), false);
    assert.strictEqual(program.fileDiagnostics.some(item => item.code === "rsgl.duplicateExportName"), false);
    assert.strictEqual(program.models.find(model => model.fileName === mainFile)?.scope.symbols.get("imported")?.type.kind, "Number");
  });
});

function findMember(module: ReturnType<typeof parseRsgl>, property: string): MemberExprNode {
  for (const statement of module.statements) {
    if (
      statement.kind === "LetDecl"
      && statement.value.kind === "MemberExpr"
      && statement.value.property.text === property
    ) {
      return statement.value;
    }
  }
  throw new Error(`Member '${property}' not found.`);
}

function listDepth(type: { kind: string; elementType?: unknown }): number {
  let depth = 0;
  let current: { kind: string; elementType?: unknown } | undefined = type;
  while (current?.kind === "List") {
    depth++;
    current = current.elementType as { kind: string; elementType?: unknown } | undefined;
  }
  return depth;
}
