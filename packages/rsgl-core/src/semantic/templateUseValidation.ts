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

interface TemplateInfo {
  node: TemplateDeclNode;
  metadata: ResolvedTemplateOutputMetadata;
}

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

/**
 * Validates linked template uses. Contextual legacy adapters are instantiated
 * only from concrete use roots, so their nested uses and deferred sink checks
 * see the caller dialect without requiring a reverse workspace scan.
 */
export function validateResolvedProgramTemplateUses(
  models: readonly RsglSemanticModel[]
): RsglFileDiagnostic[] {
  return new ResolvedTemplateUseValidator(models).validate();
}

class ResolvedTemplateUseValidator {
  private readonly diagnostics: RsglFileDiagnostic[] = [];
  private readonly diagnosticKeys = new Set<string>();
  private readonly templateInfo = new Map<TemplateDeclNode, TemplateInfo>();
  private readonly usesByTemplate = new Map<TemplateDeclNode, TemplateUseSite[]>();
  private readonly sinksByTemplate = new Map<TemplateDeclNode, ContextualTextureSinkSite[]>();
  private readonly rootUses: TemplateUseSite[] = [];
  private readonly conflictingTemplates = new Set<TemplateDeclNode>();
  private readonly validatedTemplateContexts = new Set<string>();
  private readonly templateIds = new WeakMap<TemplateDeclNode, number>();
  private nextTemplateId = 1;

  public constructor(private readonly models: readonly RsglSemanticModel[]) {
    for (const model of models) {
      for (const item of model.diagnostics) {
        this.diagnosticKeys.add(diagnosticKey(model.fileName, item));
      }
    }
    for (const model of models) {
      for (const symbol of model.symbols) {
        if (symbol.kind !== "template" || !isTemplateDeclNode(symbol.node)) {
          continue;
        }
        const conflict = symbol.signature?.templateOutputConflict;
        if (conflict) {
          this.conflictingTemplates.add(symbol.node);
          if (!hasTemplateDefinitionConflict(model, symbol.node)) {
            this.push(fileDiagnostic(
              model.fileName,
              "rsgl.conflictingResolvedTemplateOutputDialects",
              `Legacy template '${symbol.name}' has incompatible output evidence: ${conflict.evidence.join(", ")}. Split the template into one output dialect or make it a complete-resource template.`,
              symbol.node.name?.range ?? symbol.node.range
            ));
          }
        }
        const metadata = resolvedTemplateOutputMetadata(symbol);
        if (metadata) {
          this.templateInfo.set(symbol.node, { node: symbol.node, metadata });
        }
      }
      for (const record of model.templateUses ?? []) {
        const site = { fileName: model.fileName, model, record };
        if (record.enclosingTemplate) {
          appendToMap(this.usesByTemplate, record.enclosingTemplate, site);
        } else {
          this.rootUses.push(site);
        }
      }
      for (const record of model.contextualTextureSinks ?? []) {
        appendToMap(this.sinksByTemplate, record.enclosingTemplate, {
          fileName: model.fileName,
          model,
          record
        });
      }
    }
  }

  public validate(): RsglFileDiagnostic[] {
    // Callable-kind errors do not depend on a body dialect and remain useful
    // even when a contextual template is currently unused.
    for (const site of this.allUseSites()) {
      this.validateUseCallableKind(site);
    }

    for (const site of this.rootUses) {
      this.validateUse(site, site.record.callerContext ?? resourcesCallerContext);
    }
    for (const info of this.templateInfo.values()) {
      if (this.conflictingTemplates.has(info.node)) {
        continue;
      }
      const callerContext = templateOutputBodyCallerContext(info.metadata);
      if (callerContext) {
        this.validateTemplateBody(info.node, callerContext);
      }
    }
    return this.diagnostics;
  }

