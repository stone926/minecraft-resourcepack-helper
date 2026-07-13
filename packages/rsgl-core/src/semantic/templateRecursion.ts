import type { TemplateDeclNode } from "../parser";
import { fileDiagnostic } from "./diagnostics";
import { lookup } from "./scopes";
import type { RsglFileDiagnostic, RsglSemanticModel } from "./types";

interface TemplateCallEdge {
  from: TemplateDeclNode;
  to: TemplateDeclNode;
  fileName: string;
  range: { start: number; end: number };
  calleeName: string;
}

export function validateTemplateRecursion(models: readonly RsglSemanticModel[]): RsglFileDiagnostic[] {
  const edges = collectTemplateCallEdges(models);
  // A call edge participates in a cycle exactly when both endpoints belong to
  // the same strongly connected component. Filtering the original edge list
  // keeps diagnostic order and call-site locations stable.
  const componentByTemplate = indexStronglyConnectedComponents(edges);

  return edges
    .filter(edge => {
      const component = componentByTemplate.get(edge.from);
      return component !== undefined && component === componentByTemplate.get(edge.to);
    })
    .map(edge => fileDiagnostic(
      edge.fileName,
      "rsgl.templateRecursion",
      `Template '${edge.calleeName}' participates in a recursive expansion cycle.`,
      edge.range
    ));
}

function collectTemplateCallEdges(models: readonly RsglSemanticModel[]): TemplateCallEdge[] {
  const edges: TemplateCallEdge[] = [];
  for (const model of models) {
    for (const use of model.templateUses ?? []) {
      if (!use.enclosingTemplate) {
        continue;
      }
      const expression = use.expression;
      if (expression.kind !== "CallExpr" || expression.callee.kind !== "IdentifierExpr") {
        continue;
      }
      const symbol = lookup(use.scope, expression.callee.name.text);
      if (!symbol?.signature?.templateOutput || !isTemplateDeclNode(symbol.node)) {
        continue;
      }
      edges.push({
        from: use.enclosingTemplate,
        to: symbol.node,
        fileName: model.fileName,
        range: expression.range,
        calleeName: expression.callee.name.text
      });
    }
  }
  return edges;
}

function isTemplateDeclNode(node: unknown): node is TemplateDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "TemplateDecl");
}

interface TemplateCallGraph {
  nodes: readonly TemplateDeclNode[];
  adjacency: ReadonlyMap<TemplateDeclNode, readonly TemplateDeclNode[]>;
  reverseAdjacency: ReadonlyMap<TemplateDeclNode, readonly TemplateDeclNode[]>;
}

interface DepthFirstSearchFrame {
  node: TemplateDeclNode;
  nextNeighborIndex: number;
}

function indexStronglyConnectedComponents(
  edges: readonly TemplateCallEdge[]
): Map<TemplateDeclNode, number> {
  const graph = createTemplateCallGraph(edges);
  const finishingOrder = collectFinishingOrder(graph.nodes, graph.adjacency);
  const componentByTemplate = new Map<TemplateDeclNode, number>();
  let component = 0;

  for (let index = finishingOrder.length - 1; index >= 0; index--) {
    const root = finishingOrder[index];
    if (componentByTemplate.has(root)) {
      continue;
    }

    assignComponent(root, component, graph.reverseAdjacency, componentByTemplate);
    component++;
  }

  return componentByTemplate;
}

function createTemplateCallGraph(edges: readonly TemplateCallEdge[]): TemplateCallGraph {
  const nodes: TemplateDeclNode[] = [];
  const adjacency = new Map<TemplateDeclNode, TemplateDeclNode[]>();
  const reverseAdjacency = new Map<TemplateDeclNode, TemplateDeclNode[]>();

  const ensureNode = (node: TemplateDeclNode): void => {
    if (adjacency.has(node)) {
      return;
    }
    nodes.push(node);
    adjacency.set(node, []);
    reverseAdjacency.set(node, []);
  };

  for (const edge of edges) {
    ensureNode(edge.from);
    ensureNode(edge.to);
    adjacency.get(edge.from)?.push(edge.to);
    reverseAdjacency.get(edge.to)?.push(edge.from);
  }

  return { nodes, adjacency, reverseAdjacency };
}

function collectFinishingOrder(
  nodes: readonly TemplateDeclNode[],
  adjacency: ReadonlyMap<TemplateDeclNode, readonly TemplateDeclNode[]>
): TemplateDeclNode[] {
  const visited = new Set<TemplateDeclNode>();
  const finishingOrder: TemplateDeclNode[] = [];

  for (const root of nodes) {
    if (visited.has(root)) {
      continue;
    }

    visited.add(root);
    const stack: DepthFirstSearchFrame[] = [{ node: root, nextNeighborIndex: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.nextNeighborIndex >= neighbors.length) {
        finishingOrder.push(frame.node);
        stack.pop();
        continue;
      }

      const next = neighbors[frame.nextNeighborIndex];
      frame.nextNeighborIndex++;
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      stack.push({ node: next, nextNeighborIndex: 0 });
    }
  }

  return finishingOrder;
}

function assignComponent(
  root: TemplateDeclNode,
  component: number,
  reverseAdjacency: ReadonlyMap<TemplateDeclNode, readonly TemplateDeclNode[]>,
  componentByTemplate: Map<TemplateDeclNode, number>
): void {
  componentByTemplate.set(root, component);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    for (const next of reverseAdjacency.get(current) ?? []) {
      if (componentByTemplate.has(next)) {
        continue;
      }
      componentByTemplate.set(next, component);
      stack.push(next);
    }
  }
}
