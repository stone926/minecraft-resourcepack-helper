import type { PreviewTransform, PreviewVec3 } from "../ir/PreviewDocument";

export function normalizeDisplayTransforms(value: unknown): Record<string, PreviewTransform> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const transforms: Record<string, PreviewTransform> = {};
  for (const [name, rawTransform] of Object.entries(value as Record<string, unknown>)) {
    if (!rawTransform || typeof rawTransform !== "object" || Array.isArray(rawTransform)) {
      continue;
    }

    const transform = rawTransform as Record<string, unknown>;
    transforms[name] = {
      rotation: vectorOrDefault(transform.rotation, [0, 0, 0]),
      translation: clampVector(vectorOrDefault(transform.translation, [0, 0, 0]), -80, 80),
      scale: clampVector(vectorOrDefault(transform.scale, [1, 1, 1]), -4, 4)
    };
  }

  return transforms;
}

export function normalizePartialDisplayTransforms(value: unknown): Record<string, Partial<PreviewTransform>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const transforms: Record<string, Partial<PreviewTransform>> = {};
  for (const [name, rawTransform] of Object.entries(value as Record<string, unknown>)) {
    if (!rawTransform || typeof rawTransform !== "object" || Array.isArray(rawTransform)) {
      continue;
    }

    const transform = rawTransform as Record<string, unknown>;
    transforms[name] = {};
    const rotation = vectorOrUndefined(transform.rotation);
    const translation = vectorOrUndefined(transform.translation);
    const scale = vectorOrUndefined(transform.scale);

    if (rotation) {
      transforms[name].rotation = rotation;
    }
    if (translation) {
      transforms[name].translation = clampVector(translation, -80, 80);
    }
    if (scale) {
      transforms[name].scale = clampVector(scale, -4, 4);
    }
  }

  return transforms;
}

function vectorOrDefault(value: unknown, fallback: PreviewVec3): PreviewVec3 {
  return vectorOrUndefined(value) ?? fallback;
}

function vectorOrUndefined(value: unknown): PreviewVec3 | undefined {
  if (!Array.isArray(value) || value.length < 3) {
    return undefined;
  }

  const vector = value.slice(0, 3).map(item => typeof item === "number" && Number.isFinite(item) ? item : undefined);
  if (!vector.every((item): item is number => item !== undefined)) {
    return undefined;
  }

  return [vector[0], vector[1], vector[2]];
}

function clampVector(value: PreviewVec3, min: number, max: number): PreviewVec3 {
  return [
    clamp(value[0], min, max),
    clamp(value[1], min, max),
    clamp(value[2], min, max)
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
