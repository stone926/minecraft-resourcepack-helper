import { RsglDiagnostic, TextRange } from "../parser";
import { RsglFileDiagnostic } from "./types";

export function diagnostic(code: string, message: string, range: TextRange, severity: RsglDiagnostic["severity"] = "error"): RsglDiagnostic {
  return { code, message, range, severity };
}

export function fileDiagnostic(fileName: string, code: string, message: string, range: TextRange, severity: RsglDiagnostic["severity"] = "error"): RsglFileDiagnostic {
  return { fileName, code, message, range, severity };
}

export function withFileName(fileName: string, diagnostics: RsglDiagnostic[]): RsglFileDiagnostic[] {
  return diagnostics.map(item => ({ ...item, fileName }));
}

export function toDiagnostic(diagnostic: RsglFileDiagnostic): RsglDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity
  };
}
