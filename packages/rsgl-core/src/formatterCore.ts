export function formatRsglText(text: string, tabSize = 2): string {
  const indentText = " ".repeat(tabSize);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let depth = 0;

  const formatted = lines.map(line => {
    const trimmedRight = line.trimEnd();
    const trimmed = trimmedRight.trimStart();
    if (trimmed.length === 0) {
      return "";
    }

    const closingCount = countLeadingClosers(trimmed);
    depth = Math.max(0, depth - closingCount);
    const result = `${indentText.repeat(depth)}${trimmed}`;
    depth = Math.max(0, depth + countIndentDelta(trimmed));
    return result;
  });

  return formatted.join("\n");
}

function countLeadingClosers(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === "}" || char === "]" || char === ")") {
      count++;
    } else {
      break;
    }
  }
  return count;
}

function countIndentDelta(line: string): number {
  let delta = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let inString: "\"" | "`" | null = null;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1] ?? "";

    if (inLineComment) {
      break;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inString) {
      if (char === "\\") {
        index++;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
    } else if (char === "\"" || char === "`") {
      inString = char;
    } else if (char === "{" || char === "[" || char === "(") {
      delta++;
    } else if (char === "}" || char === "]" || char === ")") {
      delta--;
    }
  }

  return delta;
}
