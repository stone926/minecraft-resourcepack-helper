export interface DiagnosticsRefresh {
  id: number;
  documentVersion: number;
  uriKey: string;
}

export class DiagnosticsRefreshGate {
  private readonly activeRefreshIds = new Map<string, number>();
  private nextRefreshId = 0;

  begin(uriKey: string, documentVersion: number): DiagnosticsRefresh {
    const id = ++this.nextRefreshId;
    this.activeRefreshIds.set(uriKey, id);
    return { id, documentVersion, uriKey };
  }

  isCurrent(refresh: DiagnosticsRefresh, documentVersion: number, isClosed: boolean): boolean {
    return !isClosed &&
      documentVersion === refresh.documentVersion &&
      this.activeRefreshIds.get(refresh.uriKey) === refresh.id;
  }

  clear(uriKey: string): void {
    this.activeRefreshIds.delete(uriKey);
  }

  clearAll(): void {
    this.activeRefreshIds.clear();
  }
}
