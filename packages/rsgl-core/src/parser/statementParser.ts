import { ExpressionParser, unquoteString } from "./expressionParser";
import {
  parseMultipartBody,
  parseMultipartSection,
  parseVariantBody,
  parseVariantsSection
} from "./blockstateStatementParser";
import { tryParseItemModelStatement } from "./itemModelStatementParser";
import { tryParseModelGeometryStatement } from "./modelGeometryStatementParser";
import { tryParsePackAtlasEquipmentStatement } from "./packAtlasEquipmentStatementParser";
import { tokenRange } from "./parserContext";
import { resourceBodySectionKeywords } from "./statementKeywords";
import {
  type BodyParseContext,
  nestedControlFlowBodyParseContext,
  sectionResourceBodyParseContext,
  type ResourceBodyParseContext
} from "./bodyParseContext";
import { ResourceStatementParserHost } from "./statementParserHost";
import {
  BlockNode,
  ExprNode,
  ExternVarStmtNode,
  ForDimensionNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  LetDeclNode,
  MergeMode,
  MergeModifierNode,
  MultipartBodyNode,
  ResourceBodyNode,
  ResourceStatementNode,
  RsglToken,
  TopLevelStatementNode,
  UseDeclNode,
  VariantBodyNode
} from "./types";

export abstract class StatementParser extends ExpressionParser {
  private resourceStatementParserHostValue: ResourceStatementParserHost | undefined;

  protected abstract parseTopLevelStatement(): TopLevelStatementNode;

