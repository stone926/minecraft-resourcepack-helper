import type * as vscode from "vscode";

/** Owns a registration transaction independently from the extension context. */
export class RegistrationScope implements vscode.Disposable {
  public readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const errors: unknown[] = [];
    for (const disposable of this.subscriptions.splice(0).reverse()) {
      try {
        disposable.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Resource surface registrations could not be disposed cleanly");
    }
  }
}
