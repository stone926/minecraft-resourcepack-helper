import { JsonValue, RsglMapping } from "./ir";
import { isJsonObject, overrideJsonObject } from "./jsonObjectMerge";

export interface RsglBlockstateFragment {
  variants?: Record<string, JsonValue>;
  multipart?: JsonValue[];
  mappings?: RsglMapping[];
}

export interface RsglBlockstateFragmentOptions {
  onError?: (code: string, message: string, range: { start: number; end: number }) => void;
}

export interface RsglBlockstateAppendResult {
  applied: Record<string, JsonValue>;
  multipartOffset: number;
}

export function mergeBlockstateContent(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === "variants" && isJsonObject(value)) {
      mergeBlockstateFragment(target, { variants: value }, range, options);
    } else if (key === "multipart" && Array.isArray(value)) {
      mergeBlockstateFragment(target, { multipart: value }, range, options);
    } else {
      target[key] = value;
    }
  }
}

export function overrideBlockstateContent(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  create: boolean,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): Record<string, JsonValue> {
  const applied: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "variants") {
      const variants = overrideBlockstateVariants(target, value, create, range, options);
      if (Object.keys(variants).length > 0) {
        applied.variants = variants;
      }
    } else if (key === "multipart") {
      const multipart = overrideBlockstateMultipart(target, value, create, range, options);
      if (multipart) {
        applied.multipart = multipart;
      }
    } else {
      Object.assign(applied, overrideJsonObject(target, { [key]: value }, create, { onError: options.onError, range }));
    }
  }
  return applied;
}

export function appendBlockstateContent(
  target: Record<string, JsonValue>,
  source: Record<string, JsonValue>,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): RsglBlockstateAppendResult {
  const applied: Record<string, JsonValue> = {};
  let multipartOffset = 0;
  for (const [key, value] of Object.entries(source)) {
    if (key === "multipart") {
      const result = appendBlockstateMultipart(target, value, range, options);
      if (result) {
        applied.multipart = result.applied;
        multipartOffset = result.offset;
      }
    } else {
      options.onError?.("rsgl.appendIncompatibleField", `append cannot merge blockstate field '${key}' because blockstate append is limited to array sections such as 'multipart'.`, range);
    }
  }
  return { applied, multipartOffset };
}

export function mergeBlockstateFragment(
  target: Record<string, JsonValue>,
  fragment: RsglBlockstateFragment,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions = {}
): void {
  if (fragment.variants) {
    if (target.multipart) {
      options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
      return;
    }
    const variants = isJsonObject(target.variants) ? target.variants : {};
    Object.assign(variants, fragment.variants);
    target.variants = variants;
  }
  if (fragment.multipart) {
    if (target.variants) {
      options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
      return;
    }
    const multipart = Array.isArray(target.multipart) ? target.multipart : [];
    multipart.push(...fragment.multipart);
    target.multipart = multipart;
  }
}

function overrideBlockstateVariants(
  target: Record<string, JsonValue>,
  value: JsonValue,
  create: boolean,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions
): Record<string, JsonValue> {
  if (!isJsonObject(value)) {
    options.onError?.("rsgl.invalidBlockstateVariantsFragment", "blockstate variants override must be an object.", range);
    return {};
  }
  if (target.multipart !== undefined) {
    options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
    return {};
  }
  if (target.variants === undefined) {
    if (!create) {
      options.onError?.("rsgl.overrideMissingField", "override cannot create missing field '/variants' without 'create'.", range);
      return {};
    }
    target.variants = {};
  }
  if (!isJsonObject(target.variants)) {
    target.variants = {};
  }
  return overrideJsonObject(target.variants, value, create, { onError: options.onError, path: "/variants", range });
}

function overrideBlockstateMultipart(
  target: Record<string, JsonValue>,
  value: JsonValue,
  create: boolean,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions
): JsonValue[] | null {
  if (!Array.isArray(value)) {
    options.onError?.("rsgl.invalidBlockstateMultipartFragment", "blockstate multipart override must be an array.", range);
    return null;
  }
  if (target.variants !== undefined) {
    options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
    return null;
  }
  if (target.multipart === undefined && !create) {
    options.onError?.("rsgl.overrideMissingField", "override cannot create missing field '/multipart' without 'create'.", range);
    return null;
  }
  target.multipart = value;
  return value;
}

function appendBlockstateMultipart(
  target: Record<string, JsonValue>,
  value: JsonValue,
  range: { start: number; end: number },
  options: RsglBlockstateFragmentOptions
): { applied: JsonValue[]; offset: number } | null {
  if (!Array.isArray(value)) {
    options.onError?.("rsgl.invalidBlockstateMultipartFragment", "blockstate multipart append must be an array.", range);
    return null;
  }
  if (target.variants !== undefined) {
    options.onError?.("rsgl.blockstateSectionConflict", "A blockstate body should use either variants or multipart, not both.", range);
    return null;
  }
  if (target.multipart === undefined) {
    target.multipart = value;
    return { applied: value, offset: 0 };
  }
  if (!Array.isArray(target.multipart)) {
    options.onError?.("rsgl.appendIncompatibleField", "append cannot merge blockstate field '/multipart' because the existing value is not an array.", range);
    return null;
  }
  const offset = target.multipart.length;
  target.multipart = [...target.multipart, ...value];
  return { applied: value, offset };
}
