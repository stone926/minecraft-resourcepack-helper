import type {
  BlockNode,
  ForStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TemplateDeclNode,
  TopLevelStatementNode
} from "../parser";
import { getLegacyResourceBodyDialectForStatement } from "../parser/resourceBodyDialectRegistry";
import {
  rsglResourceKindDescriptors,
  type RsglResourceBodyDialect,
  type RsglResourceKind
} from "../resourceKinds";
import {
  type ResolvedTemplateOutputConflict,
  type ResolvedTemplateOutputMetadata,
  type RsglLegacyTemplateBodyDialect,
  templateOutputMetadataFingerprint
} from "../templateOutput";
import type { RsglSemanticModel, RsglSymbol } from "./types";
import type { RsglScope } from "./types";
import { getRsglResourceBodyHelperDescriptor } from "../resourceBodyHelpers";
import { resolveModuleNamespaceMember } from "./moduleNamespace";
import { lookup } from "./scopes";

export type ResolvedTemplateOutputClassification =
  | {
      kind: "resolved";
      metadata: ResolvedTemplateOutputMetadata;
    }
  | {
      kind: "conflict";
      /** Recovery-only carrier; the classification itself is not contextual. */
      metadata: ResolvedTemplateOutputMetadata;
      conflict: ResolvedTemplateOutputConflict;
    };

export type TemplateMetadataResolver = (
  name: string
) => ResolvedTemplateOutputMetadata | ResolvedTemplateOutputClassification | null | undefined;

export type { ResolvedTemplateOutputConflict } from "../templateOutput";

export function inferResolvedTemplateOutputMetadata(
  template: TemplateDeclNode,
  resolveCallee: TemplateMetadataResolver = () => undefined
): ResolvedTemplateOutputMetadata {
  return classifyResolvedTemplateOutputMetadata(template, resolveCallee).metadata;
}

export function classifyResolvedTemplateOutputMetadata(
  template: TemplateDeclNode,
  resolveCallee: TemplateMetadataResolver = () => undefined
): ResolvedTemplateOutputClassification {
  if (template.outputSyntax === "explicitArrow" && template.declaredOutputDialect) {
    return {
      kind: "resolved",
      metadata: { outputSource: "explicitArrow", outputDialect: template.declaredOutputDialect }
    };
  }
  if (template.body.kind === "VariantBody") {
    return { kind: "resolved", metadata: legacyInferred(blockstateEntries("variants")) };
  }
  if (template.body.kind === "MultipartBody") {
    return { kind: "resolved", metadata: legacyInferred(blockstateEntries("multipart")) };
  }

  const parameterBindings = new Set(
    template.parameters.flatMap(parameter => parameter.name ? [parameter.name.text] : [])
  );
  const evidence = template.body.kind === "Block"
    ? collectBlockEvidence(template.body, resolveCallee, parameterBindings)
    : collectResourceBodyEvidence(template.body, resolveCallee, parameterBindings);

  // A Block containing concrete resource output is always a complete-resource
  // template. Any nested body-template use is validated separately in the
  // resources caller context instead of weakening the definition to contextual.
  if (evidence.resources && template.body.kind === "Block") {
    return {
      kind: "resolved",
      metadata: { outputSource: "noArrowResources", outputDialect: "resources" }
    };
  }

  const joined = joinBodyDialectEvidence(evidence);
  if (evidence.resources || joined.conflict || evidence.conflictingCallees.size > 0) {
    return {
      kind: "conflict",
      // The public metadata union intentionally has no invalid-output member.
      // Keep a non-exact carrier for downstream recovery; semantic validation
      // treats the accompanying conflict as definition-fatal and suppresses
      // use-site dispatch cascades.
      metadata: {
        outputSource: "legacyContextualAdapter",
        bodyNodeKind: template.body.kind
      },
      conflict: {
        evidence: [
          ...(evidence.resources ? ["resources"] : []),
          ...Array.from(evidence.bodyDialects.values(), legacyDialectKey),
          ...evidence.conflictingCallees
        ]
      }
    };
  }
  if (joined.dialect) {
    return { kind: "resolved", metadata: legacyInferred(joined.dialect) };
  }
  return {
    kind: "resolved",
    metadata: {
      outputSource: "legacyContextualAdapter",
      bodyNodeKind: template.body.kind
    }
  };
}

