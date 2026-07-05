import { CallExprNode } from "../parser";
import {
  booleanType,
  modelIdType,
  resourceIdType,
  RsglSignature,
  stringType
} from "./types";

export const blockstateTemplateUseNames = ["stairs", "slab", "fence", "wall", "pane"] as const;

export function isBlockstateTemplateUseName(name: string): boolean {
  return (blockstateTemplateUseNames as readonly string[]).includes(name);
}

export const blockstateTemplateIdParameters = new Map<string, RsglSignature["parameters"]>([
  ["stairs", [
    { name: "id", type: resourceIdType, optional: false },
    { name: "base", type: modelIdType, optional: true },
    { name: "inner", type: modelIdType, optional: true },
    { name: "outer", type: modelIdType, optional: true },
    { name: "uvlock", type: booleanType, optional: true },
    { name: "models", type: stringType, optional: true }
  ]],
  ["slab", [
    { name: "id", type: resourceIdType, optional: false },
    { name: "bottom", type: modelIdType, optional: true },
    { name: "top", type: modelIdType, optional: true },
    { name: "double", type: modelIdType, optional: false }
  ]],
  ["fence", [
    { name: "id", type: resourceIdType, optional: false },
    { name: "post", type: modelIdType, optional: true },
    { name: "side", type: modelIdType, optional: true }
  ]],
  ["wall", [
    { name: "id", type: resourceIdType, optional: false },
    { name: "post", type: modelIdType, optional: true },
    { name: "side", type: modelIdType, optional: true },
    { name: "sideTall", type: modelIdType, optional: true }
  ]],
  ["pane", [
    { name: "id", type: resourceIdType, optional: false },
    { name: "post", type: modelIdType, optional: true },
    { name: "side", type: modelIdType, optional: true },
    { name: "sideAlt", type: modelIdType, optional: true },
    { name: "noSide", type: modelIdType, optional: true },
    { name: "noSideAlt", type: modelIdType, optional: true }
  ]]
]);

export function isBlockstateTemplateIdCall(expression: CallExprNode): boolean {
  const callee = expression.callee;
  if (callee.kind !== "IdentifierExpr" || !blockstateTemplateIdParameters.has(callee.name.text)) {
    return false;
  }
  return expression.args.some(arg => arg.name?.text === "id")
    || (expression.args.length === 1 && !expression.args[0].name);
}
