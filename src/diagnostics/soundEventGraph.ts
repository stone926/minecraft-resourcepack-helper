import { parseMinecraftResourceId } from "../../packages/mc-assets/src";
import {
  arrayElements,
  getObjectMember,
  type JsonAstNode,
  type JsonDocumentNode,
  memberName,
  objectMembers,
  stringValue
} from "../utils/jsonAst";

export interface SoundEventGraphEdge {
  sourceId: string;
  targetId: string;
  targetNamespace: string;
  targetPath: string;
  value: string;
  node: JsonAstNode;
}

export interface SoundEventFileGraph {
  namespace: string;
  eventNames: ReadonlySet<string>;
  eventIds: ReadonlySet<string>;
  edges: readonly SoundEventGraphEdge[];
  edgesBySource: ReadonlyMap<string, readonly SoundEventGraphEdge[]>;
}

export function buildSoundEventFileGraph(
  ast: JsonDocumentNode,
  namespace: string
): SoundEventFileGraph {
  const eventNames = new Set<string>();
  const eventIds = new Set<string>();
  const edges: SoundEventGraphEdge[] = [];
  const edgesBySource = new Map<string, SoundEventGraphEdge[]>();

  for (const soundEvent of objectMembers(ast.body)) {
    const sourcePath = memberName(soundEvent);
    if (!sourcePath) {
      continue;
    }
    const sourceId = `${namespace}:${sourcePath}`;
    eventNames.add(sourcePath);
    eventIds.add(sourceId);

    const outgoing: SoundEventGraphEdge[] = [];
    const sounds = getObjectMember(soundEvent.value, "sounds");
    for (const sound of arrayElements(sounds?.value)) {
      if (stringValue(getObjectMember(sound, "type")?.value) !== "event") {
        continue;
      }
      const name = getObjectMember(sound, "name");
      const value = stringValue(name?.value);
      if (!value || !name?.value) {
        continue;
      }
      const target = parseMinecraftResourceId(value, namespace);
      if (!target.isValid) {
        continue;
      }
      const edge: SoundEventGraphEdge = {
        sourceId,
        targetId: `${target.namespace}:${target.path}`,
        targetNamespace: target.namespace,
        targetPath: target.path,
        value,
        node: name.value
      };
      outgoing.push(edge);
      edges.push(edge);
    }
    edgesBySource.set(sourceId, outgoing);
  }

  return { namespace, eventNames, eventIds, edges, edgesBySource };
}

/** Returns the exact reference edges that belong to a strongly connected component. */
export function findCyclicSoundEventEdges(
  edges: readonly SoundEventGraphEdge[]
): ReadonlySet<SoundEventGraphEdge> {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    addGraphEdge(forward, edge.sourceId, edge.targetId);
    addGraphEdge(reverse, edge.targetId, edge.sourceId);
    forward.set(edge.targetId, forward.get(edge.targetId) ?? []);
    reverse.set(edge.sourceId, reverse.get(edge.sourceId) ?? []);
  }

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const eventId of forward.keys()) {
    if (visited.has(eventId)) {
      continue;
    }
    visited.add(eventId);
    const stack: Array<{ eventId: string; nextTargetIndex: number }> = [{
      eventId,
      nextTargetIndex: 0
    }];
    while (stack.length > 0) {
      const current = stack[stack.length - 1];
      if (!current) {
        break;
      }
      const targets = forward.get(current.eventId) ?? [];
      const target = targets[current.nextTargetIndex];
      if (target === undefined) {
        stack.pop();
        finishOrder.push(current.eventId);
        continue;
      }
      current.nextTargetIndex++;
      if (!visited.has(target)) {
        visited.add(target);
        stack.push({ eventId: target, nextTargetIndex: 0 });
      }
    }
  }

  const componentByEvent = new Map<string, number>();
  const componentSizes: number[] = [];
  for (let index = finishOrder.length - 1; index >= 0; index--) {
    const eventId = finishOrder[index];
    if (!eventId || componentByEvent.has(eventId)) {
      continue;
    }
    const component = componentSizes.length;
    let size = 0;
    const stack = [eventId];
    componentByEvent.set(eventId, component);
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      size++;
      for (const source of reverse.get(current) ?? []) {
        if (!componentByEvent.has(source)) {
          componentByEvent.set(source, component);
          stack.push(source);
        }
      }
    }
    componentSizes.push(size);
  }

  return new Set(edges.filter(edge => {
    const sourceComponent = componentByEvent.get(edge.sourceId);
    const targetComponent = componentByEvent.get(edge.targetId);
    return sourceComponent !== undefined &&
      sourceComponent === targetComponent &&
      ((componentSizes[sourceComponent] ?? 0) > 1 || edge.sourceId === edge.targetId);
  }));
}

function addGraphEdge(graph: Map<string, string[]>, source: string, target: string): void {
  const targets = graph.get(source);
  if (targets) {
    targets.push(target);
  } else {
    graph.set(source, [target]);
  }
}
