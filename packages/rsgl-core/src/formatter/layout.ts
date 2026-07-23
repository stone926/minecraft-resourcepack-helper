import type {
  RsglFormatDocument,
  RsglFormatItem,
  RsglFormatLine,
  RsglFormatTokenFragment
} from "./lines";
import {
  createRsglFormatLine,
  isRsglFormatLineBlank
} from "./lines";
import { maximumRsglFormattedDelimiterDepth } from "./limits";
import type { RsglFormatOptions, RsglFormattingStyleRules } from "./options";
import { renderRsglLineContent } from "./spacing";
import type {
  RsglBodyBracePair,
  RsglFormatterSyntaxFacts
} from "./syntaxFacts";

const delimiterPairs: Readonly<Record<string, string>> = {
  "(": ")",
  "[": "]",
  "{": "}"
};

export function applyRsglDocumentLayout(
  document: RsglFormatDocument,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions,
  rules: Readonly<RsglFormattingStyleRules>
): void {
  applyBraceStyle(document.lines, document.preferredEol, facts, options);
  normalizeEmptyBodies(
    document.lines,
    document.preferredEol,
    facts.bodyBracePairs,
    rules.compactEmptyBodies && options.braceStyle === "sameLine"
  );
  expandConfiguredCollections(document, facts, rules);
  wrapLongCollections(document, facts, options, rules);
  limitBlankLines(document.lines, rules.maxBlankLines);
}

function applyBraceStyle(
  lines: RsglFormatLine[],
  preferredEol: string,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions
): void {
  if (options.braceStyle === "sameLine") {
    joinBodyOpeners(lines, facts);
  } else {
    splitBodyBraces(lines, preferredEol, facts);
  }
}

function joinBodyOpeners(
  lines: RsglFormatLine[],
  facts: RsglFormatterSyntaxFacts
): void {
  const result: RsglFormatLine[] = [];
  for (const current of lines) {
    const openerIndex = current.items.findIndex(item =>
      isWholeToken(item) && facts.bodyOpenOffsets.has(item.token.offset)
    );
    let previousIndex = result.length - 1;
    while (
      previousIndex >= 0
      && isRsglFormatLineBlank(result[previousIndex])
      && !result[previousIndex].separatorProtected
    ) {
      previousIndex--;
    }
    const previous = result[previousIndex];
    if (
      openerIndex !== 0
      || current.preserveLeadingText
      || !previous
      || result.slice(previousIndex + 1).some(line => line.separatorProtected)
      || previous.separatorProtected
      || isRsglFormatLineBlank(previous)
      || previous.items.some(item => item.kind === "comment")
    ) {
      result.push(current);
      continue;
    }

    result.splice(previousIndex + 1);
    previous.items.push(...current.items);
    previous.separator = current.separator;
    previous.separatorProtected = current.separatorProtected;
    previous.originalTrailingWhitespace = current.originalTrailingWhitespace;
  }
  lines.splice(0, lines.length, ...result);
}

function splitBodyBraces(
  lines: RsglFormatLine[],
  preferredEol: string,
  facts: RsglFormatterSyntaxFacts
): void {
  const closeOffsets = new Set(
    facts.bodyBracePairs.flatMap(pair =>
      pair.closeOffset === undefined ? [] : [pair.closeOffset]
    )
  );
  const result: RsglFormatLine[] = [];
  for (const line of lines) {
    if (line.preserveLeadingText) {
      result.push(line);
      continue;
    }

    const splitIndexes = new Set<number>();
    for (let index = 0; index < line.items.length; index++) {
      const item = line.items[index];
      if (!isWholeToken(item)) {
        continue;
      }
      if (facts.bodyOpenOffsets.has(item.token.offset)) {
        splitIndexes.add(index);
        let nextContentIndex = index + 1;
        while (
          nextContentIndex < line.items.length
          && line.items[nextContentIndex].kind === "comment"
        ) {
          nextContentIndex++;
        }
        splitIndexes.add(nextContentIndex);
      } else if (closeOffsets.has(item.token.offset)) {
        splitIndexes.add(index);
      }
    }
    const boundaries = [...splitIndexes]
      .filter(index => index > 0 && index < line.items.length)
      .sort((left, right) => left - right);
    if (boundaries.length === 0) {
      result.push(line);
      continue;
    }

    let start = 0;
    for (const end of [...boundaries, line.items.length]) {
      if (end <= start) {
        continue;
      }
      const segment = cloneLine(line, line.items.slice(start, end));
      if (end < line.items.length) {
        segment.separator = preferredEol;
        segment.separatorProtected = false;
        segment.originalTrailingWhitespace = "";
      }
      segment.preserveLeadingText = start === 0 && line.preserveLeadingText;
      result.push(segment);
      start = end;
    }
  }
  lines.splice(0, lines.length, ...result);
}

