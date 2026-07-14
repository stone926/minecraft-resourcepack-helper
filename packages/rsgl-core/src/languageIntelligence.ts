import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  ArgumentNode,
  CallExprNode,
  TextRange
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import {
  getRsglMemberAccessInfo,
  getRsglMemberDefinitionLocation
} from "./memberLanguageIntelligence";
import { createRsglExportMaps } from "./semantic/exportResolution";
import { formatType } from "./semantic/typeRelations";
import {
  RsglProgram,
  RsglSemanticModel,
  RsglSignature,
  RsglSymbol,
  RsglType,
  RsglTypeAliasSymbol
} from "./semantic/types";
import {
  formatTemplateOutputMetadata,
  ResolvedTemplateOutputMetadata,
  RsglTemplateCallerContext
} from "./templateOutput";

/** A protocol-neutral hover payload over a resolved semantic symbol. */
export interface RsglHoverInfo {
  range: TextRange;
  /** RSGL-like declaration text suitable for a fenced-code presentation. */
  label: string;
  /** Optional semantic metadata that should be shown as prose. */
  detail?: string;
}

/** One parameter in a protocol-neutral callable presentation. */
export interface RsglSignatureParameterInfo {
  name?: string;
  label: string;
  type: RsglType;
  optional: boolean;
  rest?: true;
}

/** A protocol-neutral callable presentation shared by hover and signature help. */
export interface RsglSignatureInfo {
  label: string;
  parameters: RsglSignatureParameterInfo[];
  returnType: RsglType;
  detail?: string;
}

