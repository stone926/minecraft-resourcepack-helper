import type {
  CanonicalizeResourceGraphIdentityOptions,
  CanonicalResourceGraphIdentity
} from "../../src/resourceGraphIdentity";

export interface ResourceGraphIdentityTestVector {
  name: string;
  kind: string;
  value: string;
  options?: CanonicalizeResourceGraphIdentityOptions;
  expected: CanonicalResourceGraphIdentity | null;
}

export const resourceGraphIdentityTestVectors: readonly ResourceGraphIdentityTestVector[] = [
  {
    name: "default namespace",
    kind: "model",
    value: "block/stone",
    expected: identity("model", "minecraft:block/stone")
  },
  {
    name: "JSON extension stripping",
    kind: "model",
    value: "example:block/stone.json",
    expected: identity("model", "example:block/stone")
  },
  {
    name: "path separator normalization",
    kind: "model",
    value: String.raw`example:block\\nested//stone.json`,
    expected: identity("model", "example:block/nested/stone")
  },
  {
    name: "texture alias and directory aggregates",
    kind: "texture",
    value: "example:block/nested/stone",
    expected: {
      ...identity("texture", "example:block/nested/stone"),
      aliasKeys: [{ kind: "texture", id: "example:block/nested/stone.png" }],
      aggregateMemberships: [
        { kind: "textureDirectory", id: "example:block" },
        { kind: "textureDirectory", id: "example:block/nested" }
      ]
    }
  },
  {
    name: "extension-bearing texture input",
    kind: "texture",
    value: "example:block/stone.png",
    expected: {
      ...identity("texture", "example:block/stone"),
      aliasKeys: [{ kind: "texture", id: "example:block/stone.png" }],
      aggregateMemberships: [{ kind: "textureDirectory", id: "example:block" }]
    }
  },
  {
    name: "vertex shader inference",
    kind: "shader",
    value: "example:core/screenquad.vsh",
    expected: identity("shaderVertex", "example:core/screenquad")
  },
  {
    name: "fragment shader configured extension",
    kind: "shader",
    value: "example:post/blur",
    options: { extension: "fsh" },
    expected: identity("shaderFragment", "example:post/blur")
  },
  {
    name: "directory aggregate target",
    kind: "texture_directory",
    value: "example:block/nested",
    expected: {
      ...identity("textureDirectory", "example:block/nested"),
      primaryCategory: "aggregate"
    }
  },
  {
    name: "font file preserves its real extension",
    kind: "font_file",
    value: "example:font/ascii.png",
    expected: identity("fontFile", "example:font/ascii.png")
  },
  {
    name: "invalid uppercase Minecraft identity",
    kind: "model",
    value: "Example:block/stone",
    expected: null
  }
];

function identity(kind: string, id: string): CanonicalResourceGraphIdentity {
  return {
    primaryKey: { kind, id },
    primaryCategory: "concrete",
    aliasKeys: [],
    aggregateMemberships: []
  };
}