function normalizeEmptyBodies(
  lines: RsglFormatLine[],
  preferredEol: string,
  pairs: readonly RsglBodyBracePair[],
  compact: boolean
): void {
  const emptyPairs = pairs.filter((pair): pair is RsglBodyBracePair & {
    closeOffset: number;
  } => pair.empty && pair.closeOffset !== undefined);
  if (emptyPairs.length === 0) {
    return;
  }
  const closeByOpen = new Map(emptyPairs.map(pair => [pair.openOffset, pair.closeOffset]));
  if (compact) {
    collapseEmptyBodies(lines, closeByOpen);
  } else {
    expandEmptyBodies(lines, preferredEol, closeByOpen);
  }
}

function collapseEmptyBodies(
  lines: RsglFormatLine[],
  closeByOpen: ReadonlyMap<number, number>
): void {
  const result: RsglFormatLine[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const lastItem = line.items[line.items.length - 1];
    const expectedClose = isWholeToken(lastItem)
      ? closeByOpen.get(lastItem.token.offset)
      : undefined;
    if (expectedClose === undefined) {
      result.push(line);
      index++;
      continue;
    }
    let closeLineIndex = index + 1;
    while (
      closeLineIndex < lines.length
      && isRsglFormatLineBlank(lines[closeLineIndex])
    ) {
      closeLineIndex++;
    }
    const closeLine = lines[closeLineIndex];
    const firstItem = closeLine?.items[0];
    if (
      !closeLine
      || !isWholeToken(firstItem)
      || firstItem.token.offset !== expectedClose
    ) {
      result.push(line);
      index++;
      continue;
    }
    line.items.push(...closeLine.items);
    line.separator = closeLine.separator;
    line.separatorProtected = closeLine.separatorProtected;
    line.originalTrailingWhitespace = closeLine.originalTrailingWhitespace;
    result.push(line);
    index = closeLineIndex + 1;
  }
  lines.splice(0, lines.length, ...result);
}

function expandEmptyBodies(
  lines: RsglFormatLine[],
  preferredEol: string,
  closeByOpen: ReadonlyMap<number, number>
): void {
  const result: RsglFormatLine[] = [];
  for (const line of lines) {
    const splitIndexes: number[] = [];
    for (let index = 1; index < line.items.length; index++) {
      const open = line.items[index - 1];
      const close = line.items[index];
      if (
        isWholeToken(open)
        && isWholeToken(close)
        && closeByOpen.get(open.token.offset) === close.token.offset
      ) {
        splitIndexes.push(index);
      }
    }
    if (splitIndexes.length === 0) {
      result.push(line);
      continue;
    }
    let start = 0;
    for (const splitIndex of splitIndexes) {
      const before = cloneLine(line, line.items.slice(start, splitIndex));
      before.separator = preferredEol;
      before.separatorProtected = false;
      before.originalTrailingWhitespace = "";
      before.preserveLeadingText = start === 0 && line.preserveLeadingText;
      result.push(before);
      start = splitIndex;
    }
    const after = cloneLine(line, line.items.slice(start));
    after.preserveLeadingText = false;
    result.push(after);
  }
  lines.splice(0, lines.length, ...result);
}

