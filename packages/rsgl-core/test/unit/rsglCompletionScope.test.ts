import * as assert from "node:assert";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { visibleRsglSymbolsAtOffset } from "../../src/completionScope";
import { getRsglDocumentCompletionItems } from "../../src/languageService";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, type RsglSemanticModel } from "../../src/semantic";

const fallbackWorkspace = {
  loadProgramFromEntry(): never {
    throw new Error("Use the open document fallback.");
  }
};

describe("RSGL completion lexical scope", () => {
  it("keeps module declarations and imports global without leaking lambda locals", () => {
    const text = [
      "import { external as imported } from \"./missing.rsgl\"",
      "let early = later",
      "let later = 1",
      "let functionValue = (hidden) => hidden"
    ].join("\n");
    const model = bind(text);
    const offset = text.indexOf("later");

    assertNamesInclude(model, offset, "imported", "early", "later", "functionValue");
    assertNamesExclude(model, offset, "hidden");

    const completions = getRsglDocumentCompletionItems({
      fileName: path.resolve("completion-global.rsgl"),
      getText: () => text
    }, offset, fallbackWorkspace);
    assert.ok(completions.some(item => item.label === "later"));
    assert.ok(completions.some(item => item.label === "imported"));
    assert.ok(completions.some(item => item.label === "seq"), "builtin completions remain available");
    assert.strictEqual(completions.some(item => item.label === "hidden"), false);
  });

  it("limits template parameters and local lets to the template body", () => {
    const text = [
      "template build(parameter: String) -> model {",
      "  let first = parameter",
      "  parent first",
      "  let later = parameter",
      "}",
      "let outside = 1"
    ].join("\n");
    const model = bind(text);
    const bodyOffset = endOf(text, "parent first");
    const outsideOffset = endOf(text, "let outside = 1");

    assertNamesInclude(model, bodyOffset, "build", "outside", "parameter", "first");
    assertNamesExclude(model, bodyOffset, "later");
    assertNamesExclude(model, outsideOffset, "parameter", "first", "later");
  });

  it("keeps lambda parameters inside their own lambda bodies", () => {
    const text = [
      "let outer = 1",
      "let firstFunction = (left) => left",
      "let secondFunction = (right) => right",
      "let result = outer"
    ].join("\n");
    const model = bind(text);
    const firstBodyOffset = endOf(text, "=> left");
    const secondBodyOffset = endOf(text, "=> right");
    const outsideOffset = endOf(text, "let result = outer");

    assertNamesInclude(model, firstBodyOffset, "left", "outer");
    assertNamesExclude(model, firstBodyOffset, "right");
    assertNamesInclude(model, secondBodyOffset, "right", "outer");
    assertNamesExclude(model, secondBodyOffset, "left");
    assertNamesExclude(model, outsideOffset, "left", "right");
  });

  it("limits loop bindings and loop-local lets to the matching loop body", () => {
    const text = [
      "model block scoped {",
      "  for item in [\"a\"] {",
      "    let captured = item",
      "    parent captured",
      "  }",
      "  for other in [\"b\"] {",
      "    parent other",
      "  }",
      "  parent minecraft:block/cube",
      "}"
    ].join("\n");
    const model = bind(text);
    const firstBodyOffset = endOf(text, "parent captured");
    const secondBodyOffset = endOf(text, "parent other");
    const outsideOffset = endOf(text, "parent minecraft:block/cube");

    assertNamesInclude(model, firstBodyOffset, "item", "captured");
    assertNamesExclude(model, firstBodyOffset, "other");
    assertNamesInclude(model, secondBodyOffset, "other");
    assertNamesExclude(model, secondBodyOffset, "item", "captured");
    assertNamesExclude(model, outsideOffset, "item", "captured", "other");
  });

  it("scopes object loop aliases across later dimensions without exposing property names", () => {
    const text = [
      "model block destructured_scope {",
      "  for {source: alias, shorthand} in [{ source: \"a\", shorthand: \"b\" }],",
      "      {later: second} in [{ later: alias }] {",
      "    parent second",
      "  }",
      "  parent minecraft:block/cube",
      "}"
    ].join("\n");
    const model = bind(text);
    const laterIterableOffset = endOf(text, "{ later: alias }");
    const bodyOffset = endOf(text, "parent second");
    const outsideOffset = endOf(text, "parent minecraft:block/cube");

    assertNamesInclude(model, laterIterableOffset, "alias", "shorthand");
    assertNamesExclude(model, laterIterableOffset, "source", "later", "second");
    assertNamesInclude(model, bodyOffset, "alias", "shorthand", "second");
    assertNamesExclude(model, bodyOffset, "source", "later");
    assertNamesExclude(model, outsideOffset, "alias", "shorthand", "second");
  });

  it("exposes explicit loop indexes only after their own iterable", () => {
    const text = [
      "model block indexed_scope {",
      "  for item at itemIndex in [1], other at otherIndex in [itemIndex] {",
      "    let selected = otherIndex",
      "    parent minecraft:block/cube",
      "  }",
      "  parent minecraft:block/cube",
      "}"
    ].join("\n");
    const model = bind(text);
    const firstIterableOffset = text.indexOf("[1]") + 1;
    const secondIterableOffset = text.indexOf("[itemIndex]") + 2;
    const bodyOffset = endOf(text, "let selected = otherIndex");
    const outsideOffset = text.lastIndexOf("parent minecraft:block/cube")
      + "parent minecraft:block/cube".length;

    assertNamesExclude(model, firstIterableOffset, "item", "itemIndex", "other", "otherIndex");
    assertNamesInclude(model, secondIterableOffset, "item", "itemIndex");
    assertNamesExclude(model, secondIterableOffset, "other", "otherIndex");
    assertNamesInclude(model, bodyOffset, "item", "itemIndex", "other", "otherIndex", "selected");
    assertNamesExclude(model, outsideOffset, "item", "itemIndex", "other", "otherIndex", "selected");
  });

  it("does not leak local lets between if siblings or after the branch", () => {
    const text = [
      "model block branches {",
      "  if true {",
      "    let thenOnly = 1",
      "    parent thenOnly",
      "  } else {",
      "    let elseOnly = 2",
      "    parent elseOnly",
      "  }",
      "  parent minecraft:block/cube",
      "}"
    ].join("\n");
    const model = bind(text);
    const thenOffset = endOf(text, "parent thenOnly");
    const elseOffset = endOf(text, "parent elseOnly");
    const afterOffset = endOf(text, "parent minecraft:block/cube");

    assertNamesInclude(model, thenOffset, "thenOnly");
    assertNamesExclude(model, thenOffset, "elseOnly");
    assertNamesInclude(model, elseOffset, "elseOnly");
    assertNamesExclude(model, elseOffset, "thenOnly");
    assertNamesExclude(model, afterOffset, "thenOnly", "elseOnly");
  });

  it("indexes locals recursively inside variant and multipart random choices", () => {
    const text = [
      "blockstate variants scoped_variant {",
      "  case * => random {",
      "    let variantChoiceLocal = minecraft:block/variant",
      "    option variantChoiceLocal",
      "    for variantRotation in [0] {",
      "      let nestedVariantLocal = variantChoiceLocal",
      "      option nestedVariantLocal with { y: variantRotation }",
      "    }",
      "  }",
      "  case { fallback: true } => minecraft:block/fallback",
      "}",
      "blockstate multipart scoped_multipart {",
      "  part always => random {",
      "    let multipartChoiceLocal = minecraft:block/multipart",
      "    option multipartChoiceLocal",
      "  }",
      "  part always => minecraft:block/post",
      "}"
    ].join("\n");
    const model = bind(text);
    const variantChoiceOffset = endOf(text, "option variantChoiceLocal");
    const nestedVariantOffset = endOf(
      text,
      "option nestedVariantLocal with { y: variantRotation }"
    );
    const afterVariantChoiceOffset = endOf(
      text,
      "case { fallback: true } => minecraft:block/fallback"
    );
    const multipartChoiceOffset = endOf(text, "option multipartChoiceLocal");
    const afterMultipartChoiceOffset = endOf(text, "part always => minecraft:block/post");

    assertNamesInclude(model, variantChoiceOffset, "variantChoiceLocal");
    assertNamesExclude(model, variantChoiceOffset, "variantRotation", "nestedVariantLocal");
    assertNamesInclude(
      model,
      nestedVariantOffset,
      "variantChoiceLocal",
      "variantRotation",
      "nestedVariantLocal"
    );
    assertNamesExclude(
      model,
      afterVariantChoiceOffset,
      "variantChoiceLocal",
      "variantRotation",
      "nestedVariantLocal"
    );
    assertNamesInclude(model, multipartChoiceOffset, "multipartChoiceLocal");
    assertNamesExclude(model, afterMultipartChoiceOffset, "multipartChoiceLocal");
  });

  it("offers local lets only after their declaration in the same body", () => {
    const text = [
      "model block ordered {",
      "  parent minecraft:block/before",
      "  let delayed = minecraft:block/value",
      "  parent delayed",
      "}"
    ].join("\n");
    const model = bind(text);

    assertNamesExclude(model, endOf(text, "parent minecraft:block/before"), "delayed");
    assertNamesInclude(model, endOf(text, "parent delayed"), "delayed");
  });

  it("scopes each range frames binding across its complete recursive model without leaking", () => {
    const text = [
      "item scoped {",
      "  range property rangeProperty {",
      "    let outer = 1",
      "    frames firstFrames model condition property frame {",
      "      on_true composite {",
      "        let nested = index",
      "        model buildModel(index, frame, outer, nested)",
      "      }",
      "      on_false fallbackModel",
      "    } with { transformation: frame }",
      "    entry index => outsideModel",
      "    frames secondFrames model use buildFrame(index: index, frame: frame)",
      "    fallback frame",
      "  }",
      "}"
    ].join("\n");
    const model = bind(text);

    assertNamesInclude(model, endOf(text, "property frame"), "outer", "index", "frame");
    assertNamesInclude(
      model,
      endOf(text, "model buildModel(index, frame, outer, nested)"),
      "outer",
      "index",
      "frame",
      "nested"
    );
    assertNamesInclude(model, endOf(text, "transformation: frame"), "outer", "index", "frame");
    assertNamesExclude(model, endOf(text, "transformation: frame"), "nested");
    assertNamesInclude(model, endOf(text, "entry index"), "outer");
    assertNamesExclude(model, endOf(text, "entry index"), "index", "frame", "nested");
    assertNamesInclude(
      model,
      endOf(text, "buildFrame(index: index, frame: frame)"),
      "outer",
      "index",
      "frame"
    );
    assertNamesExclude(model, endOf(text, "buildFrame(index: index, frame: frame)"), "nested");
    assertNamesInclude(model, endOf(text, "fallback frame"), "outer");
    assertNamesExclude(model, endOf(text, "fallback frame"), "index", "frame", "nested");
  });

  it("filters large local symbol sets within a bounded time", () => {
    const localCount = 5_000;
    const text = [
      "model block performance {",
      ...Array.from({ length: localCount }, (_, index) => `  let local${index} = ${index}`),
      `  parent local${localCount - 1}`,
      "}"
    ].join("\n");
    const model = bind(text);
    const offset = endOf(text, `parent local${localCount - 1}`);

    const startedAt = performance.now();
    let visible = visibleRsglSymbolsAtOffset(model, offset);
    for (let iteration = 0; iteration < 99; iteration++) {
      visible = visibleRsglSymbolsAtOffset(model, offset);
    }
    const elapsed = performance.now() - startedAt;

    assert.ok(visible.some(symbol => symbol.name === "local0"));
    assert.ok(visible.some(symbol => symbol.name === `local${localCount - 1}`));
    assert.ok(elapsed < 5_000, `Expected 100 scope queries under 5s, got ${elapsed.toFixed(1)}ms.`);
  });
});

function bind(text: string): RsglSemanticModel {
  return bindRsglModule(parseRsgl(text), { fileName: path.resolve("completion-scope.rsgl") });
}

function endOf(text: string, fragment: string): number {
  const start = text.indexOf(fragment);
  assert.ok(start >= 0, `Expected fragment: ${fragment}`);
  return start + fragment.length;
}

function namesAt(model: RsglSemanticModel, offset: number): Set<string> {
  return new Set(visibleRsglSymbolsAtOffset(model, offset).map(symbol => symbol.name));
}

function assertNamesInclude(model: RsglSemanticModel, offset: number, ...expected: string[]): void {
  const names = namesAt(model, offset);
  for (const name of expected) {
    assert.ok(names.has(name), `Expected '${name}' to be visible at ${offset}.`);
  }
}

function assertNamesExclude(model: RsglSemanticModel, offset: number, ...unexpected: string[]): void {
  const names = namesAt(model, offset);
  for (const name of unexpected) {
    assert.strictEqual(names.has(name), false, `Expected '${name}' to be hidden at ${offset}.`);
  }
}
