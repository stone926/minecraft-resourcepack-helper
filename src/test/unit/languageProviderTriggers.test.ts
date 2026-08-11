import * as assert from "node:assert/strict";
import {
  citCompletionTriggerCharacters,
  resourceCompletionTriggerCharacters
} from "../../registration/languageProviderTriggers";

describe("language provider completion triggers", () => {
  it("pairs resource path triggers with incomplete JSON and shader contexts", () => {
    assert.deepStrictEqual(resourceCompletionTriggerCharacters, ["\"", "<", "/", "\\", ":", "=", " "]);
    assert.ok(resourceCompletionTriggerCharacters.every(character => character.length === 1));
  });

  it("retriggers CIT keys, pattern segments, and list values", () => {
    assert.deepStrictEqual(citCompletionTriggerCharacters, ["=", ".", " "]);
  });
});
