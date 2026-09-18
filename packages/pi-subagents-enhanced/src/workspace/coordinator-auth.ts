import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type BrokerRegistration = {
  brokerId: string;
  brokerProcessIdentity: string;
  repositoryId: string;
  capability: string;
  expiresAt?: number;
};

export type TrustedBrokerRegistration = {
  capability: string;
  role: "root-broker";
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string };
  brokerProcessIdentity: string;
  repositoryId: string;
  coordinatorInstanceId: string;
};

export function createChallenge(): string { return randomBytes(32).toString("hex"); }

export function signChallenge(challenge: string, secret: string): string {
  return createHash("sha256").update(`${secret}\0${challenge}`).digest("hex");
}

export function verifyChallenge(challenge: string, proof: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(proof)) return false;
  const expected = signChallenge(challenge, secret);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(proof));
}

export function validateBrokerRegistration(registration: BrokerRegistration, repositoryId: string): BrokerRegistration {
  if (!registration || registration.repositoryId !== repositoryId || !/^[a-f0-9]{64}$/.test(registration.capability)
    || !registration.brokerId || !registration.brokerProcessIdentity) throw new Error("Invalid or foreign broker registration");
  if (registration.expiresAt !== undefined && registration.expiresAt <= Date.now()) throw new Error("Broker registration expired");
  return Object.freeze({ ...registration });
}
