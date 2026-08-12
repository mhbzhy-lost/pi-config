export class ParseError extends Error {
  constructor(message, lineNumber) {
    super(lineNumber != null ? `line ${lineNumber}: ${message}` : message);
    this.name = "ParseError";
    this.lineNumber = lineNumber;
  }
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CTX = "@@ ";
const EMPTY_CTX = "@@";

const VALID_HEADERS =
  "Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'";

function stripHeredoc(lines) {
  if (lines.length < 4) return lines;
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last.endsWith("EOF")
  ) {
    return lines.slice(1, -1);
  }
  return lines;
}

function isHeader(trimmed) {
  return (
    trimmed === END ||
    trimmed.startsWith(ADD) ||
    trimmed.startsWith(DELETE) ||
    trimmed.startsWith(UPDATE)
  );
}

function ensureUpdateNotEmpty(hunks, lineNumber) {
  const last = hunks[hunks.length - 1];
  if (!last || last.type !== "update") return;
  if (last.chunks.length === 0) {
    throw new ParseError(
      `Update file hunk for path '${last.path}' is empty`,
      lineNumber
    );
  }
  const chunk = last.chunks[last.chunks.length - 1];
  if (chunk && chunk.oldLines.length === 0 && chunk.newLines.length === 0) {
    throw new ParseError(
      "Update hunk does not contain any lines",
      lineNumber
    );
  }
}

function pushContextLine(chunk, line) {
  chunk.contextLineIndices.push([chunk.oldLines.length, chunk.newLines.length]);
  chunk.oldLines.push(line);
  chunk.newLines.push(line);
}

function ensureChunk(hunk) {
  if (hunk.chunks.length === 0) {
    hunk.chunks.push({
      changeContext: null,
      oldLines: [],
      newLines: [],
      contextLineIndices: [],
      isEndOfFile: false,
    });
  }
  return hunk.chunks[hunk.chunks.length - 1];
}

export function parsePatch(text) {
  let lines = text.trim().split("\n").map((l) => l.replace(/\r$/, ""));
  lines = stripHeredoc(lines);

  const first = (lines[0] ?? "").trim();
  const last = (lines[lines.length - 1] ?? "").trim();
  if (first !== BEGIN) {
    throw new ParseError("The first line of the patch must be '*** Begin Patch'");
  }
  if (last !== END) {
    throw new ParseError("The last line of the patch must be '*** End Patch'");
  }

  const hunks = [];
  let mode = "started"; // after BEGIN
  let i = 1;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const lineNum = i + 1;

    if (mode === "ended") {
      if (trimmed !== "") {
        throw new ParseError("The last line of the patch must be '*** End Patch'");
      }
      i++;
      continue;
    }

    // In update mode, headers are matched with trimEnd only (preserving
    // leading space) so that " *** Update File: x" is a context line.
    const headerKey = mode === "update" ? raw.trimEnd() : trimmed;

    // --- header transitions (valid from any active mode) ---
    if (headerKey === END) {
      ensureUpdateNotEmpty(hunks, lineNum);
      mode = "ended";
      i++;
      continue;
    }
    if (headerKey.startsWith(ADD)) {
      ensureUpdateNotEmpty(hunks, lineNum);
      hunks.push({ type: "add", path: headerKey.slice(ADD.length), contents: "" });
      mode = "add";
      i++;
      continue;
    }
    if (headerKey.startsWith(DELETE)) {
      ensureUpdateNotEmpty(hunks, lineNum);
      hunks.push({ type: "delete", path: headerKey.slice(DELETE.length) });
      mode = "delete";
      i++;
      continue;
    }
    if (headerKey.startsWith(UPDATE)) {
      ensureUpdateNotEmpty(hunks, lineNum);
      hunks.push({
        type: "update",
        path: headerKey.slice(UPDATE.length),
        movePath: null,
        chunks: [],
      });
      mode = "update";
      i++;
      continue;
    }

    // --- mode-specific line handling ---
    if (mode === "started" || mode === "delete") {
      throw new ParseError(
        `'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`,
        lineNum
      );
    }

    if (mode === "add") {
      if (raw.startsWith("+")) {
        const hunk = hunks[hunks.length - 1];
        hunk.contents += raw.slice(1) + "\n";
        i++;
        continue;
      }
      throw new ParseError(
        `'${trimmed}' is not a valid hunk header. ${VALID_HEADERS}`,
        lineNum
      );
    }

    // mode === "update"
    const hunk = hunks[hunks.length - 1];
    const updateLine = raw.trimEnd();

    // Move to (only before first chunk)
    if (
      hunk.chunks.length === 0 &&
      hunk.movePath === null &&
      updateLine.startsWith(MOVE_TO)
    ) {
      hunk.movePath = updateLine.slice(MOVE_TO.length);
      i++;
      continue;
    }

    // @@ context marker
    if (updateLine === EMPTY_CTX || updateLine.startsWith(CTX)) {
      const lastChunk = hunk.chunks[hunk.chunks.length - 1];
      if (lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
        throw new ParseError(
          `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
          lineNum
        );
      }
      hunk.chunks.push({
        changeContext:
          updateLine === EMPTY_CTX ? null : updateLine.slice(CTX.length),
        oldLines: [],
        newLines: [],
        contextLineIndices: [],
        isEndOfFile: false,
      });
      i++;
      continue;
    }

    // End of File marker
    if (updateLine === EOF_MARKER) {
      const lastChunk = hunk.chunks[hunk.chunks.length - 1];
      if (lastChunk && lastChunk.oldLines.length === 0 && lastChunk.newLines.length === 0) {
        throw new ParseError("Update hunk does not contain any lines", lineNum);
      }
      if (hunk.chunks.length > 0) {
        hunk.chunks[hunk.chunks.length - 1].isEndOfFile = true;
      }
      i++;
      continue;
    }

    // After End of File: only empty lines or new @@ allowed
    const lastChunk = hunk.chunks[hunk.chunks.length - 1];
    if (lastChunk && lastChunk.isEndOfFile) {
      if (updateLine === "") {
        i++;
        continue;
      }
      throw new ParseError(
        `Expected update hunk to start with a @@ context marker, got: '${raw}'`,
        lineNum
      );
    }

    // Bare empty line → empty context line
    if (raw === "") {
      const chunk = ensureChunk(hunk);
      pushContextLine(chunk, "");
      i++;
      continue;
    }

    // Context line (space prefix)
    if (raw.startsWith(" ")) {
      const chunk = ensureChunk(hunk);
      pushContextLine(chunk, raw.slice(1));
      i++;
      continue;
    }

    // Added line
    if (raw.startsWith("+")) {
      const chunk = ensureChunk(hunk);
      chunk.newLines.push(raw.slice(1));
      i++;
      continue;
    }

    // Removed line
    if (raw.startsWith("-")) {
      const chunk = ensureChunk(hunk);
      chunk.oldLines.push(raw.slice(1));
      i++;
      continue;
    }

    // Non-prefixed line after content → error
    if (
      lastChunk &&
      (lastChunk.oldLines.length > 0 || lastChunk.newLines.length > 0)
    ) {
      throw new ParseError(
        `Expected update hunk to start with a @@ context marker, got: '${raw}'`,
        lineNum
      );
    }

    throw new ParseError(
      `Unexpected line found in update hunk: '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      lineNum
    );
  }

  if (mode !== "ended") {
    throw new ParseError("The last line of the patch must be '*** End Patch'");
  }

  return { hunks };
}
