import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglDirectory,
  compileRsglFile,
  createRsglCompileSnapshot,
  loadRsglSourceFilesFromDirectory,
  type RsglCompileSnapshot
} from "../../src/compiler";
import { walkRsglModule } from "../../src/parser/astTraversal";
import type { RsglModule } from "../../src/parser";
import { rsglResourceKindDescriptors } from "../../src/resourceKinds";
import { bindRsglProgram } from "../../src/semantic";
import type { ResolvedTemplateOutputMetadata } from "../../src/templateOutput";
import { createAllRsglStdlibSourceFiles } from "../../src/stdlib";

interface DiagnosticExpectation {
  code: string;
  severity: "error" | "warning" | "info";
}

type FrozenTemplateOutputMetadata = ResolvedTemplateOutputMetadata;

interface MigrationCaseManifest {
  version: number;
  legacyProject: {
    root: string;
    snapshot: string;
  };
  resourceBodyConsumerSnapshot: string;
  templateOutputMetadataSnapshot: string;
  templateOutputMetadataSnapshotKind: "resolvedSemanticMetadata";
  templateOutputMetadataReplacementGate: string;
  compatibilityRemovalGate: {
    exactLegacyDefinitionsMustReach: number;
    contextualAdapterUsesMustReach: number;
    removeHeuristicOnlyAfterBothReachZero: boolean;
  };
  legacyTemplateCensus: {
    noArrowResourceDefinitions: number;
    explicitPublicDefinitions: number;
    exactLegacyDefinitions: number;
    contextualAdapterDefinitions: number;
    exactLegacyUses: number;
    contextualAdapterUses: number;
  };
  cases: Array<{
    id: string;
    features: string[];
    legacy: {
      status: "executable";
      source: string;
      expectedDiagnostics: DiagnosticExpectation[];
      expectedTemplateOutput?: {
        templateName: string;
        outputSource: "noArrowResources" | "legacyInferredBody" | "legacyContextualAdapter";
        expectedUseCount: number;
        outputDialect?: "resources";
        bodyKind?: "blockstateRoot";
        mode?: "variants" | "multipart";
        allowRootMerge?: true;
        allowBase?: false;
        bodyNodeKind?: "ResourceBody";
        resolvedCallerDialect?: string;
      };
    };
    canonical: {
      status: "planned" | "executable";
      source: string;
      expectedDiagnostics: DiagnosticExpectation[];
      target: string;
      expectedRangeCategories?: string[];
    };
  }>;
}

const fixtureRoot = path.resolve(
  "packages",
  "rsgl-core",
  "test",
  "fixtures",
  "abstraction-migration"
);
const manifest = readJson<MigrationCaseManifest>(path.join(fixtureRoot, "cases.json"));

