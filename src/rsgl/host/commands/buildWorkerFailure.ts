import {
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "../../../../packages/rsgl-core/src/compiler";
import type { RsglWorkerFailure } from "./buildWorkerProtocol";

export function serializeRsglWorkerFailure(error: unknown): RsglWorkerFailure {
  if (error instanceof RsglCopySourceReadError) {
    return failure(error.code, [error.copyFrom], error);
  }
  if (error instanceof RsglOutputFileReadError) {
    return failure(error.code, [error.fileName], error);
  }
  if (error instanceof RsglUnsafeOutputPathError) {
    return failure(error.code, [error.outputPath], error);
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    type: "error",
    code: "rsgl.unknown",
    args: [message],
    message,
    stack: error instanceof Error ? error.stack : undefined
  };
}

export function deserializeRsglWorkerFailure(failure: RsglWorkerFailure): Error {
  const firstArg = typeof failure.args[0] === "string" ? failure.args[0] : undefined;
  let error: Error;
  switch (failure.code) {
    case "rsgl.copySourceReadFailed":
      error = firstArg ? new RsglCopySourceReadError(firstArg) : new Error(failure.message);
      break;
    case "rsgl.outputFileReadFailed":
      error = firstArg ? new RsglOutputFileReadError(firstArg) : new Error(failure.message);
      break;
    case "rsgl.unsafeOutputPath":
      error = firstArg ? new RsglUnsafeOutputPathError(firstArg) : new Error(failure.message);
      break;
    case "rsgl.unknown":
      error = new Error(firstArg ?? failure.message);
      break;
  }

  if (failure.stack) {
    error.stack = failure.stack;
  }
  return error;
}

function failure(
  code: Exclude<RsglWorkerFailure["code"], "rsgl.unknown">,
  args: RsglWorkerFailure["args"],
  error: Error
): RsglWorkerFailure {
  return {
    type: "error",
    code,
    args,
    message: error.message,
    stack: error.stack
  };
}
