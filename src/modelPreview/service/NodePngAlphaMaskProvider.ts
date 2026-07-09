import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { throwIfCancellationRequested, type ModelPreviewCancellationToken } from "../cancellation";
import type { PngAlphaMask } from "../bake/AlphaMask";
import { readPngAlphaMask } from "./PngAlphaDecoder";

const inflate = promisify(zlib.inflate);
const maxPngBytes = 16 * 1024 * 1024;
const maxInflatedBytes = 32 * 1024 * 1024;

export async function readNodePngAlphaMask(bytes: Uint8Array, cancellationToken?: ModelPreviewCancellationToken): Promise<PngAlphaMask | null> {
  throwIfCancellationRequested(cancellationToken);
  const alphaMask = await readPngAlphaMask(
    bytes,
    async idat => {
      throwIfCancellationRequested(cancellationToken);
      const inflated = await inflate(Buffer.from(idat.buffer, idat.byteOffset, idat.byteLength));
      throwIfCancellationRequested(cancellationToken);
      return inflated;
    },
    {
      maxInputBytes: maxPngBytes,
      maxInflatedBytes
    }
  );
  throwIfCancellationRequested(cancellationToken);
  return alphaMask;
}