describe("RSGL abstraction migration baseline", () => {
  it("keeps every declared legacy case executable and wires canonical equivalence gates", () => {
    assert.strictEqual(manifest.version, 1);
    assert.ok(manifest.cases.length > 0);
    assert.deepStrictEqual(manifest.compatibilityRemovalGate, {
      exactLegacyDefinitionsMustReach: 0,
      contextualAdapterUsesMustReach: 0,
      removeHeuristicOnlyAfterBothReachZero: true
    });
    assertUnique(manifest.cases.map(migrationCase => migrationCase.id), "migration case id");
    assertUnique(manifest.cases.map(migrationCase => migrationCase.legacy.source), "legacy source");
    assertUnique(manifest.cases.map(migrationCase => migrationCase.canonical.source), "canonical source");

    const requiredFeatures = [
      "resources",
      "model-body",
      "blockstate-variants",
      "blockstate-multipart",
      "root-merge",
      "value-helper",
      "function-typed-let",
      "typed-id",
      "product",
      "model-geometry",
      "stdlib"
    ];
    const declaredFeatures = new Set(manifest.cases.flatMap(migrationCase => migrationCase.features));
    assert.deepStrictEqual(requiredFeatures.filter(feature => !declaredFeatures.has(feature)), []);

    const legacyRoot = path.join(fixtureRoot, manifest.legacyProject.root);
    const declaredLegacySources = manifest.cases
      .map(migrationCase => normalizePortablePath(migrationCase.legacy.source))
      .sort(compareOrdinal);
    const actualLegacySources = listRsglFiles(legacyRoot)
      .map(fileName => normalizePortablePath(path.relative(fixtureRoot, fileName)))
      .sort(compareOrdinal);
    assert.deepStrictEqual(actualLegacySources, declaredLegacySources, "legacy sources and manifest must stay exhaustive");

    const canonicalRoot = path.join(fixtureRoot, "canonical");
    const declaredExecutableCanonicalSources = manifest.cases
      .filter(migrationCase =>
        migrationCase.canonical.status === "executable"
        && isFileWithinRoot(canonicalRoot, path.join(fixtureRoot, migrationCase.canonical.source))
      )
      .map(migrationCase => normalizePortablePath(migrationCase.canonical.source))
      .sort(compareOrdinal);
    const actualCanonicalSources = listRsglFiles(canonicalRoot)
      .map(fileName => normalizePortablePath(path.relative(fixtureRoot, fileName)))
      .sort(compareOrdinal);
    assert.deepStrictEqual(actualCanonicalSources, declaredExecutableCanonicalSources, "canonical sources must not be orphaned");

    for (const migrationCase of manifest.cases) {
      const legacySource = path.join(fixtureRoot, migrationCase.legacy.source);
      assert.ok(fs.existsSync(legacySource), `${migrationCase.id} legacy source must exist`);

      const result = compileRsglFile(legacySource);
      assert.deepStrictEqual(diagnosticProjection(result), migrationCase.legacy.expectedDiagnostics);

      const canonicalSource = path.join(fixtureRoot, migrationCase.canonical.source);
      if (migrationCase.canonical.status === "planned") {
        assert.strictEqual(
          fs.existsSync(canonicalSource),
          false,
          `${migrationCase.id} must not enable unimplemented canonical syntax`
        );
      } else {
        assert.ok(fs.existsSync(canonicalSource), `${migrationCase.id} canonical source must exist`);
        const canonicalResult = compileRsglFile(canonicalSource);
        assert.deepStrictEqual(diagnosticProjection(canonicalResult), migrationCase.canonical.expectedDiagnostics);
        assert.deepStrictEqual(
          migrationResourceEquivalenceProjection(createRsglCompileSnapshot(canonicalResult, {
            sourceRoot: path.dirname(canonicalSource)
          })),
          migrationResourceEquivalenceProjection(createRsglCompileSnapshot(result, {
            sourceRoot: path.dirname(legacySource)
          })),
          `${migrationCase.id} canonical output must remain equivalent to its legacy source`
        );
      }
    }

    const templateCases = manifest.cases.filter(migrationCase =>
      migrationCase.features.includes("template") || migrationCase.features.includes("blockstate-root-template")
    );
    assert.ok(templateCases.every(migrationCase => migrationCase.legacy.expectedTemplateOutput));
    assert.ok(manifest.cases
      .filter(migrationCase => migrationCase.features.some(feature =>
        feature === "blockstate-variants" || feature === "blockstate-multipart" || feature === "stdlib"
      ))
      .every(migrationCase => (migrationCase.canonical.expectedRangeCategories?.length ?? 0) > 0));
  });

  it("matches the frozen legacy resource, diagnostic, and source-map projection", () => {
    const legacyRoot = path.join(fixtureRoot, manifest.legacyProject.root);
    const expected = readJson<unknown>(path.join(fixtureRoot, manifest.legacyProject.snapshot));
    const result = compileRsglDirectory(legacyRoot);
    const actual = createRsglCompileSnapshot(result, { sourceRoot: legacyRoot });

    assert.deepStrictEqual(actual, expected);
    assert.strictEqual(actual.resources.length, 12);
    assert.deepStrictEqual(actual.diagnostics.map(item => item.code), [
      "rsgl.implicitTemplateOutputDialect",
      "rsgl.implicitTemplateOutputDialect",
      "rsgl.implicitTemplateOutputDialect",
      "rsgl.implicitTemplateOutputDialect"
    ]);

    const stairs = actual.resources.find(resource => resource.outputPath.endsWith("stdlib_stairs.json"));
    const slab = actual.resources.find(resource => resource.outputPath.endsWith("stdlib_slab.json"));
    const sequence = actual.resources.find(resource => resource.outputPath.endsWith("stdlib_state_sequence.json"));
    assert.strictEqual(Object.keys((stairs?.content as { variants: object }).variants).length, 40);
    assert.ok(slab);
    assert.ok(sequence);
    assert.ok([stairs, slab, sequence].every(resource =>
      resource?.sourceMap.mappings.some(mapping => mapping.sourceFile.startsWith("<rsgl-stdlib>/"))
    ));
  });

  it("freezes legacy resource-body consumers from the central descriptor registry", () => {
    const expected = readJson<unknown>(path.join(fixtureRoot, manifest.resourceBodyConsumerSnapshot));
    const actual = rsglResourceKindDescriptors.map(descriptor => ({
      resourceKind: descriptor.keyword,
      astShape: descriptor.ast.shape,
      bodyDialect: descriptor.ast.bodyDialect,
      compileHandler: descriptor.compile.handler
    }));

    assert.deepStrictEqual(actual, expected);
  });

  it("freezes every tracked legacy template definition and compatibility use", () => {
    assert.strictEqual(manifest.templateOutputMetadataSnapshotKind, "resolvedSemanticMetadata");
    assert.ok(manifest.templateOutputMetadataReplacementGate.includes("resolvedTemplateOutputMetadata"));
    const legacyRoot = path.join(fixtureRoot, manifest.legacyProject.root);
    const projectSourceFiles = loadRsglSourceFilesFromDirectory(legacyRoot)
      .filter(sourceFile => isFileWithinRoot(legacyRoot, sourceFile.fileName));
    const program = bindRsglProgram([...projectSourceFiles, ...createAllRsglStdlibSourceFiles()]);
    const definitions: Array<{
      source: string;
      templateName: string;
      metadata: FrozenTemplateOutputMetadata;
    }> = [];
    const useCounts = new Map<string, number>();

    for (const model of program.models) {
      for (const symbol of model.symbols) {
        if (symbol.kind === "template" && symbol.node?.kind === "TemplateDecl" && symbol.signature?.templateOutput) {
          definitions.push({
            source: portableSourceFile(fixtureRoot, model.fileName),
            templateName: symbol.name,
            metadata: symbol.signature.templateOutput
          });
        }
      }
      walkRsglModule(model.module, {
        enterStatement(statement) {
          if (
            statement.kind === "UseDecl"
            && statement.expression.kind === "CallExpr"
            && statement.expression.callee.kind === "IdentifierExpr"
          ) {
            const name = statement.expression.callee.name.text;
            useCounts.set(name, (useCounts.get(name) ?? 0) + 1);
          }
        }
      });
    }

    const expectedDefinitions = readJson<typeof definitions>(
      path.join(fixtureRoot, manifest.templateOutputMetadataSnapshot)
    );
    assert.deepStrictEqual(sortDefinitions(definitions), sortDefinitions(expectedDefinitions));

    for (const migrationCase of manifest.cases) {
      const output = migrationCase.legacy.expectedTemplateOutput;
      if (!output) {
        continue;
      }
      const frozen = expectedDefinitions.find(definition =>
        definition.source === migrationCase.legacy.source
        && definition.templateName === output.templateName
      );
      assert.deepStrictEqual(frozen?.metadata, expectedDefinitionMetadata(output));
      if (output.outputSource === "legacyContextualAdapter") {
        assert.strictEqual(
          contextualUseDialect(loadModule(migrationCase.legacy.source), output.templateName),
          output.resolvedCallerDialect
        );
      }
    }

    const trackedOutputs = manifest.cases.flatMap(migrationCase => {
      const output = migrationCase.legacy.expectedTemplateOutput;
      return output ? [output] : [];
    });
    for (const output of trackedOutputs) {
      assert.strictEqual(
        useCounts.get(output.templateName),
        output.expectedUseCount,
        `${output.templateName} compatibility use count changed`
      );
    }
    const exactTemplateNames = definitions
      .filter(definition => definition.metadata.outputSource === "legacyInferredBody")
      .map(definition => definition.templateName);
    const contextualTemplateNames = definitions
      .filter(definition => definition.metadata.outputSource === "legacyContextualAdapter")
      .map(definition => definition.templateName);
    assert.strictEqual(
      definitions.filter(definition =>
        definition.source.startsWith("<rsgl-stdlib>/")
        && (
          definition.metadata.outputSource === "legacyInferredBody"
          || definition.metadata.outputSource === "legacyContextualAdapter"
        )
      ).length,
      0,
      "Bundled stdlib must not retain implicit template output definitions."
    );
    assert.deepStrictEqual({
      noArrowResourceDefinitions: definitions
        .filter(definition => definition.metadata.outputSource === "noArrowResources").length,
      explicitPublicDefinitions: definitions
        .filter(definition => definition.metadata.outputSource === "explicitArrow").length,
      exactLegacyDefinitions: exactTemplateNames.length,
      contextualAdapterDefinitions: contextualTemplateNames.length,
      exactLegacyUses: exactTemplateNames.reduce((total, name) => total + (useCounts.get(name) ?? 0), 0),
      contextualAdapterUses: contextualTemplateNames.reduce((total, name) => total + (useCounts.get(name) ?? 0), 0)
    }, manifest.legacyTemplateCensus);
  });
});

