/** Java resource-pack format resolved from a concrete Minecraft release. */
export interface JavaResourcePackFormat {
  major: number;
  minor: number;
}

const minecraftJavaVersionPattern = /^\d+\.\d+(?:\.\d+)?$/;
export const currentMinecraftJavaVersion = "26.2";
export const legacyResourcePackFormatBoundaryMinecraftVersion = "1.21.8";

/**
 * Canonical release-to-resource-pack-format registry shared by every product
 * surface. Keep this table aligned with the repository compatibility manual.
 */
const javaResourcePackFormatsByMinecraftVersion = new Map<string, JavaResourcePackFormat>([
  [currentMinecraftJavaVersion, { major: 88, minor: 0 }],
  ["26.1.2", { major: 84, minor: 0 }],
  ["26.1.1", { major: 84, minor: 0 }],
  ["26.1", { major: 84, minor: 0 }],
  ["1.21.11", { major: 75, minor: 0 }],
  ["1.21.10", { major: 69, minor: 0 }],
  ["1.21.9", { major: 69, minor: 0 }],
  [legacyResourcePackFormatBoundaryMinecraftVersion, { major: 64, minor: 0 }],
  ["1.21.7", { major: 64, minor: 0 }],
  ["1.21.6", { major: 63, minor: 0 }],
  ["1.21.5", { major: 55, minor: 0 }],
  ["1.21.4", { major: 46, minor: 0 }],
  ["1.21.3", { major: 42, minor: 0 }],
  ["1.21.2", { major: 42, minor: 0 }],
  ["1.21.1", { major: 34, minor: 0 }],
  ["1.21", { major: 34, minor: 0 }],
  ["1.20.6", { major: 32, minor: 0 }],
  ["1.20.5", { major: 32, minor: 0 }],
  ["1.20.4", { major: 22, minor: 0 }],
  ["1.20.3", { major: 22, minor: 0 }],
  ["1.20.2", { major: 18, minor: 0 }],
  ["1.20.1", { major: 15, minor: 0 }],
  ["1.20", { major: 15, minor: 0 }],
  ["1.19.4", { major: 13, minor: 0 }],
  ["1.19.3", { major: 12, minor: 0 }],
  ["1.19.2", { major: 9, minor: 0 }],
  ["1.19.1", { major: 9, minor: 0 }],
  ["1.19", { major: 9, minor: 0 }],
  ["1.18.2", { major: 8, minor: 0 }],
  ["1.18.1", { major: 8, minor: 0 }],
  ["1.18", { major: 8, minor: 0 }],
  ["1.17.1", { major: 7, minor: 0 }],
  ["1.17", { major: 7, minor: 0 }],
  ["1.16.5", { major: 6, minor: 0 }],
  ["1.16.4", { major: 6, minor: 0 }],
  ["1.16.3", { major: 6, minor: 0 }],
  ["1.16.2", { major: 6, minor: 0 }],
  ["1.16.1", { major: 5, minor: 0 }],
  ["1.16", { major: 5, minor: 0 }],
  ["1.15.2", { major: 5, minor: 0 }],
  ["1.15.1", { major: 5, minor: 0 }],
  ["1.15", { major: 5, minor: 0 }]
]);

export function isMinecraftJavaVersionText(value: string): boolean {
  return minecraftJavaVersionPattern.test(value);
}

/** Resolves a supported release without exposing the mutable registry entry. */
export function javaResourcePackFormatForMinecraftVersion(
  minecraftVersion: string
): JavaResourcePackFormat | null {
  const target = javaResourcePackFormatsByMinecraftVersion.get(minecraftVersion);
  return target ? { ...target } : null;
}

/** Stable format baseline used by metadata evaluation and new-pack scaffolding. */
export const currentJavaResourcePackFormat: Readonly<JavaResourcePackFormat> =
  Object.freeze(requiredJavaResourcePackFormat(currentMinecraftJavaVersion));

/** Last integer-only format understood by the legacy overlay declaration. */
export const legacyJavaResourcePackFormatBoundary =
  requiredJavaResourcePackFormat(legacyResourcePackFormatBoundaryMinecraftVersion).major;

function requiredJavaResourcePackFormat(minecraftVersion: string): JavaResourcePackFormat {
  const format = javaResourcePackFormatForMinecraftVersion(minecraftVersion);
  if (!format) {
    throw new Error(`Missing Java resource-pack format for ${minecraftVersion}`);
  }
  return format;
}
