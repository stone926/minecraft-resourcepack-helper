import * as assert from "node:assert/strict";
import { readOggMetadata } from "../../src";

const unsetGranule = 0xffffffffffffffffn;

/** Builds a minimal Vorbis identification packet with the given stream properties. */
function vorbisIdentificationPacket(channels: number, sampleRate: number): Buffer {
  const packet = Buffer.alloc(30);
  packet[0] = 1;
  packet.write("vorbis", 1, "ascii");
  packet[11] = channels;
  packet.writeUInt32LE(sampleRate, 12);
  packet[29] = 1;
  return packet;
}

/** Wraps packet body bytes in a single Ogg page with the given lacing values. */
function oggPage(granule: bigint, segments: number[], body: Buffer): Buffer {
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header.writeBigUInt64LE(granule, 6);
  header[26] = segments.length;
  segments.forEach((length, index) => {
    header[27 + index] = length;
  });
  return Buffer.concat([header, body]);
}

describe("Ogg metadata", () => {
  it("reads channels, sample rate, and duration from a Vorbis identification page", () => {
    const bytes = oggPage(88200n, [30], vorbisIdentificationPacket(2, 44100));
    assert.deepStrictEqual(readOggMetadata(bytes), {
      codec: "vorbis",
      channels: 2,
      sampleRate: 44100,
      durationSeconds: 2
    });
  });

  it("omits the duration when no page carries a granule position", () => {
    const bytes = oggPage(unsetGranule, [30], vorbisIdentificationPacket(1, 22050));
    assert.deepStrictEqual(readOggMetadata(bytes), {
      codec: "vorbis",
      channels: 1,
      sampleRate: 22050
    });
  });

  it("reassembles packets that span multiple lacing segments and uses the last granule", () => {
    const identification = Buffer.concat([vorbisIdentificationPacket(2, 44100), Buffer.alloc(270)]);
    const firstPage = oggPage(unsetGranule, [255, 45], identification);
    const lastPage = oggPage(132300n, [1], Buffer.from([0]));
    assert.deepStrictEqual(readOggMetadata(Buffer.concat([firstPage, lastPage])), {
      codec: "vorbis",
      channels: 2,
      sampleRate: 44100,
      durationSeconds: 3
    });
  });

  it("returns null for bytes without the OggS capture pattern", () => {
    const bytes = oggPage(0n, [30], vorbisIdentificationPacket(2, 44100));
    bytes.write("NOPE", 0, "ascii");
    assert.strictEqual(readOggMetadata(bytes), null);
    assert.strictEqual(readOggMetadata(Buffer.from("RIFF not an ogg container at all", "ascii")), null);
  });

  it("returns null for empty and truncated inputs", () => {
    assert.strictEqual(readOggMetadata(new Uint8Array(0)), null);
    const truncated = oggPage(0n, [30], vorbisIdentificationPacket(2, 44100)).subarray(0, 40);
    assert.strictEqual(readOggMetadata(truncated), null);
  });

  it("returns null when the first packet is not a Vorbis identification header", () => {
    const notVorbis = vorbisIdentificationPacket(2, 44100);
    notVorbis.write("theora", 1, "ascii");
    assert.strictEqual(readOggMetadata(oggPage(0n, [30], notVorbis)), null);

    const wrongType = vorbisIdentificationPacket(2, 44100);
    wrongType[0] = 3;
    assert.strictEqual(readOggMetadata(oggPage(0n, [30], wrongType)), null);
  });

  it("returns null for identification headers with impossible stream properties", () => {
    assert.strictEqual(readOggMetadata(oggPage(0n, [30], vorbisIdentificationPacket(0, 44100))), null);
    assert.strictEqual(readOggMetadata(oggPage(0n, [30], vorbisIdentificationPacket(2, 0))), null);
  });
});