  private validateTemplateBody(
    template: TemplateDeclNode,
    callerContext: RsglTemplateCallerContext
  ): void {
    const key = `${this.templateId(template)}\0${normalizeTemplateCallerContext(callerContext)}`;
    if (this.validatedTemplateContexts.has(key)) {
      return;
    }
    this.validatedTemplateContexts.add(key);

    for (const sink of this.sinksByTemplate.get(template) ?? []) {
      this.validateContextualTextureSink(sink, callerContext);
    }
    for (const use of this.usesByTemplate.get(template) ?? []) {
      const finalMetadata = this.templateInfo.get(template)?.metadata;
      // A linked contextual result invalidates provisional binder contexts:
      // only final exact/resources definitions retain concrete nested contexts.
      const nestedContext = finalMetadata?.outputSource === "legacyContextualAdapter"
        ? callerContext
        : use.record.callerContext ?? callerContext;
      this.validateUse(use, nestedContext);
    }
  }

  private validateUse(site: TemplateUseSite, callerContext: RsglTemplateCallerContext): void {
    const expression = site.record.expression;
    if (expression.kind !== "CallExpr") {
      return;
    }
    const symbol = resolveCallableSymbolInScope(site.record.scope, expression.callee);
    if (isTemplateDeclNode(symbol?.node) && this.conflictingTemplates.has(symbol.node)) {
      return;
    }
    const metadata = symbol ? resolvedTemplateOutputMetadata(symbol) : undefined;
    if (!metadata) {
      this.validateResourceBodyHelper(site, callerContext);
      return;
    }

    const dispatch = resolveTemplateOutputDispatch(callerContext, metadata);
    if (!dispatch.compatible) {
      const context = normalizeTemplateCallerContext(callerContext);
      const output = templateOutputMetadataFingerprint(metadata);
      if (dispatch.failure === "bodyContextRequired") {
        this.push(fileDiagnostic(
          site.fileName,
          "rsgl.templateOutputDialectRequired",
          `Template '${symbol!.name}' has an ambiguous implicit body and cannot be used in ${context}; add -> model, -> variants, or -> multipart, or make it a complete-resource template.`,
          expression.range
        ));
      } else if (dispatch.failure === "blockstateModeConflict") {
        this.push(fileDiagnostic(
          site.fileName,
          "rsgl.blockstateModeConflict",
          `Template '${symbol!.name}' produces ${output}, which conflicts with the blockstate mode required by ${context}.`,
          expression.range
        ));
      } else {
        this.push(fileDiagnostic(
          site.fileName,
          "rsgl.templateOutputDialectMismatch",
          `Template '${symbol!.name}' produces ${output}, which is incompatible with ${context}.`,
          expression.range
        ));
      }
      return;
    }
    if (dispatch.compatibilityWarning) {
      this.push(fileDiagnostic(
        site.fileName,
        "rsgl.implicitTemplateOutputDialect",
        `Template '${symbol!.name}' uses legacy implicit output inference in ${normalizeTemplateCallerContext(callerContext)}; declare -> model, -> variants, or -> multipart when the body is reusable content.`,
        expression.range,
        "warning"
      ));
    }
    if (metadata.outputSource === "legacyContextualAdapter" && isTemplateDeclNode(symbol?.node)) {
      this.validateTemplateBody(symbol.node, callerContext);
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

  private allUseSites(): TemplateUseSite[] {
    return [
      ...this.rootUses,
      ...Array.from(this.usesByTemplate.values()).flat()
    ];
  }

  private templateId(template: TemplateDeclNode): number {
    const existing = this.templateIds.get(template);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextTemplateId++;
    this.templateIds.set(template, id);
    return id;
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

function appendToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) {
    values.push(value);
  } else {
    map.set(key, [value]);
  }
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
}

function hasTemplateDefinitionConflict(
  model: RsglSemanticModel,
  template: TemplateDeclNode
): boolean {
  return model.diagnostics.some(item =>
    item.code === "rsgl.conflictingResolvedTemplateOutputDialects"
    && item.range.start >= template.range.start
    && item.range.end <= template.range.end
  );
}
