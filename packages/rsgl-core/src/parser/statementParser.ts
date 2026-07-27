import { blockSyntaxMessages, externSyntaxMessages } from "../diagnosticMessages";
import { ExpressionParser } from "./expressionParser";
import { unquoteString } from "./typeParser";
import {
  parseBlockstateMultipartRootBody,
  parseBlockstateVariantsRootBody,
  parseMultipartBody,
  parseVariantBody
} from "./blockstateStatementParser";
import { parseBlockstateChoiceBody } from "./blockstateChoiceParser";
import {
  parseItemCompositeBody,
  parseItemFirstMatchBody,
  parseItemModelTemplateBody,
  parseItemModelUseDecl,
  parseItemRangeBody,
  parseItemSelectBody,
  tryParseItemModelStatement
} from "./itemModelStatementParser";
import { tryParseModelGeometryStatement } from "./modelGeometryStatementParser";
import { tryParsePackAtlasEquipmentStatement } from "./packAtlasEquipmentStatementParser";
import { tokenRange } from "./parserContext";
import { resourceBodySectionKeywords } from "./statementKeywords";
import {
  type BlockstateRootParseContext,
  type BodyParseContext,
  nestedControlFlowBodyParseContext,
  sectionResourceBodyParseContext,
  type ResourceBodyParseContext
} from "./bodyParseContext";
import { ResourceStatementParserHost } from "./statementParserHost";
import {
  BlockNode,
  BaseStmtNode,
  BlockstateRootCommonStatementNode,
  ExprNode,
  ExternVarStmtNode,
  ForBindingPatternNode,
  ForDimensionNode,
  ForObjectBindingPatternNode,
  ForObjectBindingPropertyNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  LetDeclNode,
  MergeStmtNode,
  MergeMode,
  MergeModifierNode,
  PropertyStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  RsglStatementBodyNode,
  RsglToken,
  TopLevelStatementNode,
  UseDeclNode
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
    const value = this.parseExpression({ stopTexts: [], allowLeadingLineBreak: true });
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
    return {
      kind: "ForStmt",
      keyword: start.text,
      dimensions,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseForDimension(startToken: RsglToken): ForDimensionNode {
    const pattern = this.parseForBindingPattern();
    if (!this.expectText("in", "Expected 'in' in for statement.")) {
      this.recoverForDimensionAfterMissingIn();
    }
    const iterable = this.parseExpression({ stopTexts: [",", "{"] });
    return {
      kind: "ForDimension",
      pattern,
      iterable,
      ...this.nodeRanges(startToken, this.previousOr(startToken))
    };
  }

  /**
   * Keeps a malformed dimension local without treating skipped identifiers as
   * declarations. The existing expected-token diagnostic remains the only
   * syntax error when a later `in` lets parsing resume unambiguously.
   */
  private recoverForDimensionAfterMissingIn(): void {
    while (
      !this.isAtEnd()
      && this.current().text !== "in"
      && this.current().text !== "{"
      && this.current().text !== "}"
    ) {
      this.advance();
    }
    this.matchText("in");
  }

  private parseForBindingPattern(): ForBindingPatternNode {
    if (this.current().text === "{") {
      return this.parseForObjectBindingPattern();
    }

    const start = this.current();
    if (start.text === "in") {
      this.addDiagnosticAtCurrent("rsgl.expectedLoopBinding", "Expected loop binding before 'in'.");
      return this.syntheticIdentifier(start, "");
    }
    return this.parseIdentifier("Expected loop binding.")
      ?? this.syntheticIdentifier(start, "");
  }

  private parseForObjectBindingPattern(): ForObjectBindingPatternNode {
    const start = this.advance();
    const properties: ForObjectBindingPropertyNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const property = this.parseForObjectBindingProperty();
      if (property) {
        properties.push(property);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse object loop binding; skipping token.");
    }
    if (properties.length === 0) {
      this.addDiagnosticAtCurrent(
        "rsgl.expectedLoopBinding",
        "Expected at least one property in object loop binding."
      );
    }
    this.expectText("}", "Expected '}' after object loop binding.");
    return {
      kind: "ForObjectBindingPattern",
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseForObjectBindingProperty(): ForObjectBindingPropertyNode | null {
    const compact = this.tryParseCompactForObjectBindingProperty();
    if (compact) {
      return compact;
    }

    const start = this.current();
    const property = this.parseIdentifier("Expected object property name in loop binding.");
    if (!property) {
      return null;
    }

    if (!this.matchText(":")) {
      return {
        kind: "ForObjectBindingProperty",
        property,
        binding: property,
        shorthand: true,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }

    const separator = this.previousOr(start);
    const binding = this.parseIdentifier("Expected local name after ':' in object loop binding.")
      ?? this.syntheticIdentifier(separator, "");
    return {
      kind: "ForObjectBindingProperty",
      property,
      binding,
      shorthand: false,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  /**
   * The context-free lexer intentionally keeps `namespace:path` together as a
   * resource-location token. Inside an object binding pattern the same token
   * is unambiguously the compact alias form `{ property:local }`, so split it
   * here without weakening resource-location lexing everywhere else.
   */
  private tryParseCompactForObjectBindingProperty(): ForObjectBindingPropertyNode | undefined {
    const token = this.current();
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*):([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(token.text);
    if (!match) {
      return undefined;
    }

    this.advance();
    const propertyEnd = token.offset + match[1].length;
    const bindingStart = propertyEnd + 1;
    const property: IdentifierNode = {
      kind: "Identifier",
      text: match[1],
      range: { start: token.offset, end: propertyEnd },
      fullRange: { start: this.fullStart(token), end: propertyEnd }
    };
    const binding: IdentifierNode = {
      kind: "Identifier",
      text: match[2],
      range: { start: bindingStart, end: token.offset + token.length },
      fullRange: { start: bindingStart, end: token.offset + token.length }
    };
    return {
      kind: "ForObjectBindingProperty",
      property,
      binding,
      shorthand: false,
      ...this.nodeRanges(token, token)
    };
  }

  private nextForDimensionStartsBeforeBody(): boolean {
    if (this.current().text !== ",") {
      return false;
    }

    if (this.peekText(1) === "{") {
      let depth = 0;
      let offset = 1;
      while (this.peekText(offset) !== "") {
        const text = this.peekText(offset);
        if (text === "{") {
          depth++;
        } else if (text === "}") {
          depth--;
          if (depth === 0) {
            return this.peekText(offset + 1) === "in";
          }
        }
        offset++;
      }
      return false;
    }

    let offset = 1;
    while (this.peekText(offset) !== "" && this.peekText(offset) !== "{" && this.peekText(offset) !== "}") {
      if (this.peekText(offset) === "in") {
        return true;
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
    this.expectText("}", blockSyntaxMessages.expectedCloseAfterBlock);
    return {
      kind: "Block",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseBodyForContext(context: BodyParseContext): RsglStatementBodyNode {
    if (context.kind === "resource") {
      return this.parseResourceBody(context);
    }
    if (context.kind === "blockstateEntries") {
      return context.mode === "variants"
        ? parseVariantBody(this.resourceStatementParserHost())
        : parseMultipartBody(this.resourceStatementParserHost());
    }
    if (context.kind === "blockstateRoot") {
      return context.mode === "variants"
        ? parseBlockstateVariantsRootBody(this.resourceStatementParserHost(), context)
        : parseBlockstateMultipartRootBody(this.resourceStatementParserHost(), context);
    }
    if (context.kind === "blockstateChoice") {
      return parseBlockstateChoiceBody(this.resourceStatementParserHost());
    }
    if (context.kind === "itemModelBody") {
      const host = this.resourceStatementParserHost();
      switch (context.owner) {
        case "select":
          return parseItemSelectBody(host);
        case "range":
          return parseItemRangeBody(host);
        case "composite":
          return parseItemCompositeBody(host);
        case "first_match":
          return parseItemFirstMatchBody(host);
        case "itemModelTemplate":
          return parseItemModelTemplateBody(host);
      }
    }
    return this.parseBlock();
  }

  protected parseResourceBody(context: ResourceBodyParseContext): ResourceBodyNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return this.emptyResourceBodyAt(start, "Expected resource body.");
    }

    const statements: ResourceStatementNode[] = [];
    let seenBase = false;
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const statement = this.parseResourceStatement(context);
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
      return context.dialect === "item"
        ? parseItemModelUseDecl(this.resourceStatementParserHost())
        : this.parseUseDecl();
    }
    if (!explicitPropertyStart && token.text === "for") {
      return this.parseForStmt(context);
    }
    if (!explicitPropertyStart && token.text === "if") {
      return this.parseIfStmt(context);
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

  private parseBlockstateRootCommonStatement(
    context: BlockstateRootParseContext
  ): BlockstateRootCommonStatementNode {
    const token = this.current();
    const explicitPropertyStart = this.isExplicitPropertyStart();
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
    if (!explicitPropertyStart && token.text === "base") {
      return this.parseBaseStmt();
    }
    if (!explicitPropertyStart && token.text === "merge") {
      return this.parseMergeStmt();
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
          externSyntaxMessages.bangMustFollowExtern,
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
        externSyntaxMessages.externVarOutsideModelBody,
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

  private parsePropertyStmt(): PropertyStmtNode {
    const start = this.current();
    const name = this.parsePropertyName(start);
    if (this.current().text === ":" || this.current().text === "=") {
      this.advance();
    }

    let value: ExprNode;
    if (this.current().text === "{") {
      value = this.parseObjectExpression();
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

  private parseBaseStmt(): BaseStmtNode {
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

  private parseMergeStmt(): MergeStmtNode {
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
      expectMappingArrow: context => this.expectMappingArrow(context),
      consumeOptionalSeparator: () => this.consumeOptionalSeparator(),
      consumeBalancedBlock: message => this.consumeBalancedBlock(message),
      consumeBalancedEnclosure: (openText, closeText, message) =>
        this.consumeBalancedEnclosure(openText, closeText, message),
      recoverToLineEnd: () => this.recoverToLineEnd(),
      addDiagnosticAtCurrent: (code, message, severity) => this.addDiagnosticAtCurrent(code, message, severity),
      addDiagnostic: (code, message, range, severity) => this.addDiagnostic(code, message, range, severity),
      parseExpression: (options, minPrecedence) => this.parseExpression(options, minPrecedence),
      parseIdentifier: message => this.parseIdentifier(message),
      parseStringLiteral: () => this.parseStringLiteral(),
      parseObjectExpression: () => this.parseObjectExpression(),
      parseBlockstateRootCommonStatement: context => this.parseBlockstateRootCommonStatement(context),
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

  private isLineBoundaryOr(...texts: string[]): boolean {
    return this.isAtEnd() || texts.includes(this.current().text) || this.isStatementBoundary(this.current());
  }
}

function isExplicitMergeMode(text: string): text is Exclude<MergeMode, "shallow"> {
  return text === "deep" || text === "strict" || text === "upsert" || text === "append";
}
