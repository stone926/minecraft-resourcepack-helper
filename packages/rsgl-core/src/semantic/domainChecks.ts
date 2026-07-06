import { ExprNode, MatchExprNode, RsglDiagnostic } from "../parser";
import { diagnostic } from "./diagnostics";
import { lookup } from "./scopes";
import { RsglScope } from "./types";

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

export function isWildcardPattern(expression: ExprNode): boolean {
  return expression.kind === "IdentifierExpr" && expression.name.text === "_";
}

export function checkMatchExhaustiveness(expression: MatchExprNode, scope: RsglScope, diagnostics: RsglDiagnostic[]): void {
  if (expression.arms.some(arm => arm.patterns.some(isWildcardPattern))) {
    return;
  }

  const domain = finiteStringDomain(expression.expression, scope);
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

export function finiteStringDomain(expression: ExprNode, scope: RsglScope): string[] | null {
  if (expression.kind === "IdentifierExpr") {
    return lookup(scope, expression.name.text)?.finiteDomain
      ?? builtinFiniteStringDomains.get(expression.name.text)
      ?? null;
  }
  if (expression.kind !== "ListExpr") {
    return null;
  }

  const values: string[] = [];
  for (const element of expression.elements) {
    const value = staticStringPatternValue(element, scope);
    if (value === null) {
      return null;
    }
    values.push(value);
  }
  return values;
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
