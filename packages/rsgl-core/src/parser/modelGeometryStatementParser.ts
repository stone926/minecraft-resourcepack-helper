import {
  getRsglModelGeometryStatementDescriptor,
  getRsglModelTransformAxis,
  type RsglModelElementStatementDescriptor
} from "../modelGeometrySyntax";
import { modelTransformBodyParseContext } from "./bodyParseContext";
import {
  modelElementBodyClauseKeywords,
  modelElementHeaderClauseKeywords,
  modelFaceIntroducerKeywords,
  modelFaceTargets,
} from "./statementKeywords";
import { ResourceStatementParserHost } from "./statementParserHost";
import {
  ModelElementStmtNode,
  ModelFaceClauseNode,
  ModelGeometryPropertyNode,
  ModelTransformStmtNode,
  ModelTextureStmtNode,
  ExprNode,
  ResourceStatementNode
} from "./types";

export function tryParseModelGeometryStatement(
  host: ResourceStatementParserHost,
  bodyDialect: string | undefined
): ResourceStatementNode | undefined {
  if (bodyDialect !== "model") {
    return undefined;
  }
  const token = host.current();
  if (token.text === "texture" && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return parseModelTextureStmt(host);
  }
  const statementDescriptor = getRsglModelGeometryStatementDescriptor(token.text);
  if (statementDescriptor && host.peekText(1) !== ":" && host.peekText(1) !== "=") {
    return statementDescriptor.statement.kind === "transform"
      ? parseModelTransformStmt(host)
      : parseModelElementStmt(host, statementDescriptor as RsglModelElementStatementDescriptor);
  }
  return undefined;
}

