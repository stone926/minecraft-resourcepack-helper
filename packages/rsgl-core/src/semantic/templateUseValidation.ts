import type { RsglDiagnostic, TemplateDeclNode } from "../parser";
import { getRsglResourceBodyHelperDescriptor } from "../resourceBodyHelpers";
import {
  normalizeTemplateCallerContext,
  resolvedTemplateOutputMetadata,
  resolveTemplateOutputDispatch,
  templateOutputBodyCallerContext,
  templateOutputMetadataFingerprint,
  type ResolvedTemplateOutputMetadata,
  type RsglTemplateCallerContext
} from "../templateOutput";
import { fileDiagnostic, toDiagnostic } from "./diagnostics";
import { mergeResolvedExpectedTypeFact } from "./expectedTypeFacts";
import { checkTextureRefExpression } from "./expressionChecker";
import { lookup } from "./scopes";
import {
  callableExpressionName,
  resolveCallableSymbolInScope
} from "./moduleNamespace";
import type {
  RsglContextualTextureSinkRecord,
  RsglFileDiagnostic,
  RsglSemanticModel,
  RsglTemplateUseRecord
} from "./types";

interface TemplateUseSite {
  fileName: string;
  model: RsglSemanticModel;
  record: RsglTemplateUseRecord;
}

interface ContextualTextureSinkSite {
  fileName: string;
  model: RsglSemanticModel;
  record: RsglContextualTextureSinkRecord;
}

export function validateResolvedTemplateUses(model: RsglSemanticModel): RsglDiagnostic[] {
  return validateResolvedProgramTemplateUses([model]).map(toDiagnostic);
}

export function validateResolvedProgramTemplateUses(
  models: readonly RsglSemanticModel[]
): RsglFileDiagnostic[] {
  return new ResolvedTemplateUseValidator(models).validate();
}

class ResolvedTemplateUseValidator {
  private readonly diagnostics: RsglFileDiagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  private readonly templateMetadata = new Map<TemplateDeclNode, ResolvedTemplateOutputMetadata>();

  public constructor(private readonly models: readonly RsglSemanticModel[]) {
    for (const model of models) {
      for (const item of model.diagnostics) {
        this.diagnosticKeys.add(diagnosticKey(model.fileName, item));
      }
      for (const symbol of model.symbols) {
        if (!isTemplateDeclNode(symbol.node)) {
          continue;
        }
        const metadata = resolvedTemplateOutputMetadata(symbol);
        if (metadata) {
          this.templateMetadata.set(symbol.node, metadata);
        }
      }
    }
  }

  public validate(): RsglFileDiagnostic[] {
    for (const model of this.models) {
      for (const record of model.templateUses ?? []) {
        this.validateUse({ fileName: model.fileName, model, record });
      }
      for (const record of model.contextualTextureSinks ?? []) {
        const metadata = this.templateMetadata.get(record.enclosingTemplate);
        if (metadata) {
          this.validateContextualTextureSink(
            { fileName: model.fileName, model, record },
            templateOutputBodyCallerContext(metadata)
          );
        }
      }
    }
    return this.diagnostics;
  }