function readJson<T>(fileName: string): T {
  return JSON.parse(fs.readFileSync(fileName, "utf8")) as T;
}

function migrationResourceEquivalenceProjection(snapshot: RsglCompileSnapshot): RsglCompileSnapshot["resources"] {
  return snapshot.resources.map(resource => ({
      ...resource,
      sourceMap: {
        ...resource.sourceMap,
        mappings: resource.sourceMap.mappings.map(mapping => ({
          ...mapping,
          sourceFile: mapping.sourceFile.startsWith("<") ? mapping.sourceFile : "<case-source>"
        }))
      }
    }));
}

function sortDefinitions(
  definitions: Array<{ source: string; templateName: string; metadata: FrozenTemplateOutputMetadata }>
): Array<{ source: string; templateName: string; metadata: FrozenTemplateOutputMetadata }> {
  return definitions.sort((left, right) =>
    compareOrdinal(left.source, right.source) || compareOrdinal(left.templateName, right.templateName)
  );
}

function diagnosticProjection(result: ReturnType<typeof compileRsglFile>): DiagnosticExpectation[] {
  return result.diagnostics
    .map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity
    }))
    .sort((left, right) =>
      compareOrdinal(left.code, right.code) || compareOrdinal(left.severity, right.severity)
    );
}

