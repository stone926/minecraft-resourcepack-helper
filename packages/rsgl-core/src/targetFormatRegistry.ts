/** Frontend-safe Java resource-pack target registry shared by compiler and LSP. */
export interface RsglTargetPackFormat {
  major: number;
  minor: number;
}

const minecraftVersionPattern = /^\d+\.\d+(?:\.\d+)?$/;

const javaResourcePackFormatsByMinecraftVersion = new Map<string, RsglTargetPackFormat>([
  ["26.2", { major: 88, minor: 0 }],
  ["26.1.2", { major: 84, minor: 0 }],
  ["26.1.1", { major: 84, minor: 0 }],
  ["26.1", { major: 84, minor: 0 }],
  ["1.21.11", { major: 75, minor: 0 }],
  ["1.21.10", { major: 69, minor: 0 }],
  ["1.21.9", { major: 69, minor: 0 }],
  ["1.21.8", { major: 64, minor: 0 }],
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
  ["1.20.3", { major: 18, minor: 0 }],
  ["1.20.2", { major: 18, minor: 0 }],
  ["1.20.1", { major: 15, minor: 0 }],
  ["1.20", { major: 15, minor: 0 }],
  ["1.19.4", { major: 13, minor: 0 }],
  ["1.19.3", { major: 12, minor: 0 }],
  ["1.19.2", { major: 12, minor: 0 }],
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

export function isRsglMinecraftVersionText(value: string): boolean {
  return minecraftVersionPattern.test(value);
}

/** Resolves a supported Minecraft version without exposing the mutable registry. */
export function rsglTargetPackFormatForMinecraftVersion(
  minecraftVersion: string
): RsglTargetPackFormat | null {
  const target = javaResourcePackFormatsByMinecraftVersion.get(minecraftVersion);
  return target ? { ...target } : null;
}
