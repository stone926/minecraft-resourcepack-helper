import * as vscode from 'vscode';
import * as path from 'node:path';
import textureVarDefinitionProvider from './providers/textureVarDefinitionProvider';
import openDefaultMcAssetsPath from './commands/openDefaultMcAssetsPath';
import createNewResourcePack from './commands/createNewResourcePack';
import createNewResourcePackRoot from './commands/createNewResourcePackRoot';
import createCitTemplateCommand from './commands/createCitTemplate';
import generateCitForCurrentItemCommand from './commands/generateCitForCurrentItem';
import { applyDecoration, disposeDecoration, updateDecoration } from './decorator/textureVarDecorator';
import resourceDefinitionProvider from './providers/resourceDefinitionProvider';
import resourceCompletionProvider, { triggerResourceCompletionCommand } from './providers/resourceCompletionProvider';
import citCompletionProvider from './providers/citCompletionProvider';
import citHoverProvider from './providers/citHoverProvider';
import citCodeActionProvider, { createMissingCitResource, createMissingCitResourceCommand } from './providers/citCodeActionProvider';
import { refreshResourceDiagnostics } from './diagnostics/resourceDiagnostics';
import { getResourceGraphNodeUri, ResourceGraphTreeProvider } from './views/resourceGraphTree';
import { isResourceGraphDocumentPath } from './utils/resourceGraph';
import { ModelPreviewService } from './modelPreview/service/ModelPreviewService';
import { ModelPreviewHostFileSystem } from './modelPreview/host/ModelPreviewHostFileSystem';
import { openModelPreviewCommand } from './modelPreview/commands/openModelPreview';
import { captureModelPreviewImageCommand, exportModelPreviewImageCommand } from './modelPreview/commands/exportModelPreviewImage';
import { workspaceResourceCache } from './services/workspaceResourceCache';
import { registerRsglLanguageFeatures } from './rsgl';
import {
  buildActiveRsglResourcePack,
  buildActiveRsglResourcePackDirectory,
  buildRsglResourcePackCommand,
  buildRsglResourcePackDirectoryCommand,
  previewActiveRsglResourcePackBuild,
  previewActiveRsglResourcePackDirectoryBuild,
  previewRsglResourcePackBuildCommand,
  previewRsglResourcePackDirectoryBuildCommand
} from './rsgl/commands/build';

const jsonResourceReferenceSelectors: vscode.DocumentFilter[] = [
  { language: "json", pattern: "**/blockstates/*.json" },
  { language: "json", pattern: "**/models/**/*.json" },
  { language: "json", pattern: "**/particles/**/*.json" },
  { language: "json", pattern: "**/items/**/*.json" },
  { language: "json", pattern: "**/atlases/**/*.json" },
  { language: "json", pattern: "**/equipment/**/*.json" },
  { language: "json", pattern: "**/font/**/*.json" },
  { language: "json", pattern: "**/waypoint_style/**/*.json" },
  { language: "json", pattern: "**/post_effect/**/*.json" },
  { language: "json", pattern: "**/assets/*/sounds.json" }
];

const shaderResourceReferenceSelectors: vscode.DocumentFilter[] = [
  { pattern: "**/assets/*/shaders/core/**/*.vsh" },
  { pattern: "**/assets/*/shaders/core/**/*.fsh" },
  { pattern: "**/assets/*/shaders/post/**/*.vsh" },
  { pattern: "**/assets/*/shaders/post/**/*.fsh" }
];

const citResourceReferenceSelectors: vscode.DocumentFilter[] = [
  { pattern: "**/assets/*/citresewn/*.properties" },
  { pattern: "**/assets/*/citresewn/**/*.properties" },
  { pattern: "**/assets/*/optifine/cit.properties" },
  { pattern: "**/assets/*/optifine/cit/**/*.properties" },
  { pattern: "**/assets/*/mcpatcher/cit.properties" },
  { pattern: "**/assets/*/mcpatcher/cit/**/*.properties" }
];

const citModelResourceReferenceSelectors: vscode.DocumentFilter[] = [
  { language: "json", pattern: "**/assets/*/citresewn/*.json" },
  { language: "json", pattern: "**/assets/*/citresewn/**/*.json" },
  { language: "json", pattern: "**/assets/*/optifine/cit/**/*.json" },
  { language: "json", pattern: "**/assets/*/mcpatcher/cit/**/*.json" }
];

const resourceReferenceSelectors: vscode.DocumentFilter[] = [
  ...jsonResourceReferenceSelectors,
  ...shaderResourceReferenceSelectors,
  ...citResourceReferenceSelectors,
  ...citModelResourceReferenceSelectors
];

