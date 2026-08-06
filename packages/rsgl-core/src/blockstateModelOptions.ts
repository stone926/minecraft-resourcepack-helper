/**
 * Single source of truth for the option fields a blockstate model spec's
 * `with { ... }` block accepts. Parser validation, semantic checking, compiler
 * lowering, JSON validation, emitted key order, and completion all derive
 * from this table; declaration order is the canonical emitted JSON key order.
 */
export type RsglBlockstateModelOptionType = "number" | "boolean";

export interface RsglBlockstateModelOption {
  /** RSGL field name, which is also the emitted JSON key. */
  readonly name: string;
  readonly type: RsglBlockstateModelOptionType;
}

export const blockstateModelOptions = [
  { name: "x", type: "number" },
  { name: "y", type: "number" },
  { name: "z", type: "number" },
  { name: "uvlock", type: "boolean" }
] as const satisfies readonly RsglBlockstateModelOption[];

export type RsglBlockstateModelOptionName = (typeof blockstateModelOptions)[number]["name"];

export const blockstateModelOptionNames: readonly RsglBlockstateModelOptionName[] =
  blockstateModelOptions.map(option => option.name);

export const blockstateModelOptionNameSet: ReadonlySet<string> = new Set(blockstateModelOptionNames);

export function blockstateModelOptionType(
  name: string
): RsglBlockstateModelOptionType | undefined {
  return blockstateModelOptions.find(option => option.name === name)?.type;
}
