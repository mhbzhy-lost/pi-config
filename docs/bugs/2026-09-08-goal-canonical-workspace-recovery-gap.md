# Canonical workspace recovery gap (2026-09-08)

## Root cause

`goal_status` consulted orphan inventory only for `pending` tasks.  The public
allocation sequence durably writes `task.dispatch_requested` before the service
allocates; if the subsequent `task.workspace_allocated` append fails, the Goal
is therefore `dispatch_requested` with a durable service receipt but status did
not inspect that attempt.

`goal_integrate` also required the Goal workspace snapshot to be `active`
before inspecting the service.  A disposition receipt append failure leaves a
durable `managedDisposition` intent and a released service receipt, so retry
rejected before it could append the missing Goal receipt.

## Fix

Recovery derives the orphan candidate from the durable dispatch request and
requires its exact workspace ID, owner revision, root session, origin, task,
and attempt to match the authoritative service inventory before a challenge is
issued.  `goal_integrate` now inspects a terminal service receipt before its
active gate and, only for an exact matching existing intent, appends the missing
Goal receipt without another service disposition.
