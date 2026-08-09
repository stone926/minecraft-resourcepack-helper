import { isObjectPropertyKeyPosition } from "./completionObjectContext";
import {
  findItemModelCompletionContext,
  type RsglItemModelCompletionContext
} from "./itemModelCompletionContext";
import type { ItemModelFormat } from "./itemModelSchema";
import { effectiveItemModelTargetFormat } from "./itemModelTarget";
import {
  lexRsgl,
  parseRsgl,
  type BlockNode,
  type BlockstateMode,
  type DeclaredTemplateOutputDialect,
  type RsglModule,
  type TopLevelStatementNode
} from "./parser";
import { isRsglArrowText } from "./parser/arrowSemantics";
import { walkRsglModule } from "./parser/astTraversal";

export type {
  RsglItemModelCompletionContext,
  RsglItemModelCompletionOwner,
  RsglItemModelPropertyFamily,
  RsglItemModelSchemaCompletionContext
} from "./itemModelCompletionContext";

export interface RsglBlockstateCompletionContext {
  mode: BlockstateMode;
  scope: "concreteRoot" | "nestedRoot" | "entryTemplate";
}

export interface RsglCompletionContext {
  insideBlock: boolean;
  resourceKind?: string;
  allowBase: boolean;
  allowExternVar: boolean;
  templateOutputDialect?: DeclaredTemplateOutputDialect;
  /** Effective file-local or project fallback target, when known. */
  targetFormat?: ItemModelFormat;
  blockstate?: RsglBlockstateCompletionContext;
  itemModel?: RsglItemModelCompletionContext;
  blockstateChoice: boolean;
  /** The cursor is at a property-key position in a ModelSpec `with` object. */
  blockstateModelOptions: boolean;
  /** The cursor is inside the predicate portion of `part when ... =>`. */
  blockstatePredicate: boolean;
}

/** Computes the small amount of syntax context needed by static completions. */
export function getRsglCompletionContext(
  text: string,
  offset: number,
  projectTargetFormat?: ItemModelFormat
): RsglCompletionContext {
  const prefix = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const openBraces = unmatchedOpenBraces(prefix);
  const openBrace = openBraces.at(-1);
  if (openBrace === undefined) {
    return {
      insideBlock: false,
      allowBase: false,
      allowExternVar: false,
      blockstateChoice: false,
      blockstateModelOptions: false,
      blockstatePredicate: false
    };
  }

  // Completion is a hot LSP path. Parse the prefix once, then derive each
  // independent context facet from the same immutable syntax tree.
  const module = parseRsgl(prefix);
  const bodyOwner = bodyOwnerAt(module, prefix, openBrace);
  const templateOutputDialect = templateDialectInStatementsAt(module.statements, openBrace);
  const targetFormat = effectiveItemModelTargetFormat(module, projectTargetFormat);

  return {
    insideBlock: true,
    ...(bodyOwner.resourceKind ? { resourceKind: bodyOwner.resourceKind } : {}),
    allowBase: isBaseOperandPosition(prefix.slice(openBrace + 1))
      && bodyOwner.resourceKind !== null,
    allowExternVar: bodyOwner.resourceKind === "model",
    templateOutputDialect,
    targetFormat,
    blockstate: bodyOwner.blockstate,
    itemModel: bodyOwner.itemModel,
    blockstateChoice: bodyOwner.blockstateChoice,
    blockstateModelOptions: bodyOwner.blockstateModelOptions
      && isObjectPropertyKeyPosition(prefix.slice(openBrace + 1)),
    blockstatePredicate: isBlockstatePredicatePosition(prefix, bodyOwner)
  };
}

interface CompletionBodyOwner {
  resourceKind: string | null;
  blockstate?: RsglBlockstateCompletionContext;
  blockstateChoice: boolean;
  blockstateModelOptions: boolean;
  itemModel?: RsglItemModelCompletionContext;
}

