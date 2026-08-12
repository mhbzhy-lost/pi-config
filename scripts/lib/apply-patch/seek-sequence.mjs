function normalise(s) {
  return s
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function matchesAt(lines, pattern, i, mode) {
  for (let p = 0; p < pattern.length; p++) {
    const a = lines[i + p];
    const b = pattern[p];
    const ok =
      mode === 0
        ? a === b
        : mode === 1
          ? a.trimEnd() === b.trimEnd()
          : mode === 2
            ? a.trim() === b.trim()
            : normalise(a) === normalise(b);
    if (!ok) return false;
  }
  return true;
}

export function seekSequence(lines, pattern, start, eof) {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart =
    eof && lines.length >= pattern.length
      ? lines.length - pattern.length
      : start;

  for (let mode = 0; mode < 4; mode++) {
    for (let i = searchStart; i <= lines.length - pattern.length; i++) {
      if (matchesAt(lines, pattern, i, mode)) return i;
    }
  }
  return null;
}