export function activate(context: vscode.ExtensionContext) {
  workspaceResourceCache.setOpenTextDocumentProvider(fileName => findOpenTextDocument(fileName));
  registerRsglLanguageFeatures(context);

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    resourceReferenceSelectors,
    { provideDefinition: resourceDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerDefinitionProvider(
    [
      { language: "json", pattern: "**/models/**/*.json" }
    ],
    { provideDefinition: textureVarDefinitionProvider }
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    resourceReferenceSelectors,
    resourceCompletionProvider,
    '"',
    '<',
    '/',
    ':',
    '='
  ));

  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(
    citResourceReferenceSelectors,
    citCompletionProvider,
    '=',
    '.'
  ));

  context.subscriptions.push(vscode.languages.registerHoverProvider(
    citResourceReferenceSelectors,
    citHoverProvider
  ));

  context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
    [
      ...citResourceReferenceSelectors,
      ...citModelResourceReferenceSelectors
    ],
    citCodeActionProvider,
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  ));

  context.subscriptions.push(vscode.commands.registerCommand('McResHelper.openDefaultMcAssetsPath', openDefaultMcAssetsPath));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePack", createNewResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createNewResourcePackRoot", createNewResourcePackRoot));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.createCitTemplate", createCitTemplateCommand));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.generateCitForCurrentItem", generateCitForCurrentItemCommand));
  context.subscriptions.push(vscode.commands.registerCommand(createMissingCitResourceCommand, createMissingCitResource));
  context.subscriptions.push(vscode.commands.registerCommand(buildRsglResourcePackCommand, buildActiveRsglResourcePack));
  context.subscriptions.push(vscode.commands.registerCommand(previewRsglResourcePackBuildCommand, previewActiveRsglResourcePackBuild));
  context.subscriptions.push(vscode.commands.registerCommand(buildRsglResourcePackDirectoryCommand, buildActiveRsglResourcePackDirectory));
  context.subscriptions.push(vscode.commands.registerCommand(previewRsglResourcePackDirectoryBuildCommand, previewActiveRsglResourcePackDirectoryBuild));

  const modelPreviewService = new ModelPreviewService({
    fileSystem: new ModelPreviewHostFileSystem(),
    configuration: () => ({
      defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
      resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
    })
  });
  const openModelPreview = openModelPreviewCommand(context.extensionUri, modelPreviewService);
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openModelPreview",
    openModelPreview
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openResourceGraphModelPreview",
    (node?: unknown) => {
      const uri = getResourceGraphNodeUri(node);
      return openModelPreview(uri ?? undefined);
    }
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.openUnsupportedModelPreviewResource",
    () => vscode.window.showInformationMessage(vscode.l10n.t("Model preview supports model JSON resources only for now"))
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.exportModelPreviewImage",
    exportModelPreviewImageCommand(context.extensionUri, modelPreviewService)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.captureModelPreviewImage",
    captureModelPreviewImageCommand(context.extensionUri, modelPreviewService)
  ));
  context.subscriptions.push(vscode.commands.registerCommand(
    "McResHelper.showWorkspaceResourceCacheStats",
    () => vscode.window.showInformationMessage(JSON.stringify(workspaceResourceCache.getStats()))
  ));
  context.subscriptions.push(vscode.commands.registerCommand(triggerResourceCompletionCommand, () => {
    setTimeout(() => {
      void vscode.commands.executeCommand("editor.action.triggerSuggest");
    }, 0);
  }));

  const resourceGraphTreeProvider = new ResourceGraphTreeProvider();
  context.subscriptions.push(resourceGraphTreeProvider);
  context.subscriptions.push(vscode.window.createTreeView("McResHelper.resourceGraph", {
    treeDataProvider: resourceGraphTreeProvider,
    showCollapseAll: true
  }));
  context.subscriptions.push(vscode.commands.registerCommand("McResHelper.refreshResourceGraph", () => {
    resourceGraphTreeProvider.refresh();
  }));

  const resourceDiagnostics = vscode.languages.createDiagnosticCollection(vscode.l10n.t("McResHelper resources"));
  context.subscriptions.push(resourceDiagnostics);
  for (const document of vscode.workspace.textDocuments) {
    refreshResourceDiagnostics(document, resourceDiagnostics);
  }
  let diagnosticsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshOpenResourceDiagnosticsSoon = (delay = 250) => {
    if (diagnosticsRefreshTimer) {
      clearTimeout(diagnosticsRefreshTimer);
    }

    diagnosticsRefreshTimer = setTimeout(() => {
      diagnosticsRefreshTimer = null;
      for (const document of vscode.workspace.textDocuments) {
        refreshResourceDiagnostics(document, resourceDiagnostics);
      }
    }, delay);
  };
  context.subscriptions.push({
    dispose: () => {
      if (diagnosticsRefreshTimer) {
        clearTimeout(diagnosticsRefreshTimer);
        diagnosticsRefreshTimer = null;
      }
    }
  });

  let activeEditor: vscode.TextEditor | undefined;

  if (vscode.window.activeTextEditor) {
    activeEditor = vscode.window.activeTextEditor;
    applyDecoration(activeEditor);
  }

  // * Handle active file changed
  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      activeEditor = editor;
      applyDecoration(activeEditor);
      resourceGraphTreeProvider.refreshActiveEditor();
    } else {
      activeEditor = undefined;
      resourceGraphTreeProvider.refreshActiveEditor();
    }
  }, null, context.subscriptions);

  // * Handle file contents changed
  vscode.workspace.onDidChangeTextDocument(event => {
    workspaceResourceCache.invalidateDocument(event.document);
    if (activeEditor && event.document === activeEditor.document) {
      applyDecoration(activeEditor);
    }
    refreshResourceDiagnostics(event.document, resourceDiagnostics);
    if (isResourceGraphDocumentPath(event.document.fileName)) {
      resourceGraphTreeProvider.refreshSoon();
    }
  }, null, context.subscriptions);

  registerResourceWatcher(context, "**/assets/**/*.json", uri => {
    invalidateResourcePath(uri);
    refreshOpenResourceDiagnosticsSoon();
    resourceGraphTreeProvider.refreshSoon();
  });
  for (const pattern of [
    "**/assets/*/shaders/**/*.vsh",
    "**/assets/*/shaders/**/*.fsh",
    "**/assets/*/shaders/**/*.glsl"
  ]) {
    registerResourceWatcher(context, pattern, uri => {
      invalidateResourcePath(uri);
      refreshOpenResourceDiagnosticsSoon();
      resourceGraphTreeProvider.refreshSoon();
    });
  }
  for (const pattern of [
    "**/assets/*/textures/**/*.png",
    "**/assets/*/citresewn/*.png",
    "**/assets/*/citresewn/**/*.png",
    "**/assets/*/optifine/cit/**/*.png",
    "**/assets/*/mcpatcher/cit/**/*.png",
    "**/assets/*/textures/**/*.png.mcmeta",
    "**/pack.mcmeta",
    "**/pack.png"
  ]) {
    registerResourceWatcher(context, pattern, uri => {
      invalidateResourcePath(uri);
      refreshOpenResourceDiagnosticsSoon();
      resourceGraphTreeProvider.refreshSoon();
    });
  }
  for (const pattern of [
    "**/assets/*/citresewn/*.properties",
    "**/assets/*/citresewn/**/*.properties",
    "**/assets/*/optifine/cit.properties",
    "**/assets/*/optifine/cit/**/*.properties",
    "**/assets/*/mcpatcher/cit.properties",
    "**/assets/*/mcpatcher/cit/**/*.properties"
  ]) {
    registerResourceWatcher(context, pattern, uri => {
      invalidateResourcePath(uri);
      refreshOpenResourceDiagnosticsSoon();
      resourceGraphTreeProvider.refreshSoon();
    });
  }

  vscode.workspace.onDidOpenTextDocument(document => {
    workspaceResourceCache.invalidateDocument(document);
    refreshResourceDiagnostics(document, resourceDiagnostics);
  }, null, context.subscriptions);

  vscode.workspace.onDidCloseTextDocument(document => {
    workspaceResourceCache.invalidateDocument(document);
    resourceDiagnostics.delete(document.uri);
  }, null, context.subscriptions);

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration("McResHelper.tipColorForUndefinedTextureVariables") && activeEditor) {
      updateDecoration(activeEditor);
    }
    if (
      event.affectsConfiguration("McResHelper.defaultMcAssetsPath") ||
      event.affectsConfiguration("McResHelper.resourcePackLoadOrder")
    ) {
      workspaceResourceCache.invalidateConfiguration();
      for (const document of vscode.workspace.textDocuments) {
        refreshResourceDiagnostics(document, resourceDiagnostics);
      }
      resourceGraphTreeProvider.refresh();
    }
  }));

  context.subscriptions.push({ dispose: disposeDecoration });
}

export function deactivate() { }

function registerResourceWatcher(
  context: vscode.ExtensionContext,
  pattern: string,
  handleChange: (uri: vscode.Uri) => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  context.subscriptions.push(watcher);
  watcher.onDidCreate(handleChange, null, context.subscriptions);
  watcher.onDidChange(handleChange, null, context.subscriptions);
  watcher.onDidDelete(handleChange, null, context.subscriptions);
}

function invalidateResourcePath(uri: vscode.Uri): void {
  if (uri.scheme === "file") {
    workspaceResourceCache.invalidatePath(uri.fsPath);
  } else {
    workspaceResourceCache.invalidateAll();
  }
}

function findOpenTextDocument(fileName: string): vscode.TextDocument | null {
  const key = fileNameKey(fileName);
  return vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === "file" && fileNameKey(document.fileName) === key
  ) ?? null;
}

function fileNameKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
