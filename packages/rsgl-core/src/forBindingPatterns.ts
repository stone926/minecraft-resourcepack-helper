import type {
  ForBindingPatternNode,
  IdentifierNode
} from "./parser";

export type ForBindingMapping =
  | {
      kind: "wholeValue";
      binding: IdentifierNode;
    }
  | {
      kind: "objectProperty";
      property: IdentifierNode;
      binding: IdentifierNode;
    };

/**
 * Describes how one loop input value supplies each lexical binding. Keeping
 * this normalization independent from parsing, semantics, and evaluation
 * gives every consumer the same whole-value versus object-property rules.
 */
export function forBindingMappings(pattern: ForBindingPatternNode): ForBindingMapping[] {
  if (pattern.kind === "Identifier") {
    return [{ kind: "wholeValue", binding: pattern }];
  }
  return pattern.properties.map(property => ({
    kind: "objectProperty",
    property: property.property,
    binding: property.binding
  }));
}

/** Returns only the local declarations introduced by a for binding pattern. */
export function forBindingIdentifiers(pattern: ForBindingPatternNode): IdentifierNode[] {
  return forBindingMappings(pattern).map(mapping => mapping.binding);
}
