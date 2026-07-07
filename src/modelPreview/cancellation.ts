export interface ModelPreviewCancellationToken {
  readonly isCancellationRequested: boolean;
  throwIfCancellationRequested(): void;
}

export class ModelPreviewCancellationError extends Error {
  constructor() {
    super("Model preview request was cancelled");
    this.name = "ModelPreviewCancellationError";
  }
}

export class ModelPreviewCancellationSource {
  private cancelled = false;

  readonly token: ModelPreviewCancellationToken = new ModelPreviewCancellationTokenImpl(this);

  cancel(): void {
    this.cancelled = true;
  }

  isCancellationRequested(): boolean {
    return this.cancelled;
  }
}

class ModelPreviewCancellationTokenImpl implements ModelPreviewCancellationToken {
  constructor(private readonly source: ModelPreviewCancellationSource) { }

  get isCancellationRequested(): boolean {
    return this.source.isCancellationRequested();
  }

  throwIfCancellationRequested(): void {
    if (this.source.isCancellationRequested()) {
      throw new ModelPreviewCancellationError();
    }
  }
}

export function throwIfCancellationRequested(token?: ModelPreviewCancellationToken): void {
  token?.throwIfCancellationRequested();
}

export function isCancellationError(error: unknown): error is ModelPreviewCancellationError {
  return error instanceof ModelPreviewCancellationError;
}
