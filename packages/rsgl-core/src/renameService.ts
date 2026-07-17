import type { MemberExprNode, TextRange } from "./parser";
import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import { walkRsglModule } from "./parser/astTraversal";
import { createRsglExportMaps } from "./semantic/exportResolution";
import { resolveModuleNamespaceExpressionMember } from "./semantic/moduleNamespace";
import { originalRsglSymbolDeclaration } from "./semantic/symbolDefinition";
import type { RsglProgram, RsglSemanticModel, RsglSymbol } from "./semantic/types";

type RenameProgram = Pick<RsglProgram, "models" | "importGraph">;

export interface RsglRenameTarget {
  range: TextRange;
  placeholder: string;
}

export interface RsglRenameEdit {
  fileName: string;
  range: TextRange;
  newText: string;
}

type ResolvedRenameTarget =
  | {
      kind: "namespaceAlias";
      model: RsglSemanticModel;
      symbol: RsglSymbol;
      range: TextRange;
      name: string;
    }
  | {
      kind: "namespaceMember";
      model: RsglSemanticModel;
      expression: MemberExprNode;
      symbol: RsglSymbol;
      range: TextRange;
      name: string;
    };

/** Namespace rename deliberately covers only the two nominal namespace sites. */
export function prepareRsglNamespaceRename(
  program: RenameProgram,
  fileName: string,
  offset: number
): RsglRenameTarget | undefined {
  const target = resolveRenameTarget(program, fileName, offset);
  return target ? { range: target.range, placeholder: target.name } : undefined;
}

export function getRsglNamespaceRenameEdits(
  program: RenameProgram,
  fileName: string,
  offset: number,
  newName: string
): RsglRenameEdit[] | undefined {
  if (!isIdentifierName(newName)) {
    return undefined;
  }
  const target = resolveRenameTarget(program, fileName, offset);
  if (!target) {
    return undefined;
  }
  if (target.name === newName) {
    return [];
  }
  const edits = target.kind === "namespaceAlias"
    ? namespaceAliasEdits(target, newName)
    : namespaceMemberEdits(program, target, newName);
  return normalizeRenameEdits(edits);
}

function resolveRenameTarget(
  program: RenameProgram,
  fileName: string,
  offset: number
): ResolvedRenameTarget | undefined {
  const model = semanticModelForFile(program.models, fileName);
  if (!model) {
    return undefined;
  }

  let memberExpression: MemberExprNode | undefined;
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (
        expression.kind === "MemberExpr"
        && containsOffset(expression.property.range, offset)
        && (!memberExpression || rangeLength(expression.property.range) < rangeLength(memberExpression.property.range))
      ) {
        memberExpression = expression;
      }
    }
  });
  if (memberExpression) {
    const resolved = resolveModuleNamespaceExpressionMember(model, memberExpression);
    if (resolved?.member) {
      return {
        kind: "namespaceMember",
        model,
        expression: memberExpression,
        symbol: resolved.member.symbol,
        range: memberExpression.property.range,
        name: resolved.member.name
      };
    }
  }

  const namespaceSymbol = model.symbols.find(symbol =>
    symbol.kind === "namespace"
    && symbol.range
    && containsOffset(symbol.range, offset)
  ) ?? model.references.find(reference =>
    reference.symbol?.kind === "namespace"
    && containsOffset(reference.range, offset)
  )?.symbol;
  if (!namespaceSymbol?.range) {
    return undefined;
  }
  const occurrenceRange = model.references.find(reference =>
    reference.symbol === namespaceSymbol
    && containsOffset(reference.range, offset)
  )?.range ?? namespaceSymbol.range;
  return {
    kind: "namespaceAlias",
    model,
    symbol: namespaceSymbol,
    range: occurrenceRange,
    name: namespaceSymbol.name
  };
}

function namespaceAliasEdits(
  target: Extract<ResolvedRenameTarget, { kind: "namespaceAlias" }>,
  newName: string
): RsglRenameEdit[] {
  const edits: RsglRenameEdit[] = [{
    fileName: target.model.fileName,
    range: target.symbol.range!,
    newText: newName
  }];
  for (const reference of target.model.references) {
    if (reference.symbol === target.symbol) {
      edits.push({ fileName: target.model.fileName, range: reference.range, newText: newName });
    }
  }
  return edits;
}

