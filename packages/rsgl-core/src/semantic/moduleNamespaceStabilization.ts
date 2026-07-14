import * as path from "node:path";
import type { TextRange } from "../parser";
import { fileDiagnostic } from "./diagnostics";
import { rsglTypeKey } from "./typeNormalization";
import type {
  RsglFileDiagnostic,
  RsglImportGraph,
  RsglModuleNamespaceMember,
  RsglSemanticModel,
  RsglSymbol,
  RsglType
} from "./types";
import { unknownType } from "./types";

export type RsglModuleNamespaceEnvironment = Map<string, Map<string, RsglType>>;

interface NamespaceImportEdge {
  from: string;
  to: string;
  alias: string;
  range: TextRange;
  componentSize: number;
}

/**
 * Prevents structurally recursive namespace inference from growing one layer
 * per global bind pass. Finite cycles are allowed to settle first; a value
 * member that keeps changing inside an import SCC is then widened to Unknown
 * and held stable for the remainder of the link.
 */
export class RsglModuleNamespaceCycleStabilizer {
  private readonly cyclicEdges: NamespaceImportEdge[];
  private readonly lockedMembers = new Map<string, Map<string, Set<string>>>();
  private readonly reportedMembers = new Set<string>();
  private readonly collectedDiagnostics: RsglFileDiagnostic[] = [];

  public constructor(
    models: readonly RsglSemanticModel[],
    importGraph: RsglImportGraph
  ) {
    const components = stronglyConnectedImportComponents(importGraph);
    const componentByFile = new Map<string, readonly string[]>();
    for (const component of components) {
      if (!isCyclicComponent(component, importGraph)) {
        continue;
      }
      for (const fileName of component) {
        componentByFile.set(fileName, component);
      }
    }

    const edges: NamespaceImportEdge[] = [];
    for (const model of models) {
      const from = normalizeFileName(model.fileName);
      for (const record of model.imports) {
        if (!record.namespaceName) {
          continue;
        }
        const edge = importGraph.edges.find(candidate =>
          candidate.from === from
          && candidate.source === record.source
          && normalizeFileName(record.resolvedFileName ?? candidate.to) === candidate.to
        );
        const component = edge ? componentByFile.get(from) : undefined;
        if (!edge || !component?.includes(edge.to)) {
          continue;
        }
        edges.push({
          from,
          to: edge.to,
          alias: record.namespaceName,
          range: record.node.namespaceName?.range ?? record.node.range,
          componentSize: component.length
        });
      }
    }
    this.cyclicEdges = edges;
  }

  public stabilize(
    completedPasses: number,
    previous: RsglModuleNamespaceEnvironment,
    next: RsglModuleNamespaceEnvironment
  ): RsglModuleNamespaceEnvironment {
    for (const edge of this.cyclicEdges) {
      const settlingPasses = Math.max(8, edge.componentSize * 2 + 2);
      if (completedPasses < settlingPasses) {
        continue;
      }
      const previousType = previous.get(edge.from)?.get(edge.alias);
      const nextType = next.get(edge.from)?.get(edge.alias);
      if (previousType?.kind !== "ModuleNamespace" || nextType?.kind !== "ModuleNamespace") {
        continue;
      }
      for (const [name, nextMember] of nextType.moduleNamespaceMembers ?? []) {
        const previousMember = previousType.moduleNamespaceMembers?.get(name);
        if (
          nextMember.category !== "value"
          || previousMember?.category !== "value"
          || valueMemberTypeFingerprint(previousMember) === valueMemberTypeFingerprint(nextMember)
        ) {
          continue;
        }
        this.lockMember(edge.from, edge.alias, name);
        const reportKey = `${edge.from}\0${edge.alias}\0${name}`;
        if (!this.reportedMembers.has(reportKey)) {
          this.reportedMembers.add(reportKey);
          this.collectedDiagnostics.push(fileDiagnostic(
            edge.from,
            "rsgl.cyclicNamespaceTypeInference",
            `Type inference for '${edge.alias}.${name}' is structurally recursive across an import cycle; its namespace member type was widened to Unknown.`,
            edge.range
          ));
        }
      }
    }
    return this.applyLocks(next);
  }

