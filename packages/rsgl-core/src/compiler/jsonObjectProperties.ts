/**
 * JavaScript reorders array-index property names during enumeration. RSGL
 * records promise declaration/insertion order instead, so compiler-created
 * records retain that order in a non-serializable sidecar.
 */
const jsonObjectInsertionOrder = Symbol("rsgl.jsonObjectInsertionOrder");

type OrderedJsonObject<T> = Record<string, T> & {
  [jsonObjectInsertionOrder]?: string[];
};

export function createJsonObject<T = import("./ir").JsonValue>(
  prototype: object | null = Object.prototype
): Record<string, T> {
  const result = Object.create(prototype) as OrderedJsonObject<T>;
  defineInsertionOrder(result, []);
  return result;
}

/** Define an enumerable own data property without invoking `__proto__`. */
export function setJsonObjectProperty<T>(
  target: Record<string, T>,
  key: string,
  value: T
): void {
  const ordered = target as OrderedJsonObject<T>;
  const order = insertionOrder(ordered);
  if (!Object.hasOwn(target, key)) {
    const previousIndex = order.indexOf(key);
    if (previousIndex >= 0) {
      order.splice(previousIndex, 1);
    }
    order.push(key);
  }
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  });
}

export function jsonObjectKeys<T>(value: Readonly<Record<string, T>>): string[] {
  const enumerableKeys = Object.keys(value);
  const recorded = (value as OrderedJsonObject<T>)[jsonObjectInsertionOrder];
  if (!recorded) {
    return enumerableKeys;
  }

  const enumerable = new Set(enumerableKeys);
  const result = recorded.filter(key => enumerable.delete(key));
  result.push(...enumerableKeys.filter(key => enumerable.has(key)));
  return result;
}

export function jsonObjectEntries<T>(
  value: Readonly<Record<string, T>>
): Array<[string, T]> {
  return jsonObjectKeys(value).map(key => [key, value[key]]);
}

function insertionOrder<T>(value: OrderedJsonObject<T>): string[] {
  const existing = value[jsonObjectInsertionOrder];
  if (existing) {
    return existing;
  }
  const order = Object.keys(value);
  defineInsertionOrder(value, order);
  return order;
}

function defineInsertionOrder<T>(value: OrderedJsonObject<T>, order: string[]): void {
  Object.defineProperty(value, jsonObjectInsertionOrder, {
    value: order,
    enumerable: false,
    configurable: false,
    writable: false
  });
}
