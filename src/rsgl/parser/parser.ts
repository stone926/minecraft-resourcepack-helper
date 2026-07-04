import {
  isResourceKeyword,
  isSugarKeyword,
  isTopLevelKeyword
} from "./keywords";
import { lexRsgl } from "./lexer";
import { endRange, ParserContext, tokenRange } from "./parserContext";
import {
  ArgumentNode,
  BlockNode,
  BooleanLiteralNode,
  ExprNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  ImportSpecifierNode,
  MatchArmNode,
  ModelApplySugarNode,
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionStatementNode,
  NumberLiteralNode,
  ObjectExprNode,
  ObjectPropertyNode,
  ParameterNode,
  ResourceBodyNode,
  ResourceDeclNode,
  ResourceKind,
  ResourceStatementNode,
  RsglModule,
  RsglNode,
  RsglToken,
  StringLiteralNode,
  SugarEntryNode,
  SugarKind,
  SugarOptionNode,
  SugarPropertyNode,
  TemplateStringPart,
  TopLevelStatementNode,
  TypeNode,
  UseDeclNode,
  VariantBodyNode,
  VariantEntryNode,
  VariantSectionStatementNode
} from "./types";

const resourceBodySectionKeywords = new Set([
  "textures",
  "animation",
  "sources",
  "filter",
  "layers",
  "raw"
]);

const binaryPrecedence = new Map<string, number>([
  ["||", 2],
  ["&&", 3],
  ["==", 4],
  ["!=", 4],
  ["<", 4],
  ["<=", 4],
  [">", 4],
  [">=", 4],
  ["+", 5],
  ["-", 5],
  ["*", 6],
  ["/", 6],
  ["%", 6],
  ["..", 7]
]);

type BodyMode = "topLevel" | "resource" | "variants" | "multipart";

interface ExpressionOptions {
  stopTexts?: readonly string[];
}

export function parseRsgl(text: string): RsglModule {
  const lexResult = lexRsgl(text);
  const parser = new RsglParser(lexResult.tokens, lexResult.diagnostics);
  return parser.parseModule();
}

class RsglParser extends ParserContext {
  private targetCount = 0;

  public parseModule(): RsglModule {
    const statements: TopLevelStatementNode[] = [];
    while (!this.isAtEnd()) {
      if (this.current().text === "}") {
        const token = this.advance();
        this.addDiagnostic("rsgl.unexpectedClosingBrace", "Unexpected closing brace.", tokenRange(token));
        continue;
      }

      statements.push(this.parseTopLevelStatement());
    }

    const eof = this.current();
    return {
      kind: "Module",
      statements,
      eof,
      diagnostics: this.diagnostics,
      tokens: this.tokens,
      range: { start: 0, end: eof.offset },
      fullRange: { start: 0, end: eof.offset }
    };
  }

  private parseTopLevelStatement(): TopLevelStatementNode {
    const token = this.current();
    const keyword = token.text;

    if (keyword === "target") {
      return this.parseTargetDecl();
    }
    if (keyword === "namespace") {
      return this.parseNamespaceDecl();
    }
    if (keyword === "import") {
      return this.parseImportDecl();
    }
    if (keyword === "let") {
      return this.parseLetDecl();
    }
    if (keyword === "table") {
      return this.parseTableDecl();
    }
    if (keyword === "template") {
      return this.parseTemplateDecl();
    }
    if (isResourceKeyword(keyword)) {
      return this.parseResourceDecl();
    }
    if (isSugarKeyword(keyword)) {
      return this.parseSugarDecl();
    }
    if (keyword === "use") {
      return this.parseUseDecl();
    }
    if (keyword === "for") {
      return this.parseForStmt("topLevel");
    }
    if (keyword === "if") {
      return this.parseIfStmt("topLevel");
    }

    this.addDiagnostic("rsgl.unexpectedToken", `Unexpected token '${token.text}'.`, tokenRange(token));
    this.recoverToNextStatement();
    return {
      kind: "UnknownStmt",
      keyword,
      ...this.nodeRanges(token, this.previousOr(token))
    };
  }

