/**
 * Shared scanner for the measurement-CLI argument style: every option is a
 * `--flag value` or `--flag=value` pair, may appear at most once, and unknown
 * or malformed input fails with the calling script's own message wording.
 *
 * The scanner intentionally returns raw string values in a Map; each script
 * keeps its own validation (required flags, integers, defaults) so that its
 * externally observable error messages stay byte-for-byte identical.
 */
export function parseFlagValues(args, options = {}) {
  const values = new Map();
  const booleanFlags = new Set();
  const helpArguments = options.helpArguments ?? [];
  const switchFlags = options.switchFlags ?? [];
  const eagerKnownFlags = options.eagerKnownFlags;
  const missingValueNoun = options.missingValueNoun ?? "value";
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (helpArguments.includes(argument)) {
      if (help) {
        throw new Error(`${helpArguments[0]} may only be specified once.`);
      }
      help = true;
      continue;
    }
    if (options.unexpectedArgument && !argument.startsWith("--")) {
      throw new Error(options.unexpectedArgument(argument));
    }
    const equals = argument.indexOf("=");
    const flag = equals >= 0 ? argument.slice(0, equals) : argument;
    if (eagerKnownFlags && !eagerKnownFlags.includes(flag)) {
      throw new Error(options.unknownArgument(argument));
    }
    if (booleanFlags.has(flag) || values.has(flag)) {
      throw new Error(`${flag} may only be specified once.`);
    }
    if (switchFlags.includes(flag)) {
      booleanFlags.add(flag);
      continue;
    }
    const value = equals >= 0 ? argument.slice(equals + 1) : args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing ${missingValueNoun} after ${flag}.`);
    }
    values.set(flag, value);
    if (equals < 0) {
      index += 1;
    }
  }

  return { values, booleanFlags, help };
}
