export {
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "../../../../packages/rsgl-core/src/compiler";

export class RsglBuildWorkerExitError extends Error {
  public readonly code = "rsgl.buildWorkerExited";

  constructor(public readonly exitCode: number) {
    super("rsgl.buildWorkerExited");
    this.name = "RsglBuildWorkerExitError";
  }
}