function bodyOwnerAt(
  module: RsglModule,
  prefix: string,
  openBrace: number
): CompletionBodyOwner {
  const itemModel = findItemModelCompletionContext(module, prefix, openBrace);
  const owner: CompletionBodyOwner = {
    resourceKind: null,
    blockstateChoice: false,
    blockstateModelOptions: false,
    ...(itemModel ? { itemModel: itemModel.context } : {})
  };
  if (itemModel) {
    owner.resourceKind = itemModel.resourceKind ?? null;
    return owner;
  }
  walkRsglModule(module, {
    enterStatement(statement) {
      if (statement.kind === "ResourceDecl" && statement.body.range.start === openBrace) {
        owner.resourceKind = statement.resourceKind;
        if (statement.resourceKind === "blockstate") {
          owner.blockstate = {
            mode: statement.mode,
            scope: "concreteRoot"
          };
        }
        return "skipChildren";
      }
      if (statement.kind === "TemplateDecl" && statement.body.range.start === openBrace) {
        if (statement.body.kind === "BlockstateChoiceBody") {
          owner.blockstateChoice = true;
        } else {
          owner.blockstate = blockstateContextForBody(statement.body.kind, "entryTemplate");
        }
        return "skipChildren";
      }
      if (statement.kind === "ForStmt" && statement.body.range.start === openBrace) {
        if (statement.body.kind === "BlockstateChoiceBody") {
          owner.blockstateChoice = true;
        } else {
          owner.blockstate = blockstateContextForBody(statement.body.kind, "nestedRoot");
        }
        return "skipChildren";
      }
      if (statement.kind === "IfStmt") {
        if (statement.thenBody.range.start === openBrace) {
          if (statement.thenBody.kind === "BlockstateChoiceBody") {
            owner.blockstateChoice = true;
          } else {
            owner.blockstate = blockstateContextForBody(statement.thenBody.kind, "nestedRoot");
          }
          return "skipChildren";
        }
        if (statement.elseBody?.range.start === openBrace) {
          if (statement.elseBody.kind === "BlockstateChoiceBody") {
            owner.blockstateChoice = true;
          } else {
            owner.blockstate = blockstateContextForBody(statement.elseBody.kind, "nestedRoot");
          }
          return "skipChildren";
        }
      }
      const modelSpec = statement.kind === "BlockstateRandomOption"
        ? statement.model
        : (statement.kind === "BlockstateVariantEntry" || statement.kind === "BlockstateMultipartEntry")
            && statement.choice.kind === "BlockstateModelSpec"
          ? statement.choice
          : undefined;
      if (modelSpec?.options?.range.start === openBrace) {
        owner.blockstateModelOptions = true;
        return "skipChildren";
      }
      if (
        (statement.kind === "BlockstateVariantEntry" || statement.kind === "BlockstateMultipartEntry")
        && statement.choice.kind === "BlockstateRandomChoice"
        && statement.choice.body.range.start === openBrace
      ) {
        owner.blockstateChoice = true;
        return "skipChildren";
      }
      return undefined;
    }
  });
  return owner;
}

function isBlockstatePredicatePosition(
  prefix: string,
  owner: CompletionBodyOwner
): boolean {
  if (owner.blockstate?.mode !== "multipart") {
    return false;
  }
  const tokens = lexRsgl(prefix).tokens.filter(token => token.kind !== "endOfFile");
  for (let index = tokens.length - 2; index >= 0; index--) {
    if (tokens[index]?.text !== "part" || tokens[index + 1]?.text !== "when") {
      continue;
    }
    return !tokens.slice(index + 2).some(token => isRsglArrowText(token.text));
  }
  return false;
}

function blockstateContextForBody(
  bodyKind: string,
  rootScope: "nestedRoot" | "entryTemplate"
): RsglBlockstateCompletionContext | undefined {
  if (bodyKind === "BlockstateVariantsRootBody") {
    return { mode: "variants", scope: rootScope };
  }
  if (bodyKind === "BlockstateMultipartRootBody") {
    return { mode: "multipart", scope: rootScope };
  }
  if (bodyKind === "VariantBody") {
    return { mode: "variants", scope: "entryTemplate" };
  }
  if (bodyKind === "MultipartBody") {
    return { mode: "multipart", scope: "entryTemplate" };
  }
  return undefined;
}

function templateDialectInStatementsAt(
  statements: readonly TopLevelStatementNode[],
  openBrace: number
): DeclaredTemplateOutputDialect | undefined {
  for (const statement of statements) {
    if (
      statement.kind === "TemplateDecl"
      && statement.body.range.start <= openBrace
      && openBrace <= statement.body.range.end
      && statement.outputSyntax === "explicitArrow"
    ) {
      return statement.declaredOutputDialect;
    }
    for (const block of childTopLevelBlocks(statement)) {
      const dialect = templateDialectInStatementsAt(block.statements, openBrace);
      if (dialect) {
        return dialect;
      }
    }
  }
  return undefined;
}

function isBaseOperandPosition(bodyPrefix: string): boolean {
  const lexed = lexRsgl(bodyPrefix);
  const tokens = lexed.tokens.filter(token => token.kind !== "endOfFile");
  if (tokens.length === 0) {
    return true;
  }
  if (tokens.length !== 1) {
    return false;
  }

  const token = tokens[0];
  const trailingText = bodyPrefix.slice(token.offset + token.length);
  const continuedOnAnotherLine = trailingText.includes("\n") || trailingText.includes("\r");
  return !continuedOnAnotherLine
    && (token.kind === "identifier" || token.kind === "keyword")
    && "base".startsWith(token.text);
}

function childTopLevelBlocks(statement: TopLevelStatementNode): BlockNode[] {
  if (statement.kind === "OverlayDecl") {
    return [statement.body];
  }
  if (statement.kind === "TemplateDecl") {
    return statement.body.kind === "Block" ? [statement.body] : [];
  }
  if (statement.kind === "ForStmt") {
    return statement.body.kind === "Block" ? [statement.body] : [];
  }
  if (statement.kind === "IfStmt") {
    const blocks: BlockNode[] = [];
    if (statement.thenBody.kind === "Block") {
      blocks.push(statement.thenBody);
    }
    if (statement.elseBody?.kind === "Block") {
      blocks.push(statement.elseBody);
    }
    return blocks;
  }
  return [];
}

function unmatchedOpenBraces(text: string): number[] {
  const offsets: number[] = [];
  let inLineComment = false;
  let inBlockComment = false;
  let inString: "\"" | "`" | null = null;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n" || char === "\r") {
        inLineComment = false;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }
    if (inString) {
      if (char === "\\") {
        index++;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
    } else if (char === "\"" || char === "`") {
      inString = char;
    } else if (char === "{") {
      offsets.push(index);
    } else if (char === "}") {
      offsets.pop();
    }
  }

  return offsets;
}
