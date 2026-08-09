import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  compileRsglResourceNavigation,
  getRsglDocumentDefinitionLocation,
  getRsglDocumentDefinitionLocations,
  getRsglDocumentReferenceLocations,
  resolveRsglCompileConfiguration,
  type RsglCompileConfigurationOptions,
  type RsglLanguageWorkspace,
  type RsglWorkspaceSemanticProgram
} from "../../src";
import { RsglWorkspaceSemanticCache } from "../../src/workspaceSemantic";
import { withTempDir } from "./helpers/fs";

describe("RSGL resource language service", () => {
  it("navigates between generated resource declarations and canonical references", () => {
    withTempDir(root => {
      const definitionFile = path.join(root, "01-definitions.rsgl");
      const useFile = path.join(root, "02-uses.rsgl");
      const definitionText = "namespace nav\nmodel block target {}";
      const useText = [
        "namespace nav",
        "blockstate variants target_state { case * => nav:block/target }"
      ].join("\n");
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(useFile, useText);

      const workspace = resourceWorkspace(root);
      const useDocument = { fileName: useFile, getText: () => useText };
      const definitionDocument = { fileName: definitionFile, getText: () => definitionText };
      const definitionStart = definitionText.indexOf("target");
      const referenceStart = useText.indexOf("nav:block/target");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(useDocument, referenceStart + 4, workspace),
        {
          fileName: definitionFile,
          range: { start: definitionStart, end: definitionStart + "target".length }
        }
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(
          definitionDocument,
          definitionStart + 1,
          false,
          workspace
        ),
        [{
          fileName: useFile,
          range: { start: referenceStart, end: referenceStart + "nav:block/target".length }
        }]
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(
          useDocument,
          referenceStart + 4,
          true,
          workspace
        ),
        [
          {
            fileName: definitionFile,
            range: { start: definitionStart, end: definitionStart + "target".length }
          },
          {
            fileName: useFile,
            range: { start: referenceStart, end: referenceStart + "nav:block/target".length }
          }
        ]
      );
    }, "rsgl-resource-language-service-");
  });

  it("keeps an expression binding distinct from its dynamically generated resource identity", () => {
    withTempDir(root => {
      const fileName = path.join(root, "dynamic.rsgl");
      const text = [
        "namespace nav",
        "template emit(id: String) {",
        "  model block id {}",
        "}",
        "for id in [stone, dirt] {",
        "  use emit(id)",
        "}",
        "blockstate variants stone_state { case * => nav:block/stone }"
      ].join("\n");
      fs.writeFileSync(fileName, text);
      const workspace = resourceWorkspace(root);
      const document = { fileName, getText: () => text };
      const parameterStart = text.indexOf("id: String");
      const generatedIdStart = text.indexOf("id {}", text.indexOf("model block"));
      const resourceReferenceStart = text.indexOf("nav:block/stone");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, generatedIdStart + 1, workspace),
        {
          fileName,
          range: { start: parameterStart, end: parameterStart + "id".length }
        }
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(document, generatedIdStart + 1, true, workspace)
          .map(location => location.range),
        [
          { start: parameterStart, end: parameterStart + "id".length },
          { start: generatedIdStart, end: generatedIdStart + "id".length }
        ]
      );
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, resourceReferenceStart + 4, workspace),
        {
          fileName,
          range: { start: generatedIdStart, end: generatedIdStart + "id".length }
        }
      );
    }, "rsgl-resource-dynamic-binding-");
  });

  it("resolves finite interpolated model references to their shared template declaration", () => {
    withTempDir(root => {
      const fileName = path.join(root, "note-blocks.rsgl");
      const text = [
        "template noteOverlayModel(suffix: Json) {",
        "  model block `note_block_${suffix}` {}",
        "}",
        "for note in 0..2 {",
        "  use noteOverlayModel(note)",
        "}",
        "blockstate multipart note_block {",
        "  for note in 0..2 {",
        "    part when $state.note == note => `block/note_block_${note}`",
        "  }",
        "}"
      ].join("\n");
      fs.writeFileSync(fileName, text);
      const workspace = resourceWorkspace(root);
      const document = { fileName, getText: () => text };
      const declarationStart = text.indexOf("`note_block_${suffix}`");
      const referenceStart = text.indexOf("`block/note_block_${note}`");
      const interpolationStart = text.indexOf("${note}", referenceStart) + 2;
      const loopVariableStart = text.lastIndexOf("note in 0..2");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocations(document, referenceStart + 2, workspace),
        [{
          fileName,
          range: {
            start: declarationStart,
            end: declarationStart + "`note_block_${suffix}`".length
          }
        }]
      );
      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, interpolationStart + 1, workspace),
        {
          fileName,
          range: { start: loopVariableStart, end: loopVariableStart + "note".length }
        }
      );
    }, "rsgl-resource-interpolated-definition-");
  });

  it("applies the project default namespace to resource navigation", () => {
    withTempDir(root => {
      const fileName = path.join(root, "default-namespace.rsgl");
      const text = [
        "model block target {}",
        "blockstate variants target_state { case * => nav:block/target }"
      ].join("\n");
      fs.writeFileSync(fileName, text);
      const workspace = resourceWorkspace(root, { defaultNamespace: "nav" });
      const document = { fileName, getText: () => text };
      const definitionStart = text.indexOf("target");
      const referenceStart = text.indexOf("nav:block/target");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(document, referenceStart + 4, workspace),
        {
          fileName,
          range: { start: definitionStart, end: definitionStart + "target".length }
        }
      );
    }, "rsgl-resource-default-namespace-");
  });

  it("returns every declaration for a conflicting canonical resource id", () => {
    withTempDir(root => {
      const firstFile = path.join(root, "01-first.rsgl");
      const secondFile = path.join(root, "02-second.rsgl");
      const useFile = path.join(root, "03-use.rsgl");
      const firstText = "namespace nav\nmodel block shared {}";
      const secondText = "namespace nav\nmodel block shared {}";
      const useText = [
        "namespace nav",
        "blockstate variants state { case * => nav:block/shared }"
      ].join("\n");
      fs.writeFileSync(firstFile, firstText);
      fs.writeFileSync(secondFile, secondText);
      fs.writeFileSync(useFile, useText);
      const workspace = resourceWorkspace(root);
      const referenceStart = useText.indexOf("nav:block/shared");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocations(
          { fileName: useFile, getText: () => useText },
          referenceStart + 4,
          workspace
        ),
        [
          {
            fileName: firstFile,
            range: {
              start: firstText.indexOf("shared"),
              end: firstText.indexOf("shared") + "shared".length
            }
          },
          {
            fileName: secondFile,
            range: {
              start: secondText.indexOf("shared"),
              end: secondText.indexOf("shared") + "shared".length
            }
          }
        ]
      );
    }, "rsgl-resource-multiple-definitions-");
  });

  it("keeps unrelated resource navigation available beside a malformed module", () => {
    withTempDir(root => {
      const definitionFile = path.join(root, "01-definition.rsgl");
      const useFile = path.join(root, "02-use.rsgl");
      const malformedFile = path.join(root, "03-being-edited.rsgl");
      const definitionText = "namespace nav\nmodel block stable {}";
      const useText = [
        "namespace nav",
        "blockstate variants stable_state { case * => nav:block/stable }"
      ].join("\n");
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(useFile, useText);
      fs.writeFileSync(malformedFile, "namespace nav\nmodel block draft {}");

      const malformedOpenText = "namespace nav\nmodel block unfinished {";
      const workspace = resourceWorkspace(root, {}, cache => {
        cache.setOpenTextDocumentProvider(fileName =>
          path.normalize(fileName) === path.normalize(malformedFile)
            ? {
              fileName: malformedFile,
              version: 2,
              getText: () => malformedOpenText
            }
            : null
        );
      });
      const referenceStart = useText.indexOf("nav:block/stable");
      const definitionStart = definitionText.indexOf("stable");

      assert.deepStrictEqual(
        getRsglDocumentDefinitionLocation(
          { fileName: useFile, getText: () => useText },
          referenceStart + 4,
          workspace
        ),
        {
          fileName: definitionFile,
          range: { start: definitionStart, end: definitionStart + "stable".length }
        }
      );
      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(
          { fileName: definitionFile, getText: () => definitionText },
          definitionStart + 1,
          false,
          workspace
        ),
        [{
          fileName: useFile,
          range: { start: referenceStart, end: referenceStart + "nav:block/stable".length }
        }]
      );
    }, "rsgl-resource-malformed-sibling-");
  });

  it("reuses the navigation semantic program when a resource lookup needs compilation", () => {
    withTempDir(root => {
      const definitionFile = path.join(root, "definition.rsgl");
      const useFile = path.join(root, "use.rsgl");
      const definitionText = "namespace nav\nmodel block reused {}";
      const useText = [
        "namespace nav",
        "blockstate variants state { case * => nav:block/reused }"
      ].join("\n");
      fs.writeFileSync(definitionFile, definitionText);
      fs.writeFileSync(useFile, useText);

      const cache = RsglWorkspaceSemanticCache.create();
      const navigationProgram = cache.loadProgramFromDirectory(root);
      const build = compileRsglResourceNavigation(navigationProgram.files, {
        semanticProgram: navigationProgram.program
      });
      let navigationLoads = 0;
      let suppliedProgram: RsglWorkspaceSemanticProgram | undefined;
      const workspace: RsglLanguageWorkspace = {
        loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName),
        loadProgramForNavigation: () => {
          navigationLoads++;
          return navigationProgram;
        },
        loadResourceNavigation: (_fileName, semanticProgram) => {
          suppliedProgram = semanticProgram;
          return build.index;
        }
      };
      const referenceStart = useText.indexOf("nav:block/reused");

      assert.deepStrictEqual(
        getRsglDocumentReferenceLocations(
          { fileName: useFile, getText: () => useText },
          referenceStart + 4,
          true,
          workspace
        ).map(location => location.fileName),
        [definitionFile, useFile]
      );
      assert.strictEqual(navigationLoads, 1);
      assert.strictEqual(suppliedProgram, navigationProgram);
    }, "rsgl-resource-program-reuse-");
  });
});

function resourceWorkspace(
  root: string,
  compileOptions: RsglCompileConfigurationOptions = {},
  configureCache?: (cache: RsglWorkspaceSemanticCache) => void
): RsglLanguageWorkspace {
  const cache = RsglWorkspaceSemanticCache.create();
  configureCache?.(cache);
  const semanticConfigurationFingerprint = resolveRsglCompileConfiguration(
    compileOptions
  ).semanticFingerprint;
  const navigationProgram = cache.loadProgramFromDirectory(root, {
    semanticConfigurationFingerprint
  });
  const build = compileRsglResourceNavigation(navigationProgram.files, {
    ...compileOptions,
    semanticProgram: navigationProgram.program
  });
  return {
    loadProgramFromEntry: fileName => cache.loadProgramFromEntry(fileName, {
      semanticConfigurationFingerprint
    }),
    loadProgramForNavigation: () => navigationProgram,
    loadResourceNavigation: () => build.index
  };
}