function expandConfiguredCollections(
  document: RsglFormatDocument,
  facts: RsglFormatterSyntaxFacts,
  rules: Readonly<RsglFormattingStyleRules>
): void {
  if (!rules.expandDelimitedValues) {
    return;
  }
  transformDelimitedLines(document, facts, rules, (_line, candidate) =>
    isWithinFormattedCollectionDepth(candidate, facts)
    && (
      candidate.topLevelCommaIndexes.length > 0
      || (
        candidate.opener.token.text === "{"
        && candidate.hasTopLevelColon
      )
    )
  );
}

function wrapLongCollections(
  document: RsglFormatDocument,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions,
  rules: Readonly<RsglFormattingStyleRules>
): void {
  const lineWidths = new WeakMap<RsglFormatLine, number>();
  transformDelimitedLines(document, facts, rules, (line, candidate) =>
    isWithinFormattedCollectionDepth(candidate, facts)
    && (
      (
        candidate.topLevelCommaIndexes.length > 0
        || candidate.opener.token.text === "["
        || candidate.opener.token.text === "{"
      )
      && cachedEstimatedRenderedLineWidth(
        line,
        facts,
        options,
        rules,
        lineWidths
      ) > options.lineWidth
    )
  );
}

function transformDelimitedLines(
  document: RsglFormatDocument,
  facts: RsglFormatterSyntaxFacts,
  rules: Readonly<RsglFormattingStyleRules>,
  shouldTransform: (line: RsglFormatLine, candidate: DelimitedCandidate) => boolean
): void {
  const result: RsglFormatLine[] = [];
  const pending = [...document.lines].reverse();
  while (pending.length > 0) {
    const line = pending.pop()!;
    const candidates = delimitedCandidates(line, facts);
    const selected = outermostCandidates(
      candidates.filter(value => shouldTransform(line, value))
    );
    if (selected.length === 0) {
      result.push(line);
      continue;
    }
    const replacement = splitDelimitedCandidates(
      line,
      selected,
      document.preferredEol
    );
    if (replacement.length <= 1) {
      result.push(line);
      continue;
    }
    for (let index = replacement.length - 1; index >= 0; index--) {
      pending.push(replacement[index]);
    }
  }
  document.lines.splice(0, document.lines.length, ...result);
}

