import * as vscode from "vscode";
import { startRsglLanguageServer } from "./client";

export function registerRsglLanguageFeatures(context: vscode.ExtensionContext): void {
  startRsglLanguageServer(context);
}
