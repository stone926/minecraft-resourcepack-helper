import * as assert from "node:assert";
import * as path from "node:path";
import { createProgramCompileEnvironments } from "../../src/compiler/environment";
import { parseRsgl } from "../../src/parser";
import { bindRsglModule, bindRsglProgram } from "../../src/semantic";
import {
  compileSourceWithUncheckedExterns,
  expectNoDiagnostics,
  unitByPath
} from "./helpers/compile";

describe("RSGL Function-typed let values", () => {
  it("contextually types annotated lambda parameters", () => {
    const model = bindRsglModule(parseRsgl([
      "let parseLength: (String) -> Number = text => 1",
      "let parsed = parseLength(\"stone\")"
    ].join("\n")));
    const parameter = model.symbols.find(symbol =>
      symbol.kind === "parameter" && symbol.name === "text"
    );

    assert.deepStrictEqual(model.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(parameter?.kind, "parameter");
    assert.strictEqual(parameter?.type.kind, "String");
    assert.strictEqual(model.scope.symbols.get("parseLength")?.type.kind, "Function");
    assert.strictEqual(model.scope.symbols.get("parseLength")?.signature?.returnType.kind, "Number");
  });

  it("reports a contextual lambda body return mismatch precisely", () => {
    const source = "let parseLength: (String) -> Number = text => text";
    const model = bindRsglModule(parseRsgl(source));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.lambdaReturnTypeMismatch"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /Number/);
    assert.match(diagnostics[0].message, /String/);
    assert.strictEqual(
      model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.typeMismatch"),
      false,
      "the contextual checker should own the return diagnostic instead of adding a generic outer mismatch"
    );
  });

  it("reports annotated lambda arity mismatches", () => {
    const model = bindRsglModule(parseRsgl(
      "let choose: (String) -> String = (left, right) => left"
    ));

    assert.deepStrictEqual(
      model.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.lambdaArityMismatch"]
    );
    assert.strictEqual(model.scope.symbols.get("choose")?.signature, undefined);
  });

  it("rejects duplicate lambda parameter names", () => {
    const model = bindRsglModule(parseRsgl(
      "let duplicate: (Number, Number) -> Number = (value, value) => value"
    ));

    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.duplicateLambdaParameter").length,
      1
    );
    assert.strictEqual(
      model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.duplicateSymbol"),
      false,
      "lambda parameters use their dedicated diagnostic"
    );
  });

  it("reports wrong call arguments at the argument and wrong arity at the call", () => {
    const source = [
      "let parseLength: (String) -> Number = text => 1",
      "let wrongType = parseLength(true)",
      "let wrongArity = parseLength()"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const argumentMismatch = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.lambdaArgumentTypeMismatch"
    );
    const arityMismatch = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.lambdaArityMismatch"
    );

    assert.strictEqual(argumentMismatch.length, 1);
    assert.strictEqual(source.slice(argumentMismatch[0].range.start, argumentMismatch[0].range.end), "true");
    assert.match(argumentMismatch[0].message, /String/);
    assert.match(argumentMismatch[0].message, /true/);
    assert.strictEqual(arityMismatch.length, 1);
    assert.strictEqual(
      source.slice(arityMismatch[0].range.start, arityMismatch[0].range.end),
      "parseLength()"
    );
  });

  it("checks Function assignability across both parameters and return values", () => {
    const wrongParameter = bindRsglModule(parseRsgl([
      "let textIdentity: (String) -> String = value => value",
      "let numberIdentity: (Number) -> String = textIdentity"
    ].join("\n")));
    const wrongReturn = bindRsglModule(parseRsgl([
      "let textLength: (String) -> Number = value => 1",
      "let textIdentity: (String) -> String = textLength"
    ].join("\n")));

    assert.strictEqual(
      wrongParameter.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.typeMismatch").length,
      1,
      "a Function with an incompatible parameter type must not be assignable"
    );
    assert.strictEqual(
      wrongReturn.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.typeMismatch").length,
      1,
      "a Function with an incompatible return type must not be assignable"
    );
  });

  it("supports positional and named calls for a concrete let signature", () => {
    const result = compileSourceWithUncheckedExterns([
      "let choose: (String, Boolean) -> String = (value, enabled) => enabled ? value : \"disabled\"",
      "model block lambda_calls {",
      "  merge {",
      "    positional: choose(\"left\", false)",
      "    named: choose(enabled: true, value: \"right\")",
      "  }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/lambda_calls.json").content, {
      positional: "disabled",
      named: "right"
    });
  });

  it("rejects named arguments for an anonymous Function type", () => {
    const source = [
      "template invoke(callback: (Number) -> Number) {",
      "  let result = callback(input: 1)",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.namedArgumentsRequireSignature"
    );

    assert.strictEqual(diagnostics.length, 1);
  });

  it("infers local unannotated lambdas as callable values", () => {
    const result = compileSourceWithUncheckedExterns([
      "model block local_lambda {",
      "  let identity = value => value",
      "  merge { result: identity(\"kept\") }",
      "}"
    ]);

    expectNoDiagnostics(result);
    assert.deepStrictEqual(unitByPath(result, "models/block/local_lambda.json").content, {
      result: "kept"
    });
  });

  it("does not add outer lambda diagnostics for optional or list element errors", () => {
    const optional = bindRsglModule(parseRsgl([
      "type Entry = { value?: String }",
      "let read: (Entry) -> String = item => item.value"
    ].join("\n")));
    const listBody = bindRsglModule(parseRsgl(
      "let build: (Number) -> List<String> = value => [\"ok\", value]"
    ));
    const listArgument = bindRsglModule(parseRsgl([
      "let consume: (List<String>) -> String = values => \"ok\"",
      "let result = consume([\"ok\", 1])"
    ].join("\n")));

    assert.deepStrictEqual(
      optional.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.optionalFieldMayBeMissing"]
    );
    assert.deepStrictEqual(
      listBody.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.typeMismatch"]
    );
    assert.deepStrictEqual(
      listArgument.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.typeMismatch"]
    );
  });
});

