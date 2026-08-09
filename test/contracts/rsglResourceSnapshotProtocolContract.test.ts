import * as assert from "node:assert/strict";
import type {
  RsglResourceSnapshotEdge,
  RsglResourceSnapshotIssue,
  RsglResourceSnapshotLocation,
  RsglResourceSnapshotProducer,
  RsglResourceSnapshotResolvedTarget
} from "../../packages/rsgl-core/src/compiler/resourceSnapshot";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type {
  RsglResourceDto,
  RsglResourceEdgeDto,
  RsglResourceIssueDto,
  RsglResourceLocationDto,
  RsglResourceLogicalKeyDto,
  RsglResourceTextRangeDto,
  RsglResolvedTargetDto
} from "../../packages/rsgl-shared/src/resourceSnapshotProtocol";

type SameKeys<Left, Right> = Exclude<keyof Left, keyof Right> extends never
  ? Exclude<keyof Right, keyof Left> extends never
    ? true
    : false
  : false;

describe("RSGL resource snapshot protocol", () => {
  it("keeps compiler snapshot facts assignable to the contentless wire DTOs", () => {
    // rsgl-shared deliberately stays below rsgl-core in the build graph. These
    // checks guard the duplicated wire shape without reversing that dependency.
    const producerKeysMatch: SameKeys<RsglResourceSnapshotProducer, RsglResourceDto> = true;
    const edgeKeysMatch: SameKeys<RsglResourceSnapshotEdge, RsglResourceEdgeDto> = true;
    const issueKeysMatch: SameKeys<RsglResourceSnapshotIssue, RsglResourceIssueDto> = true;
    const logicalKeyKeysMatch: SameKeys<ResourceGraphLogicalKey, RsglResourceLogicalKeyDto> = true;
    const locationKeysMatch: SameKeys<RsglResourceSnapshotLocation, RsglResourceLocationDto> = true;
    const rangeKeysMatch: SameKeys<
      NonNullable<RsglResourceSnapshotLocation["range"]>,
      RsglResourceTextRangeDto
    > = true;
    const targetKeysMatch: SameKeys<
      RsglResourceSnapshotResolvedTarget,
      RsglResolvedTargetDto
    > = true;
    const producer: RsglResourceSnapshotProducer = {
      producerId: "producer",
      kind: "model",
      logicalKeys: [{ kind: "model", id: "minecraft:block/stone" }],
      aliasKeys: [],
      aggregateMemberships: [],
      outputPath: "assets/minecraft/models/block/stone.json",
      sourceOrigins: [{ uri: "file:///pack/main.rsgl", range: { start: 0, end: 1 } }],
      revision: "revision"
    };
    const edge: RsglResourceSnapshotEdge = {
      edgeId: "edge",
      sourceProducerId: producer.producerId,
      target: { kind: "texture", id: "minecraft:block/stone" },
      resolutionScope: "effective",
      resolutionContextId: "context",
      sourceLocation: producer.sourceOrigins[0],
      relationship: "texture",
      origin: "direct",
      resolvedTarget: { status: "generated" }
    };
    const issue: RsglResourceSnapshotIssue = {
      code: "rsgl.example",
      severity: "warning",
      message: "Example issue",
      location: producer.sourceOrigins[0]
    };

    const wireProducer: RsglResourceDto = producer;
    const wireEdge: RsglResourceEdgeDto = edge;
    const wireIssue: RsglResourceIssueDto = issue;
    assert.deepStrictEqual(
      [
        producerKeysMatch,
        edgeKeysMatch,
        issueKeysMatch,
        logicalKeyKeysMatch,
        locationKeysMatch,
        rangeKeysMatch,
        targetKeysMatch,
        wireProducer,
        wireEdge,
        wireIssue
      ],
      [true, true, true, true, true, true, true, producer, edge, issue]
    );
  });
});
