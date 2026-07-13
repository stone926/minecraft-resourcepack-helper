/**
 * Pure blockstate model-object rules shared by semantic checking and runtime
 * lowering. This module deliberately has no parser, semantic, or compiler
 * dependency so both layers can use exactly the same closed shape.
 */

export const BLOCKSTATE_MODEL_OBJECT_FIELDS = [
  "model",
  "x",
  "y",
  "z",
  "uvlock",
  "weight"
] as const;

export const BLOCKSTATE_MODEL_MODIFIER_FIELDS = [
  "x",
  "y",
  "z",
  "uvlock",
  "weight"
] as const;

export type BlockstateModelObjectField = typeof BLOCKSTATE_MODEL_OBJECT_FIELDS[number];
export type BlockstateModelModifierField = typeof BLOCKSTATE_MODEL_MODIFIER_FIELDS[number];

const objectFields = new Set<string>(BLOCKSTATE_MODEL_OBJECT_FIELDS);
const modifierFields = new Set<string>(BLOCKSTATE_MODEL_MODIFIER_FIELDS);

export function isBlockstateModelObjectField(value: string): value is BlockstateModelObjectField {
  return objectFields.has(value);
}

export function isBlockstateModelModifierField(value: string): value is BlockstateModelModifierField {
  return modifierFields.has(value);
}

export function isBlockstateQuarterTurn(value: number): boolean {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
