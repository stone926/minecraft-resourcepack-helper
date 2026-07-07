const vscode = acquireVsCodeApi();
const l10n = Object.freeze(globalThis.__MC_RES_HELPER_L10N__ ?? {});

function t(key, ...args) {
  const message = l10n[key] ?? key;
  return message.replace(/\{(\d+)\}/g, (match, index) => {
    const value = args[Number(index)];
    return value === undefined ? match : String(value);
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export { vscode, t, clamp };