function namespaceMemberEdits(
  program: RenameProgram,
  target: Extract<ResolvedRenameTarget, { kind: "namespaceMember" }>,
  newName: string
): RsglRenameEdit[] {
  const edits: RsglRenameEdit[] = [];
  const targetNode = target.symbol.node;
  const oldName = target.name;
  const exportMaps = createRsglExportMaps(program.models, program.importGraph).maps;
  const originalDefinition = originalRsglSymbolDeclaration(program.models, target.symbol);
  const renamesOriginalDeclaration = originalDefinition?.symbol.name === oldName;

  for (const model of program.models) {
    collectNamespaceMemberPropertyEdits(model, targetNode, oldName, newName, edits);
  }

  if (renamesOriginalDeclaration && originalDefinition) {
    edits.push({
      fileName: originalDefinition.fileName,
      range: originalDefinition.range,
      newText: newName
    });
    const owner = semanticModelForFile(program.models, originalDefinition.fileName);
    if (owner) {
      for (const reference of owner.references) {
        const referenceSymbol = reference.symbol;
        if (!referenceSymbol) {
          continue;
        }
        if (
          reference.name === oldName
          && referenceSymbol.node === targetNode
          && referenceSymbol.kind !== "import"
        ) {
          edits.push({ fileName: owner.fileName, range: reference.range, newText: newName });
        }
      }
    }
  }

  for (const model of program.models) {
    const modelFile = rsglPathKey(model.fileName);
    const modelExports = exportMaps.get(modelFile);
    for (const record of model.exports) {
      for (const specifier of record.node.specifiers) {
        if (specifier.exported.text !== oldName) {
          continue;
        }
        const exported = modelExports?.get(oldName);
        if (!sameLinkedDeclaration(exported, target.symbol)) {
          continue;
        }
        if (sameRange(specifier.local.range, specifier.exported.range)) {
          const local = model.scope.symbols.get(specifier.local.text);
          const renamesLocalDeclaration = !record.source
            && local?.kind !== "import"
            && sameLinkedDeclaration(local, target.symbol)
            && renamesOriginalDeclaration;
          edits.push({
            fileName: model.fileName,
            range: renamesLocalDeclaration ? specifier.exported.range : specifier.range,
            newText: renamesLocalDeclaration
              ? newName
              : `${specifier.local.text} as ${newName}`
          });
        } else {
          edits.push({ fileName: model.fileName, range: specifier.exported.range, newText: newName });
        }
      }
    }

    for (const record of model.imports) {
      const edge = program.importGraph.edges.find(candidate =>
        rsglPathKey(candidate.from) === modelFile
        && candidate.source === record.source
        && rsglPathKey(record.resolvedFileName ?? candidate.to) === rsglPathKey(candidate.to)
      );
      const targetExports = edge ? exportMaps.get(rsglPathKey(edge.to)) : undefined;
      for (const [index, item] of record.namedImports.entries()) {
        if (
          item.imported !== oldName
          || !sameLinkedDeclaration(targetExports?.get(item.imported), target.symbol)
        ) {
          continue;
        }
        const specifier = record.node.namedImports[index];
        if (!specifier) {
          continue;
        }
        if (sameRange(specifier.imported.range, specifier.local.range)) {
          edits.push({
            fileName: model.fileName,
            range: specifier.range,
            newText: `${newName} as ${specifier.local.text}`
          });
        } else {
          edits.push({ fileName: model.fileName, range: specifier.imported.range, newText: newName });
        }
      }
    }
  }

  return edits;
}

function collectNamespaceMemberPropertyEdits(
  model: RsglSemanticModel,
  targetNode: RsglSymbol["node"],
  oldName: string,
  newName: string,
  edits: RsglRenameEdit[]
): void {
  walkRsglModule(model.module, {
    enterExpression(expression) {
      if (expression.kind !== "MemberExpr" || expression.property.text !== oldName) {
        return;
      }
      const member = resolveModuleNamespaceExpressionMember(model, expression)?.member;
      if (member && member.symbol.node === targetNode) {
        edits.push({ fileName: model.fileName, range: expression.property.range, newText: newName });
      }
    }
  });
}

function normalizeRenameEdits(edits: readonly RsglRenameEdit[]): RsglRenameEdit[] {
  const unique = new Map<string, RsglRenameEdit>();
  for (const edit of edits) {
    const key = `${rsglPathKey(resolveRsglPath(edit.fileName))}\0${edit.range.start}\0${edit.range.end}`;
    const existing = unique.get(key);
    if (!existing || existing.newText === edit.newText) {
      unique.set(key, edit);
    }
  }
  return [...unique.values()].sort((left, right) =>
    rsglPathKey(resolveRsglPath(left.fileName)).localeCompare(
      rsglPathKey(resolveRsglPath(right.fileName)),
      "en"
    )
    || left.range.start - right.range.start
    || left.range.end - right.range.end
  );
}

function sameLinkedDeclaration(left: RsglSymbol | undefined, right: RsglSymbol): boolean {
  return Boolean(left && right.node && left.node === right.node);
}

function semanticModelForFile(
  models: readonly RsglSemanticModel[],
  fileName: string
): RsglSemanticModel | undefined {
  const key = rsglPathKey(resolveRsglPath(fileName));
  return models.find(model => rsglPathKey(resolveRsglPath(model.fileName)) === key);
}

function containsOffset(range: TextRange, offset: number): boolean {
  return range.start <= offset && offset <= range.end;
}

function sameRange(left: TextRange, right: TextRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function rangeLength(range: TextRange): number {
  return Math.max(0, range.end - range.start);
}

function isIdentifierName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
