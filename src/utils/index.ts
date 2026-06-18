import * as vscode from 'vscode';

export const getWorkPath = (document: vscode.TextDocument) => {
    return vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
};

export const barename = (filename: string) => {
    const dotIndex = filename.lastIndexOf('.');
    return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
};

export const trimNamespace = (path: string) => {
    return path.slice(path.lastIndexOf(':') + 1);
};

export const parsePath = (word: string) => {
    const m = /(.+:)?(.+)/.exec(word);
    if (m) {
        return [
            m[1] ? m[1] : 'minecraft', 
            m[2] ? m[2] : ''
        ];
    }
    return null;
};
