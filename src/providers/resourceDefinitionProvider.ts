import { Location, Position, TextDocument } from "vscode";
import { generateRedirectPath } from "../utils/pathGenerator";
import { findResourceReferenceAtPosition } from "../utils/resourceReferences";

export default (document: TextDocument, position: Position) => {
  const reference = findResourceReferenceAtPosition(document, position);
  if (!reference || reference.value.startsWith("#")) {
    return null;
  }

  const path = generateRedirectPath(reference.value, document, reference.target, reference.source, reference.extension);
  return path ? new Location(path, new Position(0, 0)) : null;
};
