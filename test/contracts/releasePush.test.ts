import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface PushResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

interface PushOptions {
  remoteName: string;
  branchName: string;
  tagName: string;
  expectedCommit: string;
  expectedTagObject: string;
  maxAttempts?: number;
  resumeCommand?: string;
  pushAttempt?: (args: string[], cwd: string) => PushResult | Promise<PushResult>;
  readBack?: (state: {
    expectedCommit: string;
    expectedTagObject: string;
  }) => boolean | Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: { info(message: string): void; warn(message: string): void };
  writeOutput?: (stdout: string, stderr: string) => void;
}

interface ReleasePushModule {
  isTransientGitTransportFailure(output: string): boolean;
  captureGitRemote(args: string[], options?: {
    maxAttempts?: number;
    runAttempt?: (args: string[], cwd: string) => PushResult | Promise<PushResult>;
    sleep?: (milliseconds: number) => Promise<void>;
    logger?: { info(message: string): void; warn(message: string): void };
    writeOutput?: (stdout: string, stderr: string) => void;
  }): Promise<string>;
  pushReleaseRefs(options: PushOptions): Promise<void>;
}

describe("release Git push", () => {
  let releasePush: ReleasePushModule;

  before(async () => {
    const moduleUrl = pathToFileURL(path.join(
      process.cwd(),
      "scripts",
      "release-push.mjs"
    )).href;
    releasePush = await import(moduleUrl) as ReleasePushModule;
  });

  it("pushes the branch and exactly one release tag atomically", async () => {
    const attempts: string[][] = [];
    await releasePush.pushReleaseRefs({
      ...baseOptions(),
      pushAttempt: args => {
        attempts.push([...args]);
        return { status: 0 };
      }
    });

    assert.deepStrictEqual(attempts, [[
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/master",
      "refs/tags/v2.3.2"
    ]]);
  });

  it("accepts a failed acknowledgement only after remote readback verifies both refs", async () => {
    let readbacks = 0;
    await releasePush.pushReleaseRefs({
      ...baseOptions(),
      pushAttempt: () => ({
        status: 128,
        stderr: "Connection closed by 140.82.121.4 port 22"
      }),
      readBack: state => {
        readbacks++;
        assert.strictEqual(state.expectedCommit, baseOptions().expectedCommit);
        assert.strictEqual(state.expectedTagObject, baseOptions().expectedTagObject);
        return true;
      }
    });

    assert.strictEqual(readbacks, 1);
  });

  it("retries bounded transport failures with backoff", async () => {
    let attempts = 0;
    const waits: number[] = [];
    await releasePush.pushReleaseRefs({
      ...baseOptions(),
      pushAttempt: () => ({
        status: ++attempts === 3 ? 0 : 128,
        stderr: "ssh: connect to host github.com port 22: Connection timed out"
      }),
      readBack: () => false,
      sleep: async milliseconds => {
        waits.push(milliseconds);
      }
    });

    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(waits, [2_000, 4_000]);
  });

  it("does not retry authentication or ref-policy failures", async () => {
    let attempts = 0;
    await assert.rejects(
      releasePush.pushReleaseRefs({
        ...baseOptions(),
        resumeCommand: "node scripts/release.mjs main current --resume --skip-tests",
        pushAttempt: () => {
          attempts++;
          return { status: 128, stderr: "Permission denied (publickey)." };
        },
        readBack: () => false
      }),
      (error: Error) => {
        assert.match(error.message, /git push --atomic origin/);
        assert.match(error.message, /release\.mjs main current --resume/);
        assert.match(error.message, /local release commit and annotated tag were kept/i);
        return true;
      }
    );
    assert.strictEqual(attempts, 1);
  });

  it("classifies the observed GitHub SSH disconnect as transient", () => {
    assert.strictEqual(
      releasePush.isTransientGitTransportFailure("Connection closed by 140.82.121.4 port 22"),
      true
    );
    assert.strictEqual(
      releasePush.isTransientGitTransportFailure("remote: permission to repository denied"),
      false
    );
  });

  it("retries a read-only remote preflight after the observed SSH disconnect", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const output = await releasePush.captureGitRemote(
      ["ls-remote", "--tags", "origin", "refs/tags/v2.3.2"],
      {
        runAttempt: () => ++attempts === 1
          ? { status: 128, stderr: "Connection closed by 140.82.121.4 port 22" }
          : { status: 0, stdout: "abc123\trefs/tags/v2.3.2\n" },
        sleep: async milliseconds => {
          waits.push(milliseconds);
        },
        logger: { info: () => undefined, warn: () => undefined },
        writeOutput: () => undefined
      }
    );

    assert.strictEqual(output, "abc123\trefs/tags/v2.3.2");
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(waits, [2_000]);
  });
});

function baseOptions(): PushOptions {
  return {
    remoteName: "origin",
    branchName: "master",
    tagName: "v2.3.2",
    expectedCommit: "0123456789abcdef0123456789abcdef01234567",
    expectedTagObject: "89abcdef0123456789abcdef0123456789abcdef",
    readBack: () => false,
    sleep: async () => undefined,
    logger: { info: () => undefined, warn: () => undefined },
    writeOutput: () => undefined
  };
}
