import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
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
import { originalRsglSymbolDefinition } from "./semantic/symbolDefinition";
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
  ResolvedTemplateOutputMetadata
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
    if (member.category && member.symbol) {
      const callable = callablePresentation(member.symbol, member.name);
      if (callable) {
        return {
          range: member.range,
          label: `${member.category === "template" ? "template " : "value "}${callable.label}`,
          detail: callable.detail
        };
      }
      return {
        range: member.range,
        label: `value ${member.name}: ${formatType(member.type)}`
      };
    }
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
  const callable = callablePresentation(occurrence.symbol, occurrence.name);
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
  if (!call) {
    return undefined;
  }
  let symbol: RsglSymbol | undefined;
  let displayName: string | undefined;
  if (call.callee.kind === "IdentifierExpr") {
    const reference = model.references.find(candidate =>
      sameRange(candidate.range, call.callee.range)
    );
    symbol = reference?.symbol ?? model.scope.symbols.get(call.callee.name.text);
    displayName = call.callee.name.text;
  } else if (call.callee.kind === "MemberExpr") {
    const member = getRsglMemberAccessInfo(
      program,
      fileName,
      sourceText,
      call.callee.property.range.start
    );
    symbol = member?.symbol;
    displayName = call.callee.object.kind === "IdentifierExpr"
      ? `${call.callee.object.name.text}.${call.callee.property.text}`
      : call.callee.property.text;
  }
  if (!symbol) {
    return undefined;
  }
  const signature = callablePresentation(symbol, displayName ?? symbol.name);
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

  return originalRsglSymbolDefinition(program.models, occurrence.symbol);
}

/** Formats a symbol's callable signature when parameter information is known. */
export function callablePresentation(
  symbol: RsglSymbol,
  displayName = symbol.name
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
    detail: templateOutputDetail(signature.templateOutput)
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
        ? exportMaps?.get(rsglPathKey(model.fileName))?.get(specifier.exported.text)
        : model.scope.symbols.get(specifier.local.text)
          ?? exportMaps?.get(rsglPathKey(model.fileName))?.get(specifier.exported.text);
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
          ?.get(rsglPathKey(model.fileName))
          ?.get(specifier.exported.text)
        : model.scope.typeAliases.get(specifier.local.text)
          ?? program.typeAliasExportMaps
            ?.get(rsglPathKey(model.fileName))
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

function templateOutputDetail(
  metadata: ResolvedTemplateOutputMetadata | undefined
): string | undefined {
  return metadata ? formatTemplateOutputMetadata(metadata) : undefined;
}

function isTemplateSymbol(symbol: RsglSymbol): boolean {
  return symbol.kind === "template" || Boolean(symbol.signature?.templateOutput);
}

function semanticModelForLanguageFile(
  program: RsglLanguageProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = rsglPathKey(resolveRsglPath(fileName));
  return program.models.find(model => rsglPathKey(resolveRsglPath(model.fileName)) === key);
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
