import * as assert from "node:assert";
import {
  DEFAULT_MAX_EVALUATION_ITEMS,
  DEFAULT_MAX_ITEM_MODEL_DEPTH,
  effectiveNamespace,
  parseRsglProjectConfig,
  projectCompileOptionsFromRsglConfig,
  projectEmitOptionsFromRsglConfig,
  resolveRsglCompileConfiguration,
  rsglTargetPackFormatForMinecraftVersion
} from "../../src";

describe("RSGL project compile configuration", () => {
  it("parses and explicitly maps format-based project configuration", () => {
    const config = parseRsglProjectConfig({
      namespace: "example.pack",
      target: {
        edition: "java",
        format: [50, 1]
      },
      maxEvaluationItems: 12_345,
      maxItemModelDepth: 96
    });

    assert.deepStrictEqual(config.target, {
      edition: "java",
      format: [50, 1]
    });
    assert.deepStrictEqual(projectCompileOptionsFromRsglConfig(config), {
      defaultNamespace: "example.pack",
      projectTarget: {
        edition: "java",
        packFormat: { major: 50, minor: 1 }
      },
      maxEvaluationItems: 12_345,
      maxItemModelDepth: 96
    });
    assert.deepStrictEqual(projectCompileOptionsFromRsglConfig(parseRsglProjectConfig({
      target: { edition: "java", format: 50 }
    })), {
      projectTarget: {
        edition: "java",
        packFormat: { major: 50, minor: 0 }
      }
    });
  });

  it("parses and maps supported Minecraft-version project targets", () => {
    const config = parseRsglProjectConfig({
      target: {
        edition: "java",
        mc: "1.21.4"
      }
    });

    assert.deepStrictEqual(config.target, {
      edition: "java",
      mc: "1.21.4"
    });
    assert.deepStrictEqual(projectCompileOptionsFromRsglConfig(config), {
      projectTarget: {
        edition: "java",
        packFormat: { major: 46, minor: 0 }
      }
    });
  });

  it("maps source map and manifest settings to emit options", () => {
    assert.deepStrictEqual(projectEmitOptionsFromRsglConfig(parseRsglProjectConfig({
      emitSourceMap: false,
      manifest: false
    })), {
      sourceMaps: false,
      manifest: false
    });
    assert.deepStrictEqual(projectEmitOptionsFromRsglConfig(parseRsglProjectConfig({})), {
      sourceMaps: true,
      manifest: true
    });
  });

  it("keeps public and internal project configuration keys separate", () => {
    const publicConfig = parseRsglProjectConfig({
      namespace: "example",
      target: { edition: "java", format: 50 },
      maxEvaluationItems: 500,
      maxItemModelDepth: 64
    });
    const compileOptions = projectCompileOptionsFromRsglConfig(publicConfig);

    assert.strictEqual(Object.prototype.hasOwnProperty.call(publicConfig, "defaultNamespace"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(publicConfig, "projectTarget"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compileOptions, "namespace"), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(compileOptions, "target"), false);
    assert.throws(
      () => parseRsglProjectConfig({ defaultNamespace: "example" }),
      /rsgl\.config\.json\.defaultNamespace: unknown property/
    );
    assert.throws(
      () => parseRsglProjectConfig({ projectTarget: { edition: "java", format: 50 } }),
      /rsgl\.config\.json\.projectTarget: unknown property/
    );
  });

  it("accepts local, custom, and vanilla global extern sources", () => {
    const config = parseRsglProjectConfig({
      extern: ["local", "custom", "vanilla"].map(source => ({
        source,
        kind: "model",
        patterns: ["minecraft:block/**"]
      }))
    });

    assert.deepStrictEqual(config.extern?.map(entry => entry.source), [
      "local",
      "custom",
      "vanilla"
    ]);
  });

  it("requires exactly one supported target selector", () => {
    assert.throws(
      () => parseRsglProjectConfig({ target: { edition: "java" } }),
      /rsgl\.config\.json\.target: expected exactly one of 'format' or 'mc'/
    );
    assert.throws(
      () => parseRsglProjectConfig({
        target: { edition: "java", format: 50, mc: "1.21.4" }
      }),
      /rsgl\.config\.json\.target: expected exactly one of 'format' or 'mc'/
    );
    assert.throws(
      () => parseRsglProjectConfig({ target: { edition: "java", format: 50, extra: true } }),
      /rsgl\.config\.json\.target\.extra: unknown property/
    );
  });

  it("rejects invalid namespaces, targets, and compile limits", () => {
    const invalidConfigs: readonly [unknown, RegExp][] = [
      [{ namespace: "" }, /rsgl\.config\.json\.namespace/],
      [{ namespace: "Example" }, /rsgl\.config\.json\.namespace/],
      [{ namespace: "example:pack" }, /rsgl\.config\.json\.namespace/],
      [{ namespace: ".." }, /rsgl\.config\.json\.namespace/],
      [{ target: null }, /rsgl\.config\.json\.target: expected an object/],
      [{ target: { edition: "bedrock", format: 50 } }, /rsgl\.config\.json\.target\.edition/],
      [{ target: { edition: "java", format: 0 } }, /rsgl\.config\.json\.target\.format/],
      [{ target: { edition: "java", format: 1.5 } }, /rsgl\.config\.json\.target\.format/],
      [{ target: { edition: "java", format: [50] } }, /rsgl\.config\.json\.target\.format/],
      [{ target: { edition: "java", format: [0, 0] } }, /rsgl\.config\.json\.target\.format\[0\]/],
      [{ target: { edition: "java", format: [50, -1] } }, /rsgl\.config\.json\.target\.format\[1\]/],
      [{ target: { edition: "java", format: [50, 0, 1] } }, /rsgl\.config\.json\.target\.format/],
      [{ target: { edition: "java", mc: "latest" } }, /rsgl\.config\.json\.target\.mc: expected a version/],
      [{ target: { edition: "java", mc: "1.99.0" } }, /rsgl\.config\.json\.target\.mc: unknown Minecraft version/],
      [{ maxEvaluationItems: 0 }, /rsgl\.config\.json\.maxEvaluationItems/],
      [{ maxEvaluationItems: -1 }, /rsgl\.config\.json\.maxEvaluationItems/],
      [{ maxEvaluationItems: 1.5 }, /rsgl\.config\.json\.maxEvaluationItems/],
      [{ maxEvaluationItems: Number.MAX_SAFE_INTEGER + 1 }, /rsgl\.config\.json\.maxEvaluationItems/],
      [{ maxItemModelDepth: 0 }, /rsgl\.config\.json\.maxItemModelDepth/],
      [{ maxItemModelDepth: -1 }, /rsgl\.config\.json\.maxItemModelDepth/],
      [{ maxItemModelDepth: 1.5 }, /rsgl\.config\.json\.maxItemModelDepth/],
      [{ maxItemModelDepth: Number.MAX_SAFE_INTEGER + 1 }, /rsgl\.config\.json\.maxItemModelDepth/]
    ];

    for (const [config, expectedMessage] of invalidConfigs) {
      assert.throws(() => parseRsglProjectConfig(config), expectedMessage);
    }
  });

  it("resolves namespace precedence and compile defaults once", () => {
    const defaults = resolveRsglCompileConfiguration();
    assert.strictEqual(defaults.defaultNamespace, "minecraft");
    assert.strictEqual(defaults.maxEvaluationItems, DEFAULT_MAX_EVALUATION_ITEMS);
    assert.strictEqual(defaults.maxItemModelDepth, DEFAULT_MAX_ITEM_MODEL_DEPTH);
    assert.strictEqual(effectiveNamespace(undefined, defaults), "minecraft");

    const projectDefault = resolveRsglCompileConfiguration({
      defaultNamespace: "project"
    });
    assert.strictEqual(effectiveNamespace(undefined, projectDefault), "project");
    assert.strictEqual(effectiveNamespace("declared", projectDefault), "declared");

    const hardOverride = resolveRsglCompileConfiguration({
      namespace: "override",
      defaultNamespace: "project"
    });
    assert.strictEqual(effectiveNamespace(undefined, hardOverride), "override");
    assert.strictEqual(effectiveNamespace("declared", hardOverride), "override");
  });

  it("creates stable fingerprints from normalized semantic configuration", () => {
    const minecraftTarget = projectCompileOptionsFromRsglConfig(parseRsglProjectConfig({
      namespace: "example",
      target: { edition: "java", mc: "1.21.4" },
      maxEvaluationItems: 500,
      maxItemModelDepth: 64
    }));
    const formatTarget = projectCompileOptionsFromRsglConfig(parseRsglProjectConfig({
      maxEvaluationItems: 500,
      maxItemModelDepth: 64,
      target: { format: [46, 0], edition: "java" },
      namespace: "example"
    }));
    const first = resolveRsglCompileConfiguration(minecraftTarget);
    const second = resolveRsglCompileConfiguration(formatTarget);

    assert.strictEqual(first.semanticFingerprint, second.semanticFingerprint);
    assert.strictEqual(
      resolveRsglCompileConfiguration().semanticFingerprint,
      resolveRsglCompileConfiguration({
        defaultNamespace: "minecraft",
        maxEvaluationItems: DEFAULT_MAX_EVALUATION_ITEMS,
        maxItemModelDepth: DEFAULT_MAX_ITEM_MODEL_DEPTH
      }).semanticFingerprint
    );

    const changedFingerprints = [
      resolveRsglCompileConfiguration({ ...minecraftTarget, namespace: "override" }),
      resolveRsglCompileConfiguration({ ...minecraftTarget, defaultNamespace: "other" }),
      resolveRsglCompileConfiguration({ ...minecraftTarget, maxEvaluationItems: 501 }),
      resolveRsglCompileConfiguration({ ...minecraftTarget, maxItemModelDepth: 65 }),
      resolveRsglCompileConfiguration({
        ...minecraftTarget,
        projectTarget: { edition: "java", packFormat: { major: 46, minor: 1 } }
      })
    ].map(configuration => configuration.semanticFingerprint);
    for (const fingerprint of changedFingerprints) {
      assert.notStrictEqual(fingerprint, first.semanticFingerprint);
    }
  });

  it("does not expose mutable target registry entries", () => {
    const first = rsglTargetPackFormatForMinecraftVersion("1.21.4");
    assert.ok(first);
    first.major = 1;
    assert.deepStrictEqual(rsglTargetPackFormatForMinecraftVersion("1.21.4"), {
      major: 46,
      minor: 0
    });
    assert.strictEqual(rsglTargetPackFormatForMinecraftVersion("1.99.0"), null);
  });
});
