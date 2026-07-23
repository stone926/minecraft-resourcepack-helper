const closerForOpening: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}"
};
const closingDelimiters = new Set(Object.values(closerForOpening));

export interface RsglDelimiterStack {
  expectedClosers: string[];
  closerCounts: Map<string, number>;
}

export function createRsglDelimiterStack(): RsglDelimiterStack {
  return {
    expectedClosers: [],
    closerCounts: new Map()
  };
}

export function pushRsglOpeningDelimiter(
  state: RsglDelimiterStack,
  text: string
): boolean {
  const closer = closerForOpening[text];
  if (!closer) {
    return false;
  }
  state.expectedClosers.push(closer);
  state.closerCounts.set(closer, (state.closerCounts.get(closer) ?? 0) + 1);
  return true;
}

export function consumeRsglClosingDelimiter(
  state: RsglDelimiterStack,
  text: string
): boolean {
  if (!closingDelimiters.has(text)) {
    return false;
  }
  if ((state.closerCounts.get(text) ?? 0) === 0) {
    return true;
  }

  const matchingIndex = state.expectedClosers[state.expectedClosers.length - 1] === text
    ? state.expectedClosers.length - 1
    : state.expectedClosers.lastIndexOf(text);
  const removed = state.expectedClosers.splice(matchingIndex);
  for (const closer of removed) {
    const remaining = (state.closerCounts.get(closer) ?? 1) - 1;
    if (remaining === 0) {
      state.closerCounts.delete(closer);
    } else {
      state.closerCounts.set(closer, remaining);
    }
  }
  return true;
}

export function rsglLeadingDelimiterDepth(
  state: RsglDelimiterStack,
  leadingTokenTexts: readonly string[]
): number {
  let depth = state.expectedClosers.length;
  for (const text of leadingTokenTexts) {
    if (!closingDelimiters.has(text)) {
      break;
    }
    if ((state.closerCounts.get(text) ?? 0) === 0) {
      break;
    }
    const matchingIndex = state.expectedClosers.lastIndexOf(text, depth - 1);
    if (matchingIndex < 0) {
      break;
    }
    depth = matchingIndex;
  }
  return depth;
}
