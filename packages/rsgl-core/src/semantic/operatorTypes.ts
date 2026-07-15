import { booleanType, numberType, RsglType } from "./types";

const booleanBinaryOperators = new Set([
  "&&",
  "||",
  "==",
  "!=",
  "in",
  "not in",
  "<",
  "<=",
  ">",
  ">="
]);

export function binaryOperatorResultType(operator: string): RsglType {
  return booleanBinaryOperators.has(operator) ? booleanType : numberType;
}

export function unaryOperatorResultType(operator: string): RsglType {
  return operator === "!" ? booleanType : numberType;
}
