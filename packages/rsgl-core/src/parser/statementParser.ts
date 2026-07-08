import { ExpressionParser, unquoteString } from "./expressionParser";
import { tokenRange } from "./parserContext";
import {
  BodyMode,
  equipmentLayerClauseKeywords,
  itemConditionOptionKeywords,
  itemRangeOptionKeywords,
  itemSelectOptionKeywords,
  modelElementBodyClauseKeywords,
  modelElementHeaderClauseKeywords,
  modelFaceTargets,
  modelGeometryStatementKeywords,
  resourceBodySectionKeywords
} from "./statementKeywords";
import {
  AtlasDirectoryStmtNode,
  AtlasFilterStmtNode,
  AtlasPalettedPermutationsStmtNode,
  BlockNode,
  EquipmentLayerStmtNode,
  ExprNode,
  ForDimensionNode,
  ForStmtNode,
  IdentifierNode,
  IfStmtNode,
  LetDeclNode,
  ModelElementStmtNode,
  ModelFaceClauseNode,
  ModelGeometryPropertyNode,
  ModelTextureStmtNode,
  MultipartBodyNode,
  MultipartEntryNode,
  MultipartSectionStatementNode,
  PackFilterBlockStmtNode,
  PackFormatsStmtNode,
  PackOverlayStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  RsglToken,
  TopLevelStatementNode,
  UseDeclNode,
  VariantBodyNode,
  VariantEntryNode,
  VariantSectionStatementNode
} from "./types";

export abstract class StatementParser extends ExpressionParser {
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

  protected parseForStmt(mode: BodyMode): ForStmtNode {
    const start = this.advance();
    const dimensions: ForDimensionNode[] = [];
    dimensions.push(this.parseForDimension(start));
    while (this.current().text === "," && this.nextForDimensionStartsBeforeBody()) {
      this.advance();
      dimensions.push(this.parseForDimension(this.current()));
    }
    const body = this.parseBodyForMode(mode, "for");
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

  protected parseIfStmt(mode: BodyMode): IfStmtNode {
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

  protected parseResourceBody(owner: string): ResourceBodyNode {
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
    if (owner === "model" && token.text === "texture" && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseModelTextureStmt();
    }
    if (owner === "model" && modelGeometryStatementKeywords.has(token.text) && this.peekText(1) !== ":" && this.peekText(1) !== "=") {
      return this.parseModelElementStmt();
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

  private parseModelTextureStmt(): ModelTextureStmtNode {
    const start = this.advance();
    const key = this.parseIdentifier("Expected model texture key.") ?? this.syntheticIdentifier(start, "");
    const value = this.parseExpression({ stopTexts: [] });
    return {
      kind: "ModelTextureStmt",
      keyword: start.text,
      key,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseModelElementStmt(): ModelElementStmtNode {
    const start = this.advance();
    const elementKind = start.text === "element" ? "element" : "box";
    const label = this.current().kind === "string" ? this.parseStringLiteral() : undefined;
    let from: ExprNode | undefined;
    let to: ExprNode | undefined;
    const properties: ModelGeometryPropertyNode[] = [];
    const faces: ModelFaceClauseNode[] = [];

    while (!this.isAtEnd() && !this.isLineBoundaryOr("{", "}")) {
      const mark = this.mark();
      if (this.matchText("from")) {
        from = this.parseExpression({ stopTexts: [...modelElementHeaderClauseKeywords, "{", "}"] });
      } else if (this.matchText("to")) {
        to = this.parseExpression({ stopTexts: [...modelElementHeaderClauseKeywords, "{", "}"] });
      } else if (modelElementHeaderClauseKeywords.includes(this.current().text)) {
        properties.push(this.parseModelGeometryProperty(modelElementHeaderClauseKeywords));
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedModelElementClause", "Expected 'from', 'to', or a model element clause.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse model element clause; skipping token.");
    }

    if (this.current().text === "{") {
      const body = this.parseModelElementBody();
      properties.push(...body.properties);
      faces.push(...body.faces);
    }

    return {
      kind: "ModelElementStmt",
      keyword: start.text,
      elementKind,
      label,
      from,
      to,
      properties,
      faces,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseModelElementBody(): { properties: ModelGeometryPropertyNode[]; faces: ModelFaceClauseNode[] } {
    this.matchText("{");
    const properties: ModelGeometryPropertyNode[] = [];
    const faces: ModelFaceClauseNode[] = [];
    while (!this.isAtEnd() && this.current().text !== "}") {
      const mark = this.mark();
      if (this.current().text === "face" || modelFaceTargets.has(this.current().text)) {
        faces.push(this.parseModelFaceClause());
      } else if (modelElementBodyClauseKeywords.includes(this.current().text)) {
        properties.push(this.parseModelGeometryProperty(modelElementBodyClauseKeywords));
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedModelElementBodyClause", "Expected a model element property or face clause.");
        this.recoverToLineEnd();
      }
      this.consumeOptionalSeparator();
      this.ensureProgress(mark, "Unable to parse model element body clause; skipping token.");
    }
    this.expectText("}", "Expected '}' after model element body.");
    return { properties, faces };
  }

  private parseModelFaceClause(): ModelFaceClauseNode {
    const start = this.current();
    if (this.matchText("face")) {
      // optional readability keyword
    }
    const target = this.parseIdentifier("Expected model face direction or 'all'.") ?? this.syntheticIdentifier(start, "all");
    if (!modelFaceTargets.has(target.text)) {
      this.addDiagnostic("rsgl.invalidModelFaceTarget", "Expected model face direction or 'all'.", target.range);
    }
    const properties: ModelGeometryPropertyNode[] = [];
    while (!this.isAtEnd() && !this.isLineBoundaryOr("}")) {
      const mark = this.mark();
      if (modelElementBodyClauseKeywords.includes(this.current().text)) {
        properties.push(this.parseModelGeometryProperty(modelElementBodyClauseKeywords));
      } else {
        this.addDiagnosticAtCurrent("rsgl.expectedModelFaceClause", "Expected model face property.");
        this.recoverToLineEnd();
        break;
      }
      this.ensureProgress(mark, "Unable to parse model face clause; skipping token.");
    }
    return {
      kind: "ModelFaceClause",
      target,
      properties,
      ...this.nodeRanges(start, this.previousOr(start))
    };
  }

  private parseModelGeometryProperty(stopClauses: string[]): ModelGeometryPropertyNode {
    const start = this.current();
    const name = this.parseIdentifier("Expected model geometry property.") ?? this.syntheticIdentifier(start, start.text);
    const value = this.isAtEnd() || this.isLineBoundaryOr("}") || stopClauses.includes(this.current().text)
      ? this.booleanLiteral(start, true)
      : this.parseExpression({ stopTexts: [...stopClauses, "}"] });
    return {
      kind: "ModelGeometryProperty",
      name,
      value,
      ...this.nodeRanges(start, this.previousOr(start))
    };
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

  private recoverMalformedEntryValue(): ExprNode {
    const value = this.missingExprAt(this.current());
    if (this.current().text === "{") {
      this.consumeBalancedBlock("Expected '}' after malformed entry block.");
    } else {
      this.recoverToLineEnd();
    }
    return value;
  }

  private isLineBoundaryOr(...texts: string[]): boolean {
    return this.isAtEnd() || texts.includes(this.current().text) || this.isStatementBoundary(this.current());
  }
}
