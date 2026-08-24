# Goal tools render full JSON in TUI

## Symptom

The fallback TUI renderer displayed full Goal tool calls and results, including large execution contracts, action tokens, approval data, objectives, criteria, and raw JSON.

## Root cause

Goal tool registration did not provide `renderCall` or `renderResult`. The fallback therefore rendered the public tool payload rather than a display-specific projection. The initial candidate renderer also treated planned and runtime init inputs alike and read result text without respecting the authoritative `details.value` boundary.

## Fix

Register bounded display-only renderers for the eight public Goal tools. They derive ASCII one-line summaries from public call shapes and a safe result whitelist. Runtime init recognizes only `execution.schema=goal-runtime.v1` and counts its tasks and conditions; planned init counts top-level tasks. Result parsing prefers object or JSON-string `details.value`, falling back to text JSON only when that field is absent. No Goal execution, schema, content, details, or state behavior changes.

## Regression coverage

Renderer tests assert literal summaries for every public tool and every `goal_amend` operation, safe result parsing, partial and error states, width bounds, ASCII-only output, and redaction of sensitive/raw data. Extension integration verifies all eight registered tools use the renderer.
