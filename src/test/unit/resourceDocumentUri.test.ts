import * as assert from "node:assert";
import {
  isResourceDocumentUriWithin,
  type ResourceDocumentUri
} from "../../resourceUniverse/providers/resourceDocumentUri";

describe("resource document URI boundary", () => {
  const localRoot = "file:///E:/.minecraft/resourcepacks/better_textures/assets";

  it("accepts hierarchical documents inside local and remote resource roots", () => {
    assert.strictEqual(isResourceDocumentUriWithin(
      documentUri(
        "file:///E:/.minecraft/resourcepacks/better_textures/assets/minecraft/models/block/crop.json",
        "/E:/.minecraft/resourcepacks/better_textures/assets/minecraft/models/block/crop.json"
      ),
      localRoot
    ), true);
    assert.strictEqual(isResourceDocumentUriWithin(
      documentUri(
        "vscode-remote://ssh-remote+dev/work/pack/assets/demo/models/block/example.json",
        "/work/pack/assets/demo/models/block/example.json"
      ),
      "vscode-remote://ssh-remote+dev/work/pack/assets"
    ), true);
  });

  it("ignores the Git SCM input document that triggered physical scanning", () => {
    const scmInput = documentUri(
      "vscode-scm:git/scm0/input?rootUri%3Dfile%253A%252F%252F%252Fe%25253A%252F.minecraft%252Fresourcepacks%252Fbetter_textures",
      "git/scm0/input",
      "rootUri=file%3A%2F%2F%2Fe%253A%2F.minecraft%2Fresourcepacks%2Fbetter_textures"
    );

    assert.doesNotThrow(() => isResourceDocumentUriWithin(scmInput, localRoot));
    assert.strictEqual(isResourceDocumentUriWithin(scmInput, localRoot), false);
  });

  it("ignores query-backed Git diff documents even when their path looks indexed", () => {
    assert.strictEqual(isResourceDocumentUriWithin(
      documentUri(
        "git:/E:/.minecraft/resourcepacks/better_textures/assets/minecraft/models/block/crop.json?ref=HEAD",
        "/E:/.minecraft/resourcepacks/better_textures/assets/minecraft/models/block/crop.json",
        "ref=HEAD"
      ),
      localRoot
    ), false);
  });

  it("treats malformed external document identities as outside the resource root", () => {
    assert.strictEqual(isResourceDocumentUriWithin(
      documentUri("not an absolute URI", "/resource.json"),
      localRoot
    ), false);
  });
});

function documentUri(
  serialized: string,
  path: string,
  query = "",
  fragment = ""
): ResourceDocumentUri {
  return {
    path,
    query,
    fragment,
    toString: () => serialized
  };
}
