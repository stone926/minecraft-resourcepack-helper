export type RsglModelGeometryKeywordRole =
  | "elementHeaderClause"
  | "elementBodyClause"
  | "faceIntroducer"
  | "faceTarget"
  | "transformOperation"
  | "transformClause"
  | "nestedExpression";

export type RsglModelTransformAxis = "x" | "y" | "z";

export interface RsglModelGeometryCompletionDescriptor {
  label: string;
  insertText: string;
  detail: string;
}

interface RsglModelGeometryStatementDescriptorDefinition {
  keyword: string;
  statement:
    | {
        kind: "element";
        elementKind: "box" | "element";
        completion: Omit<RsglModelGeometryCompletionDescriptor, "label">;
      }
    | {
        kind: "transform";
        completion: Omit<RsglModelGeometryCompletionDescriptor, "label">;
      };
}

interface RsglModelGeometryRoleDescriptorDefinition {
  keyword: string;
  roles: readonly RsglModelGeometryKeywordRole[];
  transformAxis?: RsglModelTransformAxis;
}

type RsglModelGeometryKeywordDescriptorDefinition =
  | RsglModelGeometryStatementDescriptorDefinition
  | RsglModelGeometryRoleDescriptorDefinition;

/**
 * Single syntax registry for model-geometry keywords.
 *
 * Keep lexical classification, parser roles, statement normalization, and
 * completion metadata together so adding a geometry clause cannot update one
 * language surface while silently missing another.
 */
export const rsglModelGeometryKeywordDescriptors = [
  {
    keyword: "box",
    statement: {
      kind: "element",
      elementKind: "box",
      completion: {
        insertText: "box \"${1:element}\" from [${2:0, 0, 0}] to [${3:16, 16, 16}] {\n  all texture \"#${4:all}\"\n}",
        detail: "Model element box"
      }
    }
  },
  {
    keyword: "element",
    statement: {
      kind: "element",
      elementKind: "element",
      completion: {
        insertText: "element from [${1:0, 0, 0}] to [${2:16, 16, 16}] {\n  all texture \"#${3:all}\"\n}",
        detail: "Model element geometry"
      }
    }
  },
  {
    keyword: "transform",
    statement: {
      kind: "transform",
      completion: {
        insertText: "transform ${1|rotate_x,rotate_y,rotate_z|}(${2:90}) around [${3:8, 8, 8}] {\n  ${4}\n}",
        detail: "Copy model geometry through an exact quarter-turn transform"
      }
    }
  },
  { keyword: "rotate_x", roles: ["transformOperation"], transformAxis: "x" },
  { keyword: "rotate_y", roles: ["transformOperation"], transformAxis: "y" },
  { keyword: "rotate_z", roles: ["transformOperation"], transformAxis: "z" },
  { keyword: "around", roles: ["transformClause"] },
  { keyword: "from", roles: ["elementHeaderClause"] },
  { keyword: "to", roles: ["elementHeaderClause"] },
  { keyword: "rotation", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "shade", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "light_emission", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "texture", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "uv", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "cullface", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "tintindex", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "face", roles: ["faceIntroducer"] },
  { keyword: "down", roles: ["faceTarget"] },
  { keyword: "up", roles: ["faceTarget"] },
  { keyword: "north", roles: ["faceTarget"] },
  { keyword: "south", roles: ["faceTarget"] },
  { keyword: "west", roles: ["faceTarget"] },
  { keyword: "east", roles: ["faceTarget"] },
  { keyword: "all", roles: ["faceTarget"] },
  { keyword: "origin", roles: ["nestedExpression"] },
  { keyword: "axis", roles: ["nestedExpression"] },
  { keyword: "angle", roles: ["nestedExpression"] },
  { keyword: "rescale", roles: ["nestedExpression"] }
] as const satisfies readonly RsglModelGeometryKeywordDescriptorDefinition[];

export type RsglModelGeometryKeywordDescriptor =
  (typeof rsglModelGeometryKeywordDescriptors)[number];
export type RsglModelGeometryStatementDescriptor =
  Extract<RsglModelGeometryKeywordDescriptor, { statement: unknown }>;
export type RsglModelElementStatementDescriptor =
  RsglModelGeometryStatementDescriptor & { statement: { kind: "element" } };
export type RsglModelTransformStatementDescriptor =
  RsglModelGeometryStatementDescriptor & { statement: { kind: "transform" } };

const rsglModelGeometryStatementDescriptors =
  rsglModelGeometryKeywordDescriptors.filter(isStatementDescriptor);
const statementDescriptorByKeyword = new Map<string, RsglModelGeometryStatementDescriptor>(
  rsglModelGeometryStatementDescriptors.map(descriptor => [descriptor.keyword, descriptor])
);

export const rsglModelGeometryKeywords: readonly string[] =
  rsglModelGeometryKeywordDescriptors.map(descriptor => descriptor.keyword);

export const modelGeometryStatementKeywords: ReadonlySet<string> = new Set(
  rsglModelGeometryStatementDescriptors.map(descriptor => descriptor.keyword)
);

export const modelElementHeaderClauseKeywords: readonly string[] =
  keywordsWithRole("elementHeaderClause");

export const modelElementBodyClauseKeywords: readonly string[] =
  keywordsWithRole("elementBodyClause");

export const modelFaceIntroducerKeywords: ReadonlySet<string> =
  new Set(keywordsWithRole("faceIntroducer"));

export const modelFaceTargets: ReadonlySet<string> =
  new Set(keywordsWithRole("faceTarget"));

export const rsglModelGeometryCompletionDescriptors: readonly RsglModelGeometryCompletionDescriptor[] =
  rsglModelGeometryStatementDescriptors.map(descriptor => ({
    label: descriptor.keyword,
    ...descriptor.statement.completion
  }));

export function getRsglModelGeometryStatementDescriptor(
  keyword: string
): RsglModelGeometryStatementDescriptor | undefined {
  return statementDescriptorByKeyword.get(keyword);
}

export function getRsglModelTransformAxis(keyword: string): RsglModelTransformAxis | undefined {
  const descriptor = rsglModelGeometryKeywordDescriptors.find(candidate => candidate.keyword === keyword);
  return descriptor && "transformAxis" in descriptor ? descriptor.transformAxis : undefined;
}

function isStatementDescriptor(
  descriptor: RsglModelGeometryKeywordDescriptor
): descriptor is RsglModelGeometryStatementDescriptor {
  return "statement" in descriptor;
}

function keywordsWithRole(role: RsglModelGeometryKeywordRole): string[] {
  return rsglModelGeometryKeywordDescriptors
    .filter((descriptor): descriptor is Extract<RsglModelGeometryKeywordDescriptor, { roles: unknown }> =>
      "roles" in descriptor && (descriptor.roles as readonly RsglModelGeometryKeywordRole[]).includes(role))
    .map(descriptor => descriptor.keyword);
}
