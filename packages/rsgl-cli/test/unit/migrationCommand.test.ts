import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runRsglCli, type RsglCliIo } from "../../src/cli";
import {
  runRsglMigrationCommand,
  type RsglMigrationTransactionFileSystem
} from "../../src/migrationCommand";

function captureIo(): { io: RsglCliIo; stdout(): string; stderr(): string } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    io: {
      writeOut: text => { output.push(text); },
      writeErr: text => { errors.push(text); }
    },
    stdout: () => output.join(""),
    stderr: () => errors.join("")
  };
}

function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsgl-migrate-"));
}

interface TransactionFileSystemHooks {
  afterRename?(source: string, destination: string): void;
  beforeLink?(source: string, destination: string): void;
  beforeRemove?(fileName: string): void;
  beforeRename?(source: string, destination: string): void;
}

function transactionFileSystem(
  hooks: TransactionFileSystemHooks = {}
): RsglMigrationTransactionFileSystem {
  return {
    exists: fileName => fs.existsSync(fileName),
    identity: fileName => {
      const stat = fs.statSync(fileName);
      return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
    },
    link: (source, destination) => {
      hooks.beforeLink?.(source, destination);
      fs.linkSync(source, destination);
    },
    readText: fileName => fs.readFileSync(fileName, "utf8"),
    remove: fileName => {
      hooks.beforeRemove?.(fileName);
      fs.rmSync(fileName);
    },
    rename: (source, destination) => {
      hooks.beforeRename?.(source, destination);
      fs.renameSync(source, destination);
      hooks.afterRename?.(source, destination);
    },
    writeTextExclusive: (fileName, text, mode) => {
      fs.writeFileSync(fileName, text, { encoding: "utf8", flag: "wx", mode });
    }
  };
}

function legacyBlockstate(id: string): string {
  return [
    `blockstate ${id} {`,
    "  variants {",
    "    [facing=north] -> @minecraft:block/stone uvlock",
    "  }",
    "}"
  ].join("\n");
}

function migrationArtifacts(root: string): string[] {
  return fs.readdirSync(root)
    .filter(fileName => fileName.includes(".migrate-"))
    .map(fileName => path.join(root, fileName));
}

