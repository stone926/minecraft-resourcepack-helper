import * as assert from "node:assert/strict";
import {
  blockstateFragmentMergePolicy,
  FragmentMergeEngine,
  genericFragmentMergePolicy,
  type FragmentMergeMode
} from "../../src/compiler/fragmentMerge";
import type { JsonValue } from "../../src/compiler/ir";
import type { EvaluationContext } from "../../src/compiler/evaluate";
import { applyResourceBodyFragment } from "../../src/compiler/resourceBodyContentMerge";

const range = { start: 10, end: 20 };

describe("RSGL fragment merge engine", () => {
  it("applies shallow and deep merges as distinct modes", () => {
    const shallowTarget: Record<string, JsonValue> = {
      object: { keep: true },
      list: [1]
    };
    const shallow = apply(shallowTarget, "shallow", {
      object: { added: true },
      list: [2]
    });

    assert.deepStrictEqual(shallowTarget, {
      object: { added: true },
      list: [2]
    });
    assert.deepStrictEqual(shallow.applied, {
      object: { added: true },
      list: [2]
    });
    assert.deepStrictEqual([...shallow.arrayOffsets], []);

    const deepTarget: Record<string, JsonValue> = {
      object: { keep: true },
      list: [1]
    };
    const deep = apply(deepTarget, "deep", {
      object: { added: true },
      list: [2, 3]
    });

    assert.deepStrictEqual(deepTarget, {
      object: { keep: true, added: true },
      list: [1, 2, 3]
    });
    assert.strictEqual(deep.arrayOffsets.get("/list"), 1);
    assert.deepStrictEqual(deep.diagnostics, []);
  });

  it("does not retain mutable references to reusable incoming fragments", () => {
    const incoming: Record<string, JsonValue> = {
      nested: { original: true },
      list: [{ original: true }]
    };
    const target: Record<string, JsonValue> = {};
    apply(target, "shallow", incoming);

    (target.nested as Record<string, JsonValue>).changed = true;
    (target.list as JsonValue[]).push({ changed: true });

    assert.deepStrictEqual(incoming, {
      nested: { original: true },
      list: [{ original: true }]
    });
  });

  it("reports every missing strict field while applying existing fields", () => {
    const target: Record<string, JsonValue> = {
      parent: "minecraft:block/base",
      textures: { all: "minecraft:block/stone" }
    };
    const result = apply(target, "strict", {
      parent: "minecraft:block/changed",
      textures: {
        all: "minecraft:block/dirt",
        missing: "minecraft:block/missing"
      },
      display: {}
    });

    assert.deepStrictEqual(target, {
      parent: "minecraft:block/changed",
      textures: { all: "minecraft:block/dirt" }
    });
    assert.deepStrictEqual(result.applied, {
      parent: "minecraft:block/changed",
      textures: { all: "minecraft:block/dirt" }
    });
    assert.deepStrictEqual(result.diagnostics.map(item => item.code), [
      "rsgl.mergeFieldNotFound",
      "rsgl.mergeFieldNotFound"
    ]);
    assert.ok(result.diagnostics.some(item => item.message.includes("/textures/missing")));
    assert.ok(result.diagnostics.some(item => item.message.includes("/display")));
  });

  it("creates fields recursively in upsert mode", () => {
    const target: Record<string, JsonValue> = {
      display: { gui: { rotation: [0, 0, 0] } }
    };
    const result = apply(target, "upsert", {
      display: { gui: { scale: [1, 1, 1] } },
      textures: {}
    });

    assert.deepStrictEqual(target, {
      display: {
        gui: {
          rotation: [0, 0, 0],
          scale: [1, 1, 1]
        }
      },
      textures: {}
    });
    assert.deepStrictEqual(result.diagnostics, []);
    assert.deepStrictEqual(result.applied.textures, {});
  });

  it("appends compatible arrays and objects and rejects scalar collisions", () => {
    const target: Record<string, JsonValue> = {
      layers: [{ texture: "minecraft:block/base" }],
      textures: { all: "minecraft:block/stone" },
      parent: "minecraft:block/base"
    };
    const result = apply(target, "append", {
      layers: [{ texture: "minecraft:block/overlay" }],
      textures: { particle: "minecraft:block/stone" },
      parent: "minecraft:block/changed",
      display: { gui: true }
    });

    assert.deepStrictEqual(target, {
      layers: [
        { texture: "minecraft:block/base" },
        { texture: "minecraft:block/overlay" }
      ],
      textures: {
        all: "minecraft:block/stone",
        particle: "minecraft:block/stone"
      },
      parent: "minecraft:block/base",
      display: { gui: true }
    });
    assert.strictEqual(result.arrayOffsets.get("/layers"), 1);
    assert.deepStrictEqual(result.diagnostics.map(item => item.code), [
      "rsgl.mergeAppendIncompatibleField"
    ]);
  });

  it("exposes blockstate append and sibling-conflict policy decisions", () => {
    const target: Record<string, JsonValue> = {
      variants: {
        "": { model: "minecraft:block/base" }
      }
    };
    const engine = new FragmentMergeEngine();
    const result = engine.apply(target, {
      mode: "append",
      sourceRange: range,
      content: {
        variants: { powered: { model: "minecraft:block/powered" } },
        multipart: [{ apply: { model: "minecraft:block/post" } }]
      }
    }, blockstateFragmentMergePolicy);

    assert.deepStrictEqual(target, {
      variants: {
        "": { model: "minecraft:block/base" }
      }
    });
    assert.deepStrictEqual(result.applied, {});
    assert.deepStrictEqual(result.diagnostics.map(item => item.code), [
      "rsgl.mergeOperationNotAllowed",
      "rsgl.mergeOperationNotAllowed"
    ]);
  });

  it("emits mappings only for content accepted by the merge policy", () => {
    const context: EvaluationContext = { namespace: "minecraft", variables: new Map() };
    const target: Record<string, JsonValue> = {};
    const mappedPaths: string[] = [];
    applyResourceBodyFragment(
      target,
      {
        content: {
          nested: { accepted: 1, rejected: 2 },
          entirelyRejected: { rejected: 3 }
        },
        mappings: [
          { generatedPath: "", sourceRange: range, context },
          { generatedPath: "/nested", sourceRange: range, context },
          { generatedPath: "/nested/accepted", sourceRange: range, context },
          { generatedPath: "/nested/rejected", sourceRange: range, context },
          { generatedPath: "/entirelyRejected", sourceRange: range, context }
        ]
      },
      "deep",
      range,
      context,
      {
        mergePolicy: {
          resourceKind: "test",
          decide: decision => decision.key === "rejected"
            ? { kind: "reject", message: "rejected for test" }
            : { kind: "allow" }
        },
        onMapping: mapping => mappedPaths.push(mapping.generatedPath)
      },
      ""
    );

    assert.deepStrictEqual(target, { nested: { accepted: 1 } });
    assert.deepStrictEqual(mappedPaths, ["", "/nested", "/nested/accepted"]);
  });
});

function apply(
  target: Record<string, JsonValue>,
  mode: FragmentMergeMode,
  content: Record<string, JsonValue>
) {
  return new FragmentMergeEngine().apply(target, { content, mode, sourceRange: range }, genericFragmentMergePolicy);
}