function outermostCandidates(
  candidates: readonly DelimitedCandidate[]
): DelimitedCandidate[] {
  const result: DelimitedCandidate[] = [];
  for (const candidate of candidates) {
    const containing = result[result.length - 1];
    if (containing && candidate.closerIndex < containing.closerIndex) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}

function delimitedCandidates(
  line: RsglFormatLine,
  facts: RsglFormatterSyntaxFacts
): DelimitedCandidate[] {
  if (
    line.preserveLeadingText
  ) {
    return [];
  }
  const firstCommentIndex = line.items.findIndex(item => item.kind === "comment");
  const result: DelimitedCandidate[] = [];
  const stack: Array<{
    openerIndex: number;
    opener: RsglFormatTokenFragment;
    expectedClose: string;
    topLevelCommaIndexes: number[];
    hasTopLevelColon: boolean;
  }> = [];
  for (let itemIndex = 0; itemIndex < line.items.length; itemIndex++) {
    const item = line.items[itemIndex];
    if (!isWholeToken(item)) {
      continue;
    }
    const expectedClose = delimiterPairs[item.token.text];
    if (expectedClose) {
      stack.push({
        openerIndex: itemIndex,
        opener: item,
        expectedClose,
        topLevelCommaIndexes: [],
        hasTopLevelColon: false
      });
      continue;
    }
    const current = stack[stack.length - 1];
    if (!current) {
      continue;
    }
    if (item.token.text === ",") {
      current.topLevelCommaIndexes.push(itemIndex);
    } else if (item.token.text === ":") {
      current.hasTopLevelColon = true;
    } else if (item.token.text === current.expectedClose) {
      stack.pop();
      if (
        itemIndex > current.openerIndex + 1
        && facts.collectionOpenOffsets.has(current.opener.token.offset)
        && (firstCommentIndex < 0 || firstCommentIndex > itemIndex)
      ) {
        result.push({
          openerIndex: current.openerIndex,
          closerIndex: itemIndex,
          opener: current.opener,
          topLevelCommaIndexes: current.topLevelCommaIndexes,
          hasTopLevelColon: current.hasTopLevelColon
        });
      }
    }
  }
  return result.sort((left, right) => left.openerIndex - right.openerIndex);
}

function isWithinFormattedCollectionDepth(
  candidate: DelimitedCandidate,
  facts: RsglFormatterSyntaxFacts
): boolean {
  return (
    facts.delimiterDepthByTokenOffset.get(candidate.opener.token.offset) ?? 0
  ) <= maximumRsglFormattedDelimiterDepth;
}

function estimatedRenderedLineWidth(
  line: RsglFormatLine,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions,
  rules: Readonly<RsglFormattingStyleRules>
): number {
  const firstToken = line.items.find(isWholeToken);
  const indentationDepth = firstToken
    ? facts.delimiterDepthByTokenOffset.get(firstToken.token.offset) ?? 0
    : 0;
  return (
    indentationDepth * options.tabSize
    + renderRsglLineContent(line, facts, rules).length
  );
}

function cachedEstimatedRenderedLineWidth(
  line: RsglFormatLine,
  facts: RsglFormatterSyntaxFacts,
  options: RsglFormatOptions,
  rules: Readonly<RsglFormattingStyleRules>,
  cache: WeakMap<RsglFormatLine, number>
): number {
  const cached = cache.get(line);
  if (cached !== undefined) {
    return cached;
  }
  const width = estimatedRenderedLineWidth(line, facts, options, rules);
  cache.set(line, width);
  return width;
}

function splitDelimitedCandidates(
  line: RsglFormatLine,
  candidates: readonly DelimitedCandidate[],
  preferredEol: string
): RsglFormatLine[] {
  const splitIndexes = new Set<number>();
  for (const candidate of candidates) {
    splitIndexes.add(candidate.openerIndex + 1);
    splitIndexes.add(candidate.closerIndex);
    for (const commaIndex of candidate.topLevelCommaIndexes) {
      splitIndexes.add(commaIndex + 1);
    }
  }

  const boundaries = [...splitIndexes]
    .filter(index => index > 0 && index < line.items.length)
    .sort((left, right) => left - right);
  const segments: RsglFormatLine[] = [];
  let start = 0;
  for (const end of [...boundaries, line.items.length]) {
    if (end <= start) {
      continue;
    }
    const segment = cloneLine(line, line.items.slice(start, end));
    if (end < line.items.length) {
      segment.separator = preferredEol;
      segment.separatorProtected = false;
      segment.originalTrailingWhitespace = "";
    }
    segment.preserveLeadingText = start === 0 && line.preserveLeadingText;
    segments.push(segment);
    start = end;
  }
  return segments;
}

function limitBlankLines(lines: RsglFormatLine[], maximum: number): void {
  let consecutive = 0;
  const result: RsglFormatLine[] = [];
  for (const line of lines) {
    if (!isRsglFormatLineBlank(line) || line.separatorProtected) {
      consecutive = 0;
      result.push(line);
      continue;
    }
    if (consecutive < maximum) {
      consecutive++;
      result.push(line);
    }
  }
  if (result.length === 0) {
    result.push(createRsglFormatLine());
  }
  lines.splice(0, lines.length, ...result);
}

interface DelimitedCandidate {
  openerIndex: number;
  closerIndex: number;
  opener: RsglFormatTokenFragment;
  topLevelCommaIndexes: number[];
  hasTopLevelColon: boolean;
}

function cloneLine(
  source: RsglFormatLine,
  items: RsglFormatItem[]
): RsglFormatLine {
  return {
    ...source,
    items
  };
}

function isWholeToken(
  item: RsglFormatItem | undefined
): item is RsglFormatTokenFragment {
  return item?.kind === "token" && item.position === "whole";
}
