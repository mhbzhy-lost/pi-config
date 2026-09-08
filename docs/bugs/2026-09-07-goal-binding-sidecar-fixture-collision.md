# Goal binding sidecar fixture collision

## Reproduction

Before this fixture change, the executor-binding singleton command reused fixed
`/tmp/run-…` directories. A previous test process could leave a durable Broker
sidecar there; a later isolated Host then rejected its synthetic run with
`Goal binding sidecar conflicts`. The focused file produced seven failures,
including the missing-terminal-proof case and its request/child-timeout
cascade.

## Cause and boundary

The collision is fixture reuse, not production behavior: production correctly
rejects a sidecar whose ownership conflicts with the requested Broker run.
That fail-closed Broker gate remains covered and unchanged.

## Fix

`integratedFixture()` now owns a temporary arena and allocates each synthetic
run a unique run ID plus an `async-` `mkdtemp` directory. The arena is disposed
through `t.after`, so no test reads or deletes a pre-existing sidecar. The
unrelated-run fixture also emits its deterministic synthetic completion rather
than waiting for a real child.
