# Goal suspension stop identity

## Root cause

`goal-runtime.v1` suspension stop derivation used projection-level `executionContractHash` and `runtimeBaseHead`. Those values describe the runtime episode, while the Broker persisted Goal binding authority is created from the dispatch ticket (`contractHash` and dispatch head). When they differ, a valid owned stop is rejected as an identity mismatch.

## Fix

The 13-field Host stop request now derives `contractHash` and `baseHead` from the durable executor dispatch/binding record (`contractHash` and `headAtDispatch`). Runtime-level values are not caller authority. Caller-supplied identity changes remain fail-closed, and Broker validation remains unchanged.

## Evidence

The suspension integration coverage asserts a valid stop with intentionally different runtime contract/base values, plus rejection for caller contract/base overrides. R10B coverage asserts the stop request matches dispatch binding authority.
