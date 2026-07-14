import { equipmentLayerClauseKeywords } from "./statementKeywords";
import { ResourceStatementParserHost } from "./statementParserHost";
import {
  domainResourceBodyParseContext,
  resourceBodyOwnerName,
  type ResourceBodyOwner
} from "./bodyParseContext";
import {
  AtlasDirectoryStmtNode,
  AtlasFilterStmtNode,
  AtlasPalettedPermutationsStmtNode,
  EquipmentLayerStmtNode,
  ExprNode,
  PackFilterBlockStmtNode,
  PackFormatsStmtNode,
  PackOverlayStmtNode,
  ResourceStatementNode
} from "./types";

export function tryParsePackAtlasEquipmentStatement(
  host: ResourceStatementParserHost,
  owner: ResourceBodyOwner,
  bodyDialect: string | undefined
): ResourceStatementNode | undefined {
  const token = host.current();
  const ownerName = resourceBodyOwnerName(owner);
  if ((bodyDialect === "pack" || ownerName === "packOverlay") && token.text === "formats") {
    return parsePackFormatsStmt(host);
  }
  if (bodyDialect === "pack" && token.text === "overlay") {
    return parsePackOverlayStmt(host);
  }
  if (ownerName === "filter" && token.text === "block" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parsePackFilterBlockStmt(host);
  }
  if (bodyDialect === "atlas" && token.text === "directory" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parseAtlasDirectoryStmt(host);
  }
  if (bodyDialect === "atlas" && token.text === "filter" && host.peekText(1) !== "{" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parseAtlasFilterStmt(host);
  }
  if (bodyDialect === "atlas" && token.text === "paletted_permutations" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parseAtlasPalettedPermutationsStmt(host);
  }
  if (bodyDialect === "equipment" && token.text === "layer" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parseEquipmentLayerStmt(host);
  }
  return undefined;
}

function parsePackFormatsStmt(host: ResourceStatementParserHost): PackFormatsStmtNode {
  const start = host.advance();
  let min: ExprNode | undefined;
  let max: ExprNode | undefined;
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (host.matchText("min")) {
      min = host.parseExpression({ stopTexts: ["max", "}"] });
    } else if (host.matchText("max")) {
      max = host.parseExpression({ stopTexts: ["min", "}"] });
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedPackFormatClause", "Expected 'min' or 'max' in pack formats.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse pack formats clause; skipping token.");
  }
  return {
    kind: "PackFormatsStmt",
    keyword: start.text,
    min,
    max,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parsePackOverlayStmt(host: ResourceStatementParserHost): PackOverlayStmtNode {
  const start = host.advance();
  const directory = host.parseExpression({ stopTexts: ["{"] });
  const body = host.current().text === "{"
    ? host.parseResourceBody(domainResourceBodyParseContext("packOverlay"))
    : host.emptyResourceBodyAt(host.current(), "Expected pack overlay body.");
  return {
    kind: "PackOverlayStmt",
    keyword: start.text,
    directory,
    body,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parsePackFilterBlockStmt(host: ResourceStatementParserHost): PackFilterBlockStmtNode {
  const start = host.advance();
  let namespace: ExprNode | undefined;
  let path: ExprNode | undefined;
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (host.matchText("namespace")) {
      namespace = host.parseExpression({ stopTexts: ["path", "}"] });
    } else if (host.matchText("path")) {
      path = host.parseExpression({ stopTexts: ["namespace", "}"] });
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedPackFilterBlockClause", "Expected 'namespace' or 'path' in pack filter block.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse pack filter block clause; skipping token.");
  }
  return {
    kind: "PackFilterBlockStmt",
    keyword: start.text,
    namespace,
    path,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseAtlasDirectoryStmt(host: ResourceStatementParserHost): AtlasDirectoryStmtNode {
  const start = host.advance();
  let source: ExprNode | undefined;
  let prefix: ExprNode | undefined;
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (host.matchText("source")) {
      source = host.parseExpression({ stopTexts: ["prefix", "}"] });
    } else if (host.matchText("prefix")) {
      prefix = host.parseExpression({ stopTexts: ["source", "}"] });
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedAtlasDirectoryClause", "Expected 'source' or 'prefix' in atlas directory source.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse atlas directory clause; skipping token.");
  }
  return {
    kind: "AtlasDirectoryStmt",
    keyword: start.text,
    source,
    prefix,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseAtlasFilterStmt(host: ResourceStatementParserHost): AtlasFilterStmtNode {
  const start = host.advance();
  let namespace: ExprNode | undefined;
  let path: ExprNode | undefined;
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (host.matchText("namespace")) {
      namespace = host.parseExpression({ stopTexts: ["path", "}"] });
    } else if (host.matchText("path")) {
      path = host.parseExpression({ stopTexts: ["namespace", "}"] });
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedAtlasFilterClause", "Expected 'namespace' or 'path' in atlas filter source.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse atlas filter clause; skipping token.");
  }
  return {
    kind: "AtlasFilterStmt",
    keyword: start.text,
    namespace,
    path,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseAtlasPalettedPermutationsStmt(host: ResourceStatementParserHost): AtlasPalettedPermutationsStmtNode {
  const start = host.advance();
  const body = host.current().text === "{"
    ? host.parseResourceBody(domainResourceBodyParseContext("atlasPalettedPermutations"))
    : host.emptyResourceBodyAt(host.current(), "Expected paletted_permutations body.");
  return {
    kind: "AtlasPalettedPermutationsStmt",
    keyword: start.text,
    body,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseEquipmentLayerStmt(host: ResourceStatementParserHost): EquipmentLayerStmtNode {
  const start = host.advance();
  const layer = host.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
  let texture: ExprNode | undefined;
  let dyeable: ExprNode | undefined;
  let color: ExprNode | undefined;
  let usePlayerTexture: ExprNode | undefined;

  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (host.matchText("texture")) {
      texture = host.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
    } else if (host.current().text === "dyeable") {
      dyeable = parseEquipmentBooleanClause(host);
    } else if (host.matchText("color")) {
      color = host.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
    } else if (host.current().text === "use_player_texture") {
      usePlayerTexture = parseEquipmentBooleanClause(host);
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedEquipmentLayerClause", "Expected 'texture', 'dyeable', 'color', or 'use_player_texture' in equipment layer.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse equipment layer clause; skipping token.");
  }

  return {
    kind: "EquipmentLayerStmt",
    keyword: start.text,
    layer,
    texture,
    dyeable,
    color,
    usePlayerTexture,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseEquipmentBooleanClause(host: ResourceStatementParserHost): ExprNode {
  const start = host.advance();
  if (host.isAtEnd() || host.isLineBoundaryOr("}") || equipmentLayerClauseKeywords.includes(host.current().text)) {
    return host.booleanLiteral(start, true);
  }
  return host.parseExpression({ stopTexts: [...equipmentLayerClauseKeywords, "}"] });
}
