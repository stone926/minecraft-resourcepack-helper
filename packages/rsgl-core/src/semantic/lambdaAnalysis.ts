import type {
  ExprNode,
  LetDeclNode,
  RsglDiagnostic,
  RsglNode,
  RsglStatement,
  TopLevelStatementNode
} from "../parser";
import { rsglPathKey } from "../pathIdentity";
import { walkRsglStatements } from "../parser/astTraversal";
import { diagnostic, fileDiagnostic } from "./diagnostics";
import { lookup } from "./scopes";
import type {
  RsglFileDiagnostic,
  RsglScope,
  RsglSemanticModel,
  RsglSymbol
} from "./types";

interface LambdaDependency {
  readonly target: LetDeclNode;
  readonly range: { start: number; end: number };
}

interface LambdaCaptureSite {
  readonly owner?: LetDeclNode;
  readonly label: string;
  readonly dependencies: LambdaDependency[];
  readonly forwardCaptures: LambdaDependency[];
}

interface LambdaValueAnalysis {
  readonly diagnostics: RsglDiagnostic[];
  /** Identifier ranges whose generic undefined/not-callable fallback is replaced. */
  readonly fallbackRanges: Array<{ start: number; end: number }>;
}

/** Adds dedicated lambda diagnostics while removing the same-site fallback noise. */
export function applyLambdaValueDiagnostics(
  diagnostics: RsglDiagnostic[],
  statements: readonly RsglStatement[],
  scope: RsglScope
): void {
  const analysis = analyzeLambdaValues(statements, scope);
  for (const range of analysis.fallbackRanges) {
    for (let index = diagnostics.length - 1; index >= 0; index--) {
      const existing = diagnostics[index];
      if (
        (existing.code === "rsgl.undefinedSymbol" || existing.code === "rsgl.notCallable")
        && existing.range.start === range.start
        && existing.range.end === range.end
      ) {
        diagnostics.splice(index, 1);
      }
    }
  }
  diagnostics.push(...analysis.diagnostics);
}

/**
 * Validates one lexical statement list after all expressions in that list
 * have been checked. This restores runtime source order even in body scopes
 * where lets are intentionally not predeclared.
 */
export function validateTopLevelLambdaValues(
  statements: readonly RsglStatement[],
  scope: RsglScope
): RsglDiagnostic[] {
  return analyzeLambdaValues(statements, scope).diagnostics;
}

function analyzeLambdaValues(
  statements: readonly RsglStatement[],
  scope: RsglScope
): LambdaValueAnalysis {
  const directLetsByName = new Map<string, LetDeclNode>();
  for (const statement of statements) {
    if (statement.kind === "LetDecl" && statement.name && !directLetsByName.has(statement.name.text)) {
      directLetsByName.set(statement.name.text, statement);
    }
  }

  const sites = statements
    .map(statement => collectLambdaCaptureSite(statement, directLetsByName, scope))
    .filter((site): site is LambdaCaptureSite => Boolean(site));
  const ownerSites = sites.filter((site): site is LambdaCaptureSite & { owner: LetDeclNode } =>
    Boolean(site.owner)
  );
  const owners = ownerSites.map(site => site.owner);
  const ownerSet = new Set(owners);
  const dependencies = new Map<LetDeclNode, LambdaDependency[]>(ownerSites.map(site => [
    site.owner,
    site.dependencies.filter(dependency => ownerSet.has(dependency.target))
  ]));

  const cyclicComponents = cyclicLambdaComponents(owners, dependencies);
  const componentByNode = new Map<LetDeclNode, Set<LetDeclNode>>();
  for (const component of cyclicComponents) {
    component.forEach(node => componentByNode.set(node, component));
  }

  const diagnostics: RsglDiagnostic[] = [];
  const fallbackRanges: Array<{ start: number; end: number }> = [];
  for (const component of cyclicComponents) {
    const ordered = [...component].sort((left, right) => left.range.start - right.range.start);
    const firstDependency = ordered
      .flatMap(lambda => dependencies.get(lambda) ?? [])
      .find(dependency => component.has(dependency.target));
    for (const owner of component) {
      for (const dependency of dependencies.get(owner) ?? []) {
        if (component.has(dependency.target)) {
          fallbackRanges.push(dependency.range);
        }
      }
    }
    diagnostics.push(diagnostic(
      "rsgl.recursiveLambdaValue",
      `Recursive lambda value cycle: ${componentNames(component).join(" -> ")}.`,
      firstDependency?.range ?? ordered[0]?.range ?? { start: 0, end: 1 }
    ));
  }
  for (const site of sites) {
    const component = site.owner ? componentByNode.get(site.owner) : undefined;
    for (const capture of site.forwardCaptures) {
      if (component?.has(capture.target)) {
        continue;
      }
      fallbackRanges.push(capture.range);
      diagnostics.push(diagnostic(
        "rsgl.invalidLambdaCapture",
        `Lambda '${site.label}' cannot capture later value '${capture.target.name?.text ?? "<unknown>"}'.`,
        capture.range
      ));
    }
  }
  return {
    diagnostics,
    fallbackRanges: deduplicateRanges(fallbackRanges)
  };
}

