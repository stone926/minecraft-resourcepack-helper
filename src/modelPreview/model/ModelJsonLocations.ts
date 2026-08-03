import type { PreviewDirection, PreviewRange } from "../ir/PreviewDocument";
import { arrayElements, memberName, objectMembers, parseJsonAst, type JsonAstNode, type JsonMemberNode } from "../../utils/jsonAst";
import type { AstLocation } from "../../utils/locationChecker";

export interface ModelFaceLocations {
  range?: PreviewRange;
  texture?: PreviewRange;
  uv?: PreviewRange;
}

export interface ModelElementLocations {
  range?: PreviewRange;
  from?: PreviewRange;
  to?: PreviewRange;
  rotationRescale?: PreviewRange;
  faces: Partial<Record<PreviewDirection, ModelFaceLocations>>;
}

export interface ModelJsonLocations {
  parent?: PreviewRange;
  textures: Record<string, PreviewRange>;
  elements: ModelElementLocations[];
}

const directions: PreviewDirection[] = ["down", "up", "north", "south", "west", "east"];

export function collectModelJsonLocations(text: string): ModelJsonLocations {
  const locations: ModelJsonLocations = {
    textures: {},
    elements: []
  };
  const document = parseJsonAst(text);
  const root = document?.body;
  if (!root) {
    return locations;
  }

  for (const member of objectMembers(root)) {
    const name = memberName(member);
    if (name === "parent") {
      locations.parent = rangeInsideStringNode(member.value) ?? rangeFromNode(member.value);
    } else if (name === "textures") {
      locations.textures = collectTextureLocations(member.value);
    } else if (name === "elements") {
      locations.elements = collectElementLocations(member.value);
    }
  }

  return locations;
}

function collectTextureLocations(node: JsonAstNode): Record<string, PreviewRange> {
  const textures: Record<string, PreviewRange> = {};
  for (const member of objectMembers(node)) {
    const name = memberName(member);
    if (name) {
      const range = rangeInsideStringNode(member.value) ?? rangeFromNode(member.value) ?? rangeFromNode(member);
      if (range) {
        textures[name] = range;
      }
    }
  }
  return textures;
}

function collectElementLocations(node: JsonAstNode): ModelElementLocations[] {
  return arrayElements(node).map(elementNode => {
    const element = unwrapElement(elementNode);
    const locations: ModelElementLocations = {
      range: rangeFromNode(element),
      faces: {}
    };

    for (const member of objectMembers(element)) {
      const name = memberName(member);
      if (name === "from") {
        locations.from = rangeFromNode(member.value);
      } else if (name === "to") {
        locations.to = rangeFromNode(member.value);
      } else if (name === "rotation") {
        locations.rotationRescale = collectRotationRescaleLocation(member.value);
      } else if (name === "faces") {
        locations.faces = collectFaceLocations(member.value);
      }
    }

    return locations;
  });
}

function collectRotationRescaleLocation(node: JsonAstNode): PreviewRange | undefined {
  for (const member of objectMembers(node)) {
    if (memberName(member) === "rescale") {
      return rangeFromNode(member.value) ?? rangeFromNode(member);
    }
  }
  return undefined;
}

function collectFaceLocations(node: JsonAstNode): Partial<Record<PreviewDirection, ModelFaceLocations>> {
  const faces: Partial<Record<PreviewDirection, ModelFaceLocations>> = {};

  for (const member of objectMembers(node)) {
    const direction = memberName(member);
    if (!isPreviewDirection(direction)) {
      continue;
    }

    const face: ModelFaceLocations = {
      range: rangeFromNode(member.value)
    };
    for (const faceMember of objectMembers(member.value)) {
      const name = memberName(faceMember);
      if (name === "texture") {
        face.texture = rangeInsideStringNode(faceMember.value) ?? rangeFromNode(faceMember.value);
      } else if (name === "uv") {
        face.uv = rangeFromNode(faceMember.value);
      }
    }
    faces[direction] = face;
  }

  return faces;
}

function isPreviewDirection(value: string | undefined): value is PreviewDirection {
  return directions.includes(value as PreviewDirection);
}

function unwrapElement(node: JsonAstNode): JsonAstNode {
  return node.type === "Element" ? node.value : node;
}

function rangeInsideStringNode(node: JsonAstNode): PreviewRange | undefined {
  const value = unwrapElement(node);
  if (value.type !== "String" || !value.loc) {
    return undefined;
  }

  return {
    start: {
      line: value.loc.start.line - 1,
      character: Math.max(0, value.loc.start.column - 1)
    },
    end: {
      line: value.loc.end.line - 1,
      character: Math.max(value.loc.start.column, value.loc.end.column - 2)
    }
  };
}

function rangeFromNode(node: JsonAstNode | JsonMemberNode): PreviewRange | undefined {
  return rangeFromLocation(node.loc);
}

function rangeFromLocation(loc: AstLocation | null | undefined): PreviewRange | undefined {
  if (!loc) {
    return undefined;
  }

  return {
    start: {
      line: loc.start.line - 1,
      character: Math.max(0, loc.start.column - 1)
    },
    end: {
      line: loc.end.line - 1,
      character: Math.max(0, loc.end.column - 1)
    }
  };
}
