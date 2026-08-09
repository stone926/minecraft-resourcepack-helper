import * as assert from "node:assert";
import * as path from "node:path";
import {
  createTextureVariableDefinitionResolver,
  registerDefaultModelTextureResolutionHost
} from "../../utils/modelTexture";
import {
  createResourceReferencePathResolver,
  registerResourceReferencePathResolver,
  type ResourcePathResolutionHost
} from "../../utils/pathGenerator";
import {
  getResourceReferences,
  registerResourceReferenceExtractor,
  type ResourceReference,
  type ResourceReferenceCacheDescriptor,
  type ResourceReferenceDocument,
  type ResourceReferenceHost
} from "../../utils/resourceReferences";
import { parseJsonAst } from "../../utils/jsonAst";

describe("resource pipeline registration", () => {
  it("keeps unregistered headless extraction pure and uncached", () => {
    let reads = 0;
    const document: ResourceReferenceDocument = {
      fileName: path.join("pack", "assets", "minecraft", "models", "block", "headless.json"),
      languageId: "json",
      version: 1,
      getText: () => {
        reads++;
        return JSON.stringify({ parent: "minecraft:block/cube" });
      }
    };

    assert.deepStrictEqual(getResourceReferences(document).map(value => value.value), [
      "minecraft:block/cube"
    ]);
    getResourceReferences(document);
    assert.strictEqual(reads, 2, "the standalone adapter must not retain state");
  });

  it("uses scoped last-registration-wins extractors without reusing stale cache entries", () => {
    const host = new MemoryReferenceHost();
    const document: ResourceReferenceDocument = {
      fileName: path.join("pack", "assets", "minecraft", "citresewn", "test.properties"),
      languageId: "properties",
      version: 1,
      getText: () => "type=item"
    };
    const outer = registerResourceReferenceExtractor("citProperties", () => [reference("outer")]);
    const inner = registerResourceReferenceExtractor("citProperties", () => [reference("inner")]);
    try {
      assert.deepStrictEqual(getResourceReferences(document, host).map(value => value.value), ["inner"]);
      outer.dispose();
      assert.deepStrictEqual(getResourceReferences(document, host).map(value => value.value), ["inner"]);
    } finally {
      inner.dispose();
      outer.dispose();
    }
    assert.ok(host.cacheWrites >= 2, "registry generation should prevent stale extraction reuse");
  });

  it("looks up a registered path mode through the injected resolution host", () => {
    const resolvedFileName = path.resolve("pack", "assets", "minecraft", "textures", "item", "test.png");
    const host: ResourcePathResolutionHost = {
      resolveResourcePath: () => null,
      getPathExists: () => false,
      getPackRoot: () => null,
      getResourceConfiguration: () => ({}),
      createFileUri: fileName => ({ fsPath: fileName } as never)
    };
    const resolver = createResourceReferencePathResolver(host);
    const registration = registerResourceReferencePathResolver("cit", context => {
      assert.strictEqual(context.host, host);
      return resolvedFileName;
    });
    const document = { fileName: path.resolve("pack", "test.properties") };
    const citReference = { ...reference("test"), resolveMode: "cit" as const };
    try {
      assert.strictEqual(resolver(citReference, document)?.fsPath, resolvedFileName);
    } finally {
      registration.dispose();
    }
    assert.strictEqual(resolver(citReference, document), null);
  });

  it("resolves model texture variables through a scoped default host", () => {
    const ast = parseJsonAst("{}")!;
    const document = { fileName: path.resolve("pack", "assets", "minecraft", "models", "item", "test.json"), getText: () => "{}" };
    const resolver = createTextureVariableDefinitionResolver(ast, document, () => ({}));
    const expected = { fileName: document.fileName, line: 3, character: 5 };
    const registration = registerDefaultModelTextureResolutionHost({
      getModelTextureVariableDefinitions: () => new Map([["layer0", expected]])
    });
    try {
      assert.deepStrictEqual(resolver.resolve("#layer0"), expected);
      assert.strictEqual(resolver.resolve("minecraft:item/test"), null);
    } finally {
      registration.dispose();
    }
    assert.throws(() => resolver.resolve("#layer0"), /has not been registered/);
  });
});

class MemoryReferenceHost implements ResourceReferenceHost {
  private readonly values = new Map<string, ResourceReference[]>();
  cacheWrites = 0;

  getJsonAst(): null {
    return null;
  }

  getResourceReferenceDocumentVersion(): string {
    return "test:1";
  }

  getCachedResourceReferences(descriptor: ResourceReferenceCacheDescriptor): ResourceReference[] | null {
    return this.values.get(descriptor.key) ?? null;
  }

  setCachedResourceReferences(
    descriptor: ResourceReferenceCacheDescriptor,
    references: ResourceReference[]
  ): void {
    this.cacheWrites++;
    this.values.set(descriptor.key, references);
  }
}

function reference(value: string): ResourceReference {
  return {
    value,
    valueNode: {},
    target: "models",
    source: "models",
    extension: "json",
    kind: "model"
  };
}
