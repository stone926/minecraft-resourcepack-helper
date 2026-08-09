import * as assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import {
  formatRsglText,
  type RsglFormatOptions
} from "../../src/formatterCore";
import { lexRsgl, parseRsgl } from "../../src/parser";

describe("RSGL formatter styles", () => {
  it("applies canonical spacing and wraps collections at the configured line width", () => {
    const source =
      "let value={foo : [1,2,3],bar : call(1,2),nested : {enabled : true}}";

    assert.strictEqual(
      formatRsglText(source, { style: "canonical", lineWidth: 100 }),
      "let value = { foo: [1, 2, 3], bar: call(1, 2), nested: { enabled: true } }"
    );
    assert.strictEqual(
      formatRsglText(source, { style: "canonical", lineWidth: 40 }),
      [
        "let value = {",
        "  foo: [1, 2, 3],",
        "  bar: call(1, 2),",
        "  nested: { enabled: true }",
        "}"
      ].join("\n")
    );
  });

  it("includes indentation when applying the configured line width", () => {
    const source = [
      ...Array.from({ length: 8 }, () => "if true {"),
      "let values = [12345678901234567890, 2]",
      ...Array.from({ length: 8 }, () => "}")
    ].join("\n");
    const formatted = formatRsglText(source, { lineWidth: 40 });
    const valueLines = formatted
      .split("\n")
      .filter(line => line.includes("12345678901234567890"));

    assert.strictEqual(valueLines.length, 1);
    assert.ok(valueLines[0].length <= 40, valueLines[0]);
    assert.ok(formatted.includes("let values = [\n"));
  });

  it("uses the compact style for tight braces and no blank lines", () => {
    const source = [
      "model block demo {",
      "",
      "",
      "let palette = { primary : [1,2], secondary : [3,4] }",
      "",
      "}"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source, { style: "compact" }),
      [
        "model block demo {",
        "  let palette = {primary: [1, 2], secondary: [3, 4]}",
        "}"
      ].join("\n")
    );
  });

  it("joins same-line body braces in a single pass across removed blank lines", () => {
    const sources = [
      "if true\n\n{",
      "model block example\n\n{\n}",
      "item\n\n{\n}"
    ];

    for (const source of sources) {
      const once = formatRsglText(source, { style: "compact" });
      assert.strictEqual(formatRsglText(once, { style: "compact" }), once);
      assert.ok(!once.includes("\n{"), source);
    }
  });

  it("uses the expanded style for collections and empty bodies", () => {
    const source = [
      "let palette = { primary : [1,2], secondary : [3,4] }",
      "model block empty {}"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source, { style: "expanded" }),
      [
        "let palette = {",
        "  primary: [",
        "    1,",
        "    2",
        "  ],",
        "  secondary: [",
        "    3,",
        "    4",
        "  ]",
        "}",
        "model block empty {",
        "}"
      ].join("\n")
    );
  });

  it("moves only body braces to the next line when configured", () => {
    const source = [
      "model block demo {",
      "textures {",
      "all : minecraft:block/stone",
      "}",
      "}"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source, { braceStyle: "nextLine" }),
      [
        "model block demo",
        "{",
        "  textures",
        "  {",
        "    all: minecraft:block/stone",
        "  }",
        "}"
      ].join("\n")
    );
  });

  it("isolates next-line body braces even when the source body is inline", () => {
    assert.strictEqual(
      formatRsglText("if true { let value=1 }", {
        braceStyle: "nextLine"
      }),
      [
        "if true",
        "{",
        "  let value = 1",
        "}"
      ].join("\n")
    );
    assert.strictEqual(
      formatRsglText("model block empty {}", {
        braceStyle: "nextLine"
      }),
      [
        "model block empty",
        "{",
        "}"
      ].join("\n")
    );
  });

  it("indents with tabs when insertSpaces is disabled", () => {
    const source = [
      "model block tabs {",
      "textures {",
      "all : minecraft:block/stone",
      "}",
      "}"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source, {
        insertSpaces: false,
        tabSize: 8
      }),
      [
        "model block tabs {",
        "\ttextures {",
        "\t\tall: minecraft:block/stone",
        "\t}",
        "}"
      ].join("\n")
    );
  });

  it("preserves CRLF for source and formatter-created line breaks", () => {
    const source = [
      "let value={foo : [1,2,3],bar : call(1,2),nested : {enabled : true}}",
      "model block demo {",
      "parent minecraft:block/cube_all",
      "}"
    ].join("\r\n");

    assert.strictEqual(
      formatRsglText(source, {
        lineWidth: 40,
        braceStyle: "nextLine",
        insertFinalNewline: true
      }),
      [
        "let value = {",
        "  foo: [1, 2, 3],",
        "  bar: call(1, 2),",
        "  nested: { enabled: true }",
        "}",
        "model block demo",
        "{",
        "  parent minecraft:block/cube_all",
        "}",
        ""
      ].join("\r\n")
    );
  });

  it("uses protected multiline content as the EOL fallback", () => {
    assert.strictEqual(
      formatRsglText("let value = `first\r\nsecond`", {
        insertFinalNewline: true
      }),
      "let value = `first\r\nsecond`\r\n"
    );
    assert.strictEqual(
      formatRsglText("/* first\rsecond */", {
        insertFinalNewline: true
      }),
      "/* first\rsecond */\r"
    );
  });

  it("normalizes mixed layout EOLs once and keeps them stable", () => {
    const source = "\n0\r\n1";
    const options = {
      style: "compact" as const,
      insertFinalNewline: true
    };
    const once = formatRsglText(source, options);

    assert.strictEqual(once, "0\r\n1\r\n");
    assert.strictEqual(formatRsglText(once, options), once);
  });

  it("honors final-newline preservation, trimming, and insertion", () => {
    assert.strictEqual(formatRsglText("let value=1"), "let value = 1");
    assert.strictEqual(formatRsglText("let value=1\n"), "let value = 1\n");
    assert.strictEqual(
      formatRsglText("let value=1", { insertFinalNewline: true }),
      "let value = 1\n"
    );
    assert.strictEqual(
      formatRsglText("let value=1\n\n\n", { trimFinalNewlines: true }),
      "let value = 1"
    );
    assert.strictEqual(
      formatRsglText("let value=1\n\n\n", {
        trimFinalNewlines: true,
        insertFinalNewline: true
      }),
      "let value = 1\n"
    );
  });

  it("preserves every byte inside a multiline template string", () => {
    const templateText =
      "`first line  \r\n    ${call(  1,2 )}\n\tthird { ) // untouched`";
    const source = [
      "model block templated {",
      `let value = ${templateText}`,
      "parent minecraft:block/cube_all",
      "}"
    ].join("\n");
    const formatted = formatRsglText(source);

    assert.strictEqual(
      formatted,
      [
        "model block templated {",
        `  let value = ${templateText}`,
        "  parent minecraft:block/cube_all",
        "}"
      ].join("\n")
    );
    assert.strictEqual(templateTokenText(formatted), templateTokenText(source));
  });

  it("ignores parentheses and other delimiters inside block comments", () => {
    const source = [
      "let value = call(",
      "/* ) fake close; ( fake open; } ] { [ */",
      "1",
      ")"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source),
      [
        "let value = call(",
        "  /* ) fake close; ( fake open; } ] { [ */",
        "  1",
        ")"
      ].join("\n")
    );
  });

  it("does not dedent comments merely because a closer follows them", () => {
    assert.strictEqual(
      formatRsglText([
        "if true {",
        "/* single */ }"
      ].join("\n")),
      [
        "if true {",
        "  /* single */ }"
      ].join("\n")
    );
    assert.strictEqual(
      formatRsglText([
        "if true {",
        "/* first",
        "second */ }"
      ].join("\n")),
      [
        "if true {",
        "  /* first",
        "  second */ }"
      ].join("\n")
    );
  });

  it("keeps inline multiline comment continuations stable", () => {
    const sources = [
      "(/*\nb",
      "let value = call(/* first\n  second */ 1)"
    ];

    for (const source of sources) {
      const once = formatRsglText(source);
      assert.strictEqual(formatRsglText(once), once);
      assert.deepStrictEqual(tokenTexts(once), tokenTexts(source));
    }
  });

  it("keeps trailing line comments attached and ignores their delimiters", () => {
    const source = [
      "model block comments {",
      "parent minecraft:block/cube_all       // trailing } ] )",
      "textures { // nested opener {",
      "all : minecraft:block/stone",
      "}",
      "}"
    ].join("\n");

    assert.strictEqual(
      formatRsglText(source),
      [
        "model block comments {",
        "  parent minecraft:block/cube_all  // trailing } ] )",
        "  textures {  // nested opener {",
        "    all: minecraft:block/stone",
        "  }",
        "}"
      ].join("\n")
    );
  });

  it("wraps collections before a trailing line comment", () => {
    assert.strictEqual(
      formatRsglText(
        "let values = [1111111111, 2222222222, 3333333333] // trailing",
        { style: "expanded", lineWidth: 40 }
      ),
      [
        "let values = [",
        "  1111111111,",
        "  2222222222,",
        "  3333333333",
        "]  // trailing"
      ].join("\n")
    );
  });

  it("keeps extern glob fragments byte-for-byte intact", () => {
    const source =
      "extern   custom model   block/**/nested/*,   *:item/*";

    assert.strictEqual(
      formatRsglText(source),
      "extern custom model block/**/nested/*, *:item/*"
    );
  });

  it("preserves extern bang semantics and malformed glob boundaries", () => {
    const valid = "extern! vanilla model minecraft:block/cube_all";
    const validFormatted = formatRsglText(valid);
    assert.strictEqual(
      validFormatted,
      "extern! vanilla model minecraft:block/cube_all"
    );
    assert.deepStrictEqual(tokenTexts(validFormatted), tokenTexts(valid));
    assert.deepStrictEqual(diagnosticCodes(validFormatted), diagnosticCodes(valid));

    const malformed =
      "extern custom texture minecraft:block/wood / *";
    const malformedFormatted = formatRsglText(malformed);
    assert.deepStrictEqual(
      tokenTexts(malformedFormatted),
      tokenTexts(malformed)
    );
    assert.deepStrictEqual(
      diagnosticCodes(malformedFormatted),
      diagnosticCodes(malformed)
    );
  });

  it("does not add whitespace after trailing separators", () => {
    const sourcesAndExpected = [
      ["let list = [1,]", "let list = [1,]"],
      ["let result = call(1,)", "let result = call(1,)"],
      ["type Record = { field: String, }", "type Record = { field: String,}"]
    ] as const;

    for (const [source, expected] of sourcesAndExpected) {
      const formatted = formatRsglText(source);
      assert.strictEqual(formatted, expected);
      assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source));
    }
  });

  it("formats syntax-aware tight pairs without changing their tokens", () => {
    const sourcesAndExpected = [
      ["type Empty = Box< >", "type Empty = Box<>"],
      ["let member = value . field", "let member = value.field"],
      ["let range = 1 .. 3", "let range = 1..3"],
      ["let grouped = ( - 1 )", "let grouped = (-1)"]
    ] as const;

    for (const [source, expected] of sourcesAndExpected) {
      const formatted = formatRsglText(source);
      assert.strictEqual(formatted, expected);
      assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source));
    }
  });

  it("keeps spaces where member and range punctuation would extend a resource location", () => {
    const sources = [
      "let member = minecraft:block/stone . field",
      "let range = minecraft:block/stone .. minecraft:block/dirt",
      "let partial = minecraft:block/stone ..",
      "let dots = value .. .",
      "let ranges = value .. .."
    ];

    for (const source of sources) {
      const formatted = formatRsglText(source);
      assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source), source);
      assert.deepStrictEqual(
        diagnosticCodes(formatted),
        diagnosticCodes(source),
        source
      );
      assert.strictEqual(formatRsglText(formatted), formatted, source);
    }
  });

  it("keeps malformed token boundaries from merging", () => {
    const sources = [
      "let value = ! =",
      "let value = ! ==",
      "let value = - >",
      "let value = 1 . 2",
      "let value = . .",
      "let value = .. ."
    ];

    for (const source of sources) {
      const formatted = formatRsglText(source);
      assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source), source);
      assert.strictEqual(formatRsglText(formatted), formatted, source);
    }
  });

  it("does not throw for malformed or partially written input", () => {
    const malformedSources = [
      "model block broken {\nlet values = [1,2",
      "let value = `unterminated\n  ${value} ) }",
      "model block broken {\n/* unfinished ) ] }",
      "} ] ) model block ??? { ["
    ];

    for (const source of malformedSources) {
      let formatted: string | undefined;
      assert.doesNotThrow(() => {
        formatted = formatRsglText(source, {
          style: "expanded",
          braceStyle: "nextLine",
          insertFinalNewline: true
        });
      });
      assert.strictEqual(typeof formatted, "string");
    }
  });

  it("preserves the complete syntax-token text sequence", () => {
    const source = [
      "import * as common from \"./common.rsgl\"",
      "extern custom model block/**/nested/*, *:item/*",
      "let result = common.make({ path : minecraft:block/stone, frames : [1,2,3] })",
      "model block example {",
      "parent minecraft:block/cube_all",
      "}"
    ].join("\n");
    const formatted = formatRsglText(source, {
      style: "expanded",
      braceStyle: "nextLine",
      lineWidth: 40
    });

    assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source));
  });

  it("is idempotent for every style and representative editor options", () => {
    const source = [
      "extern custom model block/**",
      "",
      "let palette={primary : [1,2],secondary : [3,4]}",
      "model block sample{",
      "textures{",
      "all : minecraft:block/stone // keep }",
      "}",
      "}"
    ].join("\r\n");
    const configurations: Array<{
      name: string;
      options: Partial<RsglFormatOptions>;
    }> = [
      {
        name: "canonical",
        options: { style: "canonical", lineWidth: 40 }
      },
      {
        name: "compact tabs",
        options: {
          style: "compact",
          lineWidth: 40,
          insertSpaces: false,
          tabSize: 4
        }
      },
      {
        name: "expanded next-line braces",
        options: {
          style: "expanded",
          braceStyle: "nextLine",
          insertFinalNewline: true
        }
      }
    ];

    for (const configuration of configurations) {
      const once = formatRsglText(source, configuration.options);
      assert.strictEqual(
        formatRsglText(once, configuration.options),
        once,
        configuration.name
      );
    }
  });

  it("fully expands more collections than the formatter safety floor", () => {
    const propertyCount = 120;
    const source = `let value = {${
      Array.from(
        { length: propertyCount },
        (_, index) => `p${index}: [1, 2]`
      ).join(", ")
    }}`;
    const once = formatRsglText(source, {
      style: "expanded",
      lineWidth: 240
    });

    assert.strictEqual(formatRsglText(once, {
      style: "expanded",
      lineWidth: 240
    }), once);
    assert.strictEqual(
      once.split("\n").filter(line => line.trimEnd().endsWith(": [")).length,
      propertyCount
    );
  });

  it("bounds layout expansion for pathologically deep collections", function () {
    this.timeout(5_000);
    const depth = 2_400;
    const source = `${"[".repeat(depth)}1, 2${"]".repeat(depth)}`;
    const once = formatRsglText(source, {
      style: "expanded",
      lineWidth: 40
    });

    assert.ok(
      once.length < source.length * 20,
      `Unexpected ${once.length}-byte output for ${source.length}-byte input.`
    );
    assert.strictEqual(
      formatRsglText(once, { style: "expanded", lineWidth: 40 }),
      once
    );
    assert.deepStrictEqual(tokenTexts(once), tokenTexts(source));
  });

  it("bounds indentation for pre-broken pathological nesting", () => {
    const depth = 2_400;
    const source = [
      ...Array.from({ length: depth }, () => "["),
      "1",
      ...Array.from({ length: depth }, () => "]")
    ].join("\n");
    const formatted = formatRsglText(source);
    const longestLine = Math.max(
      ...formatted.split("\n").map(line => line.length)
    );

    assert.ok(longestLine <= 129, `Unexpected ${longestLine}-column line.`);
    assert.ok(formatted.length < source.length * 70);
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("formats thousands of sibling collections without quadratic rescans", function () {
    this.timeout(10_000);
    const callCount = 4_000;
    const source = `let value = ${
      Array.from({ length: callCount }, () => "call(1, 2)").join(" + ")
    }`;
    const startedAt = performance.now();
    const formatted = formatRsglText(source, {
      style: "expanded",
      lineWidth: 40
    });
    const elapsed = performance.now() - startedAt;

    assert.ok(
      elapsed < 5_000,
      `Expected breadth formatting under 5s, got ${elapsed.toFixed(1)}ms.`
    );
    assert.strictEqual(
      formatRsglText(formatted, {
        style: "expanded",
        lineWidth: 40
      }),
      formatted
    );
  });

  it("measures each wide sibling line once while selecting wraps", function () {
    this.timeout(10_000);
    const propertyCount = 4_000;
    const source = `let value = {${
      Array.from(
        { length: propertyCount },
        (_, index) => `p${index}: [${index}, ${index + 1}]`
      ).join(", ")
    }}`;
    const startedAt = performance.now();
    const formatted = formatRsglText(source, {
      style: "canonical",
      lineWidth: 40
    });
    const elapsed = performance.now() - startedAt;

    assert.ok(
      elapsed < 5_000,
      `Expected wide-line formatting under 5s, got ${elapsed.toFixed(1)}ms.`
    );
    assert.strictEqual(
      formatRsglText(formatted, {
        style: "canonical",
        lineWidth: 40
      }),
      formatted
    );
  });

  it("handles long runs of mismatched closers without quadratic scans", function () {
    this.timeout(10_000);
    const count = 25_000;
    const source = `${"[".repeat(count)}${")".repeat(count)}`;
    const startedAt = performance.now();
    const formatted = formatRsglText(source);
    const elapsed = performance.now() - startedAt;

    assert.ok(
      elapsed < 5_000,
      `Expected malformed formatting under 5s, got ${elapsed.toFixed(1)}ms.`
    );
    assert.deepStrictEqual(tokenTexts(formatted), tokenTexts(source));
    assert.strictEqual(formatRsglText(formatted), formatted);
  });

  it("formats a larger input within a loose regression budget", function () {
    this.timeout(15_000);
    const declarationCount = 2_500;
    const source = Array.from(
      { length: declarationCount },
      (_, index) =>
        `let value_${index}={index : ${index},values : [1,2,3]}`
    ).join("\n");

    const startedAt = performance.now();
    const formatted = formatRsglText(source, {
      style: "canonical",
      lineWidth: 80
    });
    const elapsed = performance.now() - startedAt;

    assert.ok(formatted.includes(`let value_${declarationCount - 1} = {`));
    assert.ok(
      elapsed < 10_000,
      `Expected formatter to finish under 10s, got ${elapsed.toFixed(1)}ms.`
    );
  });
});

function tokenTexts(text: string): string[] {
  return lexRsgl(text).tokens
    .filter(token => token.kind !== "endOfFile")
    .map(token => token.text);
}

function templateTokenText(text: string): string {
  const token = lexRsgl(text).tokens.find(
    candidate => candidate.kind === "templateString"
  );
  assert.ok(token, "Expected a template-string token.");
  return token.text;
}

function diagnosticCodes(text: string): string[] {
  return parseRsgl(text).diagnostics.map(diagnostic => diagnostic.code);
}
