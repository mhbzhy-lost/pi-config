export const LIFECYCLE_POLICY_VERSION = "lifecycle-policy.v1" as const;
export interface LifecyclePolicyV1 { version: typeof LIFECYCLE_POLICY_VERSION; heartbeatLeaseMs:60000; renewIntervalMs:15000; progressStallMs:1200000; continueLeaseMs:600000 }
export type Clock={now():number};
export function createLifecyclePolicyV1():LifecyclePolicyV1{return {version:LIFECYCLE_POLICY_VERSION,heartbeatLeaseMs:60000,renewIntervalMs:15000,progressStallMs:1200000,continueLeaseMs:600000};}
export function evaluateLeaseExpiry(input:{expiresAt:number;clock:Clock;policy?:LifecyclePolicyV1}){void input.policy;return input.clock.now()>=input.expiresAt;}
export type ProgressStatus="active"|"stalled-suspected";
export function classifyProgressStall(input:{lastProgressAt:number;clock:Clock;activity:string;policy:LifecyclePolicyV1}){const excluded=new Set(["active-async-bash","active-tool","supervisor-wait","provider-io"]);if(excluded.has(input.activity)||input.clock.now()-input.lastProgressAt<input.policy.progressStallMs)return {status:"active" as const};return {status:"stalled-suspected" as const,event:"progress_stalled"};}
export type LifecycleState="running"|"stalled-suspected"|"stopping"|"terminal"|"lease-expired";
export function transitionLifecycleState(state:LifecycleState,reason:string):LifecycleState { if(reason==="progress_stalled"&&state==="running")return "stalled-suspected";if(reason==="explicit_stop"&&state!=="terminal")return "stopping";if(reason==="authority_lease_expired"&&state!=="terminal")return "lease-expired";return state; }
export function resolveReplyOrSteer(input:{pendingSupervisor:boolean;running:boolean}){if(input.pendingSupervisor)return "reply" as const;if(input.running)return "steer" as const;return "blocked" as const;}
