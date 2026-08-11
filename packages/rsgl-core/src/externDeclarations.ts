import type { TextRange } from "./parser";
import type { ExternResourceKind } from "./resourceKinds";

/**
 * Physical resource layer named by an extern declaration or selected as the
 * winner of Minecraft's effective resource-pack stack.
 *
 * `local` is the target/output pack, `custom` is an explicitly configured
 * resource-pack layer, and `vanilla` is the Minecraft Default layer.
 */
export type ExternResourceSource = "local" | "custom" | "vanilla";

export interface ExternResourcePattern {
  text: string;
  namespace: string | "*";
  pathSegments: readonly string[];
}

export interface ExternResourcePatternParseResult {
  pattern?: ExternResourcePattern;
  error?: string;
}

export interface RsglExternDeclaration {
  source: ExternResourceSource;
  resourceKind: ExternResourceKind;
  pattern: ExternResourcePattern;
  skipExistenceCheck: boolean;
  /** Per-entry global override; local declarations leave this undefined. */
  checkExistence?: boolean;
  /** Undefined for declarations supplied globally by rsgl.config.json. */
  fileName?: string;
  range?: TextRange;
}

export interface RsglGlobalExternConfigEntry {
  source: ExternResourceSource;
  kind: ExternResourceKind;
  patterns: readonly string[];
  /** Overrides the top-level checkExternExistence switch for this entry. */
  checkExistence?: boolean;
}

export interface RsglExternConfiguration {
  extern?: readonly RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

const namespacePattern = /^[a-z0-9_.-]+$/;
const literalPathSegmentPattern = /^[a-z0-9_.-]+$/;

export function parseExternResourcePattern(text: string): ExternResourcePatternParseResult {
  if (!text || /\s|\\/.test(text)) {
    return invalidPattern("Extern resource patterns cannot be empty or contain whitespace or backslashes.");
  }

  const colon = text.indexOf(":");
  if (colon !== text.lastIndexOf(":")) {
    return invalidPattern(`Invalid extern resource pattern '${text}': expected at most one namespace separator.`);
  }

  const hasNamespace = colon >= 0;
  const namespace = hasNamespace ? text.slice(0, colon) : "minecraft";
  const path = hasNamespace ? text.slice(colon + 1) : text;
  if (!namespace || !path) {
    return invalidPattern(`Invalid extern resource pattern '${text}': namespace and path must be non-empty.`);
  }
  if (namespace === "**") {
    return invalidPattern("'**' cannot be used as an extern namespace wildcard; use '*' for any namespace.");
  }
  if (namespace !== "*" && !namespacePattern.test(namespace)) {
    return invalidPattern(`Invalid extern namespace pattern '${namespace}'.`);
  }

  const pathSegments = path.split("/");
  if (pathSegments.some(segment => !isExternPathSegment(segment))) {
    return invalidPattern(
      `Invalid extern path pattern '${path}': wildcards must be complete path segments and path segments cannot be empty, '.' or '..'.`
    );
  }

  return {
    pattern: {
      text,
      namespace,
      pathSegments
    }
  };
}

export function externResourcePatternMatches(pattern: ExternResourcePattern, resourceId: string): boolean {
  const parsed = parseConcreteResourceId(resourceId);
  if (!parsed) {
    return false;
  }
  if (pattern.namespace !== "*" && pattern.namespace !== parsed.namespace) {
    return false;
  }
  return matchPathSegments(pattern.pathSegments, parsed.pathSegments, 0, 0);
}

/**
 * Orders declarations from most to least specific. Namespace literals outrank
 * namespace wildcards, then literal path segments outrank '*' and '**'.
 */
export function compareExternPatternSpecificity(left: ExternResourcePattern, right: ExternResourcePattern): number {
  const leftScore = externPatternSpecificity(left);
  const rightScore = externPatternSpecificity(right);
  for (let index = 0; index < leftScore.length; index++) {
    const difference = leftScore[index] - rightScore[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function isExternPathSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") {
    return false;
  }
  return segment === "*" || segment === "**" || literalPathSegmentPattern.test(segment);
}

function invalidPattern(error: string): ExternResourcePatternParseResult {
  return { error };
}

function parseConcreteResourceId(resourceId: string): { namespace: string; pathSegments: string[] } | null {
  const colon = resourceId.indexOf(":");
  if (colon <= 0 || colon !== resourceId.lastIndexOf(":")) {
    return null;
  }
  const namespace = resourceId.slice(0, colon);
  const pathSegments = resourceId.slice(colon + 1).split("/");
  if (!namespacePattern.test(namespace) || pathSegments.some(segment => !literalPathSegmentPattern.test(segment))) {
    return null;
  }
  return { namespace, pathSegments };
}

function matchPathSegments(
  patternSegments: readonly string[],
  resourceSegments: readonly string[],
  patternIndex: number,
  resourceIndex: number
): boolean {
  if (patternIndex === patternSegments.length) {
    return resourceIndex === resourceSegments.length;
  }

  const segment = patternSegments[patternIndex];
  if (segment === "**") {
    const remainingPatternSegments = patternSegments.length - patternIndex - 1;
    const maximumConsumption = resourceSegments.length - resourceIndex - remainingPatternSegments;
    for (let consumed = 1; consumed <= maximumConsumption; consumed++) {
      if (matchPathSegments(patternSegments, resourceSegments, patternIndex + 1, resourceIndex + consumed)) {
        return true;
      }
    }
    return false;
  }

  if (resourceIndex >= resourceSegments.length) {
    return false;
  }
  if (segment !== "*" && segment !== resourceSegments[resourceIndex]) {
    return false;
  }
  return matchPathSegments(patternSegments, resourceSegments, patternIndex + 1, resourceIndex + 1);
}

function externPatternSpecificity(pattern: ExternResourcePattern): readonly number[] {
  let literalSegments = 0;
  let singleWildcards = 0;
  let recursiveWildcards = 0;
  for (const segment of pattern.pathSegments) {
    if (segment === "*") {
      singleWildcards++;
    } else if (segment === "**") {
      recursiveWildcards++;
    } else {
      literalSegments++;
    }
  }
  return [
    pattern.namespace === "*" ? 0 : 1,
    literalSegments,
    -recursiveWildcards,
    -singleWildcards,
    pattern.pathSegments.length
  ];
}
