import type { PreviewIssue } from "../ir/PreviewDocument";
import { fileUriString } from "../resolve/ResourceDependencyResolver";

export class ModelIssueCollector {
  private readonly issues: PreviewIssue[] = [];

  error(message: string, fileName?: string): void {
    this.push("error", message, fileName);
  }

  warning(message: string, fileName?: string): void {
    this.push("warning", message, fileName);
  }

  info(message: string, fileName?: string): void {
    this.push("info", message, fileName);
  }

  all(): PreviewIssue[] {
    return [...this.issues];
  }

  private push(severity: PreviewIssue["severity"], message: string, fileName?: string): void {
    const issue: PreviewIssue = { severity, message };
    if (fileName) {
      issue.resourceUri = fileUriString(fileName);
    }
    this.issues.push(issue);
  }
}
