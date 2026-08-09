import * as assert from "node:assert/strict";
import { parseRsgl, type ModelTransformStmtNode } from "../../src/parser";

describe("RSGL geometry transform parser", () => {
  it("parses explicit axes, angles, pivots, and nested model-dialect bodies", () => {
    const module = parseRsgl([
      "model block transformed {",
      "  transform rotate_x(90) around [8, 8, 8] {",
      "    element from [0, 0, 0] to [16, 1, 16] { up texture \"#top\" }",
      "  }",
      "  transform rotate_y(180) around pivot {",
      "    use panel()",
      "  }",
      "  transform rotate_z(270) around [8, 8, 8] {",
      "    for copy in [0] {",
      "      if true {",
      "        transform rotate_y(copy * 90) around [8, 8, 8] {",
      "          element from [1, 2, 3] to [4, 5, 6] { north texture \"#side\" }",
      "        }",
      "      }",
      "    }",
      "  }",
      "}"
    ].join("\n"));

    assert.deepStrictEqual(module.diagnostics, []);
    const resource = module.statements[0];
    assert.strictEqual(resource.kind, "ResourceDecl");
    if (resource.kind !== "ResourceDecl") {
      return;
    }
    const transforms = resource.body.statements as ModelTransformStmtNode[];
    assert.deepStrictEqual(transforms.map(statement => statement.kind), [
      "ModelTransformStmt",
      "ModelTransformStmt",
      "ModelTransformStmt"
    ]);
    assert.deepStrictEqual(transforms.map(statement => [statement.operation.text, statement.axis]), [
      ["rotate_x", "x"],
      ["rotate_y", "y"],
      ["rotate_z", "z"]
    ]);
    assert.deepStrictEqual(
      transforms.map(statement => statement.angle.kind === "NumberLiteral" ? statement.angle.value : null),
      [90, 180, 270]
    );
    assert.strictEqual(transforms[0].pivot.kind, "ListExpr");
    assert.strictEqual(transforms[1].pivot.kind, "IdentifierExpr");
    assert.deepStrictEqual(transforms[0].body.statements.map(statement => statement.kind), ["ModelElementStmt"]);
    assert.deepStrictEqual(transforms[1].body.statements.map(statement => statement.kind), ["UseDecl"]);
    const outerFor = transforms[2].body.statements[0];
    assert.strictEqual(outerFor.kind, "ForStmt");
    if (outerFor.kind === "ForStmt" && "statements" in outerFor.body) {
      const nestedIf = outerFor.body.statements[0];
      assert.strictEqual(nestedIf.kind, "IfStmt");
      if (nestedIf.kind === "IfStmt" && "statements" in nestedIf.thenBody) {
        assert.strictEqual(nestedIf.thenBody.statements[0].kind, "ModelTransformStmt");
      }
    }
  });

  it("keeps transform-shaped explicit fields out of the controlled statement parser", () => {
    const module = parseRsgl([
      "model block data_fields {",
      "  transform: { rotate_y: 90 }",
      "  transform = 1",
      "  rotate_x: 90",
      "  around: [8, 8, 8]",
      "}"
    ].join("\n"));
    assert.deepStrictEqual(module.diagnostics, []);
    const resource = module.statements[0];
    assert.strictEqual(resource.kind, "ResourceDecl");
    if (resource.kind === "ResourceDecl") {
      assert.deepStrictEqual(
        resource.body.statements.map(statement => statement.kind),
        ["PropertyStmt", "PropertyStmt", "PropertyStmt", "PropertyStmt"]
      );
    }
  });

  it("recovers each malformed transform without swallowing its following statement", () => {
    const module = parseRsgl([
      "template broken() -> model {",
      "  transform rotate_q(90) around [8, 8, 8] {}",
      "  transform rotate_x() around [8, 8, 8] {}",
      "  transform rotate_y(180) [8, 8, 8] {}",
      "  transform rotate_z(270) around {}",
      "  transform rotate_x(90) around [8, 8, 8]",
      "  element from [0, 0, 0] to [1, 1, 1] { north texture \"#side\" }",
      "}"
    ].join("\n"));

    const codes = module.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.invalidModelTransformOperation"));
    assert.ok(codes.includes("rsgl.expectedModelTransformAngle"));
    assert.ok(codes.includes("rsgl.expectedToken"));
    assert.ok(codes.includes("rsgl.expectedModelTransformPivot"));
    assert.ok(codes.includes("rsgl.expectedResourceBody"));
    const template = module.statements[0];
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind === "TemplateDecl" && "statements" in template.body) {
      assert.deepStrictEqual(template.body.statements.map(statement => statement.kind), [
        "ModelTransformStmt",
        "ModelTransformStmt",
        "ModelTransformStmt",
        "ModelTransformStmt",
        "ModelTransformStmt",
        "ModelElementStmt"
      ]);
    }
  });

  it("does not consume a following model statement when a transform header stops at a line boundary", () => {
    const module = parseRsgl([
      "template truncated() -> model {",
      "  transform",
      "  element from [0, 0, 0] to [1, 1, 1] { north texture \"#operation\" }",
      "  transform rotate_x(",
      "  element from [1, 0, 0] to [2, 1, 1] { north texture \"#angle\" }",
      "  transform rotate_x(90)",
      "  element from [2, 0, 0] to [3, 1, 1] { north texture \"#around\" }",
      "  transform rotate_y(180) around",
      "  element from [3, 0, 0] to [4, 1, 1] { north texture \"#pivot\" }",
      "  transform rotate_z(270) around [8, 8, 8]",
      "  element from [4, 0, 0] to [5, 1, 1] { north texture \"#body\" }",
      "}"
    ].join("\n"));

    const codes = module.diagnostics.map(diagnostic => diagnostic.code);
    assert.ok(codes.includes("rsgl.expectedIdentifier"));
    assert.ok(codes.includes("rsgl.expectedModelTransformAngle"));
    assert.ok(codes.includes("rsgl.expectedToken"));
    assert.ok(codes.includes("rsgl.expectedModelTransformPivot"));
    assert.ok(codes.includes("rsgl.expectedResourceBody"));
    const template = module.statements[0];
    assert.strictEqual(template.kind, "TemplateDecl");
    if (template.kind === "TemplateDecl" && "statements" in template.body) {
      assert.deepStrictEqual(template.body.statements.map(statement => statement.kind), [
        "ModelTransformStmt",
        "ModelElementStmt",
        "ModelTransformStmt",
        "ModelElementStmt",
        "ModelTransformStmt",
        "ModelElementStmt",
        "ModelTransformStmt",
        "ModelElementStmt",
        "ModelTransformStmt",
        "ModelElementStmt"
      ]);
    }
  });
});
