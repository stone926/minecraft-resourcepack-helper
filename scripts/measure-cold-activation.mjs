#!/usr/bin/env node

import Module, { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const [bundleArgument] = process.argv.slice(2);
if (!bundleArgument) {
  throw new Error("Usage: measure-cold-activation.mjs <extension-bundle.js>");
}

const bundlePath = path.resolve(bundleArgument);
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  return request === "vscode"
    ? vscode
    : originalLoad.call(this, request, parent, isMain);
};

const context = createExtensionContext(path.dirname(bundlePath), vscode);
const startedAt = performance.now();
try {
  const extension = createRequire(import.meta.url)(bundlePath);
  extension.activate(context);
  const milliseconds = performance.now() - startedAt;
  process.stdout.write(JSON.stringify({ milliseconds }));
} finally {
  for (const disposable of context.subscriptions.reverse()) {
    disposable?.dispose?.();
  }
  Module._load = originalLoad;
}

function createExtensionContext(extensionPath, vscode) {
  return {
    subscriptions: [],
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
    asAbsolutePath: relativePath => path.join(extensionPath, relativePath),
    globalState: createMemento(),
    workspaceState: createMemento(),
    secrets: createCallableStub(),
    extensionMode: 3
  };
}

function createMemento() {
  const values = new Map();
  return {
    get: (key, defaultValue) => values.has(key) ? values.get(key) : defaultValue,
    update: async (key, value) => {
      values.set(key, value);
    },
    keys: () => [...values.keys()]
  };
}

function createVscodeStub() {
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  const watcher = () => ({
    onDidCreate: event,
    onDidChange: event,
    onDidDelete: event,
    dispose() {}
  });
  class Uri {
    constructor(fsPath) {
      this.fsPath = fsPath;
      this.path = fsPath.replaceAll("\\", "/");
      this.scheme = "file";
    }

    static file(fileName) {
      return new Uri(path.resolve(fileName));
    }

    static parse(value) {
      return new Uri(value);
    }

    toString() {
      return `file://${this.path}`;
    }
  }
  class EventEmitter {
    event = event;
    fire() {}
    dispose() {}
  }
  class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }
  const collection = {
    set() {},
    delete() {},
    clear() {},
    dispose() {}
  };
  const configuration = {
    get: (_key, defaultValue) => defaultValue,
    has: () => false,
    inspect: () => undefined,
    update: async () => undefined
  };
  return {
    Uri,
    EventEmitter,
    RelativePattern,
    TreeItem: class {},
    CodeActionKind: { QuickFix: "quickfix" },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    l10n: { t: message => String(message) },
    commands: {
      registerCommand: disposable,
      executeCommand: async () => undefined
    },
    languages: {
      createDiagnosticCollection: () => collection,
      registerDefinitionProvider: disposable,
      registerCompletionItemProvider: disposable,
      registerHoverProvider: disposable,
      registerCodeActionsProvider: disposable
    },
    window: {
      activeTextEditor: undefined,
      createTreeView: disposable,
      createTextEditorDecorationType: disposable,
      onDidChangeActiveTextEditor: event,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined
    },
    workspace: {
      textDocuments: [],
      workspaceFolders: undefined,
      getConfiguration: () => configuration,
      getWorkspaceFolder: () => undefined,
      createFileSystemWatcher: watcher,
      findFiles: async () => [],
      onDidChangeTextDocument: event,
      onDidOpenTextDocument: event,
      onDidCloseTextDocument: event,
      onWillCreateFiles: event,
      onDidCreateFiles: event,
      onWillDeleteFiles: event,
      onDidDeleteFiles: event,
      onWillRenameFiles: event,
      onDidRenameFiles: event,
      onDidChangeWorkspaceFolders: event,
      onDidChangeConfiguration: event
    },
    env: createCallableStub()
  };
}

function createCallableStub() {
  const target = function callableStub() {
    return proxy;
  };
  const proxy = new Proxy(target, {
    apply: () => proxy,
    construct: () => ({}),
    get: (object, property, receiver) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(object, property);
      if (descriptor && !descriptor.configurable) {
        return Reflect.get(object, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      if (property === Symbol.toPrimitive) {
        return () => 0;
      }
      return proxy;
    }
  });
  return proxy;
}
