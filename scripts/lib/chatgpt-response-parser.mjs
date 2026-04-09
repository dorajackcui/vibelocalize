export function parseAssistantResponseToMatrix(rawText, responseConfig) {
  const cleaned = normalizeAssistantForPaste(rawText, responseConfig);

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      return coerceMatrix(parsed);
    }

    if (Array.isArray(parsed.results)) {
      return coerceMatrix(parsed.results);
    }
  } catch {
    // Fall through to plain-text parsing.
  }

  const matrix = parseDelimitedBlock(cleaned);
  if (matrix.length > 0) {
    return matrix;
  }

  throw new Error(
    [
      "Could not parse ChatGPT response into a paste block.",
      "Configure your ChatGPT project to return either a JSON array/object or a plain-text block."
    ].join(" ")
  );
}

export function coerceMatrix(items) {
  const matrix = items.map((item) => {
    if (Array.isArray(item)) {
      return item.map((cell) => String(cell ?? ""));
    }

    return [String(item ?? "")];
  });

  if (matrix.length === 0) {
    throw new Error("ChatGPT returned an empty result block.");
  }

  return matrix;
}

export function parseDelimitedBlock(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
  if (!normalized) {
    return [];
  }

  return normalized.split("\n").map((line) => line.split("\t"));
}

export function normalizeAssistantForPaste(rawText, responseConfig) {
  if (!responseConfig.stripCodeFences) {
    return stripLeadingCodeLanguageLabel(rawText.trim());
  }

  const fencedBlockMatch = rawText.match(/```[\w-]*\n([\s\S]*?)\n```/);
  const candidate = fencedBlockMatch ? fencedBlockMatch[1] : rawText;

  return stripLeadingCodeLanguageLabel(
    candidate
      .replace(/^```[\w-]*\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim()
  );
}

export function stripLeadingCodeLanguageLabel(text) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");

  if (lines.length <= 1) {
    return normalized;
  }

  const firstLine = lines[0].trim();
  const knownLabels = new Set([
    "markdown",
    "md",
    "plaintext",
    "text",
    "txt",
    "json",
    "yaml",
    "yml",
    "csv",
    "tsv"
  ]);

  if (knownLabels.has(firstLine.toLowerCase())) {
    return lines.slice(1).join("\n").trim();
  }

  return normalized;
}