/** Resolves local/imported/re-exported callee evidence to a stable fixed point. */
export function resolveProgramTemplateOutputMetadata(models: RsglSemanticModel[]): boolean {
  const templates = models.flatMap(model => model.symbols.filter(isTemplateSymbol));
  // Conflict recovery can move exact -> contextual and make enclosing adapters
  // reclassify in the opposite direction. Leave enough room for that state to
  // propagate through reverse-ordered definition/import chains.
  const maxPasses = Math.max(4, templates.length * 4 + 4);
  for (let pass = 0; pass < maxPasses; pass++) {
    let changed = false;
    for (const model of models) {
      changed = resolveModelTemplateOutputMetadata(model) || changed;
    }
    if (!changed) {
      freezeTemplateOutputMetadata(templates);
      return true;
    }
  }
  // Import/template cycles are diagnosed by their owning validators. Do not
  // freeze a provisional state when the classifier has not converged.
  return false;
}

export function resolveModelTemplateOutputMetadata(model: RsglSemanticModel): boolean {
  let changed = false;
  for (const symbol of model.symbols) {
    if (!isTemplateSymbol(symbol)) {
      continue;
    }
    const nextClassification = classifyResolvedTemplateOutputMetadata(symbol.node, name =>
      templateOutputClassificationForName(model.scope, name)
    );
    const next = nextClassification.metadata;
    const nextConflict = nextClassification.kind === "conflict"
      ? nextClassification.conflict
      : undefined;
    const previous = symbol.signature?.templateOutput;
    const previousConflict = symbol.signature.templateOutputConflict;
    if (
      !previous
      || templateOutputMetadataFingerprint(previous) !== templateOutputMetadataFingerprint(next)
      || templateOutputConflictFingerprint(previousConflict) !== templateOutputConflictFingerprint(nextConflict)
    ) {
      symbol.signature!.templateOutput = next;
      symbol.signature!.templateOutputConflict = nextConflict;
      changed = true;
    }
  }
  return changed;
}

function collectBlockEvidence(
  body: BlockNode,
  resolveCallee: TemplateMetadataResolver,
  inheritedBindings: ReadonlySet<string>
): TemplateEvidence {
  const evidence = emptyEvidence();
  // Top-level block bindings are predeclared by the binder, so they shadow a
  // builtin helper throughout the block, including uses before the declaration.
  const bindings = extendBindings(
    inheritedBindings,
    body.statements.flatMap(statement =>
      (statement.kind === "LetDecl" || statement.kind === "TableDecl") && statement.name
        ? [statement.name.text]
        : []
    )
  );
  for (const statement of body.statements) {
    collectTopLevelStatementEvidence(statement, resolveCallee, evidence, bindings);
  }
  return evidence;
}

function collectTopLevelStatementEvidence(
  statement: TopLevelStatementNode,
  resolveCallee: TemplateMetadataResolver,
  evidence: TemplateEvidence,
  bindings: ReadonlySet<string>
): void {
  switch (statement.kind) {
    case "LetDecl":
    case "UnknownStmt":
      return;
    case "UseDecl":
      collectUseEvidence(statement.expression, resolveCallee, evidence, bindings);
      return;
    case "ForStmt":
      collectForBodyEvidence(statement, resolveCallee, evidence, bindings);
      return;
    case "IfStmt":
      collectControlFlowBodyEvidence(statement.thenBody, resolveCallee, evidence, bindings);
      if (statement.elseBody) {
        collectControlFlowBodyEvidence(statement.elseBody, resolveCallee, evidence, bindings);
      }
      return;
    default:
      // A declaration/overlay/import/etc. cannot be lowered as a resource-body
      // fragment, so its presence freezes this no-arrow template as resources.
      evidence.resources = true;
  }
}

function collectControlFlowBodyEvidence(
  body: ForStmtNode["body"],
  resolveCallee: TemplateMetadataResolver,
  evidence: TemplateEvidence,
  bindings: ReadonlySet<string>
): void {
  if (body.kind === "Block") {
    mergeEvidence(evidence, collectBlockEvidence(body, resolveCallee, bindings));
  } else if (body.kind === "ResourceBody") {
    mergeEvidence(evidence, collectResourceBodyEvidence(body, resolveCallee, bindings));
  } else {
    evidence.bodyDialects.add(blockstateEntries(body.kind === "VariantBody" ? "variants" : "multipart"));
  }
}