function expectedDefinitionMetadata(
  output: NonNullable<MigrationCaseManifest["cases"][number]["legacy"]["expectedTemplateOutput"]>
): FrozenTemplateOutputMetadata {
  if (output.outputSource === "noArrowResources") {
    return { outputSource: output.outputSource, outputDialect: output.outputDialect as "resources" };
  }
  if (output.outputSource === "legacyInferredBody") {
    return {
      outputSource: output.outputSource,
      legacyOutputDialect: {
        kind: output.bodyKind as "blockstateRoot",
        mode: output.mode as "variants" | "multipart",
        allowRootMerge: output.allowRootMerge as true,
        allowBase: output.allowBase as false
      }
    };
  }
  return { outputSource: output.outputSource, bodyNodeKind: output.bodyNodeKind as "ResourceBody" };
}

function contextualUseDialect(module: RsglModule, templateName: string): string | undefined {
  for (const statement of module.statements) {
    if (statement.kind !== "ResourceDecl") {
      continue;
    }
    const hasUse = statement.body.statements.some(child =>
      child.kind === "UseDecl"
      && child.expression.kind === "CallExpr"
      && child.expression.callee.kind === "IdentifierExpr"
      && child.expression.callee.name.text === templateName
    );
    if (!hasUse) {
      continue;
    }
    if (statement.resourceKind === "model") {
      return "model";
    }
    if (statement.resourceKind === "blockstate") {
      const mode = statement.body.statements.some(child => child.kind === "VariantsSection")
        ? "variants"
        : statement.body.statements.some(child => child.kind === "MultipartSection")
          ? "multipart"
          : "neutral";
      return `blockstateRoot:${mode}`;
    }
  }
  return undefined;
}

function loadModule(relativeFileName: string): RsglModule {
  const fileName = path.join(fixtureRoot, relativeFileName);
  const sourceFile = loadRsglSourceFilesFromDirectory(path.dirname(fileName))
    .find(candidate => path.resolve(candidate.fileName) === path.resolve(fileName));
  assert.ok(sourceFile, `Expected source module ${relativeFileName}`);
  return sourceFile.module;
}

function portableSourceFile(root: string, fileName: string): string {
  return fileName.startsWith("<")
    ? normalizePortablePath(fileName)
    : normalizePortablePath(path.relative(root, fileName));
}

function listRsglFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fileName = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRsglFiles(fileName));
    } else if (entry.isFile() && entry.name.endsWith(".rsgl")) {
      files.push(fileName);
    }
  }
  return files;
}

function assertUnique(values: string[], label: string): void {
  assert.strictEqual(new Set(values).size, values.length, `${label}s must be unique`);
}

function isFileWithinRoot(root: string, fileName: string): boolean {
  if (fileName.startsWith("<")) {
    return false;
  }
  const relative = path.relative(root, fileName);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizePortablePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
