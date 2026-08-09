import * as assert from "node:assert/strict";
import {
  type CallExprNode,
  type IdentifierNode,
  parseRsgl,
  type TemplateDeclNode,
  type TextRange
} from "../../src/parser";
import {
  bindRsglModule,
  type RsglScope,
  type RsglSemanticModel,
  type RsglSymbol,
  type RsglTemplateUseRecord
} from "../../src/semantic";
import { validateTemplateRecursion } from "../../src/semantic/templateRecursion";

describe("RSGL template recursion validation", () => {
  it("reports only cycle-member edges in their original call-site order", () => {
    const source = [
      "template entry() { use left() }",
      "template left() {",
      "  use right()",
      "  use exit()",
      "}",
      "template right() { use left() }",
      "template exit() {}",
      "template self() { use self() }",
      "use entry()"
    ].join("\n");

    const model = bindRsglModule(parseRsgl(source), { fileName: "cycles.rsgl" });
    const diagnostics = validateTemplateRecursion([model]);

    assert.deepStrictEqual(diagnostics.map(item => ({
      code: item.code,
      fileName: item.fileName,
      message: item.message,
      severity: item.severity,
      source: source.slice(item.range.start, item.range.end)
    })), [
      {
        code: "rsgl.templateRecursion",
        fileName: "cycles.rsgl",
        message: "Template 'right' participates in a recursive expansion cycle.",
        severity: "error",
        source: "right()"
      },
      {
        code: "rsgl.templateRecursion",
        fileName: "cycles.rsgl",
        message: "Template 'left' participates in a recursive expansion cycle.",
        severity: "error",
        source: "left()"
      },
      {
        code: "rsgl.templateRecursion",
        fileName: "cycles.rsgl",
        message: "Template 'self' participates in a recursive expansion cycle.",
        severity: "error",
        source: "self()"
      }
    ]);
  });

  it("handles a deep template cycle without recursive graph traversal", () => {
    const templateCount = 12_000;
    const model = createSyntheticCycleModel(templateCount);

    const diagnostics = validateTemplateRecursion([model]);

    assert.strictEqual(diagnostics.length, templateCount);
    assert.deepStrictEqual(diagnostics[0].range, callRange(0));
    assert.deepStrictEqual(diagnostics.at(-1)?.range, callRange(templateCount - 1));
  });
});

function createSyntheticCycleModel(templateCount: number): RsglSemanticModel {
  const scope: RsglScope = { kind: "global", symbols: new Map(), typeAliases: new Map() };
  const templates = Array.from({ length: templateCount }, (_, index) => createTemplate(index));
  const symbols = templates.map((template, index): RsglSymbol => ({
    name: templateName(index),
    kind: "template",
    type: { kind: "Function" },
    node: template,
    signature: {
      parameters: [],
      returnType: { kind: "Any" },
      templateOutput: { outputSource: "noArrowResources", outputDialect: "resources" }
    }
  }));
  for (const symbol of symbols) {
    scope.symbols.set(symbol.name, symbol);
  }

  const templateUses: RsglTemplateUseRecord[] = templates.map((template, index) => ({
    expression: createCall((index + 1) % templateCount, callRange(index)),
    scope,
    enclosingTemplate: template
  }));

  return {
    fileName: "deep-cycle.rsgl",
    module: parseRsgl(""),
    scope,
    symbols,
    imports: [],
    exports: [],
    references: [],
    outputResources: [],
    diagnostics: [],
    resolvedExpectedTypes: new Map(),
    templateUses
  };
}

function createTemplate(index: number): TemplateDeclNode {
  const range = { start: index, end: index + 1 };
  return {
    kind: "TemplateDecl",
    keyword: "template",
    name: identifier(templateName(index), range),
    parameters: [],
    outputSyntax: "noArrow",
    body: {
      kind: "Block",
      statements: [],
      range,
      fullRange: range
    },
    range,
    fullRange: range
  };
}

function createCall(targetIndex: number, range: TextRange): CallExprNode {
  return {
    kind: "CallExpr",
    callee: {
      kind: "IdentifierExpr",
      name: identifier(templateName(targetIndex), range),
      range,
      fullRange: range
    },
    args: [],
    range,
    fullRange: range
  };
}

function identifier(text: string, range: TextRange): IdentifierNode {
  return { kind: "Identifier", text, range, fullRange: range };
}

function templateName(index: number): string {
  return `template${index}`;
}

function callRange(index: number): TextRange {
  return { start: index * 3, end: index * 3 + 2 };
}
