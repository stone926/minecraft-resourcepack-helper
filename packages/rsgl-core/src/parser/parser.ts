import {
  isResourceKeyword,
  isSugarKeyword,
  isTopLevelKeyword
} from "./keywords";
import { lexRsgl } from "./lexer";
import { endRange, ParserContext, tokenRange } from "./parserContext";
import {
  ArgumentNode,
  AtlasDirectoryStmtNode,
  AtlasFilterStmtNode,
  AtlasPalettedPermutationsStmtNode,
  BlockNode,
  BooleanLiteralNode,
  EquipmentLayerStmtNode,
  ExprNode,
  ExportSpecifierNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  ImportSpecifierNode,
  LetDeclNode,
  MatchArmNode,
  ModelApplySugarNode,
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionStatementNode,
  NumberLiteralNode,
  ObjectExprNode,
  ObjectPropertyNode,
  PackFilterBlockStmtNode,
  PackFormatsStmtNode,
  PackOverlayStmtNode,
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
  "gui",
  "scaling",
  "layers",
  "raw"
]);

const itemRangeOptionKeywords = ["component", "source", "target", "wobble", "scale"];
const itemSelectOptionKeywords = ["component"];
const itemConditionOptionKeywords = ["component", "ignore_default", "index", "keybind", "predicate", "value"];
const equipmentLayerClauseKeywords = ["texture", "dyeable", "color", "use_player_texture", "usePlayerTexture"];

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
      const mark = this.mark();
      if (this.current().text === "}") {
        const token = this.advance();
        this.addDiagnostic("rsgl.unexpectedClosingBrace", "Unexpected closing brace.", tokenRange(token));
        continue;
      }

      statements.push(this.parseTopLevelStatement());
      this.ensureProgress(mark, "Unable to parse top-level statement; skipping token.");
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
    if (keyword === "export") {
      return this.parseExportDecl();
    }
    if (keyword === "overlay") {
      return this.parseOverlayDecl();
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
    if (keyword === "fragment") {
      return this.parseFragmentDecl();
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

  private parseOverlayDecl(): TopLevelStatementNode {
    const start = this.advance();
    const directory = this.parseExpression({ stopTexts: ["format", "{"] });
    let formatRange: ExprNode | undefined;
    if (this.matchText("format")) {
      formatRange = this.parseExpression({ stopTexts: ["{"] });
    }
    const body = this.current().text === "{"
      ? this.parseBlock()
      : this.emptyBlockAt(this.current(), "Expected overlay body.");
    return {
      kind: "OverlayDecl",
      keyword: start.text,
      directory,
      formatRange,
      body,
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
      const mark = this.mark();
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
      this.ensureProgress(mark, "Unable to parse import specifier; skipping token.");
    }
    this.expectText("}", "Expected '}' after import list.");
    return specifiers;
  }

  private parseExportDecl(): TopLevelStatementNode {
    const start = this.advance();
    const specifiers: ExportSpecifierNode[] = [];
    let source: StringLiteralNode | null = null;
    let exportAll = false;
    let expectsSource = false;

    if (this.matchText("*")) {
      exportAll = true;
      expectsSource = true;
      this.matchText("from");
    } else if (this.current().text === "{") {
      specifiers.push(...this.parseExportSpecifiers());
      expectsSource = this.matchText("from");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedExportList", "Expected export list or '*'.");
      this.recoverToLineEnd();
    }

    if (expectsSource) {
      if (this.current().kind === "string") {
        source = this.parseStringLiteral();
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedExportSource", "Expected export source string.");
        this.recoverToLineEnd();
      }
    }

    return {
      kind: "ExportDecl",
      keyword: start.text,
      specifiers,
      source,
      exportAll,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseExportSpecifiers(): ExportSpecifierNode[] {
    const specifiers: ExportSpecifierNode[] = [];
    this.matchText("{");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const start = this.current();
      const local = this.parseIdentifier("Expected export name.");
      let exported = local;
      if (this.matchText("as")) {
        exported = this.parseIdentifier("Expected exported name.") ?? local;
      }
      specifiers.push({
        kind: "ExportSpecifier",
        local: local ?? this.syntheticIdentifier(start, ""),
        exported: exported ?? this.syntheticIdentifier(start, ""),
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse export specifier; skipping token.");
    }
    this.expectText("}", "Expected '}' after export list.");
    return specifiers;
  }

  private parseLetDecl(): LetDeclNode {
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

  private parseFragmentDecl(): TopLevelStatementNode {
    const start = this.advance();
    const name = this.parseIdentifier("Expected fragment name.");
    const parameters = this.current().text === "(" ? this.parseParameters() : [];
    if (parameters.length === 0 && this.previousOr(start) === start) {
      this.addDiagnosticAtCurrent("rsgl.expectedParameters", "Expected fragment parameter list.");
    }
    const body = this.current().text === "{"
      ? this.parseResourceBody("fragment")
      : this.emptyResourceBodyAt(this.current(), "Expected fragment body.");
    return {
      kind: "FragmentDecl",
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
      const mark = this.mark();
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
      this.ensureProgress(mark, "Unable to parse parameter; skipping token.");
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
        const mark = this.mark();
        const option = this.parseSugarOption();
        if (option) {
          options.push(option);
        } else {
          break;
        }
        this.ensureProgress(mark, "Unable to parse sugar option; skipping token.");
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
      const mark = this.mark();
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
      this.ensureProgress(mark, "Unable to parse batch entry; skipping token.");
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
      const mark = this.mark();
      const binding = this.parseIdentifier("Expected loop binding.");
      if (binding) {
        bindings.push(binding);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse loop binding; skipping token.");
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
      const mark = this.mark();
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
        statements.push(this.parseResourceStatement(owner));
      }
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
      const mark = this.mark();
      statements.push(this.parseVariantSectionStatement());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse variant statement; skipping token.");
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
    if (token.text === "let") {
      return this.parseLetDecl();
    }
    if (token.text === "use") {
      return this.parseUseDecl();
    }
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
      const mark = this.mark();
      statements.push(this.parseMultipartSectionStatement());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse multipart statement; skipping token.");
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
    if (token.text === "let") {
      return this.parseLetDecl();
    }
    if (token.text === "use") {
      return this.parseUseDecl();
    }
    if (token.text === "for") {
      return this.parseForStmt("multipart");
    }
    if (token.text === "if") {
      return this.parseIfStmt("multipart");
    }
    return this.parseMultipartEntry();
  }

  private parseResourceStatement(owner: string): ResourceStatementNode {
    const token = this.current();
    if (token.text === "let") {
      return this.parseLetDecl();
    }
    if (token.text === "use") {
      return this.parseUseDecl();
    }
    if (token.text === "for") {
      return this.parseForStmt("resource");
    }
    if (token.text === "if") {
      return this.parseIfStmt("resource");
    }
    if (token.text === "raw_json" || token.text === "raw_json_file") {
      return this.parseRawLikeStmt("RawJsonStmt");
    }
    if (token.text === "override") {
      return this.parseRawLikeStmt("OverrideStmt");
    }
    if (token.text === "append") {
      return this.parseRawLikeStmt("AppendStmt");
    }
    if ((owner === "pack" || owner === "packOverlay") && token.text === "formats") {
      return this.parsePackFormatsStmt();
    }
    if (owner === "pack" && token.text === "overlay") {
      return this.parsePackOverlayStmt();
    }
    if (owner === "filter" && token.text === "block" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parsePackFilterBlockStmt();
    }
    if (owner === "atlas" && token.text === "directory" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseAtlasDirectoryStmt();
    }
    if (owner === "atlas" && token.text === "filter" && this.peekText(1) !== "{" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseAtlasFilterStmt();
    }
    if (owner === "atlas" && token.text === "paletted_permutations" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseAtlasPalettedPermutationsStmt();
    }
    if (owner === "equipment" && token.text === "layer" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseEquipmentLayerStmt();
    }
    if (owner === "mcmeta" && token.text === "texture") {
      return this.parseSectionStmt();
    }
    if (token.text === "range") {
      return this.parseItemRangeStmt();
    }
    if (token.text === "select") {
      return this.parseItemSelectStmt();
    }
    if (token.text === "condition") {
      return this.parseItemConditionStmt();
    }
    if (token.text === "composite") {
      return this.parseItemCompositeStmt();
    }
    if (token.text === "empty") {
      return this.parseItemEmptyStmt();
    }
    if (token.text === "selected_item") {
      return this.parseItemSelectedItemStmt();
    }
    if (token.text === "special") {
      return this.parseItemSpecialStmt();
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
    if (this.current().kind === "number") {
      const token = this.advance();
      return this.syntheticIdentifier(token, token.text);
    }
    return this.parseIdentifier("Expected property name.") ?? this.syntheticIdentifier(start, start.text);
  }

  private parsePackFormatsStmt(): PackFormatsStmtNode {
    const start = this.advance();
    let min: ExprNode | undefined;
    let max: ExprNode | undefined;
    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (this.matchText("min")) {
        min = this.parseExpression({ stopTexts: ["max", "}"] });
      } else if (this.matchText("max")) {
        max = this.parseExpression({ stopTexts: ["min", "}"] });
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedPackFormatClause", "Expected 'min' or 'max' in pack formats.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse pack formats clause; skipping token.");
    }
    return {
      kind: "PackFormatsStmt",
      keyword: start.text,
      min,
      max,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePackOverlayStmt(): PackOverlayStmtNode {
    const start = this.advance();
    const directory = this.parseExpression({ stopTexts: ["{"] });
    const body = this.current().text === "{"
      ? this.parseResourceBody("packOverlay")
      : this.emptyResourceBodyAt(this.current(), "Expected pack overlay body.");
    return {
      kind: "PackOverlayStmt",
      keyword: start.text,
      directory,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parsePackFilterBlockStmt(): PackFilterBlockStmtNode {
    const start = this.advance();
    let namespace: ExprNode | undefined;
    let path: ExprNode | undefined;
    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (this.matchText("namespace")) {
        namespace = this.parseExpression({ stopTexts: ["path", "}"] });
      } else if (this.matchText("path")) {
        path = this.parseExpression({ stopTexts: ["namespace", "}"] });
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedPackFilterBlockClause", "Expected 'namespace' or 'path' in pack filter block.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse pack filter block clause; skipping token.");
    }
    return {
      kind: "PackFilterBlockStmt",
      keyword: start.text,
      namespace,
      path,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseAtlasDirectoryStmt(): AtlasDirectoryStmtNode {
    const start = this.advance();
    let source: ExprNode | undefined;
    let prefix: ExprNode | undefined;
    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (this.matchText("source")) {
        source = this.parseExpression({ stopTexts: ["prefix", "}"] });
      } else if (this.matchText("prefix")) {
        prefix = this.parseExpression({ stopTexts: ["source", "}"] });
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedAtlasDirectoryClause", "Expected 'source' or 'prefix' in atlas directory source.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse atlas directory clause; skipping token.");
    }
    return {
      kind: "AtlasDirectoryStmt",
      keyword: start.text,
      source,
      prefix,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseAtlasFilterStmt(): AtlasFilterStmtNode {
    const start = this.advance();
    let namespace: ExprNode | undefined;
    let path: ExprNode | undefined;
    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (this.matchText("namespace")) {
        namespace = this.parseExpression({ stopTexts: ["path", "}"] });
      } else if (this.matchText("path")) {
        path = this.parseExpression({ stopTexts: ["namespace", "}"] });
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedAtlasFilterClause", "Expected 'namespace' or 'path' in atlas filter source.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse atlas filter clause; skipping token.");
    }
    return {
      kind: "AtlasFilterStmt",
      keyword: start.text,
      namespace,
      path,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseAtlasPalettedPermutationsStmt(): AtlasPalettedPermutationsStmtNode {
    const start = this.advance();
    const body = this.current().text === "{"
      ? this.parseResourceBody("atlasPalettedPermutations")
      : this.emptyResourceBodyAt(this.current(), "Expected paletted_permutations body.");
    return {
      kind: "AtlasPalettedPermutationsStmt",
      keyword: start.text,
      body,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseEquipmentLayerStmt(): EquipmentLayerStmtNode {
    const start = this.advance();
    const layer = this.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
    let texture: ExprNode | undefined;
    let dyeable: ExprNode | undefined;
    let color: ExprNode | undefined;
    let usePlayerTexture: ExprNode | undefined;

    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (this.matchText("texture")) {
        texture = this.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
      } else if (this.current().text === "dyeable") {
        dyeable = this.parseEquipmentBooleanClause();
      } else if (this.matchText("color")) {
        color = this.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
      } else if (this.current().text === "use_player_texture" || this.current().text === "usePlayerTexture") {
        usePlayerTexture = this.parseEquipmentBooleanClause();
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedEquipmentLayerClause", "Expected 'texture', 'dyeable', 'color', or 'use_player_texture' in equipment layer.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse equipment layer clause; skipping token.");
    }

    return {
      kind: "EquipmentLayerStmt",
      keyword: start.text,
      layer,
      texture,
      dyeable,
      color,
      usePlayerTexture,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseEquipmentBooleanClause(): ExprNode {
    const start = this.advance();
    if (this.isAtEnd() || this.isLineBoundaryOr("}") || equipmentLayerClauseKeywords.includes(this.current().text)) {
      return this.booleanLiteral(start, true);
    }
    return this.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
  }

  private parseRawLikeStmt(kind: "RawJsonStmt" | "OverrideStmt" | "AppendStmt"): ResourceStatementNode {
    const start = this.advance();
    const create = kind === "OverrideStmt" && this.matchText("create");
    const value = kind === "RawJsonStmt" && this.current().text === "("
      ? this.finishCallExpression({
        kind: "IdentifierExpr",
        name: this.syntheticIdentifier(start, start.text),
        ...this.nodeRanges(start, start)
      })
      : this.parseExpression({ stopTexts: [] });
    if (kind === "OverrideStmt") {
      return { kind, keyword: start.text, create, value, ...this.nodeRanges(start, this.previousOr(start)) };
    }
    return { kind, keyword: start.text, value, ...this.nodeRanges(start, this.previousOr(start)) };
  }

  private parseVariantsSection(): ResourceStatementNode {
    const start = this.advance();
    const entries: VariantSectionStatementNode[] = [];
    this.expectText("{", "Expected variants body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      entries.push(this.parseVariantSectionStatement());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse variant entry; skipping token.");
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
    const hasArrow = this.expectText("->", "Expected '->' in variant entry.");
    const value = hasArrow
      ? this.parseBlockstateEntryValue()
      : this.recoverMalformedEntryValue();
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
      const mark = this.mark();
      entries.push(this.parseMultipartSectionStatement());
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse multipart entry; skipping token.");
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
    const hasApply = this.expectText("apply", "Expected 'apply' in multipart entry.");
    const apply = hasApply
      ? this.parseBlockstateEntryValue()
      : this.recoverMalformedEntryValue();
    return {
      kind: "MultipartEntry",
      keyword: "multipartEntry",
      when,
      apply,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemRangeStmt(): ResourceStatementNode {
    const start = this.advance();
    const { property, options } = this.parseItemModelStatementHeader("range", itemRangeOptionKeywords);
    let frames: ReturnType<typeof this.parseItemRangeFrames> | undefined;
    let fallback: ExprNode | undefined;

    if (this.matchText("{")) {
      while (!this.isAtEnd() && this.current().text !== "}") {
        const mark = this.mark();
        if (this.current().text === "frames") {
          frames = this.parseItemRangeFrames();
        } else if (this.current().text === "fallback") {
          this.advance();
          fallback = this.parseExpression({ stopTexts: [] });
        } else {
          this.addDiagnosticAtCurrent("rsgl.unexpectedItemRangeStatement", "Expected 'frames' or 'fallback' in item range body.");
          this.recoverToLineEnd();
        }
        this.ensureProgress(mark, "Unable to parse item range statement; skipping token.");
      }
      this.expectText("}", "Expected '}' after item range body.");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedItemRangeBody", "Expected item range body.");
    }

    return {
      kind: "ItemRangeStmt",
      keyword: start.text,
      property,
      options,
      frames,
      fallback,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemRangeFrames() {
    const start = this.advance();
    const frames = this.parseExpression({ stopTexts: ["model"] });
    this.expectText("model", "Expected 'model' in item range frames clause.");
    const model = this.parseExpression({ stopTexts: [] });
    return {
      kind: "ItemRangeFrames" as const,
      frames,
      model,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemSelectStmt(): ResourceStatementNode {
    const start = this.advance();
    const { property, options } = this.parseItemModelStatementHeader("select", itemSelectOptionKeywords);
    const cases: ReturnType<typeof this.parseItemSelectCase>[] = [];
    let fallback: ExprNode | undefined;

    if (this.matchText("{")) {
      while (!this.isAtEnd() && this.current().text !== "}") {
        const mark = this.mark();
        if (this.current().text === "case") {
          cases.push(this.parseItemSelectCase());
        } else if (this.current().text === "fallback") {
          this.advance();
          fallback = this.parseExpression({ stopTexts: [] });
        } else {
          this.addDiagnosticAtCurrent("rsgl.unexpectedItemSelectStatement", "Expected 'case' or 'fallback' in item select body.");
          this.recoverToLineEnd();
        }
        this.ensureProgress(mark, "Unable to parse item select statement; skipping token.");
      }
      this.expectText("}", "Expected '}' after item select body.");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedItemSelectBody", "Expected item select body.");
    }

    return {
      kind: "ItemSelectStmt",
      keyword: start.text,
      property,
      options,
      cases,
      fallback,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemSelectCase() {
    const start = this.advance();
    const when = this.parseExpression({ stopTexts: ["->"] });
    this.expectText("->", "Expected '->' in item select case.");
    const model = this.parseExpression({ stopTexts: [] });
    return {
      kind: "ItemSelectCase" as const,
      when,
      model,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemConditionStmt(): ResourceStatementNode {
    const start = this.advance();
    const { property, options } = this.parseItemModelStatementHeader("condition", itemConditionOptionKeywords);
    let onTrue: ExprNode | undefined;
    let onFalse: ExprNode | undefined;

    if (this.matchText("{")) {
      while (!this.isAtEnd() && this.current().text !== "}") {
        const mark = this.mark();
        if (this.current().text === "on_true") {
          this.advance();
          onTrue = this.parseExpression({ stopTexts: [] });
        } else if (this.current().text === "on_false") {
          this.advance();
          onFalse = this.parseExpression({ stopTexts: [] });
        } else {
          this.addDiagnosticAtCurrent("rsgl.unexpectedItemConditionStatement", "Expected 'on_true' or 'on_false' in item condition body.");
          this.recoverToLineEnd();
        }
        this.ensureProgress(mark, "Unable to parse item condition statement; skipping token.");
      }
      this.expectText("}", "Expected '}' after item condition body.");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedItemConditionBody", "Expected item condition body.");
    }

    return {
      kind: "ItemConditionStmt",
      keyword: start.text,
      property,
      options,
      onTrue,
      onFalse,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemCompositeStmt(): ResourceStatementNode {
    const start = this.advance();
    const models = [];

    if (this.matchText("{")) {
      while (!this.isAtEnd() && this.current().text !== "}") {
        const mark = this.mark();
        if (this.current().text === "model") {
          this.advance();
          models.push(this.parseExpression({ stopTexts: [] }));
        } else {
          this.addDiagnosticAtCurrent("rsgl.unexpectedItemCompositeStatement", "Expected 'model' in item composite body.");
          this.recoverToLineEnd();
        }
        this.ensureProgress(mark, "Unable to parse item composite statement; skipping token.");
      }
      this.expectText("}", "Expected '}' after item composite body.");
    } else {
      this.addDiagnosticAtCurrent("rsgl.expectedItemCompositeBody", "Expected item composite body.");
    }

    return {
      kind: "ItemCompositeStmt",
      keyword: start.text,
      models,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemEmptyStmt(): ResourceStatementNode {
    const start = this.advance();
    return {
      kind: "ItemEmptyStmt",
      keyword: start.text,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemSelectedItemStmt(): ResourceStatementNode {
    const start = this.advance();
    return {
      kind: "ItemSelectedItemStmt",
      keyword: start.text,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemSpecialStmt(): ResourceStatementNode {
    const start = this.advance();
    this.expectText("base", "Expected 'base' in item special statement.");
    const base = this.parseExpression({ stopTexts: ["model"] });
    this.expectText("model", "Expected 'model' in item special statement.");
    const model = this.current().text === "{"
      ? this.parseObjectExpression()
      : this.parseExpression({ stopTexts: [] });
    return {
      kind: "ItemSpecialStmt",
      keyword: start.text,
      base,
      model,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseItemModelStatementHeader(owner: "range" | "select" | "condition", optionKeywords: string[]) {
    this.expectText("property", `Expected 'property' in item ${owner} statement.`);
    const property = this.parseExpression({ stopTexts: [...optionKeywords, "{"] });
    const options = [];
    while (!this.isAtEnd() && this.current().text !== "{") {
      const mark = this.mark();
      const start = this.current();
      const name = this.parseIdentifier(`Expected item ${owner} option name.`);
      if (!name) {
        this.recoverToLineEnd();
        this.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
        continue;
      }
      const value = this.parseExpression({ stopTexts: [...optionKeywords, "{"] });
      options.push({
        kind: "ItemOption" as const,
        name,
        value,
        ...this.nodeRanges(start, this.previousOr(start))
      });
      this.ensureProgress(mark, `Unable to parse item ${owner} option; skipping token.`);
    }
    return { property, options };
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
      if (this.current().text === "in" && left.kind === "IdentifierExpr") {
        const start = left;
        this.advance();
        const iterable = this.parseExpression(options, 1);
        left = {
          kind: "ForInExpr",
          binding: start.name,
          iterable,
          range: { start: start.range.start, end: iterable.range.end },
          fullRange: { start: start.fullRange.start, end: iterable.fullRange.end }
        };
        continue;
      }

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
      if (this.isStatementBoundary(this.current())) {
        break;
      }
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
      const mark = this.mark();
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
      this.ensureProgress(mark, "Unable to parse argument; skipping token.");
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
      const mark = this.mark();
      const property = this.parseObjectProperty();
      if (property) {
        properties.push(property);
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse object property; skipping token.");
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
    if (this.current().kind === "number") {
      return this.parseNumberLiteral();
    }
    return this.parseIdentifier("Expected object key.");
  }

  private parseListExpression(): ExprNode {
    const start = this.current();
    const elements: ExprNode[] = [];
    this.expectText("[", "Expected list body.");
    while (!this.isAtEnd() && this.current().text !== "]") {
      const mark = this.mark();
      elements.push(this.parseExpression({ stopTexts: [",", "]"] }));
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse list element; skipping token.");
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
      const mark = this.mark();
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
      this.ensureProgress(mark, "Unable to parse state key entry; skipping token.");
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
    while (!this.isAtEnd() && !this.isModelApplyPropertyStop()) {
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
      this.consumeModelApplyPropertySeparator();
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
    if (start.kind === "templateString") {
      return this.parseTemplateStringExpression();
    }
    if (start.kind === "resourceLocation") {
      const token = this.advance();
      return {
        kind: "ResourceLocationExpr",
        value: token.text,
        ...this.nodeRanges(token, token)
      };
    }

    if (start.kind === "identifier" || start.kind === "keyword") {
      return this.parseIdentifierOrPathExpression();
    }

    this.addDiagnostic("rsgl.expectedModelApplyPath", "Expected model path after '@'.", endRange(atToken));
    return this.missingExprAt(atToken);
  }

  private parseRandomApply(): ExprNode {
    const start = this.advance();
    const entries: ExprNode[] = [];
    if (!this.matchText("[")) {
      this.addDiagnosticAtCurrent("rsgl.expectedRandomList", "Expected '[' after random.");
    }
    while (!this.isAtEnd() && this.current().text !== "]") {
      const mark = this.mark();
      entries.push(this.parseExpression({ stopTexts: [",", "]"] }));
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse random entry; skipping token.");
    }
    this.expectText("]", "Expected ']' after random model list.");
    return {
      kind: "RandomApply",
      entries,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseBlockstateEntryValue(): ExprNode {
    return this.current().text === "random"
      ? this.parseRandomApply()
      : this.parseExpression({ stopTexts: ["}"] });
  }

  private parseMatchExpression(): ExprNode {
    const start = this.advance();
    const expression = this.parseExpression({ stopTexts: ["{"] });
    const arms: MatchArmNode[] = [];
    this.expectText("{", "Expected match body.");
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      const armStart = this.current();
      const patterns: ExprNode[] = [];
      patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      while (this.matchText("|")) {
        patterns.push(this.parseExpression({ stopTexts: ["|", "->"] }));
      }
      this.expectText("->", "Expected '->' in match arm.");
      const value = this.parseExpression({ stopTexts: [] });
      arms.push({
        kind: "MatchArm",
        patterns,
        value,
        ...this.nodeRanges(armStart, this.previousOr(armStart))
      });
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse match arm; skipping token.");
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
        const mark = this.mark();
        args.push(this.parseType());
        this.consumeOptionalSeparator();
        this.ensureProgress(mark, "Unable to parse type argument; skipping token.");
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

  private isModelApplyPropertyStop(): boolean {
    return this.isExpressionStop([",", "]", "}"]) || this.isStatementBoundary(this.current());
  }

  private looksLikeStateKeySugar(): boolean {
    if (this.current().text !== "[") {
      return false;
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

  private consumeModelApplyPropertySeparator(): void {
    if (this.current().text === ";") {
      this.advance();
      return;
    }
    if (
      this.current().text === "," &&
      (this.peekKind(1) === "identifier" || this.peekKind(1) === "keyword")
    ) {
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

  private recoverMalformedEntryValue(): ExprNode {
    const value = this.missingExprAt(this.current());
    if (this.current().text === "{") {
      this.consumeBalancedBlock("Expected '}' after malformed entry block.");
    } else {
      this.recoverToLineEnd();
    }
    return value;
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
  offsetNodeRange(expression, offset);
  if (expression.kind === "IdentifierExpr") {
    offsetNodeRange(expression.name, offset);
  } else if (expression.kind === "TemplateStringExpr") {
    for (const part of expression.parts) {
      part.range = offsetRange(part.range, offset);
      if (part.kind === "expression") {
        offsetExpressionRanges(part.expression, offset);
      }
    }
  } else if (expression.kind === "ListExpr") {
    expression.elements.forEach(element => offsetExpressionRanges(element, offset));
  } else if (expression.kind === "ObjectExpr") {
    expression.properties.forEach(property => offsetObjectPropertyRange(property, offset));
  } else if (expression.kind === "RangeExpr") {
    offsetExpressionRanges(expression.startExpr, offset);
    offsetExpressionRanges(expression.endExpr, offset);
  } else if (expression.kind === "CallExpr") {
    offsetExpressionRanges(expression.callee, offset);
    for (const arg of expression.args) {
      offsetNodeRange(arg, offset);
      if (arg.name) {
        offsetNodeRange(arg.name, offset);
      }
      offsetExpressionRanges(arg.value, offset);
    }
  } else if (expression.kind === "MemberExpr") {
    offsetExpressionRanges(expression.object, offset);
    offsetNodeRange(expression.property, offset);
  } else if (expression.kind === "IndexExpr") {
    offsetExpressionRanges(expression.object, offset);
    offsetExpressionRanges(expression.index, offset);
  } else if (expression.kind === "UnaryExpr") {
    offsetExpressionRanges(expression.operand, offset);
  } else if (expression.kind === "BinaryExpr") {
    offsetExpressionRanges(expression.left, offset);
    offsetExpressionRanges(expression.right, offset);
  } else if (expression.kind === "ConditionalExpr") {
    offsetExpressionRanges(expression.condition, offset);
    offsetExpressionRanges(expression.whenTrue, offset);
    offsetExpressionRanges(expression.whenFalse, offset);
  } else if (expression.kind === "MatchExpr") {
    offsetExpressionRanges(expression.expression, offset);
    for (const arm of expression.arms) {
      offsetNodeRange(arm, offset);
      arm.patterns.forEach(pattern => offsetExpressionRanges(pattern, offset));
      offsetExpressionRanges(arm.value, offset);
    }
  } else if (expression.kind === "StateKeySugar") {
    expression.entries.forEach(entry => offsetObjectPropertyRange(entry, offset));
  } else if (expression.kind === "ModelApplySugar") {
    offsetExpressionRanges(expression.model, offset);
    for (const property of expression.properties) {
      offsetNodeRange(property, offset);
      offsetNodeRange(property.name, offset);
      offsetExpressionRanges(property.value, offset);
    }
  } else if (expression.kind === "RandomApply") {
    expression.entries.forEach(entry => offsetExpressionRanges(entry, offset));
  }
  return expression;
}

function offsetObjectPropertyRange(property: ObjectPropertyNode, offset: number): void {
  offsetNodeRange(property, offset);
  if (property.key.kind === "DynamicKey") {
    offsetNodeRange(property.key, offset);
    offsetExpressionRanges(property.key.expression, offset);
  } else {
    offsetNodeRange(property.key, offset);
  }
  offsetExpressionRanges(property.value, offset);
}

function offsetNodeRange(node: RsglNode, offset: number): void {
  node.range = offsetRange(node.range, offset);
  node.fullRange = offsetRange(node.fullRange, offset);
}

function offsetRange(range: { start: number; end: number }, offset: number) {
  return { start: range.start + offset, end: range.end + offset };
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