/** Requires complete annotations when a local lambda becomes part of the module API. */
export function exportedLambdaAnnotationDiagnostics(
  statements: readonly TopLevelStatementNode[],
  scope: RsglScope
): RsglDiagnostic[] {
  const diagnostics: RsglDiagnostic[] = [];
  const reported = new Set<LetDeclNode>();
  for (const statement of statements) {
    if (statement.kind !== "ExportDecl" || statement.source || statement.exportAll) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const symbol = lookup(scope, specifier.local.text);
      if (!symbol?.node || !isLambdaLet(symbol.node) || symbol.node.typeAnnotation || reported.has(symbol.node)) {
        continue;
      }
      reported.add(symbol.node);
      diagnostics.push(diagnostic(
        "rsgl.exportedLambdaNeedsTypeAnnotation",
        `Exported lambda value '${symbol.name}' needs a complete Function type annotation.`,
        symbol.node.name?.range ?? specifier.local.range,
        "warning"
      ));
    }
  }
  return diagnostics;
}

/**
 * Validates named re-exports after the program linker has resolved aliases to
 * their originating value declaration.
 */
export function exportedLambdaReexportAnnotationDiagnostics(
  models: readonly RsglSemanticModel[],
  exportMaps: ReadonlyMap<string, ReadonlyMap<string, RsglSymbol>>
): RsglFileDiagnostic[] {
  const diagnostics: RsglFileDiagnostic[] = [];
  for (const model of models) {
    const exports = exportMaps.get(normalizeExportMapKey(model.fileName));
    for (const record of model.exports) {
      if (record.exportAll) {
        const targetExports = record.resolvedFileName
          ? exportMaps.get(normalizeExportMapKey(record.resolvedFileName))
          : undefined;
        for (const [exportedName, symbol] of targetExports ?? []) {
          if (!symbol.node || !isLambdaLet(symbol.node) || symbol.node.typeAnnotation) {
            continue;
          }
          diagnostics.push(fileDiagnostic(
            model.fileName,
            "rsgl.exportedLambdaNeedsTypeAnnotation",
            `Re-exported lambda value '${exportedName}' needs a complete Function type annotation.`,
            record.node.range,
            "warning"
          ));
        }
        continue;
      }
      for (const specifier of record.specifiers) {
        const symbol = exports?.get(specifier.exported);
        if (!symbol?.node || !isLambdaLet(symbol.node) || symbol.node.typeAnnotation) {
          continue;
        }
        // Direct local definitions are already diagnosed during single-module
        // binding. This program pass owns source re-exports and the equivalent
        // import-then-local-export form after linking identifies the import.
        if (!record.source && symbol.kind !== "import") {
          continue;
        }
        diagnostics.push(fileDiagnostic(
          model.fileName,
          "rsgl.exportedLambdaNeedsTypeAnnotation",
          `Re-exported lambda value '${specifier.exported}' needs a complete Function type annotation.`,
          specifier.range,
          "warning"
        ));
      }
    }
  }
  return diagnostics;
}

/**
 * Collects only lambdas in expressions owned directly by this statement.
 * Nested statement lists are checked by their own body hook and therefore
 * must not inherit the parent's source-order table.
 */
