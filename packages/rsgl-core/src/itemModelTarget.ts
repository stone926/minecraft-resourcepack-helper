import type { RsglModule } from "./parser";
import type { ItemModelFormat } from "./itemModelSchema";
import { rsglTargetPackFormatForMinecraftVersion } from "./targetFormatRegistry";

/** Reads an exact file-local target without invoking compile-time evaluation. */
export function itemModelTargetFormatInModule(
  module: RsglModule
): ItemModelFormat | undefined {
  for (const statement of module.statements) {
    if (statement.kind !== "TargetDecl") {
      continue;
    }
    if (
      statement.selector === "format"
      && statement.value.kind === "NumberLiteral"
      && isPackFormatPart(statement.value.value)
    ) {
      return [statement.value.value, 0];
    }
    if (
      statement.selector === "format"
      && statement.value.kind === "ListExpr"
      && statement.value.elements.length === 2
      && statement.value.elements[0]?.kind === "NumberLiteral"
      && statement.value.elements[1]?.kind === "NumberLiteral"
      && isPackFormatPart(statement.value.elements[0].value)
      && isPackFormatPart(statement.value.elements[1].value)
    ) {
      return [statement.value.elements[0].value, statement.value.elements[1].value];
    }
    if (statement.selector === "mc" && statement.value.kind === "StringLiteral") {
      const target = rsglTargetPackFormatForMinecraftVersion(statement.value.value);
      if (target) {
        return [target.major, target.minor];
      }
    }
  }
  return undefined;
}

/** Applies the language-service target precedence without evaluating source code. */
export function effectiveItemModelTargetFormat(
  module: RsglModule,
  projectTargetFormat?: ItemModelFormat
): ItemModelFormat | undefined {
  const fileTargetFormat = itemModelTargetFormatInModule(module);
  const targetFormat = fileTargetFormat ?? projectTargetFormat;
  return targetFormat ? [...targetFormat] : undefined;
}

function isPackFormatPart(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
