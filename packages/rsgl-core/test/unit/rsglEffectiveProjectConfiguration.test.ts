import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglDirectory,
  compileRsglFile,
  compileRsglModule,
  compileRsglProgram,
  loadRsglSourceFilesFromFile,
  normalizeRsglProjectTarget,
  type RsglCompileResult,
  type RsglNormalizedProjectTarget,
  type RsglProgramCompileOptions
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";
import {
  generatedResourceUnits,
  withUncheckedExterns
} from "./helpers/compile";
import { withTempDir } from "./helpers/fs";

const target74 = normalizeRsglProjectTarget({
  edition: "java",
  format: [74, 0]
});
const target75 = normalizeRsglProjectTarget({
  edition: "java",
  format: [75, 0]
});

describe("RSGL effective project compile configuration", () => {
  it("applies hard override, file declaration, project default, and minecraft in priority order", () => {
    assert.strictEqual(singleModelNamespace("model block priority {}"), "minecraft");
    assert.strictEqual(singleModelNamespace("model block priority {}", {
      defaultNamespace: "project_default"
    }), "project_default");
    assert.strictEqual(singleModelNamespace([
      "namespace file_declared",
      "model block priority {}"
    ].join("\n"), {
      defaultNamespace: "project_default"
    }), "file_declared");
    assert.strictEqual(singleModelNamespace([
      "namespace file_declared",
      "model block priority {}"
    ].join("\n"), {
      namespace: "hard_override",
      defaultNamespace: "project_default"
    }), "hard_override");
  });

  it("resolves imported template namespaces at the definition module", () => {
    assert.deepStrictEqual(importedTemplateResourceIds(undefined, {
      defaultNamespace: "project_default"
    }), [
      "caller:block/local",
      "project_default:block/imported"
    ]);

    assert.deepStrictEqual(importedTemplateResourceIds("library", {
      defaultNamespace: "project_default"
    }), [
      "caller:block/local",
      "library:block/imported"
    ]);

    assert.deepStrictEqual(importedTemplateResourceIds("library", {
      namespace: "hard_override",
      defaultNamespace: "project_default"
    }), [
      "hard_override:block/imported",
      "hard_override:block/local"
    ]);
  });

  it("uses the project target as the default and immutable project constraint", () => {
    const noSourceModern = compileTargetSensitiveModule(undefined, target75);
    assert.deepStrictEqual(diagnosticCodes(noSourceModern), []);

    const noSourceOlder = compileTargetSensitiveModule(undefined, target74);
    assert.deepStrictEqual(diagnosticCodes(noSourceOlder), [
      "rsgl.unsupportedBlockstateZRotation"
    ]);

    const matchingFormat = compileTargetSensitiveModule(
      "target java format [75, 0]",
      target75
    );
    assert.deepStrictEqual(diagnosticCodes(matchingFormat), []);

    const minecraftEquivalent = normalizeRsglProjectTarget({
      edition: "java",
      mc: "1.21.11"
    });
    const matchingMinecraftVersion = compileTargetSensitiveModule(
      "target java format [75, 0]",
      minecraftEquivalent
    );
    assert.deepStrictEqual(diagnosticCodes(matchingMinecraftVersion), []);

    const conflicting = compileTargetSensitiveModule(
      "target java format [74, 0]",
      target75
    );
    assert.deepStrictEqual(diagnosticCodes(conflicting), [
      "rsgl.conflictingTargetFormat"
    ]);
    assert.strictEqual(
      conflicting.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"),
      false,
      "a conflicting file target must not replace the project target used by version gates"
    );
  });

  it("includes imported target declarations in the entry closure and attributes conflicts to their file", () => {
    const mainFile = path.resolve("virtual project", "main.rsgl");
    const helperFile = path.resolve("virtual project", "helper.rsgl");
    const unrelatedFile = path.resolve("virtual project", "unrelated.rsgl");
    const mainSource = [
      "import { marker } from \"./helper.rsgl\"",
      ...targetSensitiveStatements()
    ].join("\n");
    const helperSource = [
      "target java format [74, 0]",
      "let marker = 1",
      "export { marker }"
    ].join("\n");
    const files = [
      { fileName: mainFile, module: parseRsgl(mainSource) },
      { fileName: helperFile, module: parseRsgl(helperSource) },
      {
        fileName: unrelatedFile,
        module: parseRsgl("target java format [73, 0]\nlet unrelated = 1")
      }
    ];

    const sourceTargetResult = compileRsglProgram(files, withUncheckedExterns({
      entryFileName: mainFile
    }));
    assert.deepStrictEqual(diagnosticCodes(sourceTargetResult), [
      "rsgl.unsupportedBlockstateZRotation"
    ]);

    const constrainedResult = compileRsglProgram(files, withUncheckedExterns({
      entryFileName: mainFile,
      projectTarget: target75
    }));
    assert.deepStrictEqual(diagnosticCodes(constrainedResult), [
      "rsgl.conflictingTargetFormat"
    ]);
    const conflict = constrainedResult.diagnostics.find(
      diagnostic => diagnostic.code === "rsgl.conflictingTargetFormat"
    );
    assert.ok(conflict);
    assert.strictEqual(path.normalize(conflict.fileName ?? ""), path.normalize(helperFile));
    assert.strictEqual(conflict.range.start, 0);
    assert.ok(conflict.range.end > conflict.range.start);
  });

  it("keeps entry and import-closure behavior aligned across file, program, and directory compilation", () => {
    withTempDir(root => {
      const projectRoot = path.join(root, "项目 空格");
      const sourceRoot = path.join(projectRoot, "源 文件");
      const mainFile = path.join(sourceRoot, "main 入口.rsgl");
      const helperFile = path.join(sourceRoot, "库 helper.rsgl");
      const unrelatedFile = path.join(sourceRoot, "无关.rsgl");
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(mainFile, [
        "namespace caller",
        "import { emitImported } from \"./库 helper.rsgl\"",
        "model block rotated {}",
        "use emitImported()",
        "blockstate variants rotated {",
        "  case * => block/rotated with { z: 90 }",
        "}"
      ].join("\n"));
      fs.writeFileSync(helperFile, [
        "target java format [74, 0]",
        "template emitImported() {",
        "  model block imported {}",
        "}",
        "export { emitImported }"
      ].join("\n"));
      fs.writeFileSync(unrelatedFile, [
        "namespace unrelated",
        "target java format [73, 0]",
        "model block extra {}"
      ].join("\n"));

      const options = withUncheckedExterns({
        defaultNamespace: "project_default",
        projectTarget: target75
      });
      const fileResult = compileRsglFile(mainFile, options);
      const programFiles = loadRsglSourceFilesFromFile(mainFile);
      const programResult = compileRsglProgram(programFiles, {
        ...options,
        entryFileName: mainFile
      });
      const directoryResult = compileRsglDirectory(sourceRoot, options);
      const closureFiles = new Set([mainFile, helperFile].map(normalizedPath));

      const expected = entryClosureProjection(fileResult, closureFiles, projectRoot);
      assert.deepStrictEqual(
        entryClosureProjection(programResult, closureFiles, projectRoot),
        expected
      );
      assert.deepStrictEqual(
        entryClosureProjection(directoryResult, closureFiles, projectRoot),
        expected
      );
      assert.deepStrictEqual(expected.resources.map(resource => `${resource.kind}:${resource.id}`), [
        "blockstate:caller:rotated",
        "model:caller:block/rotated",
        "model:project_default:block/imported"
      ]);
      assert.deepStrictEqual(expected.diagnostics, [{
        code: "rsgl.conflictingTargetFormat",
        fileName: "源 文件/库 helper.rsgl",
        severity: "error"
      }]);
      assert.strictEqual(
        expected.diagnostics.some(diagnostic => diagnostic.code === "rsgl.unsupportedBlockstateZRotation"),
        false
      );

      assert.ok(generatedResourceUnits(directoryResult).some(unit =>
        unit.kind === "model"
        && unit.id?.namespace === "unrelated"
        && unit.id.path === "block/extra"
      ));
      assert.ok(directoryResult.diagnostics.some(diagnostic =>
        diagnostic.code === "rsgl.conflictingTargetFormat"
        && normalizedPath(diagnostic.fileName ?? "") === normalizedPath(unrelatedFile)
      ));
    }, "mc-resourcepack-helper-rsgl-effective-config-");
  });
});

