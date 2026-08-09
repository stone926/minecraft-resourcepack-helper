import * as assert from "node:assert/strict";
import { inferRsglToolingExpressionType } from "../../src/memberTypeResolver";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, formatType } from "../../src/semantic";

describe("RSGL member tooling expression types", () => {
  it("reuses semantic collection inference without leaking generic placeholders", () => {
    const module = parseRsgl([
      "let mapped = map([{ name: \"first\" }], item => item)",
      "let empty = []"
    ].join("\n"));
    const model = bindRsglModule(module);
    const mapped = inferRsglToolingExpressionType(model, valueOf("mapped"));
    const empty = inferRsglToolingExpressionType(model, valueOf("empty"));

    assert.strictEqual(mapped.kind, "List");
    assert.strictEqual(mapped.elementType?.kind, "Object");
    assert.match(formatType(mapped.elementType?.properties?.get("name")?.type ?? { kind: "Unknown" }), /String|"first"/u);
    assert.doesNotMatch(formatType(mapped), /\b[RTU]\b/u);
    assert.strictEqual(empty.kind, "List");
    assert.strictEqual(empty.elementType?.kind, "Never");

    function valueOf(name: string) {
      const declaration = module.statements.find(statement =>
        statement.kind === "LetDecl" && statement.name?.text === name
      );
      assert.ok(declaration?.kind === "LetDecl", `Missing let '${name}'.`);
      return declaration.value;
    }
  });

  it("composes list and object spread operands in source order", () => {
    const module = parseRsgl([
      "let base = { inherited: true, overridden: \"old\" }",
      "let middle = [1, 2]",
      "let object = { before: 0, ...base, overridden: 1, after: true }",
      "let list = [\"head\", ...middle, false]"
    ].join("\n"));
    const model = bindRsglModule(module);
    const object = valueOf("object");
    const list = valueOf("list");

    const objectType = inferRsglToolingExpressionType(model, object);
    assert.deepStrictEqual(Array.from(objectType.properties?.keys() ?? []), [
      "before",
      "inherited",
      "overridden",
      "after"
    ]);
    assert.match(formatType(objectType.properties?.get("overridden")?.type ?? { kind: "Unknown" }), /Number|1/u);

    const listType = inferRsglToolingExpressionType(model, list);
    assert.strictEqual(listType.kind, "List");
    assert.match(formatType(listType.elementType ?? { kind: "Unknown" }), /Number|1|2/u);
    assert.match(formatType(listType.elementType ?? { kind: "Unknown" }), /String|"head"/u);
    assert.match(formatType(listType.elementType ?? { kind: "Unknown" }), /Boolean|false/u);

    function valueOf(name: string) {
      const declaration = module.statements.find(statement =>
        statement.kind === "LetDecl" && statement.name?.text === name
      );
      assert.ok(declaration?.kind === "LetDecl", `Missing let '${name}'.`);
      return declaration.value;
    }
  });
});
