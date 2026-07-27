import { isObjectPropertyKeyPosition } from "./completionObjectContext";
import {
  firstMatchHeaderCompletionContext,
  isItemModelSchemaCompletionKeyPosition,
  itemModelSchemaContextForNode,
  selectWhenCompletionContext,
  staticItemModelObjectKeys,
  staticItemModelSchemaName,
  type RsglItemModelSchemaCompletionContext
} from "./itemModelCompletionSchemaContext";
import {
  type ItemModelNode,
  type RsglModule,
  type RsglStatement
} from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import { touchesRange } from "./textRangeQueries";

export type RsglItemModelCompletionOwner =
  | "itemRoot"
  | "itemModelTemplate"
  | "select"
  | "range"
  | "condition"
  | "composite"
  | "first_match"
  | "modelLeaf"
  | "special";

export interface RsglItemModelCompletionContext {
  scope: "itemRoot" | "itemModelTemplate";
  owner: RsglItemModelCompletionOwner;
  expectedSlot: "producer" | "clause" | "itemModel" | "optionKey";
  optionOwner?: "modelLeafOptions" | "transformOptions";
  optionKeyPosition?: boolean;
  writtenOptionKeys?: readonly string[];
  schema?: RsglItemModelSchemaCompletionContext;
}

export type {
  RsglItemModelPropertyFamily,
  RsglItemModelSchemaCompletionContext
} from "./itemModelCompletionSchemaContext";

export interface RsglItemModelCompletionMatch {
  context: RsglItemModelCompletionContext;
  resourceKind?: "item";
}

export function isItemModelCompletionKeyPosition(
  context: RsglItemModelCompletionContext | undefined
): boolean {
  return Boolean(context?.optionOwner && context.optionKeyPosition !== false)
    || isItemModelSchemaCompletionKeyPosition(context?.schema?.kind);
}

/**
 * Creates the item-model facet of completion analysis for one parsed prefix.
 * The returned probe is intentionally parser-only so generic completion
 * orchestration does not need to know item-model body or schema-slot details.
 */
export function createItemModelCompletionAnalyzer(
  module: RsglModule,
  prefix: string,
  openBrace: number
): (statement: RsglStatement) => RsglItemModelCompletionMatch | undefined {
  const scope = itemModelScopeAt(module, openBrace);
  return statement => {
    const nested = itemModelContextForStatement(statement, prefix, openBrace, scope);
    if (nested) {
      return { context: nested };
    }
    if (
      statement.kind === "ResourceDecl"
      && statement.resourceKind === "item"
      && statement.body.range.start === openBrace
    ) {
      return {
        context: itemModelContextInStatements(
          statement.body.statements,
          prefix,
          openBrace,
          "itemRoot"
        ) ?? itemModelBodyContext("itemRoot", "itemRoot", prefix, openBrace),
        resourceKind: "item"
      };
    }
    if (
      statement.kind === "TemplateDecl"
      && statement.body.kind === "ItemModelTemplateBody"
      && statement.body.range.start === openBrace
    ) {
      return {
        context: itemModelContextInStatements(
          statement.body.statements,
          prefix,
          openBrace,
          "itemModelTemplate"
        ) ?? itemModelBodyContext(
          "itemModelTemplate",
          "itemModelTemplate",
          prefix,
          openBrace
        )
      };
    }
    if (statement.kind === "ForStmt" && statement.body.range.start === openBrace) {
      const owner = itemModelOwnerForBody(statement.body.kind);
      if (owner && scope) {
        return { context: itemModelBodyContext(scope, owner, prefix, openBrace) };
      }
    }
    if (statement.kind === "IfStmt") {
      if (statement.thenBody.range.start === openBrace) {
        const owner = itemModelOwnerForBody(statement.thenBody.kind);
        if (owner && scope) {
          return { context: itemModelBodyContext(scope, owner, prefix, openBrace) };
        }
      }
      if (statement.elseBody?.range.start === openBrace) {
        const owner = itemModelOwnerForBody(statement.elseBody.kind);
        if (owner && scope) {
          return { context: itemModelBodyContext(scope, owner, prefix, openBrace) };
        }
      }
    }
    return undefined;
  };
}

