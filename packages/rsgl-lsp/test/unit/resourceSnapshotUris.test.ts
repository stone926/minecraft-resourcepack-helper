import * as assert from "node:assert/strict";
import {
  fileNameFromSerializedResourceUri,
  resourceUriNativePathMappingsFromRequest,
  rsglSourceUriFromFileName
} from "../../src/resourceSnapshotUris";

describe("RSGL resource snapshot URI transport", () => {
  it("maps a workspace-owned vscode-remote POSIX URI without changing ProjectContext", () => {
    const mappings = resourceUriNativePathMappingsFromRequest({
      nativePathMappings: [{
        uriRoot: "vscode-remote://ssh-remote+dev/home/user/%E8%B5%84%E6%BA%90%E5%8C%85",
        fileSystemPath: "/home/user/资源包"
      }]
    });

    assert.strictEqual(
      fileNameFromSerializedResourceUri(
        "vscode-remote://ssh-remote+dev/home/user/%E8%B5%84%E6%BA%90%E5%8C%85/rsgl/main.rsgl",
        mappings
      ),
      "/home/user/资源包/rsgl/main.rsgl"
    );
    assert.strictEqual(
      rsglSourceUriFromFileName("/home/user/资源包/rsgl/main file.rsgl", mappings),
      "vscode-remote://ssh-remote+dev/home/user/%E8%B5%84%E6%BA%90%E5%8C%85/rsgl/main%20file.rsgl"
    );
    assert.strictEqual(
      fileNameFromSerializedResourceUri(
        "vscode-remote://ssh-remote+other/home/user/%E8%B5%84%E6%BA%90%E5%8C%85/rsgl/main.rsgl",
        mappings
      ),
      null
    );
  });

  it("maps a Windows-like remote URI with win32 semantics on every test host", () => {
    const mappings = resourceUriNativePathMappingsFromRequest({
      nativePathMappings: [{
        uriRoot: "vscode-remote://ssh-remote+windows/c%3A/Users/Dev/Pack",
        fileSystemPath: "C:\\Users\\Dev\\Pack"
      }]
    });

    assert.strictEqual(
      fileNameFromSerializedResourceUri(
        "vscode-remote://ssh-remote+windows/C%3A/users/DEV/pack/assets/demo/models/item.json",
        mappings
      ),
      "C:\\Users\\Dev\\Pack\\assets\\demo\\models\\item.json"
    );
    assert.strictEqual(
      fileNameFromSerializedResourceUri(
        "vscode-remote://ssh-remote+windows/c%3A/Users/Dev/Other/item.json",
        mappings
      ),
      null,
      "a host mapping must not authorize paths outside its URI root"
    );
  });
});
