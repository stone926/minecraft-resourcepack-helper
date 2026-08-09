import * as assert from "node:assert/strict";
import { inferRsglToolingExpressionType } from "../../src/memberTypeResolver";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";

describe("RSGL operator result typing", () => {
  for (const operator of ["<", "<=", ">", ">="]) {
    it(`types '${operator}' as Boolean in semantic and tooling paths`, () => {
      const module = parseRsgl([
        `let predicate: (Number) -> Boolean = value => value ${operator} 0`,
        `let result = 1 ${operator} 2`
      ].join("\n"));
      const model = bindRsglModule(module);
      const resultDeclaration = module.statements.find(statement =>
        statement.kind === "LetDecl" && statement.name?.text === "result"
      );

      assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
      assert.ok(resultDeclaration?.kind === "LetDecl");
      assert.strictEqual(
        inferRsglToolingExpressionType(model, resultDeclaration.value).kind,
        "Boolean"
      );
    });
  }
});
