import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { CodeActionKind, type Diagnostic, type TextEdit } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  applyTextEdits,
  RsglWorkspaceSemanticCache
} from "../../../rsgl-core/src";
import {
  computeDocumentCodeActions,
  rsglBlockstateLegacyFixAllKind
} from "../../src/serverCore";

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-lsp-migrate-"));
}

function legacyDiagnostic(
  document: TextDocument,
  source: string,
  needle: string,
  code: string
): Diagnostic {
  const start = source.indexOf(needle);
  assert.ok(start >= 0, `Expected source to contain ${needle}`);
  return {
    range: {
      start: document.positionAt(start),
      end: document.positionAt(start + needle.length)
    },
    code,
    message: code
  };
}

function applyLspEdits(document: TextDocument, edits: readonly TextEdit[]): string {
  return applyTextEdits(document.getText(), edits.map(edit => ({
    range: {
      start: document.offsetAt(edit.range.start),
      end: document.offsetAt(edit.range.end)
    },
    newText: edit.newText
  })));
}

describe("RSGL blockstate migration code actions", () => {
  it("returns a diagnostic quick fix and custom fix-all with UTF-16 ranges", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "legacy.rsgl");
    const source = [
      "// 🧱 resource",
      "blockstate example {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stone uvlock",
      "  }",
      "}"
    ].join("\n");
    try {
      fs.writeFileSync(fileName, source);
      const uri = pathToFileURL(fileName).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const diagnostic = legacyDiagnostic(
        document,
        source,
        "variants",
        "rsgl.legacyBlockstateWrapper"
      );
      const cache = RsglWorkspaceSemanticCache.create();

      const actions = computeDocumentCodeActions(
        document,
        fileName,
        uri,
        { diagnostics: [diagnostic] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      );

      const quickFix = actions.find(action => action.kind === CodeActionKind.QuickFix);
      const fixAll = actions.find(action => action.kind === rsglBlockstateLegacyFixAllKind);
      assert.ok(quickFix);
      assert.strictEqual(quickFix.title, "Migrate this legacy blockstate declaration");
      assert.deepStrictEqual(quickFix.diagnostics, [diagnostic]);
      assert.ok(fixAll);
      assert.strictEqual(fixAll.title, "Migrate all legacy blockstate syntax in this file");
      const edits = fixAll.edit?.changes?.[uri];
      assert.ok(edits && edits.length > 0);
      const headerEdit = edits.find(edit => edit.newText === " variants");
      assert.deepStrictEqual(headerEdit?.range, {
        start: { line: 1, character: "blockstate".length },
        end: { line: 1, character: "blockstate".length }
      });
      const migrated = applyLspEdits(document, edits);
      assert.ok(migrated.includes("blockstate variants example"));
      assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone uvlock=true"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses linked re-export metadata to infer a wrapper-less declaration mode", () => {
    const root = createTempRoot();
    const definitionsFile = path.join(root, "definitions.rsgl");
    const publicFile = path.join(root, "public.rsgl");
    const mainFile = path.join(root, "main.rsgl");
    const source = [
      "import { facingEntries } from \"./public.rsgl\"",
      "blockstate example { use facingEntries() }"
    ].join("\n");
    try {
      fs.writeFileSync(definitionsFile, [
        "template facingEntries() -> variants {",
        "  { facing: north }: minecraft:block/stone",
        "}",
        "export { facingEntries }"
      ].join("\n"));
      fs.writeFileSync(publicFile, "export { facingEntries } from \"./definitions.rsgl\"");
      fs.writeFileSync(mainFile, source);
      const uri = pathToFileURL(mainFile).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const diagnostic = legacyDiagnostic(
        document,
        source,
        "blockstate example",
        "rsgl.blockstateModeRequired"
      );
      const cache = RsglWorkspaceSemanticCache.create();

      const actions = computeDocumentCodeActions(
        document,
        mainFile,
        uri,
        { diagnostics: [diagnostic], only: [rsglBlockstateLegacyFixAllKind] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      );

      assert.strictEqual(actions.length, 1);
      const edits = actions[0].edit?.changes?.[uri];
      assert.ok(edits);
      assert.strictEqual(
        applyLspEdits(document, edits),
        source.replace("blockstate example", "blockstate variants example")
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers a complete quick fix for legacy syntax under an existing mode header", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "mode-header.rsgl");
    const source = [
      "blockstate variants example {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stone uvlock",
      "  }",
      "}"
    ].join("\n");
    try {
      fs.writeFileSync(fileName, source);
      const uri = pathToFileURL(fileName).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const diagnostic = legacyDiagnostic(
        document,
        source,
        "variants {",
        "rsgl.legacyBlockstateWrapper"
      );
      const cache = RsglWorkspaceSemanticCache.create();

      const actions = computeDocumentCodeActions(
        document,
        fileName,
        uri,
        { diagnostics: [diagnostic], only: [CodeActionKind.QuickFix] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      );

      assert.strictEqual(actions.length, 1);
      const edits = actions[0].edit?.changes?.[uri];
      assert.ok(edits && edits.length > 0);
      assert.ok(edits.every(edit => edit.newText !== " variants"));
      const migrated = applyLspEdits(document, edits);
      assert.strictEqual((migrated.match(/blockstate variants/gu) ?? []).length, 1);
      assert.ok(migrated.includes("{ facing: north }: minecraft:block/stone uvlock=true"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits a resource quick fix when migration also requires a definition edit", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "transaction.rsgl");
    const source = [
      "let publicMarker = true",
      "export { publicMarker }",
      "template metadata(enabled: Boolean) {",
      "  merge deep { custom: enabled }",
      "}",
      "blockstate example {",
      "  use metadata(true)",
      "  variants { {} -> @minecraft:block/stone }",
      "}"
    ].join("\n");
    try {
      fs.writeFileSync(fileName, source);
      const uri = pathToFileURL(fileName).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const diagnostic = legacyDiagnostic(
        document,
        source,
        "blockstate example",
        "rsgl.blockstateModeRequired"
      );
      const cache = RsglWorkspaceSemanticCache.create();

      const actions = computeDocumentCodeActions(
        document,
        fileName,
        uri,
        { diagnostics: [diagnostic] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      );

      assert.ok(!actions.some(action => action.kind === CodeActionKind.QuickFix));
      const fixAll = actions.find(action => action.kind === rsglBlockstateLegacyFixAllKind);
      assert.ok(fixAll);
      const edits = fixAll.edit?.changes?.[uri];
      assert.ok(edits && edits.length > 0);
      const migrated = applyLspEdits(document, edits);
      assert.ok(migrated.includes("let metadata: (Boolean) -> Json = enabled =>"));
      assert.ok(migrated.includes("merge deep metadata(true)"));
      assert.ok(migrated.includes("blockstate variants example"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns before loading a program for unrelated requested action kinds", () => {
    const source = "blockstate empty {}";
    const uri = "file:///unrelated-action.rsgl";
    const document = TextDocument.create(uri, "rsgl", 1, source);
    let loads = 0;

    const actions = computeDocumentCodeActions(
      document,
      "unrelated-action.rsgl",
      uri,
      { diagnostics: [], only: [CodeActionKind.Refactor] },
      {
        loadProgramFromEntry: () => {
          loads++;
          throw new Error("must not load");
        }
      }
    );

    assert.deepStrictEqual(actions, []);
    assert.strictEqual(loads, 0);
  });

  it("does not offer edits when migration requires a manual mode choice", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "ambiguous.rsgl");
    const source = "blockstate empty {}";
    try {
      fs.writeFileSync(fileName, source);
      const uri = pathToFileURL(fileName).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const diagnostic = legacyDiagnostic(
        document,
        source,
        "blockstate empty",
        "rsgl.blockstateModeRequired"
      );
      const cache = RsglWorkspaceSemanticCache.create();

      assert.deepStrictEqual(computeDocumentCodeActions(
        document,
        fileName,
        uri,
        { diagnostics: [diagnostic] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      ), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("labels partial fix-all actions as safely inferable when manual issues remain", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "partially-ambiguous.rsgl");
    const source = [
      "blockstate safe { variants { {} -> @minecraft:block/stone } }",
      "blockstate ambiguous {}"
    ].join("\n");
    try {
      fs.writeFileSync(fileName, source);
      const uri = pathToFileURL(fileName).toString();
      const document = TextDocument.create(uri, "rsgl", 1, source);
      const cache = RsglWorkspaceSemanticCache.create();
      const actions = computeDocumentCodeActions(
        document,
        fileName,
        uri,
        { diagnostics: [], only: [rsglBlockstateLegacyFixAllKind] },
        { loadProgramFromEntry: entry => cache.loadProgramFromEntry(entry) }
      );
      const fixAll = actions.find(action => action.kind === rsglBlockstateLegacyFixAllKind);

      assert.ok(fixAll);
      assert.strictEqual(
        fixAll.title,
        "Migrate safely inferable legacy blockstate syntax in this file"
      );
      const edits = fixAll.edit?.changes?.[uri];
      assert.ok(edits && edits.length > 0);
      const migrated = applyLspEdits(document, edits);
      assert.ok(migrated.includes("blockstate variants safe"));
      assert.ok(migrated.includes("blockstate ambiguous {}"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
