export type RsglModelGeometryKeywordRole =
  | "elementHeaderClause"
  | "elementBodyClause"
  | "faceIntroducer"
  | "faceTarget"
  | "nestedExpression";

export interface RsglModelGeometryCompletionDescriptor {
  label: string;
  insertText: string;
  detail: string;
}

interface RsglModelGeometryStatementDescriptorDefinition {
  keyword: string;
  statement: {
    elementKind: "box" | "element";
    completion: Omit<RsglModelGeometryCompletionDescriptor, "label">;
  };
}

interface RsglModelGeometryRoleDescriptorDefinition {
  keyword: string;
  roles: readonly RsglModelGeometryKeywordRole[];
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
      elementKind: "element",
      completion: {
        insertText: "element from [${1:0, 0, 0}] to [${2:16, 16, 16}] {\n  all texture \"#${3:all}\"\n}",
        detail: "Model element geometry"
      }
    }
  },
  { keyword: "from", roles: ["elementHeaderClause"] },
  { keyword: "to", roles: ["elementHeaderClause"] },
  { keyword: "rotation", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "shade", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "light_emission", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "mirror", roles: ["elementHeaderClause", "elementBodyClause"] },
  { keyword: "translate", roles: ["elementHeaderClause", "elementBodyClause"] },
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
