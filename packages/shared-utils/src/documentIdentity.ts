/** Structural language/file-extension check usable on both sides of a bundle boundary. */
export function isLanguageDocumentLike(
  document: { languageId?: string; fileName?: string; uriPath?: string },
  languageId: string,
  fileExtension: string
): boolean {
  if (document.languageId === languageId) {
    return true;
  }
  const normalizedExtension = fileExtension.toLowerCase();
  return [document.fileName, document.uriPath]
    .some(value => value !== undefined && value.toLowerCase().endsWith(normalizedExtension));
}
