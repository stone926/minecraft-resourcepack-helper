export interface ResourceGraphReferenceIndexKeys {
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly modelParent: boolean;
}

export class ResourceGraphReferenceIndex<T> {
  private readonly referencesBySource = new Map<string, readonly T[]>();
  private readonly incomingByTarget = new Map<string, T[]>();
  private readonly childrenByParent = new Map<string, T[]>();

  public constructor(private readonly keysFor: (reference: T) => ResourceGraphReferenceIndexKeys) { }

  public replaceSource(sourceKey: string, references: readonly T[]): void {
    this.removeSource(sourceKey);
    this.referencesBySource.set(sourceKey, references);
    for (const reference of references) {
      const keys = this.keysFor(reference);
      addReference(this.incomingByTarget, keys.targetKey, reference);
      if (keys.modelParent) {
        addReference(this.childrenByParent, keys.targetKey, reference);
      }
    }
  }

  public removeSource(sourceKey: string): void {
    const references = this.referencesBySource.get(sourceKey);
    if (!references) {
      return;
    }
    this.referencesBySource.delete(sourceKey);
    for (const reference of references) {
      const keys = this.keysFor(reference);
      removeSourceReferences(this.incomingByTarget, keys.targetKey, sourceKey, this.keysFor);
      if (keys.modelParent) {
        removeSourceReferences(this.childrenByParent, keys.targetKey, sourceKey, this.keysFor);
      }
    }
  }

  public getIncoming(targetKey: string): readonly T[] {
    return this.incomingByTarget.get(targetKey) ?? [];
  }

  public getChildren(parentKey: string): readonly T[] {
    return this.childrenByParent.get(parentKey) ?? [];
  }
}

function addReference<T>(index: Map<string, T[]>, targetKey: string, reference: T): void {
  const existing = index.get(targetKey);
  if (existing) {
    existing.push(reference);
  } else {
    index.set(targetKey, [reference]);
  }
}

function removeSourceReferences<T>(
  index: Map<string, T[]>,
  targetKey: string,
  sourceKey: string,
  keysFor: (reference: T) => ResourceGraphReferenceIndexKeys
): void {
  const existing = index.get(targetKey);
  if (!existing) {
    return;
  }
  const remaining = existing.filter(reference => keysFor(reference).sourceKey !== sourceKey);
  if (remaining.length > 0) {
    index.set(targetKey, remaining);
  } else {
    index.delete(targetKey);
  }
}
