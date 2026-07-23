import path from "node:path";

export function createExtensionContext(extensionPath, vscode, options = {}) {
  return {
    subscriptions: [],
    extension: options.extension,
    extensionPath,
    extensionUri: vscode.Uri.file(extensionPath),
    asAbsolutePath: relativePath => path.join(extensionPath, relativePath),
    globalState: createMemento(),
    workspaceState: createMemento(),
    secrets: createCallableStub(),
    storageUri: options.storagePath ? vscode.Uri.file(options.storagePath) : undefined,
    globalStorageUri: options.storagePath ? vscode.Uri.file(options.storagePath) : undefined,
    logUri: options.storagePath ? vscode.Uri.file(options.storagePath) : undefined,
    extensionMode: 3
  };
}

export function disposeExtensionContext(context) {
  for (const disposable of [...context.subscriptions].reverse()) {
    disposable?.dispose?.();
  }
}

export function createVscodeStub(options = {}) {
  const telemetry = options.telemetry;
  const disposable = () => ({ dispose() {} });
  const event = () => disposable();
  const watcher = pattern => {
    telemetry?.recordWatcher?.("vscode.workspace.createFileSystemWatcher", describePattern(pattern));
    return {
      onDidCreate: event,
      onDidChange: event,
      onDidDelete: event,
      dispose() {}
    };
  };
  class Uri {
    constructor(fsPath, scheme = "file") {
      this.fsPath = fsPath;
      this.path = fsPath.replaceAll("\\", "/");
      this.scheme = scheme;
    }

    static file(fileName) {
      return new Uri(path.resolve(fileName));
    }

    static parse(value) {
      if (value.startsWith("file://")) {
        return new Uri(value.slice("file://".length));
      }
      const separator = value.indexOf(":");
      return new Uri(value, separator > 0 ? value.slice(0, separator) : "file");
    }

    static joinPath(base, ...segments) {
      return new Uri(path.join(base.fsPath, ...segments), base.scheme);
    }

    with(change) {
      return new Uri(change.path ?? this.fsPath, change.scheme ?? this.scheme);
    }

    toString() {
      return `${this.scheme}://${this.path}`;
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
  const workspaceFolders = options.workspaceRoot ? [{
    uri: Uri.file(options.workspaceRoot),
    name: path.basename(options.workspaceRoot),
    index: 0
  }] : undefined;
  return {
    Uri,
    EventEmitter,
    RelativePattern,
    TreeItem: class {},
    CodeActionKind: { QuickFix: "quickfix" },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    l10n: { t: message => String(message) },
    commands: {
      registerCommand: disposable,
      executeCommand: async () => undefined
    },
    languages: {
      createDiagnosticCollection: () => collection,
      registerDefinitionProvider: disposable,
      registerReferenceProvider: disposable,
      registerCompletionItemProvider: disposable,
      registerHoverProvider: disposable,
      registerCodeActionsProvider: disposable
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createTreeView: disposable,
      registerWebviewViewProvider: disposable,
      createTextEditorDecorationType: disposable,
      onDidChangeActiveTextEditor: event,
      onDidChangeVisibleTextEditors: event,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      withProgress: async (_options, task) => task(createCallableStub(), createCallableStub())
    },
    workspace: {
      textDocuments: [],
      workspaceFolders,
      fs: createCallableStub(),
      getConfiguration: () => configuration,
      getWorkspaceFolder: () => workspaceFolders?.[0],
      registerFileSystemProvider: disposable,
      createFileSystemWatcher: watcher,
      findFiles: async (include, exclude, maxResults) => {
        telemetry?.recordFilesystemWalk?.(
          "vscode.workspace.findFiles",
          describePattern(include),
          { exclude: describePattern(exclude), maxResults }
        );
        return [];
      },
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
    extensions: {
      getExtension: () => undefined,
      all: [],
      onDidChange: event
    },
    env: createCallableStub()
  };
}

export function createCallableStub() {
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

function describePattern(pattern) {
  if (pattern === undefined || pattern === null) {
    return undefined;
  }
  if (typeof pattern === "string") {
    return pattern;
  }
  if (typeof pattern.pattern === "string") {
    return pattern.pattern;
  }
  return String(pattern);
}