function singleModelNamespace(
  source: string,
  options: RsglProgramCompileOptions = {}
): string | undefined {
  const result = compileRsglModule(parseRsgl(source), options);
  assert.deepStrictEqual(diagnosticCodes(result), []);
  return generatedResourceUnits(result).find(unit => unit.kind === "model")?.id?.namespace;
}

function importedTemplateResourceIds(
  helperNamespace: string | undefined,
  options: RsglProgramCompileOptions
): string[] {
  const mainFile = path.resolve("virtual imported namespace", "main.rsgl");
  const helperFile = path.resolve("virtual imported namespace", "helper.rsgl");
  const helperSource = [
    ...(helperNamespace ? [`namespace ${helperNamespace}`] : []),
    "template emitImported() {",
    "  model block imported {}",
    "}",
    "export { emitImported }"
  ].join("\n");
  const result = compileRsglProgram([
    {
      fileName: mainFile,
      module: parseRsgl([
        "namespace caller",
        "import { emitImported } from \"./helper.rsgl\"",
        "model block local {}",
        "use emitImported()"
      ].join("\n"))
    },
    { fileName: helperFile, module: parseRsgl(helperSource) }
  ], {
    ...options,
    entryFileName: mainFile
  });

  assert.deepStrictEqual(diagnosticCodes(result), []);
  return generatedResourceUnits(result)
    .filter(unit => unit.id)
    .map(unit => `${unit.id!.namespace}:${unit.id!.path}`)
    .sort();
}