  private validateUse(site: TemplateUseSite): void {
    this.validateUseCallableKind(site);
    const expression = site.record.expression;
    if (expression.kind !== "CallExpr") {
      return;
    }
    const callerContext = site.record.callerContext ?? resourcesCallerContext;
    const symbol = resolveCallableSymbolInScope(site.record.scope, expression.callee);
    const metadata = symbol ? resolvedTemplateOutputMetadata(symbol) : undefined;
    if (!metadata) {
      this.validateResourceBodyHelper(site, callerContext);
      return;
    }
    const dispatch = resolveTemplateOutputDispatch(callerContext, metadata);
    if (!dispatch.compatible) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.templateOutputDialectMismatch",
        `Template '${symbol!.name}' produces ${templateOutputMetadataFingerprint(metadata)}, which is incompatible with ${normalizeTemplateCallerContext(callerContext)}.`,
        expression.range
      ));
    }
  }

  private validateUseCallableKind(site: TemplateUseSite): void {
    const expression = site.record.expression;
    if (expression.kind !== "CallExpr") {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.functionValueCannotUse",
        "use requires a template call or a registered resource-body helper.",
        expression.range
      ));
      return;
    }
    const name = callableExpressionName(expression.callee);
    const symbol = resolveCallableSymbolInScope(site.record.scope, expression.callee);
    if (!name) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.functionValueCannotUse",
        "use requires a template call or a registered resource-body helper.",
        expression.range
      ));
      return;
    }
    const isBuiltinResourceBodyHelper = expression.callee.kind === "IdentifierExpr"
      && symbol?.kind === "builtin"
      && Boolean(getRsglResourceBodyHelperDescriptor(name));
    if (isBuiltinResourceBodyHelper || (symbol && resolvedTemplateOutputMetadata(symbol))) {
      return;
    }
    if (
      expression.callee.kind === "IdentifierExpr"
      && symbol
      && symbol.kind !== "template"
      && (symbol.signature || symbol.type.kind === "Function")
    ) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.functionValueCannotUse",
        `Function '${name}' does not produce template body content and cannot be used with use.`,
        expression.range
      ));
    }
  }

  private validateResourceBodyHelper(
    site: TemplateUseSite,
    callerContext: RsglTemplateCallerContext
  ): void {
    const expression = site.record.expression;
    if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
      return;
    }
    const name = expression.callee.name.text;
    const symbol = lookup(site.record.scope, name);
    const helper = symbol?.kind === "builtin"
      ? getRsglResourceBodyHelperDescriptor(name)
      : undefined;
    if (
      helper
      && (
        callerContext.kind !== "resourceBody"
        || callerContext.resourceKind !== helper.resourceKind
      )
    ) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.templateOutputDialectMismatch",
        `Resource-body helper '${helper.name}' is only valid in ${helper.resourceKind} bodies.`,
        expression.range
      ));
    }
  }

  private validateContextualTextureSink(
    site: ContextualTextureSinkSite,
    callerContext: RsglTemplateCallerContext
  ): void {
    const isModelSink = callerContext.kind === "resourceBody" && callerContext.resourceKind === "model";
    if (isModelSink) {
      const diagnostics: RsglDiagnostic[] = [];
      const resolvedExpectedTypes = site.model.resolvedExpectedTypes instanceof Map
        ? site.model.resolvedExpectedTypes
        : new Map(site.model.resolvedExpectedTypes);
      site.model.resolvedExpectedTypes = resolvedExpectedTypes;
      checkTextureRefExpression({
        diagnostics,
        references: [],
        recordResolvedExpectedType: (expression, expectedType) => {
          mergeResolvedExpectedTypeFact(resolvedExpectedTypes, expression, expectedType);
        },
        defineIdentifier: () => undefined
      }, site.record.expression, site.record.scope);
      for (const item of diagnostics) {
        this.push({ ...item, fileName: site.fileName });
      }
      return;
    }
    const directTextureVariable = site.record.expression.kind === "StringLiteral"
      && site.record.expression.value.startsWith("#");
    const finalActualType = site.record.expression.kind === "IdentifierExpr"
      ? lookup(site.record.scope, site.record.expression.name.text)?.type ?? site.record.actualType
      : site.record.actualType;
    if (
      directTextureVariable
      || finalActualType.kind === "TextureVariable"
      || finalActualType.kind === "TextureRef"
    ) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.textureVariableInvalidContext",
        "Texture variables are only valid in model texture sinks.",
        site.record.expression.range
      ));
    }
  }

  private push(item: RsglFileDiagnostic): void {
    const key = diagnosticKey(item.fileName, item);
    if (this.diagnosticKeys.has(key)) {
      return;
    }
    this.diagnosticKeys.add(key);
    this.diagnostics.push(item);
  }
}

const resourcesCallerContext: RsglTemplateCallerContext = { kind: "resources" };

function diagnosticKey(
  fileName: string,
  item: Pick<RsglDiagnostic, "code" | "message" | "range" | "severity">
): string {
  return [
    fileName,
    item.code,
    item.range.start,
    item.range.end,
    item.severity,
    item.message
  ].join("\0");
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
}
