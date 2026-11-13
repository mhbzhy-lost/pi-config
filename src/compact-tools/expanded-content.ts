/**
 * Render expanded tool details with the same two-column left inset as the
 * tool title (`glyph + space`). Text's padding is intentional: it applies to
 * automatic continuation lines as well as original logical lines.
 */
export function createExpandedToolText(Text: any, content: string): any {
  return new Text(content, 2, 0);
}
