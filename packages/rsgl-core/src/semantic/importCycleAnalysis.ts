import { rsglPathKey } from "../pathIdentity";
import type { RsglImportGraph } from "./types";

/** Returns deterministic strongly connected components using path-identity keys. */
export function stronglyConnectedImportComponents(importGraph: RsglImportGraph): string[][] {
  const nodes = new Set(importGraph.files.map(rsglPathKey));
  for (const edge of importGraph.edges) {
    nodes.add(rsglPathKey(edge.from));
    nodes.add(rsglPathKey(edge.to));
  }
  const outgoing = new Map<string, Set<string>>();
  for (const node of nodes) {
    outgoing.set(node, new Set());
  }
  for (const edge of importGraph.edges) {
    outgoing.get(rsglPathKey(edge.from))?.add(rsglPathKey(edge.to));
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

export function isCyclicImportComponent(
  component: readonly string[],
  importGraph: RsglImportGraph
): boolean {
  return component.length > 1
    || importGraph.edges.some(edge =>
      rsglPathKey(edge.from) === component[0] && rsglPathKey(edge.to) === component[0]
    );
}

/** Maps every cyclic file to a stable identifier for its import component. */
export function cyclicImportComponentByFile(
  importGraph: RsglImportGraph
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const component of stronglyConnectedImportComponents(importGraph)) {
    if (!isCyclicImportComponent(component, importGraph)) {
      continue;
    }
    const componentId = component[0];
    for (const fileName of component) {
      result.set(fileName, componentId);
    }
  }
  return result;
}
