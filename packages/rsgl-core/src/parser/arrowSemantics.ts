export type RsglArrowRole = "mapping" | "outputContract";
export type RsglArrowExpectation = "expected" | "recoveredUnexpected" | "missing";

export interface RsglArrowRule {
  readonly expectedText: "=>" | "->";
  readonly unexpectedText: "=>" | "->";
  readonly expectedDiagnosticCode: string;
  readonly unexpectedDiagnosticCode: string;
  readonly expectedMessage: (context: string) => string;
  readonly unexpectedMessage: (context: string) => string;
}

export interface RsglArrowQuickFix {
  readonly title: string;
  readonly original: "=>" | "->";
  readonly replacement: "=>" | "->";
}

const mappingArrowRule: RsglArrowRule = {
  expectedText: "=>",
  unexpectedText: "->",
  expectedDiagnosticCode: "rsgl.expectedMappingArrow",
  unexpectedDiagnosticCode: "rsgl.unexpectedOutputContractArrow",
  expectedMessage: context => `Expected mapping arrow '=>' in ${context}.`,
  unexpectedMessage: context =>
    `Unexpected output-contract arrow '->' in ${context}; mappings use '=>'.`
};

const outputContractArrowRule: RsglArrowRule = {
  expectedText: "->",
  unexpectedText: "=>",
  expectedDiagnosticCode: "rsgl.expectedOutputContractArrow",
  unexpectedDiagnosticCode: "rsgl.unexpectedMappingArrow",
  expectedMessage: context => `Expected output-contract arrow '->' in ${context}.`,
  unexpectedMessage: context =>
    `Unexpected mapping arrow '=>' in ${context}; output contracts use '->'.`
};

/** Returns the single canonical arrow rule for a grammar role. */
export function rsglArrowRule(role: RsglArrowRole): RsglArrowRule {
  return role === "mapping" ? mappingArrowRule : outputContractArrowRule;
}

/** True for either arrow token, including the wrong token used for parser recovery. */
export function isRsglArrowText(text: string): text is "=>" | "->" {
  return text === "=>" || text === "->";
}

/** Maps a wrong-arrow parser diagnostic to its transport-neutral replacement. */
export function rsglArrowQuickFixForDiagnosticCode(
  code: string | number | undefined
): RsglArrowQuickFix | undefined {
  if (code === mappingArrowRule.unexpectedDiagnosticCode) {
    return {
      title: "Replace '->' with mapping arrow '=>'",
      original: mappingArrowRule.unexpectedText,
      replacement: mappingArrowRule.expectedText
    };
  }
  if (code === outputContractArrowRule.unexpectedDiagnosticCode) {
    return {
      title: "Replace '=>' with output-contract arrow '->'",
      original: outputContractArrowRule.unexpectedText,
      replacement: outputContractArrowRule.expectedText
    };
  }
  return undefined;
}