  public diagnostics(): readonly RsglFileDiagnostic[] {
    return this.collectedDiagnostics;
  }

  private lockMember(fileName: string, alias: string, member: string): void {
    let aliases = this.lockedMembers.get(fileName);
    if (!aliases) {
      aliases = new Map();
      this.lockedMembers.set(fileName, aliases);
    }
    let members = aliases.get(alias);
    if (!members) {
      members = new Set();
      aliases.set(alias, members);
    }
    members.add(member);
  }

  private applyLocks(
    environment: RsglModuleNamespaceEnvironment
  ): RsglModuleNamespaceEnvironment {
    if (this.lockedMembers.size === 0) {
      return environment;
    }
    const result: RsglModuleNamespaceEnvironment = new Map();
    for (const [fileName, namespaces] of environment) {
      const lockedAliases = this.lockedMembers.get(fileName);
      if (!lockedAliases) {
        result.set(fileName, namespaces);
        continue;
      }
      const nextNamespaces = new Map(namespaces);
      for (const [alias, members] of lockedAliases) {
        const type = nextNamespaces.get(alias);
        if (type?.kind === "ModuleNamespace") {
          nextNamespaces.set(alias, widenNamespaceMembers(type, members));
        }
      }
      result.set(fileName, nextNamespaces);
    }
    return result;
  }
}

function widenNamespaceMembers(type: RsglType, names: ReadonlySet<string>): RsglType {
  const members = new Map(type.moduleNamespaceMembers ?? []);
  for (const name of names) {
    const member = members.get(name);
    if (!member || member.category !== "value") {
      continue;
    }
    members.set(name, {
      ...member,
      symbol: widenedValueSymbol(member.symbol)
    });
  }
  return { ...type, moduleNamespaceMembers: members };
}

function widenedValueSymbol(symbol: RsglSymbol): RsglSymbol {
  if (symbol.type.kind !== "Function") {
    return { ...symbol, type: unknownType };
  }
  const type: RsglType = {
    ...symbol.type,
    parameters: symbol.type.parameters?.map(() => unknownType),
    returnType: unknownType
  };
  return {
    ...symbol,
    type,
    ...(symbol.signature
      ? {
          signature: {
            ...symbol.signature,
            parameters: symbol.signature.parameters.map(parameter => ({
              ...parameter,
              type: unknownType
            })),
            returnType: unknownType
          }
        }
      : {})
  };
}

function valueMemberTypeFingerprint(member: RsglModuleNamespaceMember): string {
  const signature = member.symbol.signature;
  return [
    rsglTypeKey(member.symbol.type),
    signature
      ? [
          signature.parameters.map(parameter => rsglTypeKey(parameter.type)).join(","),
          rsglTypeKey(signature.returnType)
        ].join("->")
      : ""
  ].join("|");
}

function stronglyConnectedImportComponents(importGraph: RsglImportGraph): string[][] {
  const nodes = new Set(importGraph.files.map(normalizeFileName));
  for (const edge of importGraph.edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  const outgoing = new Map<string, Set<string>>();
  for (const node of nodes) {
    outgoing.set(node, new Set());
  }
  for (const edge of importGraph.edges) {
    outgoing.get(edge.from)?.add(edge.to);
  }

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indexes.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const target of outgoing.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) {
      return;
    }
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) {
        break;
      }
    }
    components.push(component.sort((left, right) => left.localeCompare(right, "en")));
  };

  for (const node of [...nodes].sort((left, right) => left.localeCompare(right, "en"))) {
    if (!indexes.has(node)) {
      visit(node);
    }
  }
  return components;
}

function isCyclicComponent(
  component: readonly string[],
  importGraph: RsglImportGraph
): boolean {
  return component.length > 1
    || importGraph.edges.some(edge => edge.from === component[0] && edge.to === component[0]);
}

function normalizeFileName(fileName: string): string {
  return path.normalize(path.resolve(fileName));
}
