import * as assert from "node:assert/strict";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

interface PlainSemver {
  major: number;
  minor: number;
  patch: number;
}

interface ReleaseVersionModule {
  parsePlainSemver(value: string): PlainSemver | null;
  comparePlainSemver(left: PlainSemver, right: PlainSemver): number;
  resolveNextReleaseVersion(
    currentVersion: string,
    input: string,
    options?: { manifestPath?: string }
  ): string;
}

interface ReleaseChangelogModule {
  changelogSection(content: string, title: string): string | null;
  hasChangelogSection(content: string, title: string): boolean;
  selectReleaseNotes(
    content: string,
    options: { version: string; taggingCurrentVersion: boolean }
  ): string[];
  insertReleaseSection(
    content: string,
    options: { version: string; date: string; notes: string[] }
  ): string;
}

describe("release version and changelog logic", () => {
  let versions: ReleaseVersionModule;
  let changelog: ReleaseChangelogModule;

  before(async () => {
    const scriptsRoot = path.join(process.cwd(), "scripts");
    versions = await importModule<ReleaseVersionModule>(
      path.join(scriptsRoot, "release-version.mjs")
    );
    changelog = await importModule<ReleaseChangelogModule>(
      path.join(scriptsRoot, "release-changelog.mjs")
    );
  });

  it("resolves named bumps and explicit greater versions", () => {
    assert.deepStrictEqual(versions.parsePlainSemver("1.2.3"), {
      major: 1,
      minor: 2,
      patch: 3
    });
    assert.strictEqual(
      versions.comparePlainSemver(
        { major: 1, minor: 3, patch: 0 },
        { major: 1, minor: 2, patch: 9 }
      ) > 0,
      true
    );
    assert.strictEqual(versions.resolveNextReleaseVersion("1.2.3", "patch"), "1.2.4");
    assert.strictEqual(versions.resolveNextReleaseVersion("1.2.3", "minor"), "1.3.0");
    assert.strictEqual(versions.resolveNextReleaseVersion("1.2.3", "major"), "2.0.0");
    assert.strictEqual(versions.resolveNextReleaseVersion("1.2.3", "2.1.0"), "2.1.0");
  });

  it("preserves the existing narrow version contract and error messages", () => {
    assert.strictEqual(versions.parsePlainSemver("1.2.3-beta.1"), null);
    assert.strictEqual(versions.parsePlainSemver("1.2.3+build"), null);
    assert.strictEqual(versions.parsePlainSemver("9007199254740992.0.0"), null);
    assert.deepStrictEqual(versions.parsePlainSemver("01.002.0003"), {
      major: 1,
      minor: 2,
      patch: 3
    });
    assert.strictEqual(
      versions.resolveNextReleaseVersion("01.002.0003", "patch"),
      "1.2.4"
    );
    assert.strictEqual(
      versions.resolveNextReleaseVersion("1.2.3", "01.002.0004"),
      "01.002.0004"
    );
    assert.throws(
      () => versions.resolveNextReleaseVersion("not-a-version", "patch", {
        manifestPath: "packages/example/package.json"
      }),
      /packages\/example\/package\.json version is not a plain semver version: not-a-version/
    );
    assert.throws(
      () => versions.resolveNextReleaseVersion("1.2.3", "current"),
      /Invalid release version or bump type: current/
    );
    assert.throws(
      () => versions.resolveNextReleaseVersion("1.2.3", "1.2.3"),
      /Next version 1\.2\.3 must be greater than current version 1\.2\.3\./
    );
    assert.throws(
      () => versions.resolveNextReleaseVersion("1.2.3", "1.1.9"),
      /Next version 1\.1\.9 must be greater than current version 1\.2\.3\./
    );
    assert.throws(
      () => versions.resolveNextReleaseVersion("1.2.9007199254740991", "patch"),
      /Cannot bump patch beyond JavaScript's safe integer range/
    );
  });

  it("parses CRLF sections, escaped titles, and only bracketed release boundaries", () => {
    const content = [
      "# Changelog",
      "",
      "## [1.2.3+fixture] - 2026-07-18",
      "",
      "- first  ",
      "",
      "## Commentary",
      "",
      "Still part of this release.",
      "",
      "## [1.2.2]",
      "",
      "- older",
      ""
    ].join("\r\n");

    const section = changelog.changelogSection(content, "1.2.3+fixture");
    assert.notStrictEqual(section, null);
    assert.strictEqual(section?.includes("## Commentary"), true);
    assert.strictEqual(section?.includes("Still part of this release."), true);
    assert.strictEqual(section?.includes("- older"), false);
    assert.strictEqual(section?.includes("\r"), false);

    const adjacent = "## [Empty]\n## [Next]\n\n- next\n";
    assert.strictEqual(changelog.changelogSection(adjacent, "Empty"), "");
    assert.strictEqual(changelog.hasChangelogSection(adjacent, "Empty"), true);
    assert.strictEqual(changelog.changelogSection(adjacent, "Missing"), null);
  });

  it("selects Unreleased or current-version notes with the established fallback", () => {
    const content = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "- next change  ",
      "",
      "  - nested detail  ",
      "",
      "## [1.2.3] - 2026-07-18",
      "",
      "- current release",
      ""
    ].join("\n");

    assert.deepStrictEqual(
      changelog.selectReleaseNotes(content, {
        version: "1.2.3",
        taggingCurrentVersion: false
      }),
      ["- next change", "  - nested detail"]
    );
    assert.deepStrictEqual(
      changelog.selectReleaseNotes(content, {
        version: "1.2.3",
        taggingCurrentVersion: true
      }),
      ["- current release"]
    );
    assert.deepStrictEqual(
      changelog.selectReleaseNotes("## [Unreleased]\n\n", {
        version: "1.2.3",
        taggingCurrentVersion: false
      }),
      ["- Maintenance release."]
    );
    assert.deepStrictEqual(
      changelog.selectReleaseNotes(content, {
        version: "9.9.9",
        taggingCurrentVersion: true
      }),
      ["- Maintenance release."]
    );
  });

  it("promotes Unreleased notes into a dated section without retaining CRLF", () => {
    const content = [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "- pending",
      "",
      "## [1.0.0] - 2026-01-01",
      "",
      "- initial",
      ""
    ].join("\r\n");
    const updated = changelog.insertReleaseSection(content, {
      version: "1.1.0",
      date: "2026-07-18",
      notes: ["- pending"]
    });

    assert.strictEqual(updated.includes("\r"), false);
    assert.strictEqual(updated.endsWith("\n"), true);
    assert.strictEqual(updated.endsWith("\n\n"), false);
    assert.strictEqual(
      updated,
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "## [1.1.0] - 2026-07-18",
        "",
        "- pending",
        "",
        "## [1.0.0] - 2026-01-01",
        "",
        "- initial",
        ""
      ].join("\n")
    );
  });

  it("adds a changelog header, inserts before existing releases, and rejects duplicates", () => {
    const content = "Release history\n\n## [1.0.0]\n\n- initial\n";
    const updated = changelog.insertReleaseSection(content, {
      version: "1.1.0",
      date: "2026-07-18",
      notes: ["- next"]
    });

    assert.strictEqual(updated.startsWith("# Changelog\n\nRelease history"), true);
    assert.ok(updated.indexOf("## [1.1.0]") < updated.indexOf("## [1.0.0]"));
    assert.throws(
      () => changelog.insertReleaseSection(updated, {
        version: "1.1.0",
        date: "2026-07-18",
        notes: ["- duplicate"]
      }),
      /Changelog already contains an entry for 1\.1\.0\./
    );

    const created = changelog.insertReleaseSection("", {
      version: "1.0.0",
      date: "2026-07-18",
      notes: ["- initial"]
    });
    assert.strictEqual(
      created,
      "# Changelog\n\n## [1.0.0] - 2026-07-18\n\n- initial\n"
    );
  });
});

async function importModule<T>(fileName: string): Promise<T> {
  return await import(pathToFileURL(fileName).href) as T;
}
