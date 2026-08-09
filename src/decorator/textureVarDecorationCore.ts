import type { JsonDocumentNode } from "../utils/jsonAst";
import { memberName, objectMembers } from "../utils/jsonAst";
import {
  jsonAstLocationToLineCharacterRange,
  type LineCharacterRange
} from "../utils/astLocationRanges";
import { collectTextureVariableReferenceNodes } from "../utils/modelTexture";

/**
 * Computes the source ranges for unresolved texture-variable references.
 * Local texture keys are resolved without I/O; inherited definitions are
 * supplied by the caller so this core stays independent from VS Code.
 */
export function collectUndefinedTextureVariableRanges(
  ast: JsonDocumentNode,
  hasInheritedDefinition: (reference: string) => boolean
): LineCharacterRange[] {
  const texturesAst = objectMembers(ast.body).find(member => memberName(member) === "textures");
  const localDefinitions = new Set(
    objectMembers(texturesAst?.value)
      .map(member => memberName(member))
      .filter((name): name is string => typeof name === "string" && name !== "particle")
  );

  return collectTextureVariableReferenceNodes(ast.body).flatMap(reference => {
    if (
      localDefinitions.has(reference.value.slice(1))
      || hasInheritedDefinition(reference.value)
      || !reference.node.loc
    ) {
      return [];
    }
    return [jsonAstLocationToLineCharacterRange(reference.node.loc)];
  });
}
