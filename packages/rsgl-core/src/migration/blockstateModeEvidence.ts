import type { ExprNode, TextRange } from "../parser";
import { walkRsglModule } from "../parser/astTraversal";
import type { RsglSemanticModel } from "../semantic";
import type { ResolvedTemplateOutputMetadata } from "../templateOutput";

export type InferredBlockstateMode = "variants" | "multipart";

/** Collects only mode evidence frozen by AST shape or resolved template metadata. */
export function collectBlockstateModeEvidence(
  range: TextRange,
  model: RsglSemanticModel
): Set<InferredBlockstateMode> {
  const modes = new Set<InferredBlockstateMode>();
  walkRsglModule(model.module, {
    enterStatement(statement) {
      if (!containsRange(range, statement.range)) {
        return containsRange(statement.range, range) ? undefined : "skipChildren";
      }
      if (statement.kind === "VariantsSection"
        || statement.kind === "VariantEntry"
        || statement.kind === "BlockstateVariantEntry") {
        modes.add("variants");
      } else if (statement.kind === "MultipartSection"
        || statement.kind === "MultipartEntry"
        || statement.kind === "BlockstateMultipartEntry") {
        modes.add("multipart");
      } else if (statement.kind === "PropertyStmt") {
        if (statement.name.text === "variants" || statement.name.text === "multipart") {
          modes.add(statement.name.text);
        }
      } else if (statement.kind === "MergeStmt") {
        collectStaticObjectModes(statement.value, modes);
      } else if (statement.kind === "UseDecl") {
        const metadata = resolvedUseMetadata(statement.expression, model);
        const mode = metadata && templateMode(metadata);
        if (mode) {
          modes.add(mode);
        }
      }
    }
  });
  return modes;
}

function collectStaticObjectModes(expression: ExprNode, modes: Set<InferredBlockstateMode>): void {
  if (expression.kind !== "ObjectExpr") {
    return;
  }
  for (const property of expression.properties) {
    if (property.key.kind === "Identifier"
      && (property.key.text === "variants" || property.key.text === "multipart")) {
      modes.add(property.key.text);
    }
    if (property.key.kind === "StringLiteral"
      && (property.key.value === "variants" || property.key.value === "multipart")) {
      modes.add(property.key.value);
    }
  }
}

function resolvedUseMetadata(
  expression: ExprNode,
  model: RsglSemanticModel
): ResolvedTemplateOutputMetadata | undefined {
  if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  const reference = model.references.find(candidate =>
    candidate.range.start === expression.callee.range.start
    && candidate.range.end === expression.callee.range.end
  );
  return reference?.symbol?.signature?.templateOutput;
}

function templateMode(metadata: ResolvedTemplateOutputMetadata): InferredBlockstateMode | undefined {
  if (metadata.outputSource === "explicitArrow") {
    return metadata.outputDialect === "variants" || metadata.outputDialect === "multipart"
      ? metadata.outputDialect
      : undefined;
  }
  if (metadata.outputSource !== "legacyInferredBody") {
    return undefined;
  }
  const dialect = metadata.legacyOutputDialect;
  if (dialect.kind !== "blockstateRoot" && dialect.kind !== "blockstateEntries") {
    return undefined;
  }
  return dialect.mode === "neutral" ? undefined : dialect.mode;
}

function containsRange(container: TextRange, child: TextRange): boolean {
  return container.start <= child.start && child.end <= container.end;
}
