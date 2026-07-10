import {
  lexRsgl,
  parseRsgl,
  type BlockNode,
  type TopLevelStatementNode
} from "./parser";

export interface RsglCompletionContext {
  insideBlock: boolean;
  allowBase: boolean;
  allowExternVar: boolean;
}

/** Computes the small amount of syntax context needed by static completions. */
export function getRsglCompletionContext(text: string, offset: number): RsglCompletionContext {
  const prefix = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const openBraces = unmatchedOpenBraces(prefix);
  const openBrace = openBraces.at(-1);
  if (openBrace === undefined) {
    return { insideBlock: false, allowBase: false, allowExternVar: false };
  }

  const resourceKind = concreteResourceKindAt(prefix, openBrace);

  return {
    insideBlock: true,
    allowBase: isBaseOperandPosition(prefix.slice(openBrace + 1))
      && resourceKind !== null,
    allowExternVar: resourceKind === "model"
  };
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

function concreteResourceKindAt(prefix: string, openBrace: number): string | null {
  const module = parseRsgl(prefix);
  return resourceKindInStatementsAt(module.statements, openBrace);
}

function resourceKindInStatementsAt(
  statements: readonly TopLevelStatementNode[],
  openBrace: number
): string | null {
  for (const statement of statements) {
    if (statement.kind === "ResourceDecl" && statement.body.range.start === openBrace) {
      return statement.resourceKind;
    }
    for (const block of childTopLevelBlocks(statement)) {
      const resourceKind = resourceKindInStatementsAt(block.statements, openBrace);
      if (resourceKind !== null) {
        return resourceKind;
      }
    }
  }
  return null;
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
