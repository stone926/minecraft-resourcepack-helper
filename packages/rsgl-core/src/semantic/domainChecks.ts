import { ExprNode, MatchExprNode, RsglDiagnostic } from "../parser";
import { diagnostic } from "./diagnostics";
import { lookup } from "./scopes";
import { RsglScope, RsglType } from "./types";

export const builtinFiniteStringDomains = new Map<string, string[]>([
  ["HORIZONTAL", ["north", "east", "south", "west"]],
  ["DIRECTIONS", ["down", "up", "north", "south", "west", "east"]],
  ["STAIR_SHAPES", ["straight", "inner_left", "inner_right", "outer_left", "outer_right"]],
  ["COLORS_16", [
    "white",
    "orange",
    "magenta",
    "light_blue",
    "yellow",
    "lime",
    "pink",
    "gray",
    "light_gray",
    "cyan",
    "purple",
    "blue",
    "brown",
    "green",
    "red",
    "black"
  ]]
]);

const maximumTemplateStringDomainSize = 4096;

export function isWildcardPattern(expression: ExprNode): boolean {
  return expression.kind === "IdentifierExpr" && expression.name.text === "_";
}

export function checkMatchExhaustiveness(
  expression: MatchExprNode,
  scope: RsglScope,
  diagnostics: RsglDiagnostic[],
  matchedType?: RsglType
): void {
  if (expression.arms.some(arm => arm.patterns.some(isWildcardPattern))) {
    return;
  }

  const domain = finiteStringDomain(expression.expression, scope, matchedType);
  if (!domain?.length) {
    return;
  }

  const covered = new Set<string>();
  for (const arm of expression.arms) {
    for (const pattern of arm.patterns) {
      const value = staticStringPatternValue(pattern, scope);
      if (value !== null) {
        covered.add(value);
      }
    }
  }

  const missing = domain.filter(value => !covered.has(value));
  if (missing.length === 0) {
    return;
  }

  const preview = missing.slice(0, 6).join(", ");
  const suffix = missing.length > 6 ? `, and ${missing.length - 6} more` : "";
  diagnostics.push(diagnostic(
    "rsgl.nonExhaustiveMatch",
    `Match expression is missing cases: ${preview}${suffix}.`,
    expression.range,
    "warning"
  ));
}

export function finiteStringDomain(
  expression: ExprNode,
  scope: RsglScope,
  expressionType?: RsglType
): string[] | null {
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    return symbol?.finiteDomain
      ?? builtinFiniteStringDomains.get(expression.name.text)
      ?? finiteStringDomainFromType(symbol?.type ?? expressionType)
      ?? null;
  }
  const typeDomain = finiteStringDomainFromType(expressionType);
  if (typeDomain) {
    return typeDomain;
  }
  if (expression.kind === "TemplateStringExpr") {
    return finiteTemplateStringDomain(expression, scope);
  }
  if (expression.kind !== "ListExpr") {
    return null;
  }

  const values: string[] = [];
  for (const element of expression.elements) {
    if (element.kind === "ListSpread") {
      return null;
    }
    const value = staticStringPatternValue(element, scope);
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  return values;
}

function finiteTemplateStringDomain(expression: ExprNode & { kind: "TemplateStringExpr" }, scope: RsglScope): string[] | null {
  let values = [""];
  for (const part of expression.parts) {
    if (part.kind === "text") {
      values = values.map(value => value + part.text);
      continue;
    }

    const partDomain = finiteTemplateInterpolationDomain(part.expression, scope);
    if (!partDomain?.length || values.length * partDomain.length > maximumTemplateStringDomainSize) {
      return null;
    }
    values = values.flatMap(prefix => partDomain.map(value => prefix + value));
  }
  return Array.from(new Set(values));
}

function finiteTemplateInterpolationDomain(expression: ExprNode, scope: RsglScope): string[] | null {
  if (expression.kind === "StringLiteral") {
    return [expression.value];
  }
  if (expression.kind === "NumberLiteral" || expression.kind === "BooleanLiteral") {
    return [String(expression.value)];
  }
  if (expression.kind === "NullLiteral") {
    return [""];
  }
  return finiteStringDomain(expression, scope);
}

/** Returns an exact finite string domain only when every type arm is a string literal. */
export function finiteStringDomainFromType(type: RsglType | undefined): string[] | null {
  if (!type) {
    return null;
  }
  const options = type.kind === "Union" ? type.options ?? [] : [type];
  if (options.length === 0 || options.some(option =>
    option.kind !== "String" || typeof option.literalValue !== "string"
  )) {
    return null;
  }
  return Array.from(new Set(options.map(option => option.literalValue as string)));
}

export function staticStringPatternValue(expression: ExprNode, scope: RsglScope): string | null {
  if (expression.kind === "StringLiteral" || expression.kind === "ResourceLocationExpr") {
    return expression.value;
  }
  if (expression.kind === "IdentifierExpr") {
    const symbol = lookup(scope, expression.name.text);
    return !symbol || symbol.kind === "builtin" ? expression.name.text : null;
  }
  return null;
}