function compileTargetSensitiveModule(
  targetDeclaration: string | undefined,
  projectTarget: RsglNormalizedProjectTarget
): RsglCompileResult {
  return compileRsglModule(parseRsgl([
    ...(targetDeclaration ? [targetDeclaration] : []),
    ...targetSensitiveStatements()
  ].join("\n")), withUncheckedExterns({ projectTarget }));
}

function targetSensitiveStatements(): string[] {
  return [
    "blockstate variants rotated {",
    "  case * => minecraft:block/rotated with { z: 90 }",
    "}"
  ];
}

function diagnosticCodes(result: RsglCompileResult): string[] {
  return result.diagnostics.map(diagnostic => diagnostic.code);
}

interface EntryClosureProjection {
  resources: Array<{
    kind: string;
    id: string;
    outputPath: string;
    content: unknown;
  }>;
  diagnostics: Array<{
    code: string;
    severity: string;
    fileName?: string;
  }>;
}

function entryClosureProjection(
  result: RsglCompileResult,
  closureFiles: ReadonlySet<string>,
  projectRoot: string
): EntryClosureProjection {
  const resources = generatedResourceUnits(result)
    .filter(unit => unit.sourceMap.mappings.some(mapping =>
      closureFiles.has(normalizedPath(mapping.sourceFile))
    ))
    .map(unit => ({
      kind: unit.kind,
      id: unit.id ? `${unit.id.namespace}:${unit.id.path}` : unit.outputPath,
      outputPath: unit.outputPath.replaceAll("\\", "/"),
      content: unit.content
    }))
    .sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  const diagnostics = result.diagnostics
    .filter(diagnostic => !diagnostic.fileName || closureFiles.has(normalizedPath(diagnostic.fileName)))
    .map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      ...(diagnostic.fileName ? {
        fileName: path.relative(projectRoot, diagnostic.fileName).replaceAll("\\", "/")
      } : {})
    }))
    .sort((left, right) => [left.fileName ?? "", left.code].join(":")
      .localeCompare([right.fileName ?? "", right.code].join(":")));
  return { resources, diagnostics };
}

function normalizedPath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
