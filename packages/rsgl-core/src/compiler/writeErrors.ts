export const rsglWriteErrorCodes = {
  copySourceReadFailed: "rsgl.copySourceReadFailed",
  outputFileReadFailed: "rsgl.outputFileReadFailed",
  unsafeOutputPath: "rsgl.unsafeOutputPath"
} as const;

export type RsglWriteErrorCode = typeof rsglWriteErrorCodes[keyof typeof rsglWriteErrorCodes];

export class RsglCopySourceReadError extends Error {
  public readonly code = rsglWriteErrorCodes.copySourceReadFailed;

  constructor(public readonly copyFrom: string, options?: ErrorOptions) {
    super(`Unable to read RSGL copy source '${copyFrom}'.`, options);
    this.name = "RsglCopySourceReadError";
  }
}

export class RsglOutputFileReadError extends Error {
  public readonly code = rsglWriteErrorCodes.outputFileReadFailed;

  constructor(public readonly fileName: string, options?: ErrorOptions) {
    super(`Unable to read RSGL output file '${fileName}'.`, options);
    this.name = "RsglOutputFileReadError";
  }
}

export class RsglUnsafeOutputPathError extends Error {
  public readonly code = rsglWriteErrorCodes.unsafeOutputPath;

  constructor(public readonly outputPath: string) {
    super(`Unsafe RSGL output path '${outputPath}'.`);
    this.name = "RsglUnsafeOutputPathError";
  }
}