  protected parseLetDecl(): LetDeclNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected let binding name.");
    const typeAnnotation = this.matchText(":") ? this.parseType() : undefined;
    if (!this.matchText("=")) {
      this.addDiagnosticAtCurrent("rsgl.expectedEquals", "Expected '=' in let declaration.");
    }
    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind: "LetDecl",
      keyword: start.text,
      name,
      typeAnnotation,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseUseDecl(): UseDeclNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: [] });
    return {
      kind: "UseDecl",
      keyword: start.text,
      expression,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseForStmt(context: BodyParseContext): ForStmtNode {
    const start = this.advance();
    const dimensions: ForDimensionNode[] = [];
    dimensions.push(this.parseForDimension(start));
    while (this.current().text === "," && this.nextForDimensionStartsBeforeBody()) {
      this.advance();
      dimensions.push(this.parseForDimension(this.current()));
    }
    const body = this.parseBodyForContext(nestedControlFlowBodyParseContext(context));
    const first = dimensions[0];
    return {
      kind: "ForStmt",
      keyword: start.text,
      bindings: first.bindings,
      iterable: first.iterable,
      dimensions,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseForDimension(startToken: RsglToken): ForDimensionNode {
    const bindings: IdentifierNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "in" && this.current().text !== "{") {
      const mark = this.mark();
      const binding = this.parseIdentifier("Expected loop binding.");
      if (binding) {
        bindings.push(binding);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse loop binding; skipping token.");
    }
    this.expectText("in", "Expected 'in' in for statement.");
    const iterable = this.parseExpression({ stopTexts: [",", "{"] });
    return {
      kind: "ForDimension",
      bindings,
      iterable,
      ...this.nodeRanges(startToken, this.previousOr(startToken))
    };
  }

  private nextForDimensionStartsBeforeBody(): boolean {
    if (this.current().text !== ",") {
      return false;
    }
    let offset = 1;
    while (this.peekText(offset) !== "" && this.peekText(offset) !== "{" && this.peekText(offset) !== "}") {
      if (this.peekText(offset) === "in") {
        return true;
      }
      if (this.peekText(offset) === ",") {
        return false;
      }
      offset++;
    }
    return false;
  }

  protected parseIfStmt(context: BodyParseContext): IfStmtNode {
    const start = this.advance();
    const condition = this.parseExpression({ stopTexts: ["{"] });
    const nestedContext = nestedControlFlowBodyParseContext(context);
    const thenBody = this.parseBodyForContext(nestedContext);
    const elseBody = this.matchText("else")
      ? this.parseBodyForContext(nestedContext)
      : undefined;
    return {
      kind: "IfStmt",
      keyword: start.text,
      condition,
      thenBody,
      elseBody,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseBlock(): BlockNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return this.emptyBlockAt(start, "Expected block body.");
    }

    const statements: TopLevelStatementNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      statements.push(this.parseTopLevelStatement());
      this.ensureProgress(mark, "Unable to parse block statement; skipping token.");
    }
    this.expectText("}", "Expected '}' after block.");
    return {
      kind: "Block",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseBodyForContext(context: BodyParseContext): BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode {
    if (context.kind === "resource") {
      return this.parseResourceBody(context);
    }
    if (context.kind === "variants") {
      return parseVariantBody(this.resourceStatementParserHost());
    }
    if (context.kind === "multipart") {
      return parseMultipartBody(this.resourceStatementParserHost());
    }
    return this.parseBlock();
  }

  protected parseResourceBody(context: ResourceBodyParseContext): ResourceBodyNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return this.emptyResourceBodyAt(start, "Expected resource body.");
    }

    const statements: ResourceStatementNode[] = [];
    const seenBlockstateSections = new Set<string>();
    let seenBase = false;
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      let statement: ResourceStatementNode;
      const blockstateSection = context.dialect === "blockstate" && !this.isExplicitPropertyStart();
      if (blockstateSection && this.current().text === "variants") {
        this.noteBlockstateSection(seenBlockstateSections, "variants");
        statement = parseVariantsSection(this.resourceStatementParserHost());
      } else if (blockstateSection && this.current().text === "multipart") {
        this.noteBlockstateSection(seenBlockstateSections, "multipart");
        statement = parseMultipartSection(this.resourceStatementParserHost());
      } else {
        statement = this.parseResourceStatement(context);
      }
      if (statement.kind === "BaseStmt") {
        if (!context.allowBase) {
          this.addDiagnostic(
            "rsgl.baseInvalidContext",
            "base is only valid in a concrete resource declaration body.",
            statement.range
          );
        } else if (seenBase) {
          this.addDiagnostic(
            "rsgl.duplicateBase",
            "A resource body can contain at most one base statement.",
            statement.range
          );
        } else if (statements.length > 0) {
          this.addDiagnostic(
            "rsgl.baseMustPrecedeBody",
            "The base statement must be the first statement in a resource body.",
            statement.range
          );
        }
        seenBase = true;
      }
      statements.push(statement);
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse resource statement; skipping token.");
    }

    this.expectText("}", "Expected '}' after resource body.");
    return {
      kind: "ResourceBody",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseResourceStatement(context: ResourceBodyParseContext): ResourceStatementNode {
    const token = this.current();
    const explicitPropertyStart = this.isExplicitPropertyStart();
    if (!explicitPropertyStart && token.text === "extern") {
      return this.parseExternVarStmt(context.allowModelExternVariables);
    }
    if (!explicitPropertyStart && token.text === "let") {
      return this.parseLetDecl();
    }
    if (!explicitPropertyStart && token.text === "use") {
      return this.parseUseDecl();
    }
    if (!explicitPropertyStart && token.text === "for") {
      return this.parseForStmt(context);
    }
    if (!explicitPropertyStart && token.text === "if") {
      return this.parseIfStmt(context);
    }
    if (
      !explicitPropertyStart
      && (
        token.text === "raw_json"
        || token.text === "raw_json_file"
        || token.text === "override"
        || isExplicitMergeMode(token.text)
      )
    ) {
      return this.parseRemovedMergeStmt();
    }
    if (token.text === "base" && !explicitPropertyStart) {
      return this.parseBaseStmt();
    }
    if (token.text === "merge" && !explicitPropertyStart) {
      return this.parseMergeStmt();
    }

    const host = this.resourceStatementParserHost();
    const packAtlasEquipmentStatement = explicitPropertyStart
      ? undefined
      : tryParsePackAtlasEquipmentStatement(host, context.owner, context.dialect);
    if (packAtlasEquipmentStatement) {
      return packAtlasEquipmentStatement;
    }
    const modelGeometryStatement = tryParseModelGeometryStatement(host, context.dialect);
    if (modelGeometryStatement) {
      return modelGeometryStatement;
    }
    if (!explicitPropertyStart && context.dialect === "mcmeta" && token.text === "texture") {
      return this.parseSectionStmt();
    }
    const itemModelStatement = !explicitPropertyStart && context.dialect === "item"
      ? tryParseItemModelStatement(host)
      : undefined;
    if (itemModelStatement) {
      return itemModelStatement;
    }
    if (!explicitPropertyStart && resourceBodySectionKeywords.has(token.text)) {
      return this.parseSectionStmt();
    }
    return this.parsePropertyStmt();
  }

  private parseExternVarStmt(inModelRoot: boolean): ExternVarStmtNode {
    const start = this.advance();
    let hasBang = false;
    if (this.current().text === "!") {
      const bang = this.advance();
      hasBang = true;
      if (bang.offset !== start.offset + start.length) {
        this.addDiagnostic(
          "rsgl.externBangMustBeAdjacent",
          "The '!' modifier must immediately follow 'extern' without whitespace or comments.",
          tokenRange(bang)
        );
      }
    }

    if (!this.matchText("var")) {
      this.addDiagnosticAtCurrent("rsgl.expectedExternVar", "Expected 'var' after 'extern' in a resource body.");
      this.recoverToLineEnd();
    }

    const variables: IdentifierNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}" && !this.isStatementBoundary(this.current())) {
      if (!this.matchText("#")) {
        this.addDiagnosticAtCurrent(
          "rsgl.expectedExternTextureVariable",
          "Expected a texture variable beginning with '#'."
        );
        this.recoverToLineEnd();
        break;
      }

      const variable = this.parseIdentifier("Expected texture variable name after '#'.");
      if (variable) {
        variables.push(variable);
      }
      if (!this.matchText(",")) {
        break;
      }
      if (this.isAtEnd() || this.current().text === "}" || this.isStatementBoundary(this.current())) {
        this.addDiagnosticAtCurrent(
          "rsgl.expectedExternTextureVariable",
          "Expected a texture variable after ','."
        );
        break;
      }
    }

    if (variables.length === 0 && this.previousOr(start).text === "var") {
      this.addDiagnosticAtCurrent(
        "rsgl.expectedExternTextureVariable",
        "Expected at least one texture variable after 'extern var'."
      );
    }
    if (
      !this.isAtEnd()
      && this.current().text !== "}"
      && this.current().text !== ";"
      && !this.isStatementBoundary(this.current())
    ) {
      this.addDiagnosticAtCurrent(
        "rsgl.expectedExternVarSeparator",
        "Expected ',' between external texture variables."
      );
      this.recoverToLineEnd();
    }
    if (!inModelRoot) {
      this.addDiagnostic(
        "rsgl.externVarInvalidContext",
        "'extern var' is only valid directly inside a model resource body.",
        tokenRange(start)
      );
    }
    if (hasBang) {
      this.addDiagnostic(
        "rsgl.externVarCannotSkipExistenceCheck",
        "The '!' modifier is not valid on an 'extern var' declaration.",
        tokenRange(start)
      );
    }

    return {
      kind: "ExternVarStmt",
      keyword: start.text,
      variables,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseSectionStmt(): ResourceStatementNode {
    const start = this.current();
    const name = this.parseIdentifier("Expected section name.") ?? this.syntheticIdentifier(start, start.text);
    let body: ResourceBodyNode | undefined;
    let value: ExprNode | undefined;
    if (this.current().text === "{") {
      body = this.parseResourceBody(sectionResourceBodyParseContext(name.text));
    } else {
      value = this.parseExpression({ stopTexts: [] });
    }
    return {
      kind: "SectionStmt",
      keyword: name.text,
      name,
      body,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePropertyStmt(): ResourceStatementNode {
    const start = this.current();
    const name = this.parsePropertyName(start);
    if (this.current().text === ":" || this.current().text === "=") {
      this.advance();
    }

    let value: ExprNode;
    if (this.current().text === "{") {
      value = this.parseObjectExpression();
    } else if (this.current().text === "[" && this.looksLikeStateKeySugar()) {
      value = this.parseStateKeySugar();
    } else {
      value = this.parseExpression({ stopTexts: [] });
    }

    if (value.kind === "MissingExpr") {
      this.addDiagnostic("rsgl.expectedPropertyValue", `Expected value for '${name.text}'.`, {
        start: name.range.end,
        end: name.range.end + 1
      });
    }
    return {
      kind: "PropertyStmt",
      keyword: name.text,
      name,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePropertyName(start: RsglToken): IdentifierNode {
    if (this.current().kind === "string") {
      const token = this.advance();
      return this.syntheticIdentifier(token, unquoteString(token.text));
    }
    if (this.current().kind === "number") {
      const token = this.advance();
      return this.syntheticIdentifier(token, token.text);
    }
    return this.parseIdentifier("Expected property name.") ?? this.syntheticIdentifier(start, start.text);
  }

  private parseBaseStmt(): ResourceStatementNode {
    const start = this.advance();
    const path = this.parseExpression({ stopTexts: [] });
    return {
      kind: "BaseStmt",
      keyword: start.text,
      path,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private isExplicitPropertyStart(): boolean {
    return this.peekText(1) === ":" || this.peekText(1) === "=";
  }

  private parseMergeStmt(): ResourceStatementNode {
    const start = this.advance();
    let mode: MergeMode = "shallow";
    let modifier: MergeModifierNode | undefined;
    const modifierMode = this.current().text;
    if (!this.isStatementBoundary(this.current()) && isExplicitMergeMode(modifierMode)) {
      const modifierToken = this.advance();
      mode = modifierMode;
      modifier = {
        kind: "MergeModifier",
        mode: modifierMode,
        text: modifierToken.text,
        ...this.nodeRanges(modifierToken, modifierToken)
      };
    }
    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind: "MergeStmt",
      keyword: start.text,
      mode,
      modifier,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseRemovedMergeStmt(): ResourceStatementNode {
    const start = this.advance();
    if (start.text === "override") {
      this.matchText("create");
    }
    if (!this.isAtEnd() && this.current().text !== "}" && !this.isStatementBoundary(this.current())) {
      this.parseExpression({ stopTexts: [] });
    }
    this.addDiagnostic(
      "rsgl.removedMergeSyntax",
      removedMergeSyntaxMessage(start.text),
      tokenRange(start)
    );
    return {
      kind: "UnknownStmt",
      keyword: start.text,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private resourceStatementParserHost(): ResourceStatementParserHost {
    return this.resourceStatementParserHostValue ??= {
      current: () => this.current(),
      advance: () => this.advance(),
      previousOr: fallback => this.previousOr(fallback),
      isAtEnd: () => this.isAtEnd(),
      isLineBoundaryOr: (...texts) => this.isLineBoundaryOr(...texts),
      peekText: ahead => this.peekText(ahead),
      mark: () => this.mark(),
      ensureProgress: (mark, message) => this.ensureProgress(mark, message),
      matchText: text => this.matchText(text),
      expectText: (text, message) => this.expectText(text, message),
      consumeOptionalSeparator: () => this.consumeOptionalSeparator(),
      consumeBalancedBlock: message => this.consumeBalancedBlock(message),
      recoverToLineEnd: () => this.recoverToLineEnd(),
      addDiagnosticAtCurrent: (code, message, severity) => this.addDiagnosticAtCurrent(code, message, severity),
      addDiagnostic: (code, message, range, severity) => this.addDiagnostic(code, message, range, severity),
      parseExpression: (options, minPrecedence) => this.parseExpression(options, minPrecedence),
      parseIdentifier: message => this.parseIdentifier(message),
      parseStringLiteral: () => this.parseStringLiteral(),
      parseObjectExpression: () => this.parseObjectExpression(),
      parseBlockstateEntryValue: () => this.parseBlockstateEntryValue(),
      parseLetDecl: () => this.parseLetDecl(),
      parseUseDecl: () => this.parseUseDecl(),
      parseForStmt: context => this.parseForStmt(context),
      parseIfStmt: context => this.parseIfStmt(context),
      parseResourceBody: context => this.parseResourceBody(context),
      emptyResourceBodyAt: (token, message) => this.emptyResourceBodyAt(token, message),
      missingExprAt: token => this.missingExprAt(token),
      syntheticIdentifier: (token, text) => this.syntheticIdentifier(token, text),
      booleanLiteral: (token, value) => this.booleanLiteral(token, value),
      nodeRanges: (start, end) => this.nodeRanges(start, end)
    };
  }

  private noteBlockstateSection(seen: Set<string>, section: "variants" | "multipart"): void {
    seen.add(section);
    if (seen.has("variants") && seen.has("multipart")) {
      this.addDiagnostic(
        "rsgl.blockstateSectionConflict",
        "A blockstate body should use either variants or multipart, not both.",
        tokenRange(this.current()),
        "warning"
      );
    }
  }

  private isLineBoundaryOr(...texts: string[]): boolean {
    return this.isAtEnd() || texts.includes(this.current().text) || this.isStatementBoundary(this.current());
  }
}

function isExplicitMergeMode(text: string): text is Exclude<MergeMode, "shallow"> {
  return text === "deep" || text === "strict" || text === "upsert" || text === "append";
}

function removedMergeSyntaxMessage(keyword: string): string {
  if (keyword === "override") {
    return "The override statement has been removed. Use 'merge strict' or 'merge upsert'.";
  }
  if (isExplicitMergeMode(keyword)) {
    return `The '${keyword}' merge modifier requires a preceding 'merge' keyword.`;
  }
  if (keyword === "raw_json_file") {
    return "The raw_json_file statement has been removed. Use a base statement for a base JSON document.";
  }
  return "The raw_json statement has been removed. Use a merge statement.";
}
