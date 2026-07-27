/**
 * Canonical registry of Minecraft font provider types and their required
 * fields. Compiler font validation and semantic builtin constants both derive
 * from this table so the provider name list cannot drift between layers.
 */
export const fontProviderRequiredFields: ReadonlyMap<string, readonly string[]> = new Map([
  ["bitmap", ["file", "chars", "ascent"]],
  ["space", ["advances"]],
  ["ttf", ["file"]],
  ["unihex", ["hex_file"]],
  ["reference", ["id"]],
  ["legacy_unicode", ["template", "sizes"]]
]);

export const fontProviderNames: readonly string[] = [...fontProviderRequiredFields.keys()];