  private parseTargetDecl(): TopLevelStatementNode {
    const start = this.advance();
    this.targetCount++;
    if (this.targetCount > 1) {
      this.addDiagnostic(
        "rsgl.multipleTargets",
        "A compile unit should have only one primary target.",
        tokenRange(start),
        "warning"
      );
    }

    const edition = this.parseIdentifier("Expected target edition.");
    let selector: "format" | "mc" | null = null;
    if (this.current().text === "format" || this.current().text === "mc") {
      selector = this.advance().text as "format" | "mc";
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedTargetSelector", "Expected target selector 'format' or 'mc'.");
    }

    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind: "TargetDecl",
      keyword: start.text,
      edition,
      selector,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseNamespaceDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseExpression({ stopTexts: [] });
    return {
      kind: "NamespaceDecl",
      keyword: start.text,
      name,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseImportDecl(): TopLevelStatementNode {
    const start = this.advance();
    let defaultName: IdentifierNode | undefined;
    const namedImports: ImportSpecifierNode[] = [];
    let source: StringLiteralNode | null = null;

    if (this.current().text === "{") {
      namedImports.push(...this.parseImportSpecifiers());
      this.matchText("from");
    } else if (this.current().kind === "identifier" || this.current().kind === "keyword") {
      if (this.peekText(1) === "from") {
        defaultName = this.parseIdentifier("Expected imported binding.") ?? undefined;
        this.matchText("from");
      }
    }

    if (this.current().kind === "string") {
      source = this.parseStringLiteral();
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedImportSource", "Expected import source string.");
      this.recoverToLineEnd();
    }

    return {
      kind: "ImportDecl",
      keyword: start.text,
      defaultName,
      namedImports,
      source,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseImportSpecifiers(): ImportSpecifierNode[] {
    const specifiers: ImportSpecifierNode[] = [];
    this.matchText("{");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const start = this.current();
      const imported = this.parseIdentifier("Expected import name.");
      let local = imported;
      if (this.matchText("as")) {
        local = this.parseIdentifier("Expected local import name.") ?? imported;
      }
      specifiers.push({
        kind: "ImportSpecifier",
        imported: imported ?? this.syntheticIdentifier(start, ""),
        local: local ?? this.syntheticIdentifier(start, ""),
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText("}", "Expected '}' after import list.");
    return specifiers;
  }

  private parseLetDecl(): TopLevelStatementNode {
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

  private parseTableDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected table name.");
    const body = this.current().text === "{"
      ? this.parseObjectExpression()
      : this.emptyObjectAt(this.current(), "Expected table body.");
    return {
      kind: "TableDecl",
      keyword: start.text,
      name,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseTemplateDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected template name.");
    const parameters = this.current().text === "(" ? this.parseParameters() : [];
    if (parameters.length === 0 && this.previousOr(start) === start) {
      this.addDiagnosticAtCurrent("rsgl.expectedParameters", "Expected template parameter list.");
    }
    const body = this.current().text === "{"
      ? this.parseBlock()
      : this.emptyBlockAt(this.current(), "Expected template body.");
    return {
      kind: "TemplateDecl",
      keyword: start.text,
      name,
      parameters,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseParameters(): ParameterNode[] {
    const parameters: ParameterNode[] = [];
    this.matchText("(");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const start = this.current();
      const name = this.parseIdentifier("Expected parameter name.");
      const typeAnnotation = this.matchText(":") ? this.parseType() : undefined;
      const defaultValue = this.matchText("=") ? this.parseExpression({ stopTexts: [",", ")"] }) : undefined;
      parameters.push({
        kind: "Parameter",
        name,
        typeAnnotation,
        defaultValue,
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText(")", "Expected ')' after parameters.");
    return parameters;
  }

  private parseResourceDecl(): ResourceDeclNode {
    const start = this.advance();
    const resourceKind = start.text as ResourceKind;
    let subtype: IdentifierNode | undefined;
    let id: ExprNode | undefined;

    if (resourceKind === "model") {
      subtype = this.parseIdentifier("Expected model subtype.") ?? undefined;
      id = this.parseExpression({ stopTexts: ["{"] });
    } else if (resourceKind !== "pack") {
      id = this.parseExpression({ stopTexts: ["{"] });
    }

    const body = this.current().text === "{"
      ? this.parseResourceBody(resourceKind)
      : this.emptyResourceBodyAt(this.current(), "Expected resource body.");
    return {
      kind: "ResourceDecl",
      keyword: start.text,
      resourceKind,
      subtype,
      id,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseSugarDecl(): TopLevelStatementNode {
    const start = this.advance();
    const sugarName = this.syntheticIdentifier(start, start.text);
    const sugarKind = this.getSugarKind(start.text);
    const options: SugarOptionNode[] = [];
    const entries: SugarEntryNode[] = [];
    let id: ExprNode | undefined;
    let body: ResourceBodyNode | undefined;

    if (sugarKind === "batchItemModel") {
      if (!this.matchText("model")) {
        this.addDiagnosticAtCurrent("rsgl.expectedItemsModel", "Expected 'model' after items.");
      }
      entries.push(...this.parseSugarEntryList());
    } else if (sugarKind === "batchModel") {
      entries.push(...this.parseSugarEntryList());
    } else {
      id = this.parseExpression({ stopTexts: ["{", "["] });
      while (!this.isAtEnd() && !this.isLineBoundaryOr("}", "{", "[")) {
        const option = this.parseSugarOption();
        if (option) {
          options.push(option);
        } else {
          break;
        }
      }
      if (this.current().text === "{") {
        body = this.parseResourceBody(start.text);
      }
    }

    return {
      kind: "SugarDecl",
      keyword: start.text,
      sugarKind,
      sugarName,
      id,
      entries,
      options,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseSugarEntryList(): SugarEntryNode[] {
    const entries: SugarEntryNode[] = [];
    if (!this.matchText("[")) {
      this.addDiagnosticAtCurrent("rsgl.expectedSugarList", "Expected '[' for batch declaration.");
      return entries;
    }

    while (!this.isAtEnd() && this.current().text !== "]") {
      const start = this.current();
      const id = this.parseExpression({ stopTexts: ["->", ",", "]"] });
      const target = this.matchText("->") ? this.parseExpression({ stopTexts: [",", "]"] }) : undefined;
      entries.push({
        kind: "SugarEntry",
        id,
        target,
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText("]", "Expected ']' after batch declaration.");
    return entries;
  }

  private parseSugarOption(): SugarOptionNode | null {
    const start = this.current();
    const name = this.parseIdentifier("Expected sugar option name.");
    if (!name) {
      return null;
    }
    const value = this.current().text === "="
      ? (this.advance(), this.parseExpression({ stopTexts: [] }))
      : this.parseExpression({ stopTexts: [] });
    return {
      kind: "SugarOption",
      name,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseUseDecl(): UseDeclNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: [] });
    return {
      kind: "UseDecl",
      keyword: start.text,
      expression,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseForStmt(mode: BodyMode): ForStmtNode {
    const start = this.advance();
    const bindings: IdentifierNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "in" && this.current().text !== "{") {
      const binding = this.parseIdentifier("Expected loop binding.");
      if (binding) {
        bindings.push(binding);
      }
      this.consumeOptionalSeparator();
    }
    this.expectText("in", "Expected 'in' in for statement.");
    const iterable = this.parseExpression({ stopTexts: ["{"] });
    const body = this.parseBodyForMode(mode, "for");
    return {
      kind: "ForStmt",
      keyword: start.text,
      bindings,
      iterable,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseIfStmt(mode: BodyMode): IfStmtNode {
    const start = this.advance();
    const condition = this.parseExpression({ stopTexts: ["{"] });
    const thenBody = this.parseBodyForMode(mode, "if");
    const elseBody = this.matchText("else")
      ? this.parseBodyForMode(mode, "else")
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

  private parseBlock(): BlockNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return this.emptyBlockAt(start, "Expected block body.");
    }

    const statements: TopLevelStatementNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      statements.push(this.parseTopLevelStatement());
    }
    this.expectText("}", "Expected '}' after block.");
    return {
      kind: "Block",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseBodyForMode(mode: BodyMode, owner: string): BlockNode | ResourceBodyNode | VariantBodyNode | MultipartBodyNode {
    if (mode === "resource") {
      return this.parseResourceBody(owner);
    }
    if (mode === "variants") {
      return this.parseVariantBody();
    }
    if (mode === "multipart") {
      return this.parseMultipartBody();
    }
    return this.parseBlock();
  }

  private parseResourceBody(owner: string): ResourceBodyNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return this.emptyResourceBodyAt(start, "Expected resource body.");
    }

    const statements: ResourceStatementNode[] = [];
    const seenBlockstateSections = new Set<string>();
    while (!this.isAtEnd() && this.current().text !== "}") {
      if (this.current().text === "variants") {
        if (owner === "blockstate") {
          this.noteBlockstateSection(seenBlockstateSections, "variants");
        }
        statements.push(this.parseVariantsSection());
      } else if (this.current().text === "multipart") {
        if (owner === "blockstate") {
          this.noteBlockstateSection(seenBlockstateSections, "multipart");
        }
        statements.push(this.parseMultipartSection());
      } else {
        statements.push(this.parseResourceStatement());
      }
    }

    this.expectText("}", "Expected '}' after resource body.");
    return {
      kind: "ResourceBody",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseVariantBody(): VariantBodyNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return {
        kind: "VariantBody",
        statements: [],
        ...this.nodeRanges(start, start)
      };
    }

    const statements: VariantSectionStatementNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      statements.push(this.parseVariantSectionStatement());
    }
    this.expectText("}", "Expected '}' after variants body.");
    return {
      kind: "VariantBody",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseVariantSectionStatement(): VariantSectionStatementNode {
    const token = this.current();
    if (token.text === "for") {
      return this.parseForStmt("variants");
    }
    if (token.text === "if") {
      return this.parseIfStmt("variants");
    }
    return this.parseVariantEntry();
  }

  private parseMultipartBody(): MultipartBodyNode {
    const start = this.current();
    if (!this.matchText("{")) {
      return {
        kind: "MultipartBody",
        statements: [],
        ...this.nodeRanges(start, start)
      };
    }

    const statements: MultipartSectionStatementNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      statements.push(this.parseMultipartSectionStatement());
    }
    this.expectText("}", "Expected '}' after multipart body.");
    return {
      kind: "MultipartBody",
      statements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseMultipartSectionStatement(): MultipartSectionStatementNode {
    const token = this.current();
    if (token.text === "for") {
      return this.parseForStmt("multipart");
    }
    if (token.text === "if") {
      return this.parseIfStmt("multipart");
    }
    return this.parseMultipartEntry();
  }

  private parseResourceStatement(): ResourceStatementNode {
    const token = this.current();
    if (token.text === "use") {
      return this.parseUseDecl();
    }
    if (token.text === "for") {
      return this.parseForStmt("resource");
    }
    if (token.text === "if") {
      return this.parseIfStmt("resource");
    }
    if (token.text === "raw_json") {
      return this.parseRawLikeStmt("RawJsonStmt");
    }
    if (token.text === "override") {
      return this.parseRawLikeStmt("OverrideStmt");
    }
    if (token.text === "append") {
      return this.parseRawLikeStmt("AppendStmt");
    }
    if (resourceBodySectionKeywords.has(token.text)) {
      return this.parseSectionStmt();
    }
    return this.parsePropertyStmt();
  }

  private parseSectionStmt(): ResourceStatementNode {
    const start = this.current();
    const name = this.parseIdentifier("Expected section name.") ?? this.syntheticIdentifier(start, start.text);
    let body: ResourceBodyNode | undefined;
    let value: ExprNode | undefined;
    if (this.current().text === "{") {
      body = this.parseResourceBody(name.text);
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
    return this.parseIdentifier("Expected property name.") ?? this.syntheticIdentifier(start, start.text);
  }

  private parseRawLikeStmt(kind: "RawJsonStmt" | "OverrideStmt" | "AppendStmt"): ResourceStatementNode {
    const start = this.advance();
    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind,
      keyword: start.text,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseVariantsSection(): ResourceStatementNode {
    const start = this.advance();
    const entries: VariantSectionStatementNode[] = [];
    this.expectText("{", "Expected variants body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      entries.push(this.parseVariantSectionStatement());
    }
    this.expectText("}", "Expected '}' after variants.");
    return {
      kind: "VariantsSection",
      keyword: start.text,
      entries,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseVariantEntry(): VariantEntryNode {
    const start = this.current();
    const state = this.parseExpression({ stopTexts: ["->"] });
    this.expectText("->", "Expected '->' in variant entry.");
    const value = this.current().text === "random"
      ? this.parseRandomApply()
      : this.parseExpression({ stopTexts: [] });
    return {
      kind: "VariantEntry",
      keyword: "variant",
      state,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseMultipartSection(): ResourceStatementNode {
    const start = this.advance();
    const entries: MultipartSectionStatementNode[] = [];
    this.expectText("{", "Expected multipart body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      entries.push(this.parseMultipartSectionStatement());
    }
    this.expectText("}", "Expected '}' after multipart.");
    return {
      kind: "MultipartSection",
      keyword: start.text,
      entries,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseMultipartEntry(): MultipartEntryNode {
    const start = this.current();
    let when: ExprNode | undefined;
    if (this.matchText("when")) {
      when = this.parseExpression({ stopTexts: ["apply"] });
    }
    this.expectText("apply", "Expected 'apply' in multipart entry.");
    const apply = this.current().text === "random"
      ? this.parseRandomApply()
      : this.parseExpression({ stopTexts: [] });
    return {
      kind: "MultipartEntry",
      keyword: "multipartEntry",
      when,
      apply,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  protected parseExpression(options: ExpressionOptions = {}, minPrecedence = 0): ExprNode {
    const stopTexts = options.stopTexts ?? [];
    if (this.isExpressionStop(stopTexts)) {
      this.addDiagnosticAtCurrent("rsgl.expectedExpression", "Expected expression.");
      return this.missingExprAt(this.current());
    }

    let left = this.parsePrefixExpression(stopTexts);
    left = this.parsePostfixExpression(left, stopTexts);

    while (!this.isExpressionStop(stopTexts)) {
      if (this.current().text === "?") {
        if (minPrecedence > 1) {
          break;
        }
        const start = left;
        this.advance();
        const whenTrue = this.parseExpression({ stopTexts: [":"] });
        this.expectText(":", "Expected ':' in conditional expression.");
        const whenFalse = this.parseExpression(options, 1);
        left = {
          kind: "ConditionalExpr",
          condition: start,
          whenTrue,
          whenFalse,
          range: { start: start.range.start, end: whenFalse.range.end },
          fullRange: { start: start.fullRange.start, end: whenFalse.fullRange.end }
        };
        continue;
      }

      const precedence = binaryPrecedence.get(this.current().text);
      if (precedence === undefined || precedence < minPrecedence) {
        break;
      }

      const operator = this.advance().text;
      const right = this.parseExpression(options, precedence + 1);
      if (operator === "..") {
        left = {
          kind: "RangeExpr",
          startExpr: left,
          endExpr: right,
          inclusive: true,
          range: { start: left.range.start, end: right.range.end },
          fullRange: { start: left.fullRange.start, end: right.fullRange.end }
        };
      } else {
        left = {
          kind: "BinaryExpr",
          operator,
          left,
          right,
          range: { start: left.range.start, end: right.range.end },
          fullRange: { start: left.fullRange.start, end: right.fullRange.end }
        };
      }
    }

    return left;
  }

  private parsePrefixExpression(stopTexts: readonly string[]): ExprNode {
    const token = this.current();
    if (token.text === "!" || token.text === "-") {
      const operator = this.advance().text;
      const operand = this.parseExpression({ stopTexts }, 8);
      return {
        kind: "UnaryExpr",
        operator,
        operand,
        range: { start: token.offset, end: operand.range.end },
        fullRange: { start: this.fullStart(token), end: operand.fullRange.end }
      };
    }

    if (token.text === "(") {
      this.advance();
      const expression = this.parseExpression({ stopTexts: [")"] });
      this.expectText(")", "Expected ')' after expression.");
      return expression;
    }

    if (token.text === "{") {
      return this.parseObjectExpression();
    }
    if (token.text === "[") {
      return this.looksLikeStateKeySugar() ? this.parseStateKeySugar() : this.parseListExpression();
    }
    if (token.text === "@") {
      return this.parseModelApplySugar();
    }
    if (token.text === "match") {
      return this.parseMatchExpression();
    }
    if (token.text === "random") {
      return this.parseRandomApply();
    }
    if (token.kind === "string") {
      return this.parseStringLiteral();
    }
    if (token.kind === "templateString") {
      return this.parseTemplateStringExpression();
    }
    if (token.kind === "number") {
      return this.parseNumberLiteral();
    }
    if (token.kind === "resourceLocation") {
      const consumed = this.advance();
      return {
        kind: "ResourceLocationExpr",
        value: consumed.text,
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.text === "true" || token.text === "false") {
      const consumed = this.advance();
      return {
        kind: "BooleanLiteral",
        value: consumed.text === "true",
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.text === "null") {
      const consumed = this.advance();
      return {
        kind: "NullLiteral",
        ...this.nodeRanges(consumed, consumed)
      };
    }
    if (token.kind === "identifier" || token.kind === "keyword") {
      return this.parseIdentifierOrPathExpression();
    }

    this.addDiagnosticAtCurrent("rsgl.expectedExpression", "Expected expression.");
    if (!this.isAtEnd()) {
      this.advance();
    }
    return this.missingExprAt(token);
  }

  private parsePostfixExpression(expression: ExprNode, stopTexts: readonly string[]): ExprNode {
    let result = expression;
    let reading = true;
    while (reading && !this.isExpressionStop(stopTexts)) {
      if (this.current().text === "(") {
        result = this.finishCallExpression(result);
      } else if (this.current().text === "." && this.peekKind(1) !== "number") {
        const dot = this.advance();
        const property = this.parseIdentifier("Expected member name.") ?? this.syntheticIdentifier(dot, "");
        result = {
          kind: "MemberExpr",
          object: result,
          property,
          range: { start: result.range.start, end: property.range.end },
          fullRange: { start: result.fullRange.start, end: property.fullRange.end }
        };
      } else if (this.current().text === "[") {
        const start = result;
        this.advance();
        const index = this.parseExpression({ stopTexts: ["]"] });
        this.expectText("]", "Expected ']' after index expression.");
        result = {
          kind: "IndexExpr",
          object: start,
          index,
          range: { start: start.range.start, end: this.previousOr(this.current()).offset + this.previousOr(this.current()).length },
          fullRange: { start: start.fullRange.start, end: this.previousOr(this.current()).offset + this.previousOr(this.current()).length }
        };
      } else {
        reading = false;
      }
    }
    return result;
  }

  private finishCallExpression(callee: ExprNode): ExprNode {
    const start = callee;
    const args: ArgumentNode[] = [];
    this.matchText("(");
    while (!this.isAtEnd() && this.current().text !== ")") {
      const argStart = this.current();
      let name: IdentifierNode | undefined;
      if ((this.current().kind === "identifier" || this.current().kind === "keyword") && this.peekText(1) === ":") {
        name = this.parseIdentifier("Expected argument name.") ?? undefined;
        this.matchText(":");
      }
      const value = this.parseExpression({ stopTexts: [",", ")"] });
      args.push({
        kind: "Argument",
        name,
        value,
        ...this.nodeRanges(argStart, this.previousOr(argStart))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText(")", "Expected ')' after arguments.");
    const end = this.previousOr(this.current());
    return {
      kind: "CallExpr",
      callee,
      args,
      range: { start: start.range.start, end: end.offset + end.length },
      fullRange: { start: start.fullRange.start, end: end.offset + end.length }
    };
  }

  private parseIdentifierOrPathExpression(): ExprNode {
    const first = this.parseIdentifier("Expected identifier.");
    if (!first) {
      return this.missingExprAt(this.current());
    }

    const pathParts = [first.text];
    let endToken = this.previousOr(this.current());
    while (
      this.current().text === "/" &&
      !this.hasLeadingTrivia(this.current()) &&
      (this.peekKind(1) === "identifier" || this.peekKind(1) === "keyword") &&
      !this.hasLeadingTrivia(this.peek(1))
    ) {
      pathParts.push(this.advance().text);
      const segment = this.advance();
      pathParts.push(segment.text);
      endToken = segment;
    }

    if (pathParts.length > 1) {
      return {
        kind: "ResourceLocationExpr",
        value: pathParts.join(""),
        range: { start: first.range.start, end: endToken.offset + endToken.length },
        fullRange: { start: first.fullRange.start, end: endToken.offset + endToken.length }
      };
    }

    return {
      kind: "IdentifierExpr",
      name: first,
      range: first.range,
      fullRange: first.fullRange
    };
  }

  private parseObjectExpression(): ObjectExprNode {
    const start = this.current();
    const properties: ObjectPropertyNode[] = [];
    this.expectText("{", "Expected object body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const property = this.parseObjectProperty();
      if (property) {
        properties.push(property);
      }
      this.consumeOptionalSeparator();
    }
    this.expectText("}", "Expected '}' after object.");
    return {
      kind: "ObjectExpr",
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseObjectProperty(): ObjectPropertyNode | null {
    const start = this.current();
    const key = this.parsePropertyKey();
    if (!key) {
      this.recoverToLineEnd();
      return null;
    }
    if (!this.matchText(":") && !this.matchText("=")) {
      this.addDiagnosticAtCurrent("rsgl.expectedPropertySeparator", "Expected ':' or '=' after object key.");
    }
    const value = this.parseExpression({ stopTexts: [",", "}"] });
    return {
      kind: "ObjectProperty",
      key,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePropertyKey(): ObjectPropertyNode["key"] | null {
    if (this.current().text === "[") {
      const start = this.advance();
      const expression = this.parseExpression({ stopTexts: ["]"] });
      this.expectText("]", "Expected ']' after dynamic key.");
      return {
        kind: "DynamicKey",
        expression,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    if (this.current().kind === "string") {
      return this.parseStringLiteral();
    }
    return this.parseIdentifier("Expected object key.");
  }

  private parseListExpression(): ExprNode {
    const start = this.current();
    const elements: ExprNode[] = [];
    this.expectText("[", "Expected list body.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      elements.push(this.parseExpression({ stopTexts: [",", "]"] }));
      this.consumeOptionalSeparator();
    }
    this.expectText("]", "Expected ']' after list.");
    return {
      kind: "ListExpr",
      elements,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseStateKeySugar(): ExprNode {
    const start = this.current();
    const entries: ObjectPropertyNode[] = [];
    this.expectText("[", "Expected state key sugar.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      const keyStart = this.current();
      const key = this.parsePropertyKey();
      if (!key) {
        break;
      }
      this.expectText("=", "Expected '=' in state key sugar.");
      const value = this.parseExpression({ stopTexts: [",", "]"] });
      entries.push({
        kind: "ObjectProperty",
        key,
        value,
        ...this.nodeRanges(keyStart, this.previousOr(keyStart))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText("]", "Expected ']' after state key sugar.");
    return {
      kind: "StateKeySugar",
      entries,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseModelApplySugar(): ModelApplySugarNode {
    const start = this.advance();
    const model = this.parseModelApplyPath(start);
    const properties: SugarPropertyNode[] = [];
    while (!this.isAtEnd() && !this.isExpressionStop([",", "]", "}"])) {
      const propertyStart = this.current();
      const name = this.parseIdentifier("Expected model apply property.");
      if (!name) {
        break;
      }
      const value = this.matchText("=")
        ? this.parseExpression({ stopTexts: [",", "]", "}"] })
        : this.booleanLiteral(propertyStart, true);
      properties.push({
        kind: "SugarProperty",
        name,
        value,
        ...this.nodeRanges(propertyStart, this.previousOr(propertyStart))
      });
      this.consumeOptionalSeparator();
    }
    return {
      kind: "ModelApplySugar",
      model,
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseModelApplyPath(atToken: RsglToken): ExprNode {
    const start = this.current();
    if (start.kind === "resourceLocation") {
      const token = this.advance();
      return {
        kind: "ResourceLocationExpr",
        value: token.text,
        ...this.nodeRanges(token, token)
      };
    }

    const parts: string[] = [];
    let end = start;
    while (
      !this.isAtEnd() &&
      !this.hasLeadingTrivia(this.current()) &&
      !this.isExpressionStop([",", "]", "}"])
    ) {
      parts.push(this.advance().text);
      end = this.previousOr(start);
    }

    if (parts.length === 0) {
      this.addDiagnostic("rsgl.expectedModelApplyPath", "Expected model path after '@'.", endRange(atToken));
      return this.missingExprAt(atToken);
    }

    return {
      kind: "ResourceLocationExpr",
      value: parts.join(""),
      range: { start: start.offset, end: end.offset + end.length },
      fullRange: { start: this.fullStart(start), end: end.offset + end.length }
    };
  }

  private parseRandomApply(): ExprNode {
    const start = this.advance();
    const entries: ExprNode[] = [];
    if (!this.matchText("[")) {
      this.addDiagnosticAtCurrent("rsgl.expectedRandomList", "Expected '[' after random.");
    }
    while (!this.isAtEnd() && this.current().text !== "]") {
      entries.push(this.parseExpression({ stopTexts: [",", "]"] }));
      this.consumeOptionalSeparator();
    }
    this.expectText("]", "Expected ']' after random model list.");
    return {
      kind: "RandomApply",
      entries,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseMatchExpression(): ExprNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: ["{"] });
    const arms: MatchArmNode[] = [];
    this.expectText("{", "Expected match body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const armStart = this.current();
      const patterns: ExprNode[] = [];
      patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      while (this.matchText("|")) {
        patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      }
      this.expectText("->", "Expected '->' in match arm.");
      const value = this.parseExpression({ stopTexts: [",", "}"] });
      arms.push({
        kind: "MatchArm",
        patterns,
        value,
        ...this.nodeRanges(armStart, this.previousOr(armStart))
      });
      this.consumeOptionalSeparator();
    }
    this.expectText("}", "Expected '}' after match.");
    return {
      kind: "MatchExpr",
      expression,
      arms,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseStringLiteral(): StringLiteralNode {
    const token = this.advance();
    return {
      kind: "StringLiteral",
      value: unquoteString(token.text),
      raw: token.text,
      ...this.nodeRanges(token, token)
    };
  }

  private parseTemplateStringExpression(): ExprNode {
    const token = this.advance();
    return {
      kind: "TemplateStringExpr",
      raw: token.text,
      parts: parseTemplateStringParts(token),
      ...this.nodeRanges(token, token)
    };
  }

  private parseNumberLiteral(): NumberLiteralNode {
    const token = this.advance();
    return {
      kind: "NumberLiteral",
      value: token.text.startsWith("0x") || token.text.startsWith("0X") ? Number.parseInt(token.text.slice(2), 16) : Number(token.text),
      raw: token.text,
      ...this.nodeRanges(token, token)
    };
  }

  private parseType(): TypeNode {
    const first = this.parsePrimaryType();
    const options = [first];
    while (this.matchText("|")) {
      options.push(this.parsePrimaryType());
    }
    if (options.length === 1) {
      return first;
    }
    return {
      kind: "UnionType",
      options,
      range: { start: options[0].range.start, end: options[options.length - 1].range.end },
      fullRange: { start: options[0].fullRange.start, end: options[options.length - 1].fullRange.end }
    };
  }

  private parsePrimaryType(): TypeNode {
    const start = this.current();
    if (this.current().kind === "string") {
      return { kind: "LiteralType", value: this.parseStringLiteral(), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().kind === "number") {
      return { kind: "LiteralType", value: this.parseNumberLiteral(), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().text === "true" || this.current().text === "false") {
      return { kind: "LiteralType", value: this.booleanLiteral(this.advance(), start.text === "true"), ...this.nodeRanges(start, this.previousOr(start)) };
    }
    if (this.current().text === "null") {
      return { kind: "LiteralType", value: { kind: "NullLiteral", ...this.nodeRanges(this.advance(), this.previousOr(start)) }, ...this.nodeRanges(start, this.previousOr(start)) };
    }

    const name = this.parseIdentifier("Expected type name.");
    if (!name) {
      return { kind: "MissingType", ...this.nodeRanges(start, start) };
    }
    if (this.matchText("<")) {
      const args: TypeNode[] = [];
      while (!this.isAtEnd() && this.current().text !== ">") {
        args.push(this.parseType());
        this.consumeOptionalSeparator();
      }
      this.expectText(">", "Expected '>' after generic type arguments.");
      return {
        kind: "GenericType",
        name,
        args,
        ...this.nodeRanges(start, this.previousOr(start))
      };
    }
    return {
      kind: "NamedType",
      name,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseIdentifier(message: string): IdentifierNode | null {
    const token = this.current();
    if (token.kind !== "identifier" && token.kind !== "keyword") {
      this.addDiagnosticAtCurrent("rsgl.expectedIdentifier", message);
      return null;
    }
    this.advance();
    return this.syntheticIdentifier(token, token.text);
  }

  private syntheticIdentifier(token: RsglToken | RsglNode, text: string): IdentifierNode {
    const range = getNodeOrTokenRange(token);
    const fullRange = getNodeOrTokenFullRange(token);
    return {
      kind: "Identifier",
      text,
      range,
      fullRange
    };
  }

  private booleanLiteral(token: RsglToken, value: boolean): BooleanLiteralNode {
    return {
      kind: "BooleanLiteral",
      value,
      ...this.nodeRanges(token, token)
    };
  }

  private emptyObjectAt(token: RsglToken, message: string): ObjectExprNode {
    this.addDiagnosticAtCurrent("rsgl.expectedObject", message);
    return {
      kind: "ObjectExpr",
      properties: [],
      ...this.nodeRanges(token, token)
    };
  }

  private emptyBlockAt(token: RsglToken, message: string): BlockNode {
    this.addDiagnosticAtCurrent("rsgl.expectedBody", message);
    return {
      kind: "Block",
      statements: [],
      ...this.nodeRanges(token, token)
    };
  }

  private emptyResourceBodyAt(token: RsglToken, message: string): ResourceBodyNode {
    this.addDiagnosticAtCurrent("rsgl.expectedResourceBody", message);
    return {
      kind: "ResourceBody",
      statements: [],
      ...this.nodeRanges(token, token)
    };
  }

  private missingExprAt(token: RsglToken | RsglNode): ExprNode {
    return {
      kind: "MissingExpr",
      range: getNodeOrTokenRange(token),
      fullRange: getNodeOrTokenFullRange(token)
    };
  }

  private isExpressionStop(stopTexts: readonly string[]): boolean {
    if (this.isAtEnd()) {
      return true;
    }
    if (stopTexts.includes(this.current().text)) {
      return true;
    }
    return stopTexts.length === 0 && this.isStatementBoundary(this.current());
  }

  private looksLikeStateKeySugar(): boolean {
    if (this.current().text !== "[") {
      return false;
    }
    if (this.peekText(1) === "]") {
      return true;
    }
    return (this.peekKind(1) === "identifier" || this.peekKind(1) === "keyword" || this.peekKind(1) === "string") &&
      this.peekText(2) === "=";
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

  private getSugarKind(keyword: string): SugarKind {
    if (keyword === "cube_all" || keyword === "item_generated") {
      return "batchModel";
    }
    if (keyword === "items") {
      return "batchItemModel";
    }
    if (keyword === "wood_family" || keyword === "block_family") {
      return "family";
    }
    return "conventionalBlockstate";
  }

  private consumeOptionalSeparator(): void {
    if (this.current().text === "," || this.current().text === ";") {
      this.advance();
    }
  }

  private expectText(text: string, message: string): boolean {
    if (this.matchText(text)) {
      return true;
    }
    this.addDiagnosticAtCurrent(expectedTokenDiagnosticCode(text), message);
    return false;
  }

  private recoverToLineEnd(): void {
    while (!this.isAtEnd() && !this.isStatementBoundary(this.current()) && this.current().text !== "}") {
      this.advance();
    }
  }

  private recoverToNextStatement(): void {
    this.advance();
    while (!this.isAtEnd()) {
      const token = this.current();
      if (token.text === "}" || (this.isStatementBoundary(token) && isTopLevelKeyword(token.text))) {
        return;
      }
      this.advance();
    }
  }

  private isLineBoundaryOr(...texts: string[]): boolean {
    return this.isAtEnd() || texts.includes(this.current().text) || this.isStatementBoundary(this.current());
  }

  private nodeRanges(start: RsglToken, end: RsglToken): Pick<RsglNode, "range" | "fullRange"> {
    return {
      range: { start: start.offset, end: end.offset + end.length },
      fullRange: { start: this.fullStart(start), end: end.offset + end.length }
    };
  }

  private fullStart(token: RsglToken): number {
    return token.leadingTrivia.length > 0 ? token.leadingTrivia[0].offset : token.offset;
  }

  private hasLeadingTrivia(token: RsglToken): boolean {
    return token.leadingTrivia.length > 0;
  }

  private peek(ahead: number): RsglToken {
    return this.tokens[this.tokenOffset() + ahead] ?? this.current();
  }

  private peekText(ahead: number): string {
    return this.peek(ahead).text;
  }

  private peekKind(ahead: number): RsglToken["kind"] {
    return this.peek(ahead).kind;
  }

  private tokenOffset(): number {
    const current = this.current();
    return this.tokens.indexOf(current);
  }
}

function getNodeOrTokenRange(value: RsglToken | RsglNode) {
  if ("range" in value) {
    return value.range;
  }
  return tokenRange(value);
}

function getNodeOrTokenFullRange(value: RsglToken | RsglNode) {
  if ("fullRange" in value) {
    return value.fullRange;
  }
  return tokenRange(value);
}

function expectedTokenDiagnosticCode(text: string): string {
  if (text === "}") {
    return "rsgl.expectedClosingBrace";
  }
  if (text === "]") {
    return "rsgl.expectedClosingBracket";
  }
  if (text === ")") {
    return "rsgl.expectedClosingParen";
  }
  return "rsgl.expectedToken";
}

function parseTemplateStringParts(token: RsglToken): TemplateStringPart[] {
  const raw = token.text;
  const content = raw.startsWith("`") && raw.endsWith("`") ? raw.slice(1, -1) : raw.slice(1);
  const parts: TemplateStringPart[] = [];
  let index = 0;
  let textStart = 0;
  while (index < content.length) {
    if (content[index] === "$" && content[index + 1] === "{") {
      if (textStart < index) {
        parts.push({
          kind: "text",
          text: content.slice(textStart, index),
          range: { start: token.offset + 1 + textStart, end: token.offset + 1 + index }
        });
      }
      const exprStart = index + 2;
      const exprEnd = findTemplateExpressionEnd(content, exprStart);
      const expressionText = content.slice(exprStart, exprEnd);
      parts.push({
        kind: "expression",
        expression: parseStandaloneExpression(expressionText, token.offset + 1 + exprStart),
        range: { start: token.offset + 1 + index, end: token.offset + 1 + Math.min(content.length, exprEnd + 1) }
      });
      index = Math.min(content.length, exprEnd + 1);
      textStart = index;
    } else if (content[index] === "\\") {
      index += 2;
    } else {
      index++;
    }
  }
  if (textStart < content.length) {
    parts.push({
      kind: "text",
      text: content.slice(textStart),
      range: { start: token.offset + 1 + textStart, end: token.offset + 1 + content.length }
    });
  }
  return parts;
}

function parseStandaloneExpression(text: string, baseOffset: number): ExprNode {
  const lexResult = lexRsgl(text);
  const parser = new StandaloneExpressionParser(lexResult.tokens, lexResult.diagnostics);
  return offsetExpressionRanges(parser.parse(), baseOffset);
}

class StandaloneExpressionParser extends RsglParser {
  public parse(): ExprNode {
    return this.parseExpression();
  }
}

function offsetExpressionRanges<T extends ExprNode>(expression: T, offset: number): T {
  expression.range = { start: expression.range.start + offset, end: expression.range.end + offset };
  expression.fullRange = { start: expression.fullRange.start + offset, end: expression.fullRange.end + offset };
  return expression;
}

function findTemplateExpressionEnd(content: string, start: number): number {
  let depth = 1;
  for (let index = start; index < content.length; index++) {
    if (content[index] === "{") {
      depth++;
    } else if (content[index] === "}") {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return content.length;
}

function unquoteString(raw: string): string {
  if (!raw.startsWith("\"")) {
    return raw;
  }
  const body = raw.endsWith("\"") ? raw.slice(1, -1) : raw.slice(1);
  return body.replace(/\\(u[0-9A-Fa-f]{4}|[nrt"\\])/g, (_match, escape: string) => {
    if (escape === "n") {
      return "\n";
    }
    if (escape === "r") {
      return "\r";
    }
    if (escape === "t") {
      return "\t";
    }
    if (escape.startsWith("u")) {
      return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    }
    return escape;
  });
}