function collectLambdaCaptureSite(
  statement: RsglStatement,
  directLetsByName: ReadonlyMap<string, LetDeclNode>,
  scope: RsglScope
): LambdaCaptureSite | undefined {
  const dependencies: LambdaDependency[] = [];
  const boundNames = new Map<string, number>();
  let lambdaDepth = 0;
  let foundLambda = false;

  walkRsglStatements([statement], {
    enterStatement(current) {
      if (current !== statement) {
        return "skipChildren";
      }
      return;
    },
    enterExpression(expression) {
      if (expression.kind === "LambdaExpr") {
        foundLambda = true;
        lambdaDepth++;
        expression.parameters.forEach(parameter => addBoundName(boundNames, parameter.text));
        return;
      }
      // A normal forward reference in an initializer keeps its ordinary
      // undefined/value-order diagnostic. Only a lambda creates a closure.
      if (
        lambdaDepth === 0
        || expression.kind !== "IdentifierExpr"
        || boundNames.has(expression.name.text)
      ) {
        return;
      }
      const localTarget = directLetsByName.get(expression.name.text);
      const symbol = lookup(scope, expression.name.text);
      const target = localTarget ?? (
        symbol?.node?.kind === "LetDecl" ? symbol.node as LetDeclNode : undefined
      );
      if (target) {
        dependencies.push({ target, range: expression.range });
      }
    },
    leaveExpression(expression) {
      if (expression.kind !== "LambdaExpr") {
        return;
      }
      expression.parameters.forEach(parameter => removeBoundName(boundNames, parameter.text));
      lambdaDepth--;
    }
  });

  if (!foundLambda) {
    return undefined;
  }
  const uniqueDependencies = deduplicateDependencies(dependencies);
  const owner = statement.kind === "LetDecl" ? statement : undefined;
  return {
    owner,
    label: owner?.name?.text ?? "<anonymous>",
    dependencies: uniqueDependencies,
    forwardCaptures: uniqueDependencies.filter(dependency =>
      dependency.target.range.start > statement.range.start
    )
  };
}

function isLambdaLet(statement: RsglNode): statement is LetDeclNode & {
  value: Extract<ExprNode, { kind: "LambdaExpr" }>;
} {
  if (statement.kind !== "LetDecl") {
    return false;
  }
  return (statement as LetDeclNode).value.kind === "LambdaExpr";
}

function deduplicateDependencies(dependencies: readonly LambdaDependency[]): LambdaDependency[] {
  const seen = new Set<string>();
  return dependencies.filter(dependency => {
    const key = `${dependency.target.range.start}:${dependency.range.start}:${dependency.range.end}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function deduplicateRanges(
  ranges: readonly { start: number; end: number }[]
): Array<{ start: number; end: number }> {
  const seen = new Set<string>();
  return ranges.filter(range => {
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function cyclicLambdaComponents(
  nodes: readonly LetDeclNode[],
  dependencies: ReadonlyMap<LetDeclNode, readonly LambdaDependency[]>
): Set<LetDeclNode>[] {
  const adjacency = new Map(nodes.map(node => [
    node,
    (dependencies.get(node) ?? []).map(dependency => dependency.target)
  ] as const));
  const reverse = new Map(nodes.map(node => [node, [] as LetDeclNode[]] as const));
  for (const [source, targets] of adjacency) {
    for (const target of targets) {
      reverse.get(target)?.push(source);
    }
  }

  const visited = new Set<LetDeclNode>();
  const order: LetDeclNode[] = [];
  for (const start of nodes) {
    if (visited.has(start)) {
      continue;
    }
    const stack: Array<{ node: LetDeclNode; expanded: boolean }> = [{ node: start, expanded: false }];
    while (stack.length > 0) {
      const item = stack.pop()!;
      if (item.expanded) {
        order.push(item.node);
        continue;
      }
      if (visited.has(item.node)) {
        continue;
      }
      visited.add(item.node);
      stack.push({ node: item.node, expanded: true });
      for (const target of [...(adjacency.get(item.node) ?? [])].reverse()) {
        if (!visited.has(target)) {
          stack.push({ node: target, expanded: false });
        }
      }
    }
  }

  const assigned = new Set<LetDeclNode>();
  const cyclic: Set<LetDeclNode>[] = [];
  for (const start of order.reverse()) {
    if (assigned.has(start)) {
      continue;
    }
    const component = new Set<LetDeclNode>();
    const stack = [start];
    assigned.add(start);
    while (stack.length > 0) {
      const node = stack.pop()!;
      component.add(node);
      for (const target of reverse.get(node) ?? []) {
        if (!assigned.has(target)) {
          assigned.add(target);
          stack.push(target);
        }
      }
    }
    const selfRecursive = component.size === 1
      && (adjacency.get(start) ?? []).includes(start);
    if (component.size > 1 || selfRecursive) {
      cyclic.push(component);
    }
  }
  return cyclic;
}

function componentNames(component: ReadonlySet<LetDeclNode>): string[] {
  const names = [...component]
    .sort((left, right) => left.range.start - right.range.start)
    .map(node => node.name?.text ?? "<anonymous>");
  return names.length > 0 ? [...names, names[0]] : ["<anonymous>"];
}

function addBoundName(boundNames: Map<string, number>, name: string): void {
  boundNames.set(name, (boundNames.get(name) ?? 0) + 1);
}

function removeBoundName(boundNames: Map<string, number>, name: string): void {
  const count = boundNames.get(name) ?? 0;
  if (count <= 1) {
    boundNames.delete(name);
  } else {
    boundNames.set(name, count - 1);
  }
}

function normalizeExportMapKey(fileName: string): string {
  return rsglPathKey(fileName);
}
