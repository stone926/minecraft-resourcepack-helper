import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as path from "node:path";

interface InstrumentedCall {
  hook: string;
  args: unknown[];
}

interface InstrumentationWarning {
  hook: string;
  message: string;
}

interface TargetVscodeApiInstrumentation {
  readonly active: boolean;
  observeModuleLoad(request: string, parentFileName: string | undefined, api: object): boolean;
  stop(): void;
}

interface TargetVscodeApiModule {
  createTargetVscodeApiInstrumentation(options: {
    extensionRoot: string;
    platform?: string;
    onCall?(call: InstrumentedCall): void;
    onHookInstalled?(hook: string): void;
    onWarning?(warning: InstrumentationWarning): void;
  }): TargetVscodeApiInstrumentation;
  isPathWithinRoot(rootPath: string, fileName: string, platform?: string): boolean;
}

type ApiMethod = (this: unknown, ...args: unknown[]) => unknown;

interface FileSystemApi {
  readDirectory: ApiMethod;
}

interface WorkspaceApi {
  findFiles: ApiMethod;
  readonly fs: FileSystemApi;
  createFileSystemWatcher: ApiMethod;
}

interface ApiFixture {
  api: { workspace: WorkspaceApi };
  workspace: WorkspaceApi;
  fileSystem: FileSystemApi;
  originals: {
    findFiles: ApiMethod;
    readDirectory: ApiMethod;
    createFileSystemWatcher: ApiMethod;
  };
  invocations: string[];
  symbol: symbol;
}

const moduleRequire = createRequire(__filename);
const instrumentationModule = moduleRequire(path.join(
  process.cwd(),
  "scripts",
  "activation-probe",
  "target-vscode-api.cjs"
)) as TargetVscodeApiModule;

