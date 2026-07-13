import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { isJsonObject } from "../../src/compiler/jsonValues";

describe("RSGL JSON value helpers", () => {
  it("recognizes JSON objects without accepting arrays or compiler lambdas", () => {
    assert.strictEqual(isJsonObject({ value: 1 }), true);
    assert.strictEqual(isJsonObject({ kind: "text", text: "hello" }), true);
    assert.strictEqual(isJsonObject({ kind: "lambda" }), true);
    assert.strictEqual(isJsonObject({
      kind: "lambda",
      parameters: [],
      body: { kind: "LiteralExpr" },
      context: {},
      impureCalls: []
    }), false);
    assert.strictEqual(isJsonObject([]), false);
    assert.strictEqual(isJsonObject(null), false);
  });

  it("keeps one object-classification implementation across the compiler", () => {
    const compilerDirectory = path.join(process.cwd(), "packages", "rsgl-core", "src", "compiler");
    const definition = /(?:export\s+)?function\s+(?:isJsonObject|isJsonObjectValue|isObject)\s*\(/g;
    const definitions = fs.readdirSync(compilerDirectory)
      .filter(fileName => fileName.endsWith(".ts"))
      .flatMap(fileName => [...fs.readFileSync(path.join(compilerDirectory, fileName), "utf8").matchAll(definition)]
        .map(() => fileName));

    assert.deepStrictEqual(definitions, ["jsonValues.ts"]);
  });
});
