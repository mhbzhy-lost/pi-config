import type { ManagedWorkspaceService } from "./registry.ts";

/** 读取仍用本地服务；处置与可信 proof 一同交给 coordinator 权威执行。 */
export function createCoordinatorDispositionFacade({ localService, coordinatorClient, resolveTerminalProof }: { localService: ManagedWorkspaceService; coordinatorClient: any; resolveTerminalProof?: (run: any) => unknown }): ManagedWorkspaceService {
  if (!localService || !coordinatorClient) throw new TypeError("workspace disposition facade requires coordinator client");
  function withProof(input: any) {
    const entry = localService.listOwned({ ownerScope: input.ownerScope }).find((candidate: any) => candidate.workspaceId === input.workspaceId);
    if (!entry) throw Object.assign(new Error("workspace does not belong to this owner"), { code: "MANAGED_WORKSPACE_OWNER_SCOPE" });
    const fresh: any = resolveTerminalProof?.(entry.run);
    const proof = fresh?.state === "observed" ? fresh : entry.terminalProof ?? fresh;
    return { ...input, ...(proof === undefined || proof === null ? {} : { terminalProof: proof }) };
  }
  return Object.freeze({
    ...localService,
    issueOwnedDisposition: (input: any) => coordinatorClient.issueOwnedDisposition(withProof(input)),
    disposeOwned: (input: any) => coordinatorClient.disposeOwned(withProof(input)),
    releaseOwned: (input: any) => coordinatorClient.releaseOwned(withProof(input)),
  });
}