function parseModelTextureStmt(host: ResourceStatementParserHost): ModelTextureStmtNode {
  const start = host.advance();
  const key = host.parseIdentifier("Expected model texture key.") ?? host.syntheticIdentifier(start, "");
  const value = host.parseExpression({ stopTexts: [] });
  return {
    kind: "ModelTextureStmt",
    keyword: start.text,
    key,
    value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseModelElementStmt(
  host: ResourceStatementParserHost,
  descriptor: RsglModelElementStatementDescriptor
): ModelElementStmtNode {
  const start = host.advance();
  const elementKind = descriptor.statement.elementKind;
  const label = host.current().kind === "string" ? host.parseStringLiteral() : undefined;
  let from: ExprNode | undefined;
  let to: ExprNode | undefined;
  const properties: ModelGeometryPropertyNode[] = [];
  const faces: ModelFaceClauseNode[] = [];

  while (!host.isAtEnd() && !host.isLineBoundaryOr("{", "}")) {
    const mark = host.mark();
    if (host.matchText("from")) {
      from = host.parseExpression({ stopTexts: [...modelElementHeaderClauseKeywords, "{", "}"] });
    } else if (host.matchText("to")) {
      to = host.parseExpression({ stopTexts: [...modelElementHeaderClauseKeywords, "{", "}"] });
    } else if (modelElementHeaderClauseKeywords.includes(host.current().text)) {
      properties.push(parseModelGeometryProperty(host, modelElementHeaderClauseKeywords));
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedModelElementClause", "Expected 'from', 'to', or a model element clause.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse model element clause; skipping token.");
  }

  if (host.current().text === "{") {
    const body = parseModelElementBody(host);
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
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseModelTransformStmt(host: ResourceStatementParserHost): ModelTransformStmtNode {
  const start = host.advance();
  const operationStart = host.current();
  const operation = host.isLineBoundaryOr()
    ? missingTransformOperation(host, operationStart)
    : host.parseIdentifier("Expected rotate_x, rotate_y, or rotate_z after 'transform'.")
      ?? host.syntheticIdentifier(operationStart, "");
  const axis = getRsglModelTransformAxis(operation.text) ?? null;
  if (!axis && operation.text) {
    host.addDiagnostic(
      "rsgl.invalidModelTransformOperation",
      "Model transform operation must be rotate_x, rotate_y, or rotate_z.",
      operation.range
    );
  }

  host.expectText("(", "Expected '(' before model transform angle.");
  const angleStart = host.current();
  const angle = host.isLineBoundaryOr(")", "around", "{", "}")
    ? missingTransformExpression(host, angleStart, "rsgl.expectedModelTransformAngle", "Expected model transform angle.")
    : host.parseExpression({ stopTexts: [")", "around", "{", "}"] });
  host.expectText(")", "Expected ')' after model transform angle.");
  host.expectText("around", "Expected 'around' after model transform angle.");

  const pivotStart = host.current();
  const pivot = host.isLineBoundaryOr("{", "}")
    ? missingTransformExpression(host, pivotStart, "rsgl.expectedModelTransformPivot", "Expected model transform pivot after 'around'.")
    : host.parseExpression({ stopTexts: ["{", "}"] });
  const body = host.current().text === "{"
    ? host.parseResourceBody(modelTransformBodyParseContext)
    : host.emptyResourceBodyAt(host.current(), "Expected model transform body.");

  return {
    kind: "ModelTransformStmt",
    keyword: start.text,
    operation,
    axis,
    angle,
    pivot,
    body,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function missingTransformOperation(
  host: ResourceStatementParserHost,
  token: ReturnType<ResourceStatementParserHost["current"]>
) {
  host.addDiagnosticAtCurrent(
    "rsgl.expectedIdentifier",
    "Expected rotate_x, rotate_y, or rotate_z after 'transform'."
  );
  return host.syntheticIdentifier(token, "");
}

function missingTransformExpression(
  host: ResourceStatementParserHost,
  token: ReturnType<ResourceStatementParserHost["current"]>,
  code: string,
  message: string
): ExprNode {
  host.addDiagnostic(code, message, { start: token.offset, end: token.offset + token.length });
  return host.missingExprAt(token);
}

function parseModelElementBody(
  host: ResourceStatementParserHost
): { properties: ModelGeometryPropertyNode[]; faces: ModelFaceClauseNode[] } {
  host.matchText("{");
  const properties: ModelGeometryPropertyNode[] = [];
  const faces: ModelFaceClauseNode[] = [];
  while (!host.isAtEnd() && host.current().text !== "}") {
    const mark = host.mark();
    if (modelFaceIntroducerKeywords.has(host.current().text) || modelFaceTargets.has(host.current().text)) {
      faces.push(parseModelFaceClause(host));
    } else if (modelElementBodyClauseKeywords.includes(host.current().text)) {
      properties.push(parseModelGeometryProperty(host, modelElementBodyClauseKeywords));
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedModelElementBodyClause", "Expected a model element property or face clause.");
      host.recoverToLineEnd();
    }
    host.consumeOptionalSeparator();
    host.ensureProgress(mark, "Unable to parse model element body clause; skipping token.");
  }
  host.expectText("}", "Expected '}' after model element body.");
  return { properties, faces };
}

function parseModelFaceClause(host: ResourceStatementParserHost): ModelFaceClauseNode {
  const start = host.current();
  if (modelFaceIntroducerKeywords.has(host.current().text)) {
    host.advance();
    // optional readability keyword
  }
  const target = host.parseIdentifier("Expected model face direction or 'all'.") ?? host.syntheticIdentifier(start, "all");
  if (!modelFaceTargets.has(target.text)) {
    host.addDiagnostic("rsgl.invalidModelFaceTarget", "Expected model face direction or 'all'.", target.range);
  }
  const properties: ModelGeometryPropertyNode[] = [];
  while (!host.isAtEnd() && !host.isLineBoundaryOr("}")) {
    const mark = host.mark();
    if (modelElementBodyClauseKeywords.includes(host.current().text)) {
      properties.push(parseModelGeometryProperty(host, modelElementBodyClauseKeywords));
    } else {
      host.addDiagnosticAtCurrent("rsgl.expectedModelFaceClause", "Expected model face property.");
      host.recoverToLineEnd();
      break;
    }
    host.ensureProgress(mark, "Unable to parse model face clause; skipping token.");
  }
  return {
    kind: "ModelFaceClause",
    target,
    properties,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}

function parseModelGeometryProperty(
  host: ResourceStatementParserHost,
  stopClauses: readonly string[]
): ModelGeometryPropertyNode {
  const start = host.current();
  const name = host.parseIdentifier("Expected model geometry property.") ?? host.syntheticIdentifier(start, start.text);
  const value = host.isAtEnd() || host.isLineBoundaryOr("}") || stopClauses.includes(host.current().text)
    ? host.booleanLiteral(start, true)
    : host.parseExpression({ stopTexts: [...stopClauses, "}"] });
  return {
    kind: "ModelGeometryProperty",
    name,
    value,
    ...host.nodeRanges(start, host.previousOr(start))
  };
}