function itemModelScopeAt(
  module: RsglModule,
  offset: number
): RsglItemModelCompletionContext["scope"] | undefined {
  let selected: { scope: RsglItemModelCompletionContext["scope"]; span: number } | undefined;
  walkRsglModule(module, {
    enterStatement(statement) {
      let scope: RsglItemModelCompletionContext["scope"] | undefined;
      let bodyRange: { start: number; end: number } | undefined;
      if (statement.kind === "ResourceDecl" && statement.resourceKind === "item") {
        scope = "itemRoot";
        bodyRange = statement.body.range;
      } else if (
        statement.kind === "TemplateDecl"
        && statement.body.kind === "ItemModelTemplateBody"
      ) {
        scope = "itemModelTemplate";
        bodyRange = statement.body.range;
      }
      if (!scope || !bodyRange || !touchesRange(bodyRange, offset)) {
        return undefined;
      }
      const span = bodyRange.end - bodyRange.start;
      if (!selected || span < selected.span) {
        selected = { scope, span };
      }
      return undefined;
    }
  });
  return selected?.scope;
}

function itemModelContextForStatement(
  statement: RsglStatement,
  prefix: string,
  openBrace: number,
  scope: RsglItemModelCompletionContext["scope"] | undefined
): RsglItemModelCompletionContext | undefined {
  if (!scope) {
    return undefined;
  }
  switch (statement.kind) {
    case "ItemModelProducerStmt":
      return itemModelContextForNode(statement.value, prefix, openBrace, scope);
    case "ItemSelectCase":
    case "ItemRangeEntry":
    case "ItemRangeFrames":
    case "ItemFallbackClause":
    case "ItemCompositeModel":
    case "ItemFirstMatchWhen":
      return itemModelContextForNode(statement.model, prefix, openBrace, scope);
    default:
      return undefined;
  }
}

function itemModelContextForNode(
  node: ItemModelNode,
  prefix: string,
  openBrace: number,
  scope: RsglItemModelCompletionContext["scope"]
): RsglItemModelCompletionContext | undefined {
  const schema = itemModelSchemaContextForNode(node, prefix, openBrace);
  if (schema) {
    return {
      scope,
      owner: itemModelOwnerForNode(node),
      expectedSlot: schema.kind.endsWith("FieldName") || schema.kind === "propertyOptionName"
        ? "optionKey"
        : "itemModel",
      schema
    };
  }
  if ("options" in node && node.options?.range.start === openBrace) {
    return {
      scope,
      owner: itemModelOwnerForNode(node),
      expectedSlot: "optionKey",
      optionOwner: node.kind === "ItemModelExpr" ? "modelLeafOptions" : "transformOptions",
      optionKeyPosition: isObjectPropertyKeyPosition(prefix.slice(openBrace + 1)),
      writtenOptionKeys: staticItemModelObjectKeys(node.options)
    };
  }

  switch (node.kind) {
    case "ItemModelSelect":
      if (node.body.range.start === openBrace) {
        return itemModelContextInStatements(
          node.body.statements,
          prefix,
          openBrace,
          scope,
          staticItemModelSchemaName(node.property)
        ) ?? itemModelBodyContext(scope, "select", prefix, openBrace);
      }
      return itemModelContextInStatements(
        node.body.statements,
        prefix,
        openBrace,
        scope,
        staticItemModelSchemaName(node.property)
      );
    case "ItemModelRange":
      if (node.body.range.start === openBrace) {
        return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope)
          ?? itemModelBodyContext(scope, "range", prefix, openBrace);
      }
      return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope);
    case "ItemModelComposite":
      if (node.body.range.start === openBrace) {
        return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope)
          ?? itemModelBodyContext(scope, "composite", prefix, openBrace);
      }
      return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope);
    case "ItemModelFirstMatch":
      if (node.body.range.start === openBrace) {
        return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope)
          ?? itemModelBodyContext(scope, "first_match", prefix, openBrace);
      }
      return itemModelContextInStatements(node.body.statements, prefix, openBrace, scope);
    case "ItemModelCondition": {
      const firstBranchStart = Math.min(
        node.onTrue?.range.start ?? Number.POSITIVE_INFINITY,
        node.onFalse?.range.start ?? Number.POSITIVE_INFINITY
      );
      if (
        prefix[openBrace] === "{"
        && node.property.range.end <= openBrace
        && openBrace < firstBranchStart
      ) {
        return itemModelBodyContext(scope, "condition", prefix, openBrace);
      }
      return (node.onTrue && itemModelContextForNode(node.onTrue, prefix, openBrace, scope))
        || (node.onFalse && itemModelContextForNode(node.onFalse, prefix, openBrace, scope))
        || undefined;
    }
    case "ItemModelExpr":
    case "ItemModelUse":
    case "ItemModelSpecial":
    case "ItemModelEmpty":
    case "ItemModelSelectedItem":
      return undefined;
    default:
      return assertNeverItemModel(node);
  }
}