function collectForBodyEvidence(
  statement: ForStmtNode,
  resolveCallee: TemplateMetadataResolver,
  evidence: TemplateEvidence,
  bindings: ReadonlySet<string>
): void {
  const loopBindings = statement.dimensions.length > 0
    ? statement.dimensions.flatMap(dimension => dimension.bindings.map(binding => binding.text))
    : statement.bindings.map(binding => binding.text);
  collectControlFlowBodyEvidence(
    statement.body,
    resolveCallee,
    evidence,
    extendBindings(bindings, loopBindings)
  );
}

function collectResourceBodyEvidence(
  body: ResourceBodyNode,
  resolveCallee: TemplateMetadataResolver,
  inheritedBindings: ReadonlySet<string>
): TemplateEvidence {
  const evidence = emptyEvidence();
  // Resource-body lets are sequential rather than predeclared.
  const bindings = new Set(inheritedBindings);
  for (const statement of body.statements) {
    collectResourceStatementEvidence(statement, resolveCallee, evidence, bindings);
    if (statement.kind === "LetDecl" && statement.name) {
      bindings.add(statement.name.text);
    }
  }
  return evidence;
}

function collectResourceStatementEvidence(
  statement: ResourceStatementNode,
  resolveCallee: TemplateMetadataResolver,
  evidence: TemplateEvidence,
  bindings: ReadonlySet<string>
): void {
  if (isRootContentStatement(statement)) {
    evidence.rootContent = true;
  }
  if (statement.kind === "VariantsSection") {
    evidence.bodyDialects.add(blockstateRoot("variants"));
    return;
  }
  if (statement.kind === "MultipartSection") {
    evidence.bodyDialects.add(blockstateRoot("multipart"));
    return;
  }
  if (statement.kind === "VariantEntry") {
    evidence.bodyDialects.add(blockstateEntries("variants"));
    return;
  }
  if (statement.kind === "MultipartEntry") {
    evidence.bodyDialects.add(blockstateEntries("multipart"));
    return;
  }
  if (statement.kind === "UseDecl") {
    collectUseEvidence(statement.expression, resolveCallee, evidence, bindings);
    return;
  }
  if (statement.kind === "ForStmt") {
    collectForBodyEvidence(statement, resolveCallee, evidence, bindings);
    return;
  }
  if (statement.kind === "IfStmt") {
    collectControlFlowBodyEvidence(statement.thenBody, resolveCallee, evidence, bindings);
    if (statement.elseBody) {
      collectControlFlowBodyEvidence(statement.elseBody, resolveCallee, evidence, bindings);
    }
    return;
  }

  if (statement.kind === "SectionStmt" && statement.body) {
    mergeEvidence(evidence, collectResourceBodyEvidence(statement.body, resolveCallee, bindings));
  }

  const dialect = getLegacyResourceBodyDialectForStatement(statement);
  if (!dialect) {
    return;
  }
  for (const resourceKind of resourceKindsForDialect(dialect)) {
    if (resourceKind !== "blockstate") {
      evidence.bodyDialects.add({ kind: "resourceBody", resourceKind });
    }
  }
}

