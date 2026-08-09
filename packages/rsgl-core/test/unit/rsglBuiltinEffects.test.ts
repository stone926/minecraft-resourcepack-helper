import * as assert from "node:assert/strict";
import { createBuiltinSymbols, builtinEffects } from "../../src/semantic/builtins";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule } from "../../src/semantic";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  unitByPath
} from "./helpers/compile";

describe("RSGL builtin effect metadata", () => {
  it("classifies every callable builtin in the central registry", () => {
    const callables = createBuiltinSymbols().filter(symbol => symbol.signature);

    assert.ok(callables.length > 0);
    assert.ok(callables.every(symbol => symbol.effect === "pure" || symbol.effect === "io"));
    assert.strictEqual(builtinEffects.size, callables.length);
    for (const symbol of callables) {
      assert.strictEqual(builtinEffects.get(symbol.name), symbol.effect, symbol.name);
    }
    assert.strictEqual(callables.find(symbol => symbol.name === "has")?.effect, "pure");
    assert.deepStrictEqual(
      callables.filter(symbol => symbol.effect === "io").map(symbol => symbol.name),
      ["glob"]
    );
  });

  it("reports a resolved IO builtin call", () => {
    const model = bindRsglModule(parseRsgl(
      "let load: (String) -> Json = pattern => glob(pattern)"
    ));

    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaImpureCall").length,
      1
    );
  });

  it("does not classify same-named values or lambda parameters as builtins", () => {
    const result = compileSourceWithUncheckedExterns([
      "let glob: (String) -> String = value => `value/${value}`",
      "let fromValue: (String) -> String = value => glob(value)",
      "let invoke: ((String) -> String) -> String = glob => glob(\"parameter\")",
      "let fromParameter = invoke(value => `argument/${value}`)",
      "model block effect_shadowing {",
      "  merge {",
      "    from_value: fromValue(\"kept\")",
      "    from_parameter: fromParameter",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/effect_shadowing.json").content, {
      from_value: "value/kept",
      from_parameter: "argument/parameter"
    });
  });

  it("assigns nested lambda effects to the nested lambda only", () => {
    const source = "let outer = value => (inner => glob(inner))";
    const model = bindRsglModule(parseRsgl(source));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.lambdaImpureCall"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(
      source.slice(diagnostics[0].range.start, diagnostics[0].range.end),
      "glob"
    );
  });
});