describe("RSGL let-lambda capture, recursion, and purity rules", () => {
  it("rejects direct recursion", () => {
    const model = bindRsglModule(parseRsgl(
      "let recurse: (Number) -> Number = value => recurse(value)"
    ));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.recursiveLambdaValue"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /recurse/);
  });

  it("rejects indirect recursion and reports the complete cycle once", () => {
    const model = bindRsglModule(parseRsgl([
      "let first: (Number) -> Number = value => second(value)",
      "let second: (Number) -> Number = value => first(value)"
    ].join("\n")));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.recursiveLambdaValue"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.match(diagnostics[0].message, /first/);
    assert.match(diagnostics[0].message, /second/);
  });

  it("rejects captures of values declared after the lambda", () => {
    const source = [
      "let decorate: (String) -> String = value => `${suffix}/${value}`",
      "let suffix = \"later\""
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidLambdaCapture"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(source.slice(diagnostics[0].range.start, diagnostics[0].range.end), "suffix");
  });

  it("rejects later-value captures hidden inside nested lambdas", () => {
    const source = [
      "let outer: (Number) -> (Number) -> Number = x => y => later",
      "let later = 1"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidLambdaCapture"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(source.slice(diagnostics[0].range.start, diagnostics[0].range.end), "later");
  });

  it("does not confuse nested lambda parameters with later top-level values", () => {
    const model = bindRsglModule(parseRsgl([
      "let outer: (Number) -> (Number) -> Number = x => later => later",
      "let later = 1"
    ].join("\n")));

    assert.strictEqual(
      model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidLambdaCapture"),
      false
    );
  });

  it("finds direct and indirect recursion hidden inside nested lambdas", () => {
    const direct = bindRsglModule(parseRsgl(
      "let recurse: (Number) -> Number = value => (inner => recurse(inner))(value)"
    ));
    const indirect = bindRsglModule(parseRsgl([
      "let first: (Number) -> Number = value => (inner => second(inner))(value)",
      "let second: (Number) -> Number = value => (inner => first(inner))(value)"
    ].join("\n")));

    assert.deepStrictEqual(
      direct.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.recursiveLambdaValue"]
    );
    assert.deepStrictEqual(
      indirect.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.recursiveLambdaValue"]
    );
    assert.match(indirect.diagnostics[0].message, /first/);
    assert.match(indirect.diagnostics[0].message, /second/);
  });

  it("analyzes lambdas wrapped by list, object, call, and conditional expressions", () => {
    const recursiveSources = [
      "let wrapped = [value => wrapped][0]",
      "let wrapped = { callback: value => wrapped }",
      "let wrapped = (identity => identity)(value => wrapped)",
      "let wrapped = true ? (value => wrapped) : (value => value)"
    ];
    const captureSources = [
      "let wrapped = [value => later][0]\nlet later = 1",
      "let wrapped = { callback: value => later }\nlet later = 1",
      "let wrapped = (identity => identity)(value => later)\nlet later = 1",
      "let wrapped = true ? (value => later) : (value => value)\nlet later = 1"
    ];

    for (const source of recursiveSources) {
      const codes = bindRsglModule(parseRsgl(source)).diagnostics.map(diagnostic => diagnostic.code);
      assert.deepStrictEqual(codes, ["rsgl.recursiveLambdaValue"], source);
    }
    for (const source of captureSources) {
      const codes = bindRsglModule(parseRsgl(source)).diagnostics.map(diagnostic => diagnostic.code);
      assert.deepStrictEqual(codes, ["rsgl.invalidLambdaCapture"], source);
    }
  });

  it("upgrades an inline call-argument capture without hiding ordinary forward references", () => {
    const inlineSource = [
      "template consume(mapper: (Number) -> Number) -> model {",
      "  merge { result: mapper(1) }",
      "}",
      "model block inline_capture {",
      "  use consume(mapper: value => later)",
      "  let later = 1",
      "}"
    ].join("\n");
    const inlineModel = bindRsglModule(parseRsgl(inlineSource));
    const ordinaryModel = bindRsglModule(parseRsgl([
      "model block ordinary_forward {",
      "  let early = later",
      "  let later = 1",
      "}"
    ].join("\n")));

    assert.deepStrictEqual(
      inlineModel.diagnostics.map(diagnostic => diagnostic.code),
      ["rsgl.invalidLambdaCapture"]
    );
    assert.strictEqual(
      ordinaryModel.diagnostics.some(diagnostic => diagnostic.code === "rsgl.invalidLambdaCapture"),
      false
    );
    assert.strictEqual(
      ordinaryModel.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"),
      true
    );
  });

  it("enforces wrapped-lambda recursion in every statement-list body", () => {
    const sources = new Map<string, string>([
      ["block", "if true {\n  let wrapped = [value => wrapped][0]\n}"],
      ["resource", "model block probe {\n  let wrapped = [value => wrapped][0]\n}"],
      ["variants template", "template probe() -> variants {\n  let wrapped = [value => wrapped][0]\n}"],
      ["multipart template", "template probe() -> multipart {\n  let wrapped = [value => wrapped][0]\n}"],
      ["variants root", "blockstate variants probe {\n  let wrapped = [value => wrapped][0]\n}"],
      ["multipart root", "blockstate multipart probe {\n  let wrapped = [value => wrapped][0]\n}"],
      ["resource if", [
        "model block probe {",
        "  if true {",
        "    let wrapped = [value => wrapped][0]",
        "  }",
        "}"
      ].join("\n")],
      ["resource for", [
        "model block probe {",
        "  for index in [0] {",
        "    let wrapped = [value => wrapped][0]",
        "  }",
        "}"
      ].join("\n")]
    ]);

    for (const [label, source] of sources) {
      const codes = bindRsglModule(parseRsgl(source)).diagnostics.map(diagnostic => diagnostic.code);
      assert.deepStrictEqual(codes, ["rsgl.recursiveLambdaValue"], label);
    }
  });

  it("enforces wrapped-lambda forward capture in every statement-list body", () => {
    const localBody = [
      "  let wrapped = { callback: value => later }",
      "  let later = 1"
    ].join("\n");
    const sources = new Map<string, string>([
      ["block", `if true {\n${localBody}\n}`],
      ["resource", `model block probe {\n${localBody}\n}`],
      ["variants template", `template probe() -> variants {\n${localBody}\n}`],
      ["multipart template", `template probe() -> multipart {\n${localBody}\n}`],
      ["variants root", `blockstate variants probe {\n${localBody}\n}`],
      ["multipart root", `blockstate multipart probe {\n${localBody}\n}`],
      ["resource if", [
        "model block probe {",
        "  if true {",
        "    let wrapped = { callback: value => later }",
        "    let later = 1",
        "  }",
        "}"
      ].join("\n")],
      ["resource for", [
        "model block probe {",
        "  for index in [0] {",
        "    let wrapped = { callback: value => later }",
        "    let later = 1",
        "  }",
        "}"
      ].join("\n")]
    ]);

    for (const [label, source] of sources) {
      const codes = bindRsglModule(parseRsgl(source)).diagnostics.map(diagnostic => diagnostic.code);
      assert.deepStrictEqual(codes, ["rsgl.invalidLambdaCapture"], label);
    }
  });

  it("uses dedicated recursion diagnostics for resource-body lambdas", () => {
    const model = bindRsglModule(parseRsgl([
      "model block local_recursion {",
      "  let recurse: (Number) -> Number = value => recurse(value)",
      "}"
    ].join("\n")));
    const codes = model.diagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.recursiveLambdaValue").length, 1);
    assert.strictEqual(codes.includes("rsgl.undefinedSymbol"), false);
    assert.strictEqual(codes.includes("rsgl.notCallable"), false);
  });

  it("uses dedicated forward-capture diagnostics for resource-body lambdas", () => {
    const source = [
      "model block local_capture {",
      "  let decorate: (String) -> String = value => `${suffix}/${value}`",
      "  let suffix = \"later\"",
      "}"
    ].join("\n");
    const model = bindRsglModule(parseRsgl(source));
    const captures = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.invalidLambdaCapture"
    );

    assert.strictEqual(captures.length, 1);
    assert.strictEqual(source.slice(captures[0].range.start, captures[0].range.end), "suffix");
    assert.strictEqual(
      model.diagnostics.some(diagnostic => diagnostic.code === "rsgl.undefinedSymbol"),
      false
    );
  });

  it("allows captures of previous immutable values, imports, and pure builtins", () => {
    const libraryFile = path.resolve("pack", "capture-values.rsgl");
    const mainFile = path.resolve("pack", "capture-main.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl([
          "let importedPrefix = \"imported\"",
          "export { importedPrefix }"
        ].join("\n"))
      },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { importedPrefix } from \"./capture-values.rsgl\"",
          "let localPrefix = \"local\"",
          "let fromPrevious: (String) -> String = value => `${localPrefix}/${value}`",
          "let fromImport: (String) -> String = value => `${importedPrefix}/${value}`",
          "let fromBuiltin: (String) -> Number = direction => yaw(direction)"
        ].join("\n"))
      }
    ]);

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
  });

  it("rejects IO builtins inside pure lambdas", () => {
    const model = bindRsglModule(parseRsgl(
      "let load: (String) -> Json = pattern => glob(pattern)"
    ));

    assert.strictEqual(
      model.diagnostics.filter(diagnostic => diagnostic.code === "rsgl.lambdaImpureCall").length,
      1
    );
  });
});