/** Signature-help state at one source offset. */
export interface RsglSignatureHelpInfo {
  signatures: RsglSignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

/** An offset-based definition location; protocol layers own URI/position conversion. */
export interface RsglDefinitionLocation {
  fileName: string;
  range: TextRange;
}

type RsglLanguageProgram = Pick<
  RsglProgram,
  "models" | "importGraph" | "typeAliasExportMaps"
>;

interface RsglValueOccurrence {
  kind: "value";
  symbol: RsglSymbol;
  name: string;
  range: TextRange;
}

interface RsglTypeAliasOccurrence {
  kind: "typeAlias";
  alias: RsglTypeAliasSymbol;
  name: string;
  range: TextRange;
}

type RsglSemanticOccurrence = RsglValueOccurrence | RsglTypeAliasOccurrence;

/** Resolves hover information directly from the linked semantic program. */
export function getRsglHoverInfo(
  program: RsglLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglHoverInfo | undefined {
  const model = semanticModelForLanguageFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const member = getRsglMemberAccessInfo(program, fileName, sourceText, offset);
  if (member) {
    return {
      range: member.range,
      label: `property ${member.name}${member.optional ? "?" : ""}: ${formatType(member.type)}`
    };
  }
  const occurrence = semanticOccurrenceAtOffset(program, model, offset);
  if (!occurrence) {
    return undefined;
  }
  if (occurrence.kind === "typeAlias") {
    return {
      range: occurrence.range,
      label: `type ${occurrence.name} = ${formatType(occurrence.alias.type ?? { kind: "Unknown" })}`
    };
  }
  const callerContext = templateCallerContextAtOffset(model, offset);
  const callable = callablePresentation(occurrence.symbol, occurrence.name, callerContext);
  if (callable) {
    const prefix = isTemplateSymbol(occurrence.symbol) ? "template " : "";
    return {
      range: occurrence.range,
      label: `${prefix}${callable.label}`,
      detail: callable.detail
    };
  }
  return {
    range: occurrence.range,
    label: `${occurrence.symbol.kind} ${occurrence.name}: ${formatType(occurrence.symbol.type)}`
  };
}

/** Resolves the innermost callable at an argument-list offset. */
export function getRsglSignatureHelpInfo(
  program: RsglLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglSignatureHelpInfo | undefined {
  const model = semanticModelForLanguageFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const call = callExpressionAtOffset(model, offset);
  if (!call || call.callee.kind !== "IdentifierExpr") {
    return undefined;
  }
  const reference = model.references.find(candidate =>
    sameRange(candidate.range, call.callee.range)
  );
  const symbol = reference?.symbol ?? model.scope.symbols.get(call.callee.name.text);
  if (!symbol) {
    return undefined;
  }
  const callerContext = templateCallerContextAtOffset(model, offset);
  const signature = callablePresentation(symbol, call.callee.name.text, callerContext);
  if (!signature) {
    return undefined;
  }
  const argumentIndex = activeArgumentIndex(call, sourceText, offset);
  const activeParameter = activeParameterIndex(signature, call.args[argumentIndex], argumentIndex);
  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter
  };
}

/** Resolves local, imported, and re-exported aliases to the original declaration. */
export function getRsglDefinitionLocation(
  program: RsglLanguageProgram,
  fileName: string,
  sourceText: string,
  offset: number
): RsglDefinitionLocation | undefined {
  const model = semanticModelForLanguageFile(program, fileName);
  if (!model) {
    return undefined;
  }
  const member = getRsglMemberDefinitionLocation(program, fileName, sourceText, offset);
  if (member) {
    return member;
  }
  const occurrence = semanticOccurrenceAtOffset(program, model, offset);
  if (!occurrence) {
    return undefined;
  }

  if (occurrence.kind === "typeAlias") {
    for (const owner of program.models) {
      if (owner.module.statements.some(statement => statement === occurrence.alias.node)) {
        return {
          fileName: owner.fileName,
          range: occurrence.alias.node.name?.range ?? occurrence.alias.node.range
        };
      }
    }
    return undefined;
  }
  if (!occurrence.symbol.node) {
    return undefined;
  }

  const definitions = program.models.flatMap(owner => owner.symbols
    .filter(candidate =>
      candidate.node === occurrence.symbol.node
      && candidate.kind !== "import"
      && candidate.range
    )
    .map(candidate => ({
      fileName: owner.fileName,
      range: candidate.range!
    })));
  return definitions
    .sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

/** Formats a symbol's callable signature when parameter information is known. */
export function callablePresentation(
  symbol: RsglSymbol,
  displayName = symbol.name,
  callerContext?: RsglTemplateCallerContext
): RsglSignatureInfo | undefined {
  const signature = resolvedCallableSignature(symbol);
  if (!signature) {
    return undefined;
  }
  const parameters = signature.parameters.map(parameter => ({
    name: parameter.name,
    label: `${parameter.rest ? "..." : ""}${parameter.name}: ${formatType(parameter.type)}${parameter.optional ? " = ..." : ""}`,
    type: parameter.type,
    optional: parameter.optional,
    ...(parameter.rest ? { rest: true as const } : {})
  }));
  const label = `${displayName}(${parameters.map(parameter => parameter.label).join(", ")}): ${formatType(signature.returnType)}`;
  return {
    label,
    parameters,
    returnType: signature.returnType,
    detail: templateOutputDetail(signature.templateOutput, callerContext)
  };
}

function resolvedCallableSignature(symbol: RsglSymbol): RsglSignature | undefined {
  if (symbol.signature) {
    return symbol.signature;
  }
  if (symbol.type.kind !== "Function" || !symbol.type.parameters || !symbol.type.returnType) {
    return undefined;
  }
  return {
    parameters: symbol.type.parameters.map((type, index) => ({
      name: `arg${index + 1}`,
      type,
      optional: false
    })),
    returnType: symbol.type.returnType
  };
}

function semanticOccurrenceAtOffset(
  program: RsglLanguageProgram,
  model: RsglSemanticModel,
  offset: number
): RsglSemanticOccurrence | undefined {
  const candidates: RsglSemanticOccurrence[] = [];
  walkRsglModule(model.module, {
    enterType(type) {
      if (type.kind !== "NamedType" || !touchesRange(type.name.range, offset)) {
        return;
      }
      const alias = model.scope.typeAliases.get(type.name.text);
      if (alias) {
        candidates.push({
          kind: "typeAlias",
          alias,
          name: type.name.text,
          range: type.name.range
        });
      }
    }
  });
  for (const reference of model.references) {
    if (reference.symbol && touchesRange(reference.range, offset)) {
      candidates.push({
        kind: "value",
        symbol: reference.symbol,
        name: reference.name,
        range: reference.range
      });
    }
  }

  for (const record of model.imports) {
    for (const specifier of record.node.namedImports) {
      const symbol = model.scope.symbols.get(specifier.local.text);
      if (!symbol) {
        continue;
      }
      if (touchesRange(specifier.imported.range, offset)) {
        candidates.push({ kind: "value", symbol, name: specifier.imported.text, range: specifier.imported.range });
      }
      if (touchesRange(specifier.local.range, offset)) {
        candidates.push({ kind: "value", symbol, name: specifier.local.text, range: specifier.local.range });
      }
    }
    for (const specifier of record.node.namedImports) {
      const alias = model.scope.typeAliases.get(specifier.local.text);
      if (!alias) {
        continue;
      }
      if (touchesRange(specifier.imported.range, offset)) {
        candidates.push({
          kind: "typeAlias",
          alias,
          name: specifier.imported.text,
          range: specifier.imported.range
        });
      }
      if (touchesRange(specifier.local.range, offset)) {
        candidates.push({
          kind: "typeAlias",
          alias,
          name: specifier.local.text,
          range: specifier.local.range
        });
      }
    }
  }

  const exportMaps = model.exports.some(record =>
    record.node.specifiers.some(specifier =>
      touchesRange(specifier.local.range, offset) || touchesRange(specifier.exported.range, offset)
    )
  )
    ? createRsglExportMaps(program.models, program.importGraph).maps
    : undefined;
  for (const record of model.exports) {
    for (const specifier of record.node.specifiers) {
      const symbol = record.source
        ? exportMaps?.get(path.normalize(model.fileName))?.get(specifier.exported.text)
        : model.scope.symbols.get(specifier.local.text)
          ?? exportMaps?.get(path.normalize(model.fileName))?.get(specifier.exported.text);
      if (!symbol) {
        continue;
      }
      if (touchesRange(specifier.local.range, offset)) {
        candidates.push({ kind: "value", symbol, name: specifier.local.text, range: specifier.local.range });
      }
      if (touchesRange(specifier.exported.range, offset)) {
        candidates.push({ kind: "value", symbol, name: specifier.exported.text, range: specifier.exported.range });
      }
    }
    for (const specifier of record.node.specifiers) {
      const alias = record.source
        ? program.typeAliasExportMaps
          ?.get(path.normalize(model.fileName))
          ?.get(specifier.exported.text)
        : model.scope.typeAliases.get(specifier.local.text)
          ?? program.typeAliasExportMaps
            ?.get(path.normalize(model.fileName))
            ?.get(specifier.exported.text);
      if (!alias) {
        continue;
      }
      if (touchesRange(specifier.local.range, offset)) {
        candidates.push({
          kind: "typeAlias",
          alias,
          name: specifier.local.text,
          range: specifier.local.range
        });
      }
      if (touchesRange(specifier.exported.range, offset)) {
        candidates.push({
          kind: "typeAlias",
          alias,
          name: specifier.exported.text,
          range: specifier.exported.range
        });
      }
    }
  }

  for (const symbol of model.symbols) {
    if (symbol.range && touchesRange(symbol.range, offset)) {
      candidates.push({ kind: "value", symbol, name: symbol.name, range: symbol.range });
    }
  }
  for (const statement of model.module.statements) {
    if (statement.kind !== "TypeAliasDecl" || !statement.name || !touchesRange(statement.name.range, offset)) {
      continue;
    }
    const alias = model.scope.typeAliases.get(statement.name.text);
    if (alias) {
      candidates.push({
        kind: "typeAlias",
        alias,
        name: statement.name.text,
        range: statement.name.range
      });
    }
  }
  return candidates.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function callExpressionAtOffset(model: RsglSemanticModel, offset: number): CallExprNode | undefined {
  const calls: CallExprNode[] = [];
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind === "CallExpr" && touchesRange(expression.range, offset)) {
        calls.push(expression);
      }
    }
  });
  return calls.sort((left, right) => rangeLength(left.range) - rangeLength(right.range))[0];
}

