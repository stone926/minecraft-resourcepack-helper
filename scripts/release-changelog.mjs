const maintenanceNotes = Object.freeze(["- Maintenance release."]);

/** Return a raw section body normalized to LF, or null when its heading is absent. */
export function changelogSection(content, title) {
  const normalized = normalizeChangelog(content);
  return locateChangelogSection(normalized, title)?.body ?? null;
}

export function hasChangelogSection(content, title) {
  return changelogSection(content, title) !== null;
}

/** Select the notes promoted by a new release or reused by an explicit current release. */
export function selectReleaseNotes(content, { version, taggingCurrentVersion }) {
  const title = taggingCurrentVersion ? version : "Unreleased";
  const body = changelogSection(content, title)?.trim();
  if (!body) {
    return [...maintenanceNotes];
  }
  return body
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean);
}

/**
 * Insert a dated release section and return a normalized changelog with one
 * trailing LF. The caller supplies the date to keep this transformation pure.
 */
export function insertReleaseSection(content, { version, date, notes }) {
  let normalized = normalizeChangelog(content);
  if (normalized.includes(`## [${version}]`)) {
    throw new Error(`Changelog already contains an entry for ${version}.`);
  }
  if (!normalized.startsWith("# Changelog")) {
    normalized = `# Changelog\n\n${normalized}`;
  }

  const entry = `## [${version}] - ${date}\n\n${notes.join("\n")}\n\n`;
  const unreleased = locateChangelogSection(normalized, "Unreleased");
  if (unreleased) {
    const beforeBody = normalized.slice(0, unreleased.bodyStart);
    const afterBody = normalized.slice(unreleased.bodyEnd).trimStart();
    normalized = `${beforeBody}\n${entry}${afterBody}`;
  } else {
    const firstVersion = normalized.search(/\n## \[/);
    normalized = firstVersion < 0
      ? `${normalized.trimEnd()}\n\n${entry}`
      : `${normalized.slice(0, firstVersion).trimEnd()}\n\n${entry}${normalized.slice(firstVersion).trimStart()}`;
  }
  return `${normalized.trimEnd()}\n`;
}

function normalizeChangelog(content) {
  return content.replace(/\r\n/g, "\n");
}

function locateChangelogSection(content, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^## \\[${escaped}\\][^\\n]*\\n`, "m").exec(content);
  if (!match) {
    return null;
  }
  const bodyStart = match.index + match[0].length;
  const nextHeading = /^## \[/gm;
  nextHeading.lastIndex = bodyStart;
  const next = nextHeading.exec(content);
  const bodyEnd = next?.index ?? content.length;
  return {
    body: content.slice(bodyStart, bodyEnd),
    bodyStart,
    bodyEnd
  };
}
