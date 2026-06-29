export function isModelPreviewFileName(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]models[\\/].+\.json$/i.test(fileName);
}
