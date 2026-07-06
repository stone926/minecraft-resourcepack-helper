import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getPackImageResourceIssues,
  getTextResourceIssues,
  javaStringHashCode,
  readPngMetadata
} from "../../diagnostics/nonJsonResourceChecks";
import type { LocalizedMessage } from "../../i18n/messages";
import { readOggMetadata } from "../../../packages/mc-assets/src";

describe("non-JSON resource checks", () => {
  it("reads PNG dimensions from the IHDR header", () => {
    assert.deepStrictEqual(readPngMetadata(createPngBytes(256, 128)), {
      width: 256,
      height: 128
    });
    assert.strictEqual(readPngMetadata(Buffer.from("not png")), null);
  });

  it("reads Ogg Vorbis channel, sample rate, and duration metadata", () => {
    assert.deepStrictEqual(readOggMetadata(createOggVorbisBytes(2, 44100, 88200)), {
      codec: "vorbis",
      channels: 2,
      sampleRate: 44100,
      durationSeconds: 2
    });
    assert.strictEqual(readOggMetadata(Buffer.from("not ogg")), null);
  });

  it("checks pack.png and colormap PNG dimensions", () => {
    const root = createTempDirectory();

    try {
      fs.writeFileSync(path.join(root, "pack.png"), createPngBytes(16, 16));
      const colormapRoot = path.join(root, "assets", "minecraft", "textures", "colormap");
      fs.mkdirSync(colormapRoot, { recursive: true });
      fs.writeFileSync(path.join(colormapRoot, "grass.png"), createPngBytes(128, 256));
      fs.writeFileSync(path.join(colormapRoot, "foliage.png"), createPngBytes(256, 256));

      const issues = getPackImageResourceIssues(root);

      assert.deepStrictEqual(issues.map(issue => path.basename(issue.filePath)), ["grass.png"]);
      assert.match(messageKey(issues[0].message), /256x256/);
      assert.deepStrictEqual(issues[0].message.args, [128, 256]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing pack.png as informational", () => {
    const root = createTempDirectory();

    try {
      const issues = getPackImageResourceIssues(root);

      assert.strictEqual(issues.length, 1);
      assert.strictEqual(path.basename(issues[0].filePath), "pack.png");
      assert.strictEqual(issues[0].severity, "information");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks special splashes.txt rules", () => {
    const hiddenSplash = "This message will never appear on the splash screen, isn't that weird?";
    assert.strictEqual(javaStringHashCode(hiddenSplash), 125780783);

    const issues = getTextResourceIssues(
      path.join("pack", "assets", "minecraft", "texts", "splashes.txt"),
      `${hiddenSplash}\n${"x".repeat(50)}\nInvalid §z code`,
      Buffer.from("valid utf8")
    );

    assert.ok(issues.some(issue => /will never be displayed/.test(messageKey(issue.message))));
    assert.ok(issues.some(issue => /wraps lines wider than 256px/.test(messageKey(issue.message))));
    assert.ok(issues.some(issue => /Unsupported Minecraft formatting code/.test(messageKey(issue.message))));
  });

  it("checks UTF-8 and PLAYERNAME placeholder rules in ending text files", () => {
    const issues = getTextResourceIssues(
      path.join("pack", "assets", "minecraft", "texts", "end.txt"),
      "Hello playername\nHello PLAYERNAME",
      Buffer.from([0xff])
    );

    assert.ok(issues.some(issue => /valid UTF-8/.test(messageKey(issue.message))));
    assert.ok(issues.some(issue => /Only uppercase PLAYERNAME/.test(messageKey(issue.message))));
  });
});

function messageKey(message: LocalizedMessage): string {
  return message.message;
}

function createPngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function createOggVorbisBytes(channels: number, sampleRate: number, samples: number): Buffer {
  const identification = Buffer.alloc(30);
  identification[0] = 1;
  identification.write("vorbis", 1, "ascii");
  identification.writeUInt32LE(0, 7);
  identification[11] = channels;
  identification.writeUInt32LE(sampleRate, 12);
  identification[29] = 1;
  return Buffer.concat([
    createOggPage(identification, 0n, 0, 2),
    createOggPage(Buffer.from([0]), BigInt(samples), 1, 4)
  ]);
}

function createOggPage(packet: Buffer, granule: bigint, sequence: number, headerType: number): Buffer {
  const segments = [packet.length];
  const header = Buffer.alloc(27 + segments.length);
  header.write("OggS", 0, "ascii");
  header[5] = headerType;
  header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  header[27] = packet.length;
  return Buffer.concat([header, packet]);
}

function createTempDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-"));
}
