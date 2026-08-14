import * as assert from "node:assert/strict";
import { parseRsgl } from "../../src/parser";
import {
  bindRsglModule,
  formatType,
  type RsglSemanticModel
} from "../../src/semantic";
import { scopeForTruthyCondition } from "../../src/semantic/typeNarrowing";
import {
  anyType,
  jsonType,
  nullType,
  type RsglScope,
  type RsglType,
  unknownType
} from "../../src/semantic/types";

describe("RSGL record type semantics", () => {
  it("keeps type aliases separate from the value namespace", () => {
    const model = bind([
      "type Entry = { name: String }",
      "let Entry = 1",
      "let record: Entry = { name: \"ok\" }"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(model.scope.symbols.get("Entry")?.type.kind, "Number");
    assert.strictEqual(model.scope.typeAliases.get("Entry")?.type?.kind, "Object");
  });

  it("checks nested required and excess fields while preserving width subtyping", () => {
    const model = bind([
      "type Metadata = { age: Number }",
      "type Entry = { name: String; metadata?: Metadata }",
      "let rich = { name: \"ok\", size: 2 }",
      "let widened: Entry = rich",
      "let bad: Entry = { nmae: \"typo\", metadata: {} }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.excessRecordField",
      "rsgl.missingRecordField",
      "rsgl.missingRecordField"
    ]);
    assert.ok(model.diagnostics[0].message.includes("Did you mean 'name'?"));
  });

  it("narrows optional fields only through an explicit has check", () => {
    const model = bind([
      "type Entry = { name: String; top?: String }",
      "let record: Entry = { name: \"crop\" }",
      "let unsafe = record.top",
      "if has(record, \"top\") { let safe: String = record.top }",
      "if record.top { let stillUnsafe = record.top }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.optionalFieldMayBeMissing",
      "rsgl.optionalFieldMayBeMissing",
      "rsgl.optionalFieldMayBeMissing"
    ]);
    assert.strictEqual(model.symbols.find(symbol => symbol.name === "safe")?.type.kind, "String");
  });

  it("carries has narrowing through true conjunction branches", () => {
    const model = bind([
      "type Animation = { frametime: Number }",
      "type Entry = { animation?: Animation; top?: String }",
      "let record: Entry = {}",
      "let enabled: Boolean = true",
      "if enabled && has(record, \"animation\") {",
      "  let animation = record.animation",
      "}",
      "if has(record, \"top\") && enabled {",
      "  let top = record.top",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), []);
    assert.strictEqual(model.symbols.find(symbol => symbol.name === "animation")?.type.kind, "Object");
    assert.strictEqual(model.symbols.find(symbol => symbol.name === "top")?.type.kind, "String");
  });

  it("removes definitely non-object union arms after a has guard", () => {
    const model = bind([
      "type Box = { value: String }",
      "let read: (Box | null) -> String = box => has(box, \"value\") ? box.value : \"none\""
    ]);

    assert.deepStrictEqual(codes(model), []);
  });

  it("retains dynamic Any, Json, and Unknown arms after a has guard", () => {
    const condition = parseExpression("has(candidate, \"value\")");
    for (const dynamicType of [anyType, jsonType, unknownType]) {
      const scope = narrowingScope({ kind: "Union", options: [dynamicType, nullType] });
      const narrowed = scopeForTruthyCondition(scope, condition).symbols.get("candidate")?.type;

      assert.strictEqual(narrowed?.kind, dynamicType.kind);
    }
  });

  it("contextually checks every record in a list", () => {
    const model = bind([
      "type Entry = { name: String; enabled?: Boolean }",
      "let entries: List<Entry> = [",
      "  { name: \"first\" },",
      "  { nmae: \"second\", extra: true }",
      "]"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.excessRecordField",
      "rsgl.excessRecordField",
      "rsgl.missingRecordField"
    ]);
  });

  it("selects contextual record-union arms by literal discriminators", () => {
    const model = bind([
      "type Event = { kind: \"a\"; a: Number } | { kind: \"b\"; b: Number }",
      "let validA: Event = { kind: \"a\", a: 1 }",
      "let validB: Event = { kind: \"b\", b: 2 }",
      "let excess: Event = { kind: \"a\", a: 1, typo: true }",
      "let missing: Event = { kind: \"b\" }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.excessRecordField",
      "rsgl.missingRecordField"
    ]);
  });

  it("rejects ambiguous contextual record unions instead of applying width subtyping", () => {
    const model = bind([
      "type Choice = { value: Number } | { value: String }",
      "let source = true",
      "let invalid: Choice = { value: source }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.ambiguousRecordUnion",
      "rsgl.typeMismatch"
    ]);
  });

  it("checks finite computed fields and rejects non-finite keys on closed records", () => {
    const model = bind([
      "type Named = { name: String }",
      "let finiteKey: \"name\" = \"name\"",
      "let valid: Named = { [finiteKey]: \"ok\" }",
      "let unknownKey: \"extra\" = \"extra\"",
      "let invalid: Named = { [unknownKey]: \"bad\" }",
      "let dynamicKey: String = \"name\"",
      "let dynamic: Named = { [dynamicKey]: \"bad\" }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.excessRecordField",
      "rsgl.missingRecordField",
      "rsgl.dynamicRecordKeyRequiresFiniteDomain",
      "rsgl.missingRecordField"
    ]);
  });

  it("retains literal types in discriminated record fields", () => {
    const model = bind([
      "type State = { kind: \"active\" | \"inactive\" }",
      "let active: State = { kind: \"active\" }",
      "let invalid: State = { kind: \"other\" }"
    ]);

    assert.deepStrictEqual(codes(model), ["rsgl.typeMismatch"]);
    const kind = model.scope.typeAliases.get("State")?.type?.properties?.get("kind")?.type;
    assert.strictEqual(kind ? formatType(kind) : "", "\"active\" | \"inactive\"");
  });

  it("diagnoses duplicate and circular aliases even when they are unused", () => {
    const model = bind([
      "type Duplicate = { first: String }",
      "type Duplicate = { second: String }",
      "type A = B",
      "type B = List<A>"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.duplicateTypeAlias",
      "rsgl.circularTypeAlias",
      "rsgl.circularTypeAlias"
    ]);
  });

  it("reports unknown type names and a local self-cycle exactly once", () => {
    const model = bind([
      "let value: Bogus = 1",
      "type Recursive = { next: Recursive }"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.circularTypeAlias",
      "rsgl.unknownType"
    ]);
    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.circularTypeAlias").length,
      1
    );
    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.unknownType").length,
      1
    );
  });

  it("narrows finite-key symbols only when has resolves to the builtin", () => {
    const model = bind([
      "type Entry = { top?: String }",
      "let record: Entry = {}",
      "let key: \"top\" = \"top\"",
      "if has(record, key) { let finiteSafe: String = record.top }",
      "type Pair = { top?: String; bottom?: String }",
      "let pair: Pair = {}",
      "let multiKey: \"top\" | \"bottom\" = true ? \"top\" : \"bottom\"",
      "if has(pair, multiKey) { let multiKeyStillUnsafe = pair.top }",
      "model block shadow_has {",
      "  let has = (object, field) => true",
      "  if has(record, key) { let shadowUnsafe = record.top }",
      "}"
    ]);

    assert.deepStrictEqual(codes(model), [
      "rsgl.optionalFieldMayBeMissing",
      "rsgl.optionalFieldMayBeMissing"
    ]);
    assert.strictEqual(model.symbols.find(symbol => symbol.name === "finiteSafe")?.type.kind, "String");
  });

  it("keeps dynamic-key objects open", () => {
    const model = bind([
      "let key = \"future\"",
      "let value = 1",
      "let dynamic: Json = { [key]: value }"
    ]);

    assert.deepStrictEqual(codes(model), []);
  });
});

function bind(lines: string[]): RsglSemanticModel {
  return bindRsglModule(parseRsgl(lines.join("\n")));
}

function codes(model: RsglSemanticModel): string[] {
  return model.diagnostics.map(diagnostic => diagnostic.code);
}

function parseExpression(source: string) {
  const statement = parseRsgl(`let result = ${source}`).statements[0];
  assert.ok(statement?.kind === "LetDecl");
  return statement.value;
}

function narrowingScope(candidateType: RsglType): RsglScope {
  return {
    kind: "global",
    typeAliases: new Map(),
    symbols: new Map([
      ["has", {
        name: "has",
        kind: "builtin",
        type: { kind: "Function" }
      }],
      ["candidate", {
        name: "candidate",
        kind: "variable",
        type: candidateType
      }]
    ])
  };
}
