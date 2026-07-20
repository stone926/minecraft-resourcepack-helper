import {
  isMinecraftJavaVersionText,
  javaResourcePackFormatForMinecraftVersion
} from "../../packages/mc-assets/src";
import {
  resolveResourceProjectUri,
  resourceProjectUriParent,
  type ResourceLayerConfigurationDto,
  type ResourcePackFormatDto,
  type ResourceProjectConfigurationDto,
  type SerializedResourceUri
} from "../../packages/resource-project/src";

const targetProperties = new Set(["edition", "format", "mc"]);

/** Extracts the canonical project fields without importing the RSGL compiler. */
export function parseResourceProjectConfiguration(
  configUri: SerializedResourceUri,
  text: string
): ResourceProjectConfigurationDto {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!isRecord(value)) {
    throw new Error("Expected the project configuration to be a JSON object.");
  }

  const configRootUri = resourceProjectUriParent(configUri);
  if (!configRootUri) {
    throw new Error(`Project configuration URI has no parent: ${configUri}`);
  }
  const defaultAssetsPath = optionalNullableString(
    value.defaultAssetsPath,
    "defaultAssetsPath"
  );
  const resourcePackRoots = optionalStringArray(value.resourcePackRoots, "resourcePackRoots");
  const targetPackFormat = parseTargetPackFormat(value.target, "target");

  return {
    configUri,
    root: optionalString(value.root, "root"),
    outDir: optionalString(value.outDir, "outDir"),
    ...(defaultAssetsPath === undefined
      ? {}
      : {
        vanillaLayer: defaultAssetsPath === null
          ? null
          : resourceLayerConfigurationFromRoot(
            "vanilla",
            defaultAssetsPath,
            configRootUri,
            0
          )
      }),
    ...(resourcePackRoots === undefined
      ? {}
      : {
        externalLayers: resourcePackRoots.map((root, index) =>
          resourceLayerConfigurationFromRoot("custom", root, configRootUri, index)
        )
      }),
    ...(targetPackFormat ? { targetPackFormat } : {})
  };
}

/** Builds a layer descriptor input without converting remote URIs to native paths. */
export function resourceLayerConfigurationFromRoot(
  role: "custom" | "vanilla",
  root: string,
  baseUri: SerializedResourceUri,
  priority: number
): ResourceLayerConfigurationDto {
  const resolvedRoot = resolveResourceProjectUri(baseUri, root);
  const pathname = new URL(resolvedRoot).pathname;
  const source = /\.jar$/i.test(pathname) && role === "vanilla"
    ? "clientJar"
    : /\.(?:zip|jar)$/i.test(pathname)
      ? "zip"
      : "directory";
  return { role, source, root: resolvedRoot, priority };
}

function parseTargetPackFormat(
  value: unknown,
  field: string
): ResourcePackFormatDto | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`Expected '${field}' to be an object.`);
  }
  for (const property of Object.keys(value)) {
    if (!targetProperties.has(property)) {
      throw new Error(`Unknown property '${field}.${property}'.`);
    }
  }
  if (value.edition !== "java") {
    throw new Error(`Expected '${field}.edition' to be 'java'.`);
  }

  const hasFormat = Object.prototype.hasOwnProperty.call(value, "format");
  const hasMinecraftVersion = Object.prototype.hasOwnProperty.call(value, "mc");
  if (hasFormat === hasMinecraftVersion) {
    throw new Error(`Expected '${field}' to contain exactly one of 'format' or 'mc'.`);
  }
  if (hasFormat) {
    return parseTargetFormat(value.format, `${field}.format`);
  }
  if (typeof value.mc !== "string") {
    throw new Error(`Expected '${field}.mc' to be a Minecraft version string.`);
  }
  if (!isMinecraftJavaVersionText(value.mc)) {
    throw new Error(`Expected '${field}.mc' to be a version like '1.21.4'.`);
  }
  const target = javaResourcePackFormatForMinecraftVersion(value.mc);
  if (!target) {
    throw new Error(`Unknown Minecraft version '${value.mc}' in '${field}.mc'.`);
  }
  return target;
}

function parseTargetFormat(value: unknown, field: string): ResourcePackFormatDto {
  if (typeof value === "number") {
    return { major: requirePositiveSafeInteger(value, field), minor: 0 };
  }
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error(`Expected '${field}' to be a positive integer or [major, minor] pair.`);
  }
  return {
    major: requirePositiveSafeInteger(value[0], `${field}[0]`),
    minor: requireNonNegativeSafeInteger(value[1], `${field}[1]`)
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected '${field}' to be a string.`);
  }
  return value;
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  return value === null ? null : optionalString(value, field);
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Expected '${field}' to be an array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`Expected '${field}[${index}]' to be a string.`);
    }
    return entry;
  });
}

function requirePositiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected '${field}' to be a positive safe integer.`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Expected '${field}' to be a non-negative safe integer.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
