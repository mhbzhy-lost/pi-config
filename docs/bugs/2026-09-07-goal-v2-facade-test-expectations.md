# Goal v2 and facade test expectation drift

## Classification

The three focused failures were stale test expectations, not production regressions:

- `planned.v2` direct dispatch is frozen/read-only. It must not mint a run-binding ticket; historical v2 reducer replay remains covered.
- An untrusted started/facade lifecycle event is observable for UI and lifecycle state, but has neither a broker grant nor an executor settlement proof.
- A generic authorization has no broker capabilities and is likewise not an executor settlement authority.

## Security decision

Settlement proof requires a registered, deeply frozen Host `RunAuthorization` with Goal authority bound to the run. Facade observation is not authority and must not be used to restore v2 dispatch writing or privileged broker capabilities.