function activeArgumentIndex(call: CallExprNode, sourceText: string, offset: number): number {
  if (call.args.length === 0) {
    return 0;
  }
  for (let index = 0; index < call.args.length; index++) {
    const argument = call.args[index];
    if (touchesRange(argument.range, offset)) {
      return index;
    }
    if (offset < argument.range.start) {
      return index;
    }
  }
  const lastIndex = call.args.length - 1;
  const last = call.args[lastIndex];
  return sourceText.slice(last.range.end, Math.max(last.range.end, offset)).includes(",")
    ? call.args.length
    : lastIndex;
}

function activeParameterIndex(
  signature: RsglSignatureInfo,
  argument: ArgumentNode | undefined,
  ordinal: number
): number {
  if (signature.parameters.length === 0) {
    return 0;
  }
  if (argument?.name) {
    const namedIndex = signature.parameters.findIndex(parameter => parameter.name === argument.name?.text);
    if (namedIndex >= 0) {
      return namedIndex;
    }
  }
  return Math.max(0, Math.min(ordinal, signature.parameters.length - 1));
}

function templateCallerContextAtOffset(
  model: RsglSemanticModel,
  offset: number
): RsglTemplateCallerContext | undefined {
  return model.templateUses
    ?.filter(record => record.callerContext && touchesRange(record.expression.range, offset))
    .sort((left, right) => rangeLength(left.expression.range) - rangeLength(right.expression.range))[0]
    ?.callerContext;
}

function templateOutputDetail(
  metadata: ResolvedTemplateOutputMetadata | undefined,
  callerContext: RsglTemplateCallerContext | undefined
): string | undefined {
  if (!metadata) {
    return undefined;
  }
  if (metadata.outputSource !== "legacyContextualAdapter") {
    return formatTemplateOutputMetadata(metadata);
  }
  return callerContext
    ? `legacy contextual compatibility (resolved at use: ${formatCallerDialect(callerContext)})`
    : "legacy contextual compatibility (resolved at use)";
}

function formatCallerDialect(context: RsglTemplateCallerContext): string {
  if (context.kind === "resources") {
    return "resources";
  }
  if (context.kind === "resourceBody") {
    return context.resourceKind;
  }
  return context.mode === "neutral" ? `${context.kind} (neutral)` : context.mode;
}

function isTemplateSymbol(symbol: RsglSymbol): boolean {
  return symbol.kind === "template" || Boolean(symbol.signature?.templateOutput);
}

function semanticModelForLanguageFile(
  program: RsglLanguageProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = normalizePathKey(path.resolve(fileName));
  return program.models.find(model => normalizePathKey(path.resolve(model.fileName)) === key);
}

function touchesRange(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function rangeLength(range: TextRange): number {
  return range.end - range.start;
}
