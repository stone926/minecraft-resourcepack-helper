import * as assert from "node:assert";
import type { ResourceReferenceDocument } from "../../../utils/resourceReferences";

export function createJsonDocument(fileName: string, value: unknown): ResourceReferenceDocument {
  return {
    languageId: "json",
    fileName,
    getText: () => JSON.stringify(value, null, 2)
  };
}

export function createTextDocument(fileName: string, text: string, languageId = "plaintext"): ResourceReferenceDocument {
  return {
    languageId,
    fileName,
    getText: () => text
  };
}

export function createMarkedTextDocument(
  fileName: string,
  markedText: string,
  languageId: string,
  version: number
): {
    document: ResourceReferenceDocument;
    position: { line: number; character: number };
    getTextCallCount: () => number;
  } {
  const markerOffset = markedText.indexOf("|");
  assert.notStrictEqual(markerOffset, -1);

  const text = `${markedText.slice(0, markerOffset)}${markedText.slice(markerOffset + 1)}`;
  const textBeforeMarker = markedText.slice(0, markerOffset);
  const linesBeforeMarker = textBeforeMarker.split("\n");
  let getTextCallCount = 0;

  return {
    document: {
      languageId,
      fileName,
      version,
      getText: () => {
        getTextCallCount++;
        return text;
      }
    },
    position: {
      line: linesBeforeMarker.length - 1,
      character: linesBeforeMarker[linesBeforeMarker.length - 1].length
    },
    getTextCallCount: () => getTextCallCount
  };
}
