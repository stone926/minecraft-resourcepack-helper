import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** Streams a file through SHA-256; resolves `{ bytes, sha256 }`. */
export function sha256File(fileName) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = createReadStream(fileName);
    stream.on("data", chunk => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ bytes, sha256: hash.digest("hex") }));
  });
}
