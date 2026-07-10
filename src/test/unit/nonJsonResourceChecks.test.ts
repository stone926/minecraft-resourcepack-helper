import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  getPackImageResourceIssues,
  getTextResourceIssues,
  javaStringHashCode,
  readPngMetadata,
  type PackImageResourceHost
} from "../../diagnostics/nonJsonResourceChecks";
import type { LocalizedMessage } from "../../i18n/messages";
import { readOggMetadata } from "../../../packages/mc-assets/src";
import { createOggVorbisBytes, createPngBytes, createTempDirectory } from "./helpers/tempPack";

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

      const issues = getPackImageResourceIssues(root, createPackImageResourceHost());

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
      const issues = getPackImageResourceIssues(root, createPackImageResourceHost());

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

function createPackImageResourceHost(): PackImageResourceHost {
  return {
    pathExists: fileName => fs.existsSync(fileName),
    readDirectoryEntries: directory => {
      try {
        return fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return null;
      }
    },
    readPngMetadata: fileName => {
      try {
        return readPngMetadata(fs.readFileSync(fileName));
      } catch {
        return null;
      }
    }
  };
}