function itemModelContextInStatements(
  statements: readonly RsglStatement[],
  prefix: string,
  openBrace: number,
  scope: RsglItemModelCompletionContext["scope"],
  selectPropertyName?: string
): RsglItemModelCompletionContext | undefined {
  for (const statement of statements) {
    if (statement.kind === "ItemSelectCase") {
      const selectWhen = selectWhenCompletionContext(statement, prefix, selectPropertyName);
      if (selectWhen) {
        return {
          scope,
          owner: "select",
          expectedSlot: "itemModel",
          schema: selectWhen
        };
      }
    }
    if (statement.kind === "ItemFirstMatchWhen") {
      const header = firstMatchHeaderCompletionContext(statement, prefix);
      if (header) {
        return {
          scope,
          owner: "first_match",
          expectedSlot: header.kind === "propertyOptionName" ? "optionKey" : "itemModel",
          schema: header
        };
      }
    }
    const context = itemModelContextForStatement(statement, prefix, openBrace, scope);
    if (context) {
      return context;
    }
    if (statement.kind === "ForStmt") {
      const owner = itemModelOwnerForBody(statement.body.kind);
      if (owner && statement.body.range.start === openBrace) {
        return itemModelBodyContext(scope, owner, prefix, openBrace);
      }
    } else if (statement.kind === "IfStmt") {
      const thenOwner = itemModelOwnerForBody(statement.thenBody.kind);
      if (thenOwner && statement.thenBody.range.start === openBrace) {
        return itemModelBodyContext(scope, thenOwner, prefix, openBrace);
      }
      const elseOwner = statement.elseBody && itemModelOwnerForBody(statement.elseBody.kind);
      if (elseOwner && statement.elseBody?.range.start === openBrace) {
        return itemModelBodyContext(scope, elseOwner, prefix, openBrace);
      }
    }
  }
  return undefined;
}


function itemModelBodyContext(
  scope: RsglItemModelCompletionContext["scope"],
  owner: RsglItemModelCompletionOwner,
  prefix: string,
  openBrace: number
): RsglItemModelCompletionContext {
  return {
    scope,
    owner,
    expectedSlot: isItemModelValuePosition(prefix.slice(openBrace + 1), owner)
      ? "itemModel"
      : owner === "itemRoot" || owner === "itemModelTemplate"
        ? "producer"
        : "clause"
  };
}

function isItemModelValuePosition(
  bodyPrefix: string,
  owner: RsglItemModelCompletionOwner
): boolean {
  const line = bodyPrefix.slice(Math.max(bodyPrefix.lastIndexOf("\n"), bodyPrefix.lastIndexOf("\r")) + 1);
  if (owner === "condition") {
    return /^\s*on_(?:true|false)\b/.test(line);
  }
  if (owner === "composite") {
    return /^\s*model\b/.test(line);
  }
  if (owner === "range" && /^\s*frames\b.*\bmodel\b/.test(line)) {
    return true;
  }
  if (owner === "select" || owner === "range" || owner === "first_match") {
    return line.includes("=>") || /^\s*fallback\b/.test(line);
  }
  return false;
}

function itemModelOwnerForBody(bodyKind: string): RsglItemModelCompletionOwner | undefined {
  if (bodyKind === "ItemSelectBody") {
    return "select";
  }
  if (bodyKind === "ItemRangeBody") {
    return "range";
  }
  if (bodyKind === "ItemCompositeBody") {
    return "composite";
  }
  if (bodyKind === "ItemFirstMatchBody") {
    return "first_match";
  }
  if (bodyKind === "ItemModelTemplateBody") {
    return "itemModelTemplate";
  }
  return undefined;
}

function itemModelOwnerForNode(node: ItemModelNode): RsglItemModelCompletionOwner {
  switch (node.kind) {
    case "ItemModelRange":
      return "range";
    case "ItemModelSelect":
      return "select";
    case "ItemModelCondition":
      return "condition";
    case "ItemModelComposite":
      return "composite";
    case "ItemModelFirstMatch":
      return "first_match";
    case "ItemModelExpr":
      return "modelLeaf";
    case "ItemModelSpecial":
      return "special";
    case "ItemModelUse":
    case "ItemModelEmpty":
    case "ItemModelSelectedItem":
      return "itemModelTemplate";
    default:
      return assertNeverItemModel(node);
  }
}

function assertNeverItemModel(value: never): never {
  throw new Error(`Unhandled item-model completion node: ${JSON.stringify(value)}`);
}