describe("RSGL let-lambda module APIs", () => {
  it("warns for an unannotated lambda in an explicit local named export", () => {
    const model = bindRsglModule(parseRsgl([
      "let callback = value => value",
      "export { callback }"
    ].join("\n")), { fileName: path.resolve("pack", "local-export.rsgl") });
    const diagnostics = model.diagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.exportedLambdaNeedsTypeAnnotation"
    );

    assert.strictEqual(diagnostics.length, 1);
    assert.strictEqual(diagnostics[0].severity, "warning");
  });

  it("warns at an explicit named re-export of an unannotated lambda", () => {
    const libraryFile = path.resolve("pack", "untyped-library.rsgl");
    const barrelFile = path.resolve("pack", "untyped-barrel.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl("let callback = value => value\nexport { callback }")
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { callback as exposed } from \"./untyped-library.rsgl\"")
      }
    ]);
    const diagnostics = program.fileDiagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.exportedLambdaNeedsTypeAnnotation"
    );

    assert.strictEqual(diagnostics.length, 2);
    assert.ok(diagnostics.some(diagnostic => diagnostic.fileName === libraryFile));
    assert.ok(diagnostics.some(diagnostic => diagnostic.fileName === barrelFile));
    assert.ok(diagnostics.every(diagnostic => diagnostic.severity === "warning"));
  });

  it("warns for the equivalent import-then-local-export form", () => {
    const libraryFile = path.resolve("pack", "untyped-import-library.rsgl");
    const barrelFile = path.resolve("pack", "untyped-import-barrel.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl("let callback = value => value\nexport { callback }")
      },
      {
        fileName: barrelFile,
        module: parseRsgl([
          "import { callback } from \"./untyped-import-library.rsgl\"",
          "export { callback }"
        ].join("\n"))
      }
    ]);
    const diagnostics = program.fileDiagnostics.filter(diagnostic =>
      diagnostic.code === "rsgl.exportedLambdaNeedsTypeAnnotation"
    );

    assert.strictEqual(diagnostics.length, 2);
    assert.ok(diagnostics.some(diagnostic => diagnostic.fileName === libraryFile));
    assert.ok(diagnostics.some(diagnostic => diagnostic.fileName === barrelFile));
    assert.ok(diagnostics.every(diagnostic => diagnostic.severity === "warning"));
  });

  it("does not require annotations for module-private lambdas", () => {
    const model = bindRsglModule(parseRsgl("let callback = value => value"));

    assert.strictEqual(
      model.diagnostics.some(diagnostic =>
        diagnostic.code === "rsgl.exportedLambdaNeedsTypeAnnotation"
      ),
      false
    );
  });

  it("preserves lambda parameter names and types through import and re-export", () => {
    const libraryFile = path.resolve("pack", "signatures.rsgl");
    const barrelFile = path.resolve("pack", "signature-barrel.rsgl");
    const mainFile = path.resolve("pack", "signature-main.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl([
          "let route: (String, Boolean) -> String = (resourcePath, enabled) => resourcePath",
          "export { route }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { route as routed } from \"./signatures.rsgl\"")
      },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { routed } from \"./signature-barrel.rsgl\"",
          "let resolved = routed(enabled: true, resourcePath: \"minecraft:block/stone\")"
        ].join("\n"))
      }
    ]);
    const mainModel = program.models.find(model => model.fileName === mainFile);
    const imported = mainModel?.scope.symbols.get("routed");

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(imported?.kind, "import");
    assert.deepStrictEqual(
      imported?.signature?.parameters.map(parameter => [parameter.name, parameter.type.kind]),
      [["resourcePath", "String"], ["enabled", "Boolean"]]
    );
    assert.strictEqual(imported?.signature?.returnType.kind, "String");
  });

  it("does not publish an invalid annotated arity as an import signature", () => {
    const libraryFile = path.resolve("pack", "invalid-signature.rsgl");
    const barrelFile = path.resolve("pack", "invalid-signature-barrel.rsgl");
    const mainFile = path.resolve("pack", "invalid-signature-main.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl([
          "let invalid: (String) -> Number = (left, right) => left",
          "export { invalid }"
        ].join("\n"))
      },
      {
        fileName: barrelFile,
        module: parseRsgl("export { invalid as forwarded } from \"./invalid-signature.rsgl\"")
      },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { forwarded } from \"./invalid-signature-barrel.rsgl\"",
          "let result = forwarded(left: \"stone\")"
        ].join("\n"))
      }
    ]);
    const imported = program.models
      .find(model => model.fileName === mainFile)
      ?.scope.symbols.get("forwarded");
    const codes = program.fileDiagnostics.map(diagnostic => diagnostic.code);

    assert.strictEqual(codes.filter(code => code === "rsgl.lambdaArityMismatch").length, 1);
    assert.strictEqual(codes.filter(code => code === "rsgl.namedArgumentsRequireSignature").length, 1);
    assert.strictEqual(codes.includes("rsgl.lambdaReturnTypeMismatch"), false);
    assert.strictEqual(imported?.signature, undefined);
  });

  it("evaluates an imported closure with its definition values exactly once", () => {
    const libraryFile = path.resolve("pack", "runtime-closure.rsgl");
    const mainFile = path.resolve("pack", "runtime-main.rsgl");
    const program = bindRsglProgram([
      {
        fileName: libraryFile,
        module: parseRsgl([
          "let prefix = glob(\"closure-probe\")[0]",
          "let decorate: (String) -> String = value => `${prefix}/${value}`",
          "export { decorate }"
        ].join("\n"))
      },
      {
        fileName: mainFile,
        module: parseRsgl([
          "import { decorate } from \"./runtime-closure.rsgl\"",
          "let result = decorate(value: \"stone\")"
        ].join("\n"))
      }
    ]);
    let globCalls = 0;
    const environments = createProgramCompileEnvironments(
      program,
      { namespaceOverride: undefined, defaultNamespace: "minecraft" },
      {
        globLoader: () => {
          globCalls += 1;
          return ["captured"];
        }
      }
    );
    const mainEnvironment = environments.get(path.normalize(mainFile));

    assert.deepStrictEqual(program.diagnostics.map(diagnostic => diagnostic.code), []);
    assert.strictEqual(globCalls, 1, "the captured definition value must be evaluated once per module environment");
    assert.strictEqual(mainEnvironment?.localValueBindings.get("result")?.value, "captured/stone");
  });
});
