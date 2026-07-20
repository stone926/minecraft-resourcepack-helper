import {
  isMinecraftJavaVersionText,
  javaResourcePackFormatForMinecraftVersion,
  type JavaResourcePackFormat
} from "../../mc-assets/src";

/** RSGL compatibility alias over the canonical Minecraft asset-layer type. */
export type RsglTargetPackFormat = JavaResourcePackFormat;

export const isRsglMinecraftVersionText = isMinecraftJavaVersionText;

export const rsglTargetPackFormatForMinecraftVersion =
  javaResourcePackFormatForMinecraftVersion;