function collectUseEvidence(
  expression: Extract<TopLevelStatementNode, { kind: "UseDecl" }>["expression"],
  resolveCallee: TemplateMetadataResolver,
  evidence: TemplateEvidence,
  bindings: ReadonlySet<string>
): void {
  if (expression.kind !== "CallExpr") {
    return;
  }
  const callee = expression.callee;
  const name = callee.kind === "IdentifierExpr"
    ? callee.name.text
    : callee.kind === "MemberExpr" && callee.object.kind === "IdentifierExpr"
      ? `${callee.object.name.text}.${callee.property.text}`
      : undefined;
  if (!name) {
    return;
  }
  const rootName = name.split(".", 1)[0];
  if (bindings.has(rootName)) {
    return;
  }
  const resolved = resolveCallee(name);
  if (resolved === null) {
    // A lexical non-template binding is intentionally distinct from an
    // unresolved name: it shadows a same-named builtin resource-body helper.
    return;
  }
  if (resolved === undefined) {
    const helper = name.includes(".") ? undefined : getRsglResourceBodyHelperDescriptor(name);
    if (helper) {
      evidence.bodyDialects.add({ kind: "resourceBody", resourceKind: helper.resourceKind });
    }
    return;
  }
  if (isTemplateOutputClassification(resolved) && resolved.kind === "conflict") {
    evidence.conflictingCallees.add(`conflicting-template:${name}`);
    return;
  }
  const metadata = isTemplateOutputClassification(resolved) ? resolved.metadata : resolved;
  if (metadata.outputSource === "noArrowResources") {
    evidence.resources = true;
  } else if (metadata.outputSource === "explicitArrow") {
    evidence.bodyDialects.add(metadata.outputDialect === "model"
      ? { kind: "resourceBody", resourceKind: "model" }
      : blockstateEntries(metadata.outputDialect));
  } else if (metadata.outputSource === "legacyInferredBody") {
    evidence.bodyDialects.add(metadata.legacyOutputDialect);
  }
}

function extendBindings(
  inherited: ReadonlySet<string>,
  names: Iterable<string>
): ReadonlySet<string> {
  const result = new Set(inherited);
  for (const name of names) {
    result.add(name);
  }
  return result;
}

function resourceKindsForDialect(dialect: RsglResourceBodyDialect): RsglResourceKind[] {
  return rsglResourceKindDescriptors
    .filter(descriptor => descriptor.ast.bodyDialect === dialect)
    .map(descriptor => descriptor.keyword);
}

function blockstateRoot(mode: "neutral" | "variants" | "multipart"): RsglLegacyTemplateBodyDialect {
  return { kind: "blockstateRoot", mode, allowRootMerge: true, allowBase: false };
}

function blockstateEntries(mode: "variants" | "multipart"): RsglLegacyTemplateBodyDialect {
  return { kind: "blockstateEntries", mode, allowRootMerge: false, allowBase: false };
}

function legacyInferred(legacyOutputDialect: RsglLegacyTemplateBodyDialect): ResolvedTemplateOutputMetadata {
  return { outputSource: "legacyInferredBody", legacyOutputDialect };
}

interface TemplateEvidence {
  resources: boolean;
  rootContent: boolean;
  bodyDialects: LegacyDialectSet;
  conflictingCallees: Set<string>;
}

class LegacyDialectSet {
  private readonly valuesByKey = new Map<string, RsglLegacyTemplateBodyDialect>();

  public add(value: RsglLegacyTemplateBodyDialect): void {
    this.valuesByKey.set(legacyDialectKey(value), value);
  }

  public values(): IterableIterator<RsglLegacyTemplateBodyDialect> {
    return this.valuesByKey.values();
  }
}

function emptyEvidence(): TemplateEvidence {
  return {
    resources: false,
    rootContent: false,
    bodyDialects: new LegacyDialectSet(),
    conflictingCallees: new Set()
  };
}

function mergeEvidence(target: TemplateEvidence, source: TemplateEvidence): void {
  target.resources ||= source.resources;
  target.rootContent ||= source.rootContent;
  for (const dialect of source.bodyDialects.values()) {
    target.bodyDialects.add(dialect);
  }
  for (const callee of source.conflictingCallees) {
    target.conflictingCallees.add(callee);
  }
}

function isTemplateOutputClassification(
  value: ResolvedTemplateOutputMetadata | ResolvedTemplateOutputClassification
): value is ResolvedTemplateOutputClassification {
  return "kind" in value;
}

interface JoinedBodyDialectEvidence {
  dialect?: RsglLegacyTemplateBodyDialect;
  conflict: boolean;
}

function joinBodyDialectEvidence(evidence: TemplateEvidence): JoinedBodyDialectEvidence {
  let joined: RsglLegacyTemplateBodyDialect | undefined;
  for (const dialect of evidence.bodyDialects.values()) {
    if (!joined) {
      joined = dialect;
      continue;
    }
    const next = joinLegacyBodyDialects(joined, dialect);
    if (!next) {
      return { conflict: true };
    }
    joined = next;
  }
  if (joined?.kind === "blockstateEntries" && evidence.rootContent) {
    joined = blockstateRoot(joined.mode);
  }
  return { dialect: joined, conflict: false };
}

