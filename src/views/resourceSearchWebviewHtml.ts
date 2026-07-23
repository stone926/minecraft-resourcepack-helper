import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { resourceSearchKinds } from "../services/resourceSearchModel";

export function resourceSearchWebviewHtml(): string {
  const nonce = randomUUID().replaceAll("-", "");
  const strings = JSON.stringify({
    placeholder: vscode.l10n.t("Search resource IDs and paths"),
    blockstate: vscode.l10n.t("Blockstates"),
    model: vscode.l10n.t("Models"),
    texture: vscode.l10n.t("Textures"),
    typeToSearch: vscode.l10n.t("Type to search local and RSGL-generated resources."),
    searching: vscode.l10n.t("Searching resources…"),
    noResults: vscode.l10n.t("No matching resources."),
    partial: vscode.l10n.t("Some resource results may be incomplete."),
    unavailable: vscode.l10n.t("The resource inventory is unavailable."),
    open: vscode.l10n.t("Open resource"),
    failed: vscode.l10n.t("Resource search failed: {0}")
  }).replaceAll("<", "\\u003c");
  const kinds = JSON.stringify(resourceSearchKinds);
  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }
    input[type="search"] {
      width: 100%;
      height: 26px;
      padding: 3px 7px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      outline: none;
    }
    input[type="search"]:focus {
      border-color: var(--vscode-focusBorder);
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 10px;
      padding: 7px 0 5px;
      color: var(--vscode-descriptionForeground);
    }
    .filters label { display: inline-flex; align-items: center; gap: 4px; }
    .status {
      min-height: 20px;
      padding: 4px 2px;
      color: var(--vscode-descriptionForeground);
    }
    .status.warning { color: var(--vscode-editorWarning-foreground); }
    .status.error { color: var(--vscode-editorError-foreground); }
    .results { margin: 0; padding: 0; list-style: none; }
    .result {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0 7px;
      width: 100%;
      padding: 5px 4px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 2px;
      text-align: left;
      cursor: pointer;
    }
    .result:hover { background: var(--vscode-list-hoverBackground); }
    .result:focus {
      outline: 1px solid var(--vscode-focusBorder);
      background: var(--vscode-list-focusBackground);
    }
    .kind {
      min-width: 24px;
      padding: 1px 3px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 3px;
      text-align: center;
      font-size: 0.85em;
    }
    .content { min-width: 0; }
    .label, .description, .detail {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .label { color: var(--vscode-foreground); }
    .description, .detail {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
  </style>
</head>
<body>
  <input id="query" type="search" autocomplete="off" spellcheck="false">
  <div id="filters" class="filters"></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <ul id="results" class="results"></ul>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const strings = ${strings};
    const kinds = ${kinds};
    const abbreviations = { blockstate: "BS", model: "M", texture: "T" };
    const query = document.getElementById("query");
    const filters = document.getElementById("filters");
    const status = document.getElementById("status");
    const results = document.getElementById("results");
    let requestId = 0;
    let latestRequestId = -1;
    let timer;

    query.placeholder = strings.placeholder;
    query.setAttribute("aria-label", strings.placeholder);
    for (const kind of kinds) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = kind;
      checkbox.checked = true;
      checkbox.addEventListener("change", scheduleSearch);
      label.append(checkbox, document.createTextNode(strings[kind]));
      filters.append(label);
    }

    query.addEventListener("input", scheduleSearch);
    query.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") {
        const first = results.querySelector("button");
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    });

    window.addEventListener("message", event => {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      if (message.type === "invalidate") {
        scheduleSearch();
        return;
      }
      if (message.requestId !== latestRequestId) return;
      if (message.type === "searchError") {
        renderStatus(format(strings.failed, message.message), "error");
        results.replaceChildren();
        return;
      }
      if (message.type !== "searchResult") return;
      renderResults(message.items);
      if (!query.value.trim()) {
        renderStatus(strings.typeToSearch);
      } else if (message.coverage === "unavailable") {
        renderStatus(strings.unavailable, "warning");
      } else if (message.coverage === "partial") {
        renderStatus(strings.partial, "warning");
      } else if (message.items.length === 0) {
        renderStatus(strings.noResults);
      } else {
        renderStatus("");
      }
    });

    function scheduleSearch() {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 160);
    }

    function runSearch() {
      const selectedKinds = [...filters.querySelectorAll("input:checked")].map(input => input.value);
      latestRequestId = ++requestId;
      results.replaceChildren();
      if (query.value.trim()) {
        renderStatus(strings.searching);
      } else {
        renderStatus(strings.typeToSearch);
      }
      vscode.postMessage({
        type: "search",
        requestId: latestRequestId,
        query: query.value,
        kinds: selectedKinds
      });
    }

    function renderResults(items) {
      const fragment = document.createDocumentFragment();
      for (const item of items) {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "result";
        button.title = item.detail || item.label;
        button.setAttribute("aria-label", strings.open + ": " + item.label);
        button.addEventListener("click", () => {
          vscode.postMessage({ type: "navigate", resultId: item.resultId });
        });

        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = abbreviations[item.kind] || item.kindLabel;
        kind.title = item.kindLabel;
        const content = document.createElement("span");
        content.className = "content";
        content.append(
          line("label", item.label),
          line("description", item.description),
          line("detail", item.detail)
        );
        button.append(kind, content);
        row.append(button);
        fragment.append(row);
      }
      results.replaceChildren(fragment);
    }

    function line(className, text) {
      const element = document.createElement("div");
      element.className = className;
      element.textContent = text || "";
      return element;
    }

    function renderStatus(text, kind = "") {
      status.className = "status" + (kind ? " " + kind : "");
      status.textContent = text;
    }

    function format(template, value) {
      return template.replace("{0}", String(value));
    }

    renderStatus(strings.typeToSearch);
    query.focus();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
