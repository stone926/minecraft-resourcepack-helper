export type RsglArrowRole = "mapping" | "outputContract";
export type RsglArrowExpectation = "expected" | "missing";

export interface RsglArrowRule {
  readonly expectedText: "=>" | "->";
  readonly expectedDiagnosticCode: string;
  readonly expectedMessage: (context: string) => string;
}

const mappingArrowRule: RsglArrowRule = {
  expectedText: "=>",
  expectedDiagnosticCode: "rsgl.expectedMappingArrow",
  expectedMessage: context => `Expected mapping arrow '=>' in ${context}.`
};

const outputContractArrowRule: RsglArrowRule = {
  expectedText: "->",
  expectedDiagnosticCode: "rsgl.expectedOutputContractArrow",
  expectedMessage: context => `Expected output-contract arrow '->' in ${context}.`
};

/** Returns the single canonical arrow rule for a grammar role. */
export function rsglArrowRule(role: RsglArrowRole): RsglArrowRule {
  return role === "mapping" ? mappingArrowRule : outputContractArrowRule;
}

/** True for either arrow token when an editor feature needs a token boundary. */
export function isRsglArrowText(text: string): text is "=>" | "->" {
  return text === "=>" || text === "->";
}
