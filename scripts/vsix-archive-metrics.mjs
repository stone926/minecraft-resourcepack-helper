import { sha256File } from "./lib/hash.mjs";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { requiredString } from "./lib/parse.mjs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// yauzl is shipped in the locked VSCE toolchain used to create the archive.
const yauzl = require("yauzl");

export const defaultVsixArchiveLimits = Object.freeze({
  maximumArchiveBytes: 1024 * 1024 * 1024,
  maximumEntries: 20_000,
  maximumInstalledBytes: 1024 * 1024 * 1024,
  maximumCapturedEntryBytes: 32 * 1024 * 1024,
  maximumCapturedTotalBytes: 64 * 1024 * 1024
});

/** Opens a lazily streamed VSIX archive through the one repository ZIP layer. */
export function openVsixArchive(fileName, errorLabel = "Unable to open VSIX archive") {
  return new Promise((resolve, reject) => {
    yauzl.open(fileName, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new Error(`${errorLabel}: ${fileName}`, { cause: error }));
        return;
      }
      resolve(zipFile);
    });
  });
}

export function nextVsixArchiveEntry(
  zipFile,
  errorMessage = "Invalid VSIX archive while reading its entries."
) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zipFile.removeListener("entry", onEntry);
      zipFile.removeListener("end", onEnd);
      zipFile.removeListener("error", onError);
    };
    const onEntry = entry => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = error => {
      cleanup();
      reject(new Error(errorMessage, { cause: error }));
    };
    zipFile.once("entry", onEntry);
    zipFile.once("end", onEnd);
    zipFile.once("error", onError);
    zipFile.readEntry();
  });
}

export function openVsixArchiveEntryStream(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new Error(`Unable to read VSIX entry: ${entry.fileName}`, { cause: error }));
        return;
      }
      resolve(stream);
    });
  });
}

export async function readVsixArchiveMetrics(fileName, options = {}) {
  const absoluteFileName = path.resolve(requiredString(fileName, "fileName"));
  const limits = normalizeLimits(options.limits);
  const captureEntry = options.captureEntry ?? (() => false);
  if (typeof captureEntry !== "function") {
    throw new Error("captureEntry must be a function when provided.");
  }

  const archiveBytes = statSync(absoluteFileName).size;
  if (archiveBytes > limits.maximumArchiveBytes) {
    throw new Error(`VSIX archive exceeds the ${limits.maximumArchiveBytes} byte safety limit.`);
  }
  const sha256 = await hashFile(absoluteFileName);
  const result = await inspectArchive(absoluteFileName, captureEntry, limits);
  const compressedEntriesBytes = sum(result.entries, "compressedBytes");
  if (compressedEntriesBytes > archiveBytes) {
    throw new Error("VSIX central-directory compressed sizes exceed the archive file size.");
  }
  return Object.freeze({
    archiveBytes,
    sha256,
    fileCount: result.entries.filter(entry => !entry.directory).length,
    compressedEntriesBytes,
    installedBytes: sum(result.entries, "installedBytes"),
    entries: Object.freeze(result.entries),
    capturedEntries: Object.freeze(result.capturedEntries)
  });
}

export function findVsixArchiveEntry(metrics, archivePath) {
  const normalized = normalizeVsixArchivePath(archivePath);
  return metrics.entries.find(entry => entry.path === normalized);
}

