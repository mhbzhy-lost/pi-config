# Auto Integration recovery hardening

## Root cause

The process-wide lifecycle record prevented duplicate enqueue after extension reload, but an in-flight trusted coordinator result was consumed after the owning extension had been disposed. The post-await path entered `advanceAutoIntegration` before rechecking generation liveness. Conflict continuation was bounded only by a raw counter, so repeated outcomes with an unchanged conflict digest still woke the model, while the intended policy permits a second continuation only after observable progress.

## Fix

Recheck lifecycle ownership immediately after every awaited coordinator result. Track the durable conflict digest in the shared lifecycle record, preserve on the first repeated digest, and cap progressive conflict continuations at two. A lifecycle explicitly marked non-managed now registers no handlers or process record.

## Regression coverage

`test/subagent-auto-integration-recovery.integration.mjs` covers extension reload/duplicate events, disposal during a late trusted query, unchanged and changing conflict digests, and non-managed isolation. The tests use coordinator/provider outcome fixtures and do not invoke an external model.
