import type { PreviewIssue, PreviewRange } from "../ir/PreviewDocument";
import { fileUriString } from "../resolve/ResourceDependencyResolver";

export class ModelIssueCollector {
  private readonly issues: PreviewIssue[] = [];

  error(message: string, fileName?: string, range?: PreviewRange): void {
    this.push("error", message, fileName, range);
  }

  warning(message: string, fileName?: string, range?: PreviewRange): void {
    this.push("warning", message, fileName, range);
  }

  info(message: string, fileName?: string, range?: PreviewRange): void {
    this.push("info", message, fileName, range);
  }

  all(): PreviewIssue[] {
    return [...this.issues];
  }

  size(): number {
    return this.issues.length;
  }

  private push(severity: PreviewIssue["severity"], message: string, fileName?: string, range?: PreviewRange): void {
    const issue: PreviewIssue = { severity, message };
    if (fileName) {
      issue.resourceUri = fileUriString(fileName);
    }
    if (range) {
      issue.range = range;
    }
    this.issues.push(issue);
  }
}