describe("target-scoped VS Code API instrumentation", () => {
  it("patches only target modules while preserving the workspace.fs API surface", () => {
    const target = createApiFixture();
    const testExtension = createApiFixture();
    const calls: InstrumentedCall[] = [];
    const hooks: string[] = [];
    const warnings: InstrumentationWarning[] = [];
    const originalFsDescriptor = Object.getOwnPropertyDescriptor(target.workspace, "fs");
    const originalFsKeys = Reflect.ownKeys(target.fileSystem);
    const instrumentation = instrumentationModule.createTargetVscodeApiInstrumentation({
      extensionRoot: "C:\\Users\\Stone\\extensions\\minecraft-resourcepack-helper",
      platform: "win32",
      onCall: call => calls.push(call),
      onHookInstalled: hook => hooks.push(hook),
      onWarning: warning => warnings.push(warning)
    });

    assert.strictEqual(instrumentation.observeModuleLoad(
      "vscode",
      "c:\\users\\stone\\EXTENSIONS\\minecraft-resourcepack-helper\\bundle\\extension.js",
      target.api
    ), true);
    assert.strictEqual(instrumentation.observeModuleLoad(
      "vscode",
      "C:\\Users\\Stone\\extensions\\minecraft-resourcepack-helper-old\\bundle\\extension.js",
      testExtension.api
    ), false, "a sibling-prefix path must not be treated as the target extension");
    assert.strictEqual(instrumentation.observeModuleLoad(
      "vscode",
      "C:\\Users\\Stone\\extensions\\minecraft-resourcepack-helper\\bundle\\second.js",
      target.api
    ), false, "the same extension-scoped API object must not be wrapped twice");

    const replacementFileSystem = target.workspace.fs;
    const replacementFsDescriptor = Object.getOwnPropertyDescriptor(target.workspace, "fs");
    assert.notStrictEqual(replacementFileSystem, target.fileSystem);
    assert.strictEqual(Object.getPrototypeOf(replacementFileSystem), Object.getPrototypeOf(target.fileSystem));
    assert.strictEqual(Object.isExtensible(replacementFileSystem), Object.isExtensible(target.fileSystem));
    assert.deepStrictEqual(Reflect.ownKeys(replacementFileSystem), originalFsKeys);
    assert.strictEqual(replacementFsDescriptor?.configurable, originalFsDescriptor?.configurable);
    assert.strictEqual(replacementFsDescriptor?.enumerable, originalFsDescriptor?.enumerable);
    assert.strictEqual(typeof replacementFsDescriptor?.get, "function");
    assert.strictEqual(replacementFsDescriptor?.set, originalFsDescriptor?.set);
    for (const key of originalFsKeys) {
      const before = Object.getOwnPropertyDescriptor(target.fileSystem, key);
      const after = Object.getOwnPropertyDescriptor(replacementFileSystem, key);
      if (key === "readDirectory") {
        assert.strictEqual(after?.configurable, before?.configurable);
        assert.strictEqual(after?.enumerable, before?.enumerable);
        assert.strictEqual(after?.writable, before?.writable);
        assert.notStrictEqual(after?.value, before?.value);
      } else {
        assert.deepStrictEqual(after, before);
      }
    }

    const capturedFindFiles = target.workspace.findFiles;
    assert.strictEqual(target.workspace.findFiles("**/*.json"), "find-result");
    assert.strictEqual(target.workspace.fs.readDirectory("file:///pack"), "read-result");
    assert.strictEqual(target.workspace.createFileSystemWatcher("**/pack.mcmeta"), "watch-result");
    assert.deepStrictEqual(calls.map(call => call.hook), [
      "vscode.workspace.findFiles",
      "vscode.workspace.fs.readDirectory",
      "vscode.workspace.createFileSystemWatcher"
    ]);
    assert.deepStrictEqual(hooks, [
      "vscode.workspace.findFiles",
      "vscode.workspace.fs.readDirectory",
      "vscode.workspace.createFileSystemWatcher"
    ]);
    assert.deepStrictEqual(warnings, []);
    assert.strictEqual(testExtension.workspace.findFiles, testExtension.originals.findFiles);
    assert.strictEqual(testExtension.workspace.fs, testExtension.fileSystem);

    instrumentation.stop();
    assert.strictEqual(instrumentation.active, false);
    assert.strictEqual(target.workspace.findFiles, target.originals.findFiles);
    assert.strictEqual(target.workspace.fs, target.fileSystem);
    assert.strictEqual(target.workspace.createFileSystemWatcher, target.originals.createFileSystemWatcher);
    assert.deepStrictEqual(Object.getOwnPropertyDescriptor(target.workspace, "fs"), originalFsDescriptor);

    const recordedBeforeCapturedCall = calls.length;
    assert.strictEqual(capturedFindFiles("after-stop"), "find-result");
    assert.strictEqual(calls.length, recordedBeforeCapturedCall,
      "a captured wrapper must stop recording as soon as instrumentation stops");
    assert.strictEqual(instrumentation.observeModuleLoad(
      "vscode",
      "C:\\Users\\Stone\\extensions\\minecraft-resourcepack-helper\\bundle\\late.js",
      target.api
    ), false);
  });

  it("continues restoring after one independent restorer fails", () => {
    const target = createApiFixture();
    const calls: InstrumentedCall[] = [];
    const warnings: InstrumentationWarning[] = [];
    const instrumentation = instrumentationModule.createTargetVscodeApiInstrumentation({
      extensionRoot: "C:\\extension",
      platform: "win32",
      onCall: call => calls.push(call),
      onWarning: warning => warnings.push(warning)
    });
    instrumentation.observeModuleLoad(
      "vscode",
      "C:\\extension\\bundle\\extension.js",
      target.api
    );
    const capturedWatcher = target.workspace.createFileSystemWatcher;
    const watcherDescriptor = Object.getOwnPropertyDescriptor(
      target.workspace,
      "createFileSystemWatcher"
    );
    Object.defineProperty(target.workspace, "createFileSystemWatcher", {
      ...watcherDescriptor,
      configurable: false,
      value: capturedWatcher,
      writable: false
    });

    instrumentation.stop();

    assert.strictEqual(target.workspace.findFiles, target.originals.findFiles);
    assert.strictEqual(target.workspace.fs, target.fileSystem);
    assert.strictEqual(target.workspace.createFileSystemWatcher, capturedWatcher);
    assert.ok(warnings.some(warning =>
      warning.hook === "vscode.workspace.createFileSystemWatcher"
      && /redefine property|restore/i.test(warning.message)
    ));
    const callCount = calls.length;
    assert.strictEqual(capturedWatcher("after-failed-restore"), "watch-result");
    assert.strictEqual(calls.length, callCount,
      "even an unrestored captured wrapper must be inactive after stop");
    instrumentation.stop();
  });

  it("uses platform-aware path boundaries instead of string prefixes", () => {
    assert.strictEqual(instrumentationModule.isPathWithinRoot(
      "C:\\Users\\Stone\\Extension",
      "c:\\users\\stone\\extension\\bundle\\extension.js",
      "win32"
    ), true);
    assert.strictEqual(instrumentationModule.isPathWithinRoot(
      "C:\\Users\\Stone\\Extension",
      "C:\\Users\\Stone\\Extension-sibling\\bundle\\extension.js",
      "win32"
    ), false);
    assert.strictEqual(instrumentationModule.isPathWithinRoot(
      "/opt/Extension",
      "/opt/extension/bundle/extension.js",
      "linux"
    ), false, "POSIX paths remain case-sensitive");
  });
});

function createApiFixture(): ApiFixture {
  const invocations: string[] = [];
  const symbol = Symbol("descriptor-sentinel");
  const findFiles: ApiMethod = function findFiles() {
    invocations.push("findFiles");
    return "find-result";
  };
  const readDirectory: ApiMethod = function readDirectory() {
    invocations.push("readDirectory");
    return "read-result";
  };
  const createFileSystemWatcher: ApiMethod = function createFileSystemWatcher() {
    invocations.push("createFileSystemWatcher");
    return "watch-result";
  };
  const fileSystem = {} as FileSystemApi;
  Object.defineProperties(fileSystem, {
    readDirectory: {
      configurable: false,
      enumerable: false,
      value: readDirectory,
      writable: false
    },
    hiddenState: {
      configurable: false,
      enumerable: false,
      value: 17,
      writable: false
    },
    [symbol]: {
      configurable: false,
      enumerable: true,
      value: "symbol-value",
      writable: false
    }
  });
  Object.preventExtensions(fileSystem);

  const workspace = {} as WorkspaceApi;
  Object.defineProperties(workspace, {
    findFiles: {
      configurable: true,
      enumerable: true,
      value: findFiles,
      writable: true
    },
    fs: {
      configurable: true,
      enumerable: false,
      get() {
        return fileSystem;
      }
    },
    createFileSystemWatcher: {
      configurable: true,
      enumerable: true,
      value: createFileSystemWatcher,
      writable: true
    }
  });

  return {
    api: { workspace },
    workspace,
    fileSystem,
    originals: { findFiles, readDirectory, createFileSystemWatcher },
    invocations,
    symbol
  };
}
