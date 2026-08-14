import type { TextRange } from "../parser";
import { rsglPathKey } from "../pathIdentity";
import { fileDiagnostic } from "./diagnostics";
import { RsglImportGraphIndex } from "./importGraphIndex";
import {
  isCyclicImportComponent,
  stronglyConnectedImportComponents
} from "./importCycleAnalysis";
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
  componentId: string;
  fileName: string;
  alias: string;
  range: TextRange;
  settlingPasses: number;
}

interface ImportComponentDependencyGraph {
  componentByFile: ReadonlyMap<string, string>;
  importersByComponent: ReadonlyMap<string, ReadonlySet<string>>;
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
  private readonly changingPasses = new Map<string, Map<string, Map<string, number>>>();
  private readonly reportedMembers = new Set<string>();
  private readonly collectedDiagnostics: RsglFileDiagnostic[] = [];
  private readonly componentDependencies: ImportComponentDependencyGraph;
  private readonly settlingPassBudget: number;

  public constructor(
    models: readonly RsglSemanticModel[],
    importGraph: RsglImportGraph
  ) {
    const components = stronglyConnectedImportComponents(importGraph);
    this.componentDependencies = createImportComponentDependencyGraph(components, importGraph);
    const importGraphIndex = new RsglImportGraphIndex(importGraph);
    const componentByFile = new Map<string, readonly string[]>();
    let settlingPassBudget = 0;
    for (const component of components) {
      if (!isCyclicImportComponent(component, importGraph)) {
        continue;
      }
      settlingPassBudget += Math.max(8, component.length * 2 + 2);
      for (const fileName of component) {
        componentByFile.set(fileName, component);
      }
    }
    this.settlingPassBudget = settlingPassBudget;

    const edges: NamespaceImportEdge[] = [];
    for (const model of models) {
      const from = rsglPathKey(model.fileName);
      for (const record of model.imports) {
        if (!record.namespaceName) {
          continue;
        }
        const namespaceSymbol = model.scope.symbols.get(record.namespaceName);
        if (namespaceSymbol?.kind !== "namespace" || namespaceSymbol.node !== record.node) {
          continue;
        }
        const edge = importGraphIndex.resolve(
          model.fileName,
          record.source,
          record.resolvedFileName
        );
        const component = edge ? componentByFile.get(from) : undefined;
        const targetKey = edge ? rsglPathKey(edge.to) : undefined;
        if (!edge || !targetKey || !component?.includes(targetKey)) {
          continue;
        }
        edges.push({
          from,
          componentId: component[0],
          fileName: model.fileName,
          alias: record.namespaceName,
          range: record.node.namespaceName?.range ?? record.node.range,
          settlingPasses: Math.max(8, component.length * 2 + 2)
        });
      }
    }
    this.cyclicEdges = edges;
  }

  public stabilize(
    previous: RsglModuleNamespaceEnvironment,
    next: RsglModuleNamespaceEnvironment,
    pendingInputFiles: ReadonlySet<string>
  ): RsglModuleNamespaceEnvironment {
    const componentsWithPendingDependencies = componentsDependingOnPendingFiles(
      pendingInputFiles,
      this.componentDependencies
    );
    for (const edge of this.cyclicEdges) {
      if (componentsWithPendingDependencies.has(edge.componentId)) {
        this.resetChangingPasses(edge);
        continue;
      }
      const previousType = previous.get(edge.from)?.get(edge.alias);
      const nextType = next.get(edge.from)?.get(edge.alias);
      if (previousType?.kind !== "ModuleNamespace" || nextType?.kind !== "ModuleNamespace") {
        continue;
      }
      for (const [name, nextMember] of nextType.moduleNamespaceMembers ?? []) {
        if (this.lockedMembers.get(edge.from)?.get(edge.alias)?.has(name)) {
          continue;
        }
        const previousMember = previousType.moduleNamespaceMembers?.get(name);
        if (
          nextMember.category !== "value"
          || previousMember?.category !== "value"
        ) {
          this.resetChangingPasses(edge, name);
          continue;
        }
        if (valueMemberTypeFingerprint(previousMember) === valueMemberTypeFingerprint(nextMember)) {
          this.resetChangingPasses(edge, name);
          continue;
        }
        if (this.incrementChangingPasses(edge, name) < edge.settlingPasses) {
          continue;
        }
        this.lockMember(edge.from, edge.alias, name);
        const reportKey = `${edge.from}\0${edge.alias}\0${name}`;
        if (!this.reportedMembers.has(reportKey)) {
          this.reportedMembers.add(reportKey);
          this.collectedDiagnostics.push(fileDiagnostic(
            edge.fileName,
            "rsgl.cyclicNamespaceTypeInference",
            `Type inference for '${edge.alias}.${name}' is structurally recursive across an import cycle; its namespace member type was widened to Unknown.`,
            edge.range
          ));
        }
      }
    }
    return this.applyLocks(next);
  }

  /** Extra cap headroom for cyclic components that may settle serially. */
  public additionalPassBudget(): number {
    return this.settlingPassBudget;
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

  private incrementChangingPasses(edge: NamespaceImportEdge, member: string): number {
    let aliases = this.changingPasses.get(edge.from);
    if (!aliases) {
      aliases = new Map();
      this.changingPasses.set(edge.from, aliases);
    }
    let members = aliases.get(edge.alias);
    if (!members) {
      members = new Map();
      aliases.set(edge.alias, members);
    }
    const next = (members.get(member) ?? 0) + 1;
    members.set(member, next);
    return next;
  }

  private resetChangingPasses(edge: NamespaceImportEdge, member?: string): void {
    const aliases = this.changingPasses.get(edge.from);
    const members = aliases?.get(edge.alias);
    if (!members) {
      return;
    }
    if (member !== undefined) {
      members.delete(member);
      if (members.size > 0) {
        return;
      }
    }
    aliases?.delete(edge.alias);
    if (aliases?.size === 0) {
      this.changingPasses.delete(edge.from);
    }
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

/**
 * Retains the reverse condensation graph so each pass can mark only components
 * that transitively depend on inputs which actually changed.
 */
function createImportComponentDependencyGraph(
  components: readonly (readonly string[])[],
  importGraph: RsglImportGraph
): ImportComponentDependencyGraph {
  const componentByFile = new Map<string, string>();
  const importersByComponent = new Map<string, Set<string>>();
  for (const component of components) {
    const componentId = component[0];
    importersByComponent.set(componentId, new Set());
    for (const fileName of component) {
      componentByFile.set(fileName, componentId);
    }
  }
  for (const edge of importGraph.edges) {
    const sourceComponent = componentByFile.get(rsglPathKey(edge.from));
    const targetComponent = componentByFile.get(rsglPathKey(edge.to));
    if (sourceComponent && targetComponent && sourceComponent !== targetComponent) {
      importersByComponent.get(targetComponent)?.add(sourceComponent);
    }
  }
  return { componentByFile, importersByComponent };
}

function componentsDependingOnPendingFiles(
  pendingInputFiles: ReadonlySet<string>,
  dependencyGraph: ImportComponentDependencyGraph
): ReadonlySet<string> {
  const queue = Array.from(pendingInputFiles, fileName =>
    dependencyGraph.componentByFile.get(fileName)
  ).filter((componentId): componentId is string => Boolean(componentId));
  const result = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    for (const importer of dependencyGraph.importersByComponent.get(queue[index]) ?? []) {
      if (result.has(importer)) {
        continue;
      }
      result.add(importer);
      queue.push(importer);
    }
  }
  return result;
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