describe("RSGL migrate CLI", () => {
  it("defaults to a dry run without changing the source", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "legacy.rsgl");
    const source = [
      "blockstate example {",
      "  variants {",
      "    [facing=north] -> @minecraft:block/stone uvlock",
      "  }",
      "}"
    ].join("\n");
    try {
      fs.writeFileSync(fileName, source);
      const captured = captureIo();

      assert.strictEqual(runRsglCli(["migrate", fileName], captured.io), 0);
      assert.strictEqual(fs.readFileSync(fileName, "utf8"), source);
      assert.match(captured.stdout(), /Would migrate .*legacy\.rsgl/u);
      assert.match(captured.stdout(), /dry run/u);
      assert.match(captured.stdout(), /--write/u);
      assert.strictEqual(captured.stderr(), "");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a file with spaces and non-ASCII paths using re-exported mode metadata", () => {
    const root = createTempRoot();
    const sourceRoot = path.join(root, "资源 包 source");
    const definitionsFile = path.join(sourceRoot, "definitions.rsgl");
    const publicFile = path.join(sourceRoot, "public.rsgl");
    const mainFile = path.join(sourceRoot, "主 entry.rsgl");
    const mainSource = [
      "import { facingEntries } from \"./public.rsgl\"",
      "blockstate example { use facingEntries() }"
    ].join("\n");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(definitionsFile, [
        "template facingEntries() -> variants {",
        "  { facing: north }: minecraft:block/stone",
        "}",
        "export { facingEntries }"
      ].join("\n"));
      fs.writeFileSync(publicFile, "export { facingEntries } from \"./definitions.rsgl\"");
      fs.writeFileSync(mainFile, mainSource);
      const captured = captureIo();

      assert.strictEqual(runRsglCli(["migrate", mainFile, "--write"], captured.io), 0);
      assert.strictEqual(
        fs.readFileSync(mainFile, "utf8"),
        mainSource.replace("blockstate example", "blockstate variants example")
      );
      assert.match(captured.stdout(), /Migrated .*主 entry\.rsgl/u);
      assert.strictEqual(captured.stderr(), "");
      assert.deepStrictEqual(
        fs.readdirSync(sourceRoot).sort(),
        ["definitions.rsgl", "public.rsgl", "主 entry.rsgl"].sort()
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prints manual issues without manufacturing a file edit", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "ambiguous.rsgl");
    const source = "blockstate empty {}";
    try {
      fs.writeFileSync(fileName, source);
      const captured = captureIo();

      assert.strictEqual(runRsglCli(["migrate", fileName, "--write"], captured.io), 1);
      assert.strictEqual(fs.readFileSync(fileName, "utf8"), source);
      assert.match(captured.stderr(), /blockstateModeSelectionRequired/u);
      assert.match(captured.stdout(), /0 file\(s\) changed, 1 issue\(s\)/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rechecks the moved backup and restores a save made after preflight", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "legacy.rsgl");
    const source = legacyBlockstate("example");
    const concurrentlySavedSource = `${source}\n// saved after migration analysis`;
    let saveInjected = false;
    try {
      fs.writeFileSync(fileName, source);
      const captured = captureIo();
      const fileSystem = transactionFileSystem({
        beforeRename: (sourceFileName, destination) => {
          if (!saveInjected
            && sourceFileName === fileName
            && destination.includes(".migrate-backup-")) {
            saveInjected = true;
            fs.writeFileSync(fileName, concurrentlySavedSource);
          }
        }
      });

      assert.strictEqual(
        runRsglMigrationCommand(
          { target: fileName, write: true },
          captured.io,
          { transactionFileSystem: fileSystem }
        ),
        1
      );
      assert.strictEqual(saveInjected, true);
      assert.strictEqual(fs.readFileSync(fileName, "utf8"), concurrentlySavedSource);
      assert.deepStrictEqual(migrationArtifacts(root), []);
      assert.match(captured.stderr(), /moved file no longer matches the analyzed source/u);
      assert.doesNotMatch(captured.stdout(), /migration complete/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not overwrite a concurrent file that appears before rollback restore", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "legacy.rsgl");
    const source = legacyBlockstate("example");
    const movedSource = `${source}\n// save moved into backup`;
    const concurrentSource = `${source}\n// newer save at the original path`;
    let renameInjected = false;
    try {
      fs.writeFileSync(fileName, source);
      const captured = captureIo();
      const fileSystem = transactionFileSystem({
        beforeRename: (sourceFileName, destination) => {
          if (!renameInjected
            && sourceFileName === fileName
            && destination.includes(".migrate-backup-")) {
            renameInjected = true;
            fs.writeFileSync(fileName, movedSource);
          }
        },
        afterRename: (sourceFileName, destination) => {
          if (renameInjected
            && sourceFileName === fileName
            && destination.includes(".migrate-backup-")) {
            fs.writeFileSync(fileName, concurrentSource);
          }
        }
      });

      assert.strictEqual(
        runRsglMigrationCommand(
          { target: fileName, write: true },
          captured.io,
          { transactionFileSystem: fileSystem }
        ),
        1
      );
      assert.strictEqual(fs.readFileSync(fileName, "utf8"), concurrentSource);
      const artifacts = migrationArtifacts(root);
      assert.strictEqual(artifacts.length, 1);
      assert.match(path.basename(artifacts[0]), /\.migrate-backup-/u);
      assert.strictEqual(fs.readFileSync(artifacts[0], "utf8"), movedSource);
      assert.match(captured.stderr(), /Rollback was incomplete/u);
      assert.ok(captured.stderr().includes(fileName));
      assert.ok(captured.stderr().includes(artifacts[0]));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves a concurrent save when a later file makes the transaction roll back", () => {
    const root = createTempRoot();
    const firstFileName = path.join(root, "a.rsgl");
    const secondFileName = path.join(root, "b.rsgl");
    const firstSource = legacyBlockstate("first");
    const secondSource = legacyBlockstate("second");
    const concurrentSource = "// concurrent editor save during transaction";
    let installedFileName: string | undefined;
    let failureInjected = false;
    try {
      fs.writeFileSync(firstFileName, firstSource);
      fs.writeFileSync(secondFileName, secondSource);
      const captured = captureIo();
      const fileSystem = transactionFileSystem({
        beforeLink: (_source, destination) => {
          if (installedFileName === undefined
            && (destination === firstFileName || destination === secondFileName)) {
            installedFileName = destination;
          }
        },
        beforeRename: (sourceFileName, destination) => {
          if (!failureInjected
            && installedFileName !== undefined
            && sourceFileName !== installedFileName
            && destination.includes(".migrate-backup-")) {
            failureInjected = true;
            fs.writeFileSync(installedFileName, concurrentSource);
            throw new Error("deterministic second-file transaction failure");
          }
        }
      });

      assert.strictEqual(
        runRsglMigrationCommand(
          { target: root, write: true },
          captured.io,
          { transactionFileSystem: fileSystem }
        ),
        1
      );
      assert.strictEqual(failureInjected, true);
      assert.strictEqual(fs.readFileSync(firstFileName, "utf8"), firstSource);
      assert.strictEqual(fs.readFileSync(secondFileName, "utf8"), secondSource);
      const artifacts = migrationArtifacts(root);
      assert.ok(artifacts.length >= 1);
      assert.ok(artifacts.some(artifact => fs.readFileSync(artifact, "utf8") === concurrentSource));
      assert.match(captured.stderr(), /deterministic second-file transaction failure/u);
      assert.match(captured.stderr(), /concurrent content was preserved/u);
      for (const artifact of artifacts) {
        assert.ok(captured.stderr().includes(artifact));
      }
      assert.doesNotMatch(captured.stdout(), /migration complete/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores earlier files when a later file fails without leaving artifacts", () => {
    const root = createTempRoot();
    const firstFileName = path.join(root, "a.rsgl");
    const secondFileName = path.join(root, "b.rsgl");
    const firstSource = legacyBlockstate("first");
    const secondSource = legacyBlockstate("second");
    let installedFileName: string | undefined;
    let failureInjected = false;
    try {
      fs.writeFileSync(firstFileName, firstSource);
      fs.writeFileSync(secondFileName, secondSource);
      const captured = captureIo();
      const fileSystem = transactionFileSystem({
        beforeLink: (_source, destination) => {
          if (installedFileName === undefined
            && (destination === firstFileName || destination === secondFileName)) {
            installedFileName = destination;
          }
        },
        beforeRename: (sourceFileName, destination) => {
          if (!failureInjected
            && installedFileName !== undefined
            && sourceFileName !== installedFileName
            && destination.includes(".migrate-backup-")) {
            failureInjected = true;
            throw new Error("deterministic later-file failure");
          }
        }
      });

      assert.strictEqual(
        runRsglMigrationCommand(
          { target: root, write: true },
          captured.io,
          { transactionFileSystem: fileSystem }
        ),
        1
      );
      assert.strictEqual(failureInjected, true);
      assert.strictEqual(fs.readFileSync(firstFileName, "utf8"), firstSource);
      assert.strictEqual(fs.readFileSync(secondFileName, "utf8"), secondSource);
      assert.deepStrictEqual(migrationArtifacts(root), []);
      assert.match(captured.stderr(), /deterministic later-file failure/u);
      assert.doesNotMatch(captured.stderr(), /Rollback was incomplete/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports post-commit cleanup failures and the retained artifact path", () => {
    const root = createTempRoot();
    const fileName = path.join(root, "legacy.rsgl");
    const source = legacyBlockstate("example");
    let cleanupFailureInjected = false;
    try {
      fs.writeFileSync(fileName, source);
      const captured = captureIo();
      const fileSystem = transactionFileSystem({
        beforeRemove: artifactFileName => {
          if (!cleanupFailureInjected && artifactFileName.includes(".migrate-backup-")) {
            cleanupFailureInjected = true;
            throw new Error("deterministic backup cleanup failure");
          }
        }
      });

      assert.strictEqual(
        runRsglMigrationCommand(
          { target: fileName, write: true },
          captured.io,
          { transactionFileSystem: fileSystem }
        ),
        1
      );
      assert.strictEqual(cleanupFailureInjected, true);
      assert.match(fs.readFileSync(fileName, "utf8"), /^blockstate variants example/u);
      const artifacts = migrationArtifacts(root);
      assert.strictEqual(artifacts.length, 1);
      assert.match(path.basename(artifacts[0]), /\.migrate-backup-/u);
      assert.strictEqual(fs.readFileSync(artifacts[0], "utf8"), source);
      assert.match(captured.stderr(), /Migration was applied, but cleanup was incomplete/u);
      assert.match(captured.stderr(), /deterministic backup cleanup failure/u);
      assert.ok(captured.stderr().includes(artifacts[0]));
      assert.doesNotMatch(captured.stdout(), /migration complete/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
