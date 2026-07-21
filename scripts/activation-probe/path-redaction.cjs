"use strict";

function redactActivationPaths(value, replacements, platform = process.platform) {
  if (value === undefined) {
    return undefined;
  }
  let result = String(value).replaceAll("\\", "/");
  for (const [source, replacement] of replacements) {
    result = replacePathToken(result, source, replacement, platform);
  }
  return result;
}

function replacePathToken(value, source, replacement, platform = process.platform) {
  const normalizedSource = String(source).replaceAll("\\", "/");
  if (normalizedSource.length === 0) {
    return value;
  }
  const caseInsensitive = platform === "win32";
  const needle = caseInsensitive ? normalizedSource.toLowerCase() : normalizedSource;
  let result = value;
  let searchFrom = 0;
  while (searchFrom <= result.length - normalizedSource.length) {
    const haystack = caseInsensitive ? result.toLowerCase() : result;
    const index = haystack.indexOf(needle, searchFrom);
    if (index < 0) {
      break;
    }
    result = `${result.slice(0, index)}${replacement}${result.slice(index + normalizedSource.length)}`;
    searchFrom = index + replacement.length;
  }
  return result;
}

module.exports = {
  redactActivationPaths,
  replacePathToken
};