function joinLegacyBodyDialects(
  left: RsglLegacyTemplateBodyDialect,
  right: RsglLegacyTemplateBodyDialect
): RsglLegacyTemplateBodyDialect | undefined {
  if (left.kind === "resourceBody" || right.kind === "resourceBody") {
    return left.kind === "resourceBody"
      && right.kind === "resourceBody"
      && left.resourceKind === right.resourceKind
      ? left
      : undefined;
  }

  const mode = joinBlockstateModes(left.mode, right.mode);
  if (!mode) {
    return undefined;
  }
  if (left.kind === "blockstateRoot" || right.kind === "blockstateRoot") {
    return blockstateRoot(mode);
  }
  // Entry evidence is always concrete; neutral can only originate from a root.
  return mode === "neutral" ? undefined : blockstateEntries(mode);
}

function joinBlockstateModes(
  left: "neutral" | "variants" | "multipart",
  right: "neutral" | "variants" | "multipart"
): "neutral" | "variants" | "multipart" | undefined {
  if (left === "neutral") {
    return right;
  }
  if (right === "neutral") {
    return left;
  }
  return left === right ? left : undefined;
}

function isRootContentStatement(statement: ResourceStatementNode): boolean {
  return statement.kind === "PropertyStmt"
    || statement.kind === "SectionStmt"
    || statement.kind === "MergeStmt"
    || statement.kind === "BaseStmt";
}

function legacyDialectKey(dialect: RsglLegacyTemplateBodyDialect): string {
  return dialect.kind === "resourceBody"
    ? `${dialect.kind}:${dialect.resourceKind}`
    : `${dialect.kind}:${dialect.mode}`;
}

function isTemplateSymbol(symbol: RsglSymbol): symbol is RsglSymbol & {
  node: TemplateDeclNode;
  signature: NonNullable<RsglSymbol["signature"]>;
} {
  return symbol.kind === "template" && symbol.node?.kind === "TemplateDecl" && Boolean(symbol.signature);
}

export function templateOutputClassificationForSymbol(
  symbol: RsglSymbol | undefined
): ResolvedTemplateOutputClassification | null | undefined {
  const metadata = symbol?.signature?.templateOutput;
  if (metadata) {
    const conflict = symbol.signature?.templateOutputConflict;
    return conflict
      ? { kind: "conflict", metadata, conflict }
      : { kind: "resolved", metadata };
  }
  if (!symbol || symbol.kind === "builtin") {
    return undefined;
  }
  return null;
}

export function templateOutputClassificationForName(
  scope: RsglScope,
  name: string
): ResolvedTemplateOutputClassification | null | undefined {
  const separator = name.indexOf(".");
  if (separator < 0) {
    return templateOutputClassificationForSymbol(lookup(scope, name));
  }
  const namespace = lookup(scope, name.slice(0, separator));
  const member = namespace
    ? resolveModuleNamespaceMember(namespace.type, name.slice(separator + 1))
    : undefined;
  return templateOutputClassificationForSymbol(member?.symbol);
}

function templateOutputConflictFingerprint(
  conflict: ResolvedTemplateOutputConflict | undefined
): string {
  return conflict?.evidence.join("\0") ?? "";
}

function freezeTemplateOutputMetadata(
  symbols: Array<RsglSymbol & { signature: NonNullable<RsglSymbol["signature"]> }>
): void {
  for (const symbol of symbols) {
    const metadata = symbol.signature.templateOutput;
    if (metadata && !Object.isFrozen(metadata)) {
      if (metadata.outputSource === "legacyInferredBody") {
        Object.freeze(metadata.legacyOutputDialect);
      }
      Object.freeze(metadata);
    }
    const conflict = symbol.signature.templateOutputConflict;
    if (conflict && !Object.isFrozen(conflict)) {
      if (!Object.isFrozen(conflict.evidence)) {
        Object.freeze(conflict.evidence);
      }
      Object.freeze(conflict);
    }
  }
}