function inspectArchive(fileName, captureEntry, limits) {
  return new Promise((resolve, reject) => {
    yauzl.open(fileName, {
      autoClose: false,
      lazyEntries: true,
      decodeStrings: true,
      strictFileNames: true,
      validateEntrySizes: true
    }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(new Error(`Unable to open VSIX archive metadata: ${fileName}`, { cause: openError }));
        return;
      }

      const entries = [];
      const capturedEntries = {};
      const foldedPaths = new Set();
      let installedBytes = 0;
      let capturedBytes = 0;
      let settled = false;

      const fail = error => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        reject(error);
      };
      zipFile.on("error", error => fail(new Error(`Invalid VSIX archive: ${fileName}`, { cause: error })));
      zipFile.on("end", () => {
        if (settled) {
          return;
        }
        settled = true;
        zipFile.close();
        resolve({ entries, capturedEntries });
      });
      zipFile.on("entry", entry => {
        try {
          if (entries.length >= limits.maximumEntries) {
            throw new Error(`VSIX archive exceeds the ${limits.maximumEntries} entry safety limit.`);
          }
          const entryPath = normalizeVsixArchivePath(entry.fileName);
          const foldedPath = entryPath.toLowerCase();
          if (foldedPaths.has(foldedPath)) {
            throw new Error(`VSIX archive contains a duplicate or case-colliding path: ${entryPath}`);
          }
          foldedPaths.add(foldedPath);
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new Error(`Encrypted VSIX entries are not supported: ${entryPath}`);
          }
          const madeByPlatform = entry.versionMadeBy >>> 8;
          const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (madeByPlatform === 3 && unixFileType === 0o120000) {
            throw new Error(`Symbolic-link VSIX entries are not supported: ${entryPath}`);
          }
          if (!Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0
            || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
            throw new Error(`VSIX entry has an invalid size: ${entryPath}`);
          }
          const directory = entryPath.endsWith("/");
          if (!directory) {
            installedBytes += entry.uncompressedSize;
            if (installedBytes > limits.maximumInstalledBytes) {
              throw new Error(
                `VSIX archive exceeds the ${limits.maximumInstalledBytes} installed-byte safety limit.`
              );
            }
          }
          const metadata = Object.freeze({
            path: entryPath,
            directory,
            compressedBytes: entry.compressedSize,
            installedBytes: entry.uncompressedSize,
            compressionMethod: entry.compressionMethod,
            crc32: entry.crc32 >>> 0
          });
          entries.push(metadata);

          if (directory || !captureEntry(entryPath, metadata)) {
            zipFile.readEntry();
            return;
          }
          if (entry.uncompressedSize > limits.maximumCapturedEntryBytes) {
            throw new Error(
              `Captured VSIX entry exceeds the ${limits.maximumCapturedEntryBytes} byte safety limit: ${entryPath}`
            );
          }
          if (capturedBytes + entry.uncompressedSize > limits.maximumCapturedTotalBytes) {
            throw new Error(
              `Captured VSIX entries exceed the ${limits.maximumCapturedTotalBytes} byte safety limit.`
            );
          }
          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(new Error(`Unable to read VSIX entry: ${entryPath}`, { cause: streamError }));
              return;
            }
            const chunks = [];
            let actualBytes = 0;
            stream.on("data", chunk => {
              actualBytes += chunk.length;
              if (actualBytes > limits.maximumCapturedEntryBytes) {
                stream.destroy(new Error(`Captured VSIX entry expanded beyond its safety limit: ${entryPath}`));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", error => fail(new Error(`Unable to read VSIX entry: ${entryPath}`, { cause: error })));
            stream.on("end", () => {
              if (settled) {
                return;
              }
              if (actualBytes !== entry.uncompressedSize) {
                fail(new Error(
                  `VSIX entry size mismatch for ${entryPath}: ${actualBytes} != ${entry.uncompressedSize}.`
                ));
                return;
              }
              if (capturedBytes + actualBytes > limits.maximumCapturedTotalBytes) {
                fail(new Error(
                  `Captured VSIX entries exceed the ${limits.maximumCapturedTotalBytes} byte safety limit.`
                ));
                return;
              }
              capturedBytes += actualBytes;
              capturedEntries[entryPath] = Buffer.concat(chunks, actualBytes);
              zipFile.readEntry();
            });
          });
        } catch (error) {
          fail(error);
        }
      });
      zipFile.readEntry();
    });
  });
}

export function normalizeVsixArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("VSIX entry paths must be non-empty strings without NUL bytes.");
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Unsafe VSIX entry path: ${value}`);
  }
  const directory = value.endsWith("/");
  const rawPath = directory ? value.slice(0, -1) : value;
  const normalized = path.posix.normalize(rawPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`VSIX entry escapes the archive root: ${value}`);
  }
  if (normalized.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`VSIX entry path is not canonical: ${value}`);
  }
  if (normalized !== rawPath) {
    throw new Error(`VSIX entry path is not canonical: ${value}`);
  }
  return directory ? `${normalized}/` : normalized;
}

function normalizeLimits(overrides = {}) {
  const result = { ...defaultVsixArchiveLimits, ...overrides };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  return result;
}

async function hashFile(fileName) {
  return (await sha256File(fileName)).sha256;
}

function sum(entries, property) {
  return entries.reduce((total, entry) => total + (entry.directory ? 0 : entry[property]), 0);
}
