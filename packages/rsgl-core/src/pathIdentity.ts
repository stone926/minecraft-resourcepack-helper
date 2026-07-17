import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";

/**
 * A filesystem path has two deliberately separate representations in RSGL:
 * a stable identity key for lookup and a normalized display path for I/O and
 * diagnostics. Never expose the identity key as a user-facing file name.
 */
export interface RsglPathIdentity {
  readonly key: string;
  readonly fileName: string;
}

export function normalizeRsglPath(fileName: string): string {
  return path.normalize(fileName);
}

export function resolveRsglPath(fileName: string): string {
  return normalizeRsglPath(path.resolve(fileName));
}

export function rsglPathKey(fileName: string): string {
  return normalizePathKey(fileName);
}

export function resolvedRsglPathKey(fileName: string): string {
  return rsglPathKey(resolveRsglPath(fileName));
}

export function rsglPathIdentity(fileName: string): RsglPathIdentity {
  const normalized = normalizeRsglPath(fileName);
  return { key: rsglPathKey(normalized), fileName: normalized };
}

export function resolvedRsglPathIdentity(fileName: string): RsglPathIdentity {
  return rsglPathIdentity(resolveRsglPath(fileName));
}

export function sameRsglPath(left: string, right: string): boolean {
  return rsglPathKey(left) === rsglPathKey(right);
}

/** Returns whether a candidate is the root itself or a strict descendant. */
export function isRsglPathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(resolvedRsglPathKey(root), resolvedRsglPathKey(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * A Map that stores path identity keys while accepting display-path lookups.
 * Iteration always exposes identity keys; file names intended for display must
 * remain in the mapped value.
 */
export class RsglPathKeyMap<Value> extends Map<string, Value> {
  public constructor(entries?: Iterable<readonly [string, Value]> | null) {
    super();
    if (entries) {
      for (const [fileName, value] of entries) {
        this.set(fileName, value);
      }
    }
  }

  public override set(fileName: string, value: Value): this {
    return super.set(rsglPathKey(fileName), value);
  }

  public override get(fileName: string): Value | undefined {
    return super.get(rsglPathKey(fileName));
  }

  public override has(fileName: string): boolean {
    return super.has(rsglPathKey(fileName));
  }

  public override delete(fileName: string): boolean {
    return super.delete(rsglPathKey(fileName));
  }
}
