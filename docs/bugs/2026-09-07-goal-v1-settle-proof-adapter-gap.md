# v1 settle canonical-proof adapter gap

## Provenance

The production path is `goal_dispatch` → Host-authorized strict v1 executor binding → Root Broker owned run → runner-written official `process-terminal.json` → `goal_settle`. The immutable v1 binding anchors run ID, async directory, workspace receipt, attempt, contract hash and dispatch head.

## First deviation

`goal_settle` only populated `runProof` for v2 `runBinding`; planned/runtime v1 used `executorBinding`, but never awaited the T2 canonical async inspector and never set `executorProof`. The v1 reducer then rejected the settlement or treated the terminal proof as missing. This is production reachable when the in-memory terminal event is gone while the official observed sidecar remains.

## Resolution boundary

Settlement now awaits only the T2 registry async inspector for v1 and passes its already verified canonical result through `executionProofForLegacyTask()`. That adapter only removes the transport-only agent profile and checks the immutable v1 binding before the reducer. It does not read `status.json`, logs, caller evidence, or any alternate sidecar.

Missing, unsafe, malformed, foreign, pending, identity-conflicting, or terminal-conflicting inspector results remain `EXECUTOR_TERMINAL_PROOF_MISSING`; succeeded settlements require terminal outcome `succeeded`, while failed/blocked settlements preserve the verified terminal outcome.
