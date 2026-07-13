import type { TextEdit } from "./types";

/** Applies protocol-independent edits and rejects malformed or overlapping input. */
export function applyTextEdits(sourceText: string, edits: readonly TextEdit[]): string {
  const ordered = [...edits].sort(compareEdits);
  validateTextEdits(sourceText, ordered);

  let result = sourceText;
  for (let index = ordered.length - 1; index >= 0; index--) {
    const edit = ordered[index];
    result = result.slice(0, edit.range.start) + edit.newText + result.slice(edit.range.end);
  }
  return result;
}

export function sortTextEdits(edits: readonly TextEdit[]): TextEdit[] {
  return [...edits].sort(compareEdits);
}

function validateTextEdits(sourceText: string, edits: readonly TextEdit[]): void {
  let previousEnd = 0;
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    if (
      !Number.isInteger(edit.range.start)
      || !Number.isInteger(edit.range.end)
      || edit.range.start < 0
      || edit.range.end < edit.range.start
      || edit.range.end > sourceText.length
    ) {
      throw new RangeError(`Invalid migration edit range ${edit.range.start}..${edit.range.end}.`);
    }
    if (index > 0 && edit.range.start < previousEnd) {
      throw new Error("Migration edits must not overlap.");
    }
    previousEnd = Math.max(previousEnd, edit.range.end);
  }
}

function compareEdits(left: TextEdit, right: TextEdit): number {
  return left.range.start - right.range.start || left.range.end - right.range.end;
}
