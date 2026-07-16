import {
  rsglTargetPackFormatForMinecraftVersion,
  type RsglTargetPackFormat
} from "../targetFormatRegistry";

export {
  isRsglMinecraftVersionText,
  rsglTargetPackFormatForMinecraftVersion,
  type RsglTargetPackFormat
} from "../targetFormatRegistry";

/** Public project-target shape accepted by rsgl.config.json. */
export type RsglTargetConfig =
  | {
    edition: "java";
    format: number | [number, number];
    mc?: never;
  }
  | {
    edition: "java";
    mc: string;
    format?: never;
  };

/** Normalized project-wide target constraint used by compiler internals. */
export interface RsglNormalizedProjectTarget {
  edition: "java";
  packFormat: RsglTargetPackFormat;
}

/** Converts the public target syntax into a canonical compiler constraint. */
export function normalizeRsglProjectTarget(
  target: RsglTargetConfig
): RsglNormalizedProjectTarget {
  if ("format" in target && target.format !== undefined) {
    const [major, minor] = Array.isArray(target.format)
      ? target.format
      : [target.format, 0];
    return {
      edition: "java",
      packFormat: { major, minor }
    };
  }

  const packFormat = rsglTargetPackFormatForMinecraftVersion(target.mc);
  if (!packFormat) {
    throw new Error(`No Java resource pack format mapping is defined for Minecraft ${target.mc}.`);
  }
  return { edition: "java", packFormat };
}
