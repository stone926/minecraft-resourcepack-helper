import * as assert from "node:assert";
import { getRsglCompletionCandidates } from "../../src/completionData";

describe("RSGL completion data", () => {
  it("provides top-level and block-aware completion candidates", () => {
    const topLevel = getRsglCompletionCandidates("", 0);
    assert.ok(topLevel.some(candidate => candidate.label === "target"));
    assert.ok(topLevel.some(candidate => candidate.label === "target mc"));
    assert.ok(topLevel.some(candidate => candidate.label === "export"));
    assert.ok(topLevel.some(candidate => candidate.label === "atlas"));
    assert.ok(topLevel.some(candidate => candidate.label === "particles"));
    assert.ok(topLevel.some(candidate => candidate.label === "equipment"));
    assert.ok(topLevel.some(candidate => candidate.label === "font"));
    assert.ok(topLevel.some(candidate => candidate.label === "waypoint_style"));
    assert.ok(topLevel.some(candidate => candidate.label === "post_effect"));
    assert.ok(topLevel.some(candidate => candidate.label === "json"));
    assert.ok(topLevel.some(candidate => candidate.label === "lang"));
    assert.ok(topLevel.some(candidate => candidate.label === "sounds"));
    assert.ok(topLevel.some(candidate => candidate.label === "text"));
    assert.ok(topLevel.some(candidate => candidate.label === "copy"));
    assert.ok(topLevel.some(candidate => candidate.label === "cubeAll"));

    const inBlock = getRsglCompletionCandidates("model block stone {\n  ", "model block stone {\n  ".length);
    assert.ok(inBlock.some(candidate => candidate.label === "textures"));
    assert.ok(inBlock.some(candidate => candidate.label === "box"));
    assert.ok(inBlock.some(candidate => candidate.label === "raw_json"));
  });
});
