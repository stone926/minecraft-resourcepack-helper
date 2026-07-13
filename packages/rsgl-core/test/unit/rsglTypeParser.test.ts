import * as assert from "node:assert";
import { parseRsgl, walkRsglModule } from "../../src/parser";

describe("RSGL type parser", () => {
  it("parses structural aliases with optional and recursively nested field types", () => {
    const source = [
      "type CropFamily = {",
      "  name: String",
      "  maxAge: Number,",
      "  metadata?: {",
      "    tags: List<\"crop\" | \"plant\">",
      "    transform?: (String | Number) -> List<Json>",
      "  }",
      "}",
      "let families: List<CropFamily> = []"
    ].join("\n");
    const module = parseRsgl(source);

    assert.deepStrictEqual(module.diagnostics, []);
    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "LetDecl"]);
    const alias = module.statements[0];
    assert.strictEqual(alias.kind, "TypeAliasDecl");
    if (alias.kind !== "TypeAliasDecl") {
      return;
    }
    assert.strictEqual(alias.name?.text, "CropFamily");
    assert.strictEqual(alias.typeAnnotation.kind, "ObjectType");
    if (alias.typeAnnotation.kind !== "ObjectType") {
      return;
    }
    assert.deepStrictEqual(
      alias.typeAnnotation.properties.map(property => [property.name?.text, property.optional]),
      [["name", false], ["maxAge", false], ["metadata", true]]
    );

    const metadata = alias.typeAnnotation.properties[2].typeAnnotation;
    assert.strictEqual(metadata.kind, "ObjectType");
    if (metadata.kind !== "ObjectType") {
      return;
    }
    assert.deepStrictEqual(
      metadata.properties.map(property => [property.name?.text, property.optional]),
      [["tags", false], ["transform", true]]
    );
    const tags = metadata.properties[0].typeAnnotation;
    assert.strictEqual(tags.kind, "GenericType");
    assert.strictEqual(tags.kind === "GenericType" ? tags.name.text : "", "List");
    assert.strictEqual(tags.kind === "GenericType" ? tags.args[0].kind : "", "UnionType");
    const transform = metadata.properties[1].typeAnnotation;
    assert.strictEqual(transform.kind, "FunctionType");
    if (transform.kind === "FunctionType") {
      assert.strictEqual(transform.parameters[0].kind, "UnionType");
      assert.strictEqual(transform.returnType.kind, "GenericType");
    }

    const families = module.statements[1];
    assert.strictEqual(families.kind, "LetDecl");
    assert.strictEqual(families.kind === "LetDecl" ? families.typeAnnotation?.kind : "", "GenericType");
  });

  it("keeps malformed field recovery local to the record", () => {
    const module = parseRsgl("type Broken = { name String, next?: Number }\nlet after = 1");

    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "LetDecl"]);
    assert.ok(module.diagnostics.some(diagnostic => diagnostic.message.includes("Expected ':' after object type field name")));
    const alias = module.statements[0];
    assert.strictEqual(alias.kind, "TypeAliasDecl");
    if (alias.kind === "TypeAliasDecl" && alias.typeAnnotation.kind === "ObjectType") {
      assert.deepStrictEqual(alias.typeAnnotation.properties.map(property => property.name?.text), ["name", "next"]);
      assert.strictEqual(alias.typeAnnotation.properties[1].optional, true);
    }
  });

  it("does not consume the next declaration when a record is missing its closing brace", () => {
    const module = parseRsgl("type Broken = { name: String\nlet after = 1");

    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "LetDecl"]);
    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedClosingBrace"));
  });

  it("does not consume the next declaration after an incomplete field function type", () => {
    const module = parseRsgl("type Broken = { handler: (String\nlet after = 1");

    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "LetDecl"]);
    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedClosingParen"));
    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.expectedClosingBrace"));
  });

  it("rejects the internal Missing sentinel without consuming the next declaration", () => {
    const module = parseRsgl("type Invalid = { value: Missing }\nlet after = 1");

    assert.deepStrictEqual(module.statements.map(statement => statement.kind), ["TypeAliasDecl", "LetDecl"]);
    assert.deepStrictEqual(module.diagnostics.map(diagnostic => diagnostic.code), ["rsgl.internalMissingType"]);
    const alias = module.statements[0];
    assert.strictEqual(alias.kind, "TypeAliasDecl");
    if (alias.kind === "TypeAliasDecl" && alias.typeAnnotation.kind === "ObjectType") {
      assert.strictEqual(alias.typeAnnotation.properties[0].typeAnnotation.kind, "MissingType");
    }
  });

  it("keeps type aliases module-scoped", () => {
    const module = parseRsgl("if true { type Nested = { value: String } }");

    assert.ok(module.diagnostics.some(diagnostic => diagnostic.code === "rsgl.typeAliasMustBeTopLevel"));
    const conditional = module.statements[0];
    assert.strictEqual(conditional.kind, "IfStmt");
    if (conditional.kind === "IfStmt" && conditional.thenBody.kind === "Block") {
      assert.strictEqual(conditional.thenBody.statements[0].kind, "TypeAliasDecl");
    }
  });

  it("walks alias bodies and annotations through the type visitor", () => {
    const module = parseRsgl([
      "type Payload = { handler?: (String | Number) -> List<{ value: Json }> }",
      "let values: List<Payload> = []"
    ].join("\n"));
    const types: string[] = [];

    walkRsglModule(module, {
      enterType(type) {
        types.push(type.kind);
      }
    });

    assert.deepStrictEqual(types, [
      "ObjectType",
      "FunctionType",
      "UnionType",
      "NamedType",
      "NamedType",
      "GenericType",
      "ObjectType",
      "NamedType",
      "GenericType",
      "NamedType"
    ]);
  });
});
