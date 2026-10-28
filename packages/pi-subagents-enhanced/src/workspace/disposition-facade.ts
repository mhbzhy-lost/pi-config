import type { ManagedWorkspaceService } from "./registry.ts";

/** 读取仍用本地服务；处置与可信 proof 一同交给 coordinator 权威执行。 */
export function createCoordinatorDispositionFacade({ localService, coordinatorClient, resolveCoordinatorClient, resolveTerminalProof }: { localService: ManagedWorkspaceService; coordinatorClient?: any; resolveCoordinatorClient?: (entry: any) => Promise<any>; resolveTerminalProof?: (run: any) => unknown }): ManagedWorkspaceService {
  if (!localService || (!coordinatorClient && !resolveCoordinatorClient)) throw new TypeError("workspace disposition facade requires coordinator client");
  async function dispatch(operation: string, input: any) {
    const entries = localService.listOwned({ ownerScope: input.ownerScope }).filter((candidate: any) => candidate.workspaceId === input.workspaceId);
    if (entries.length !== 1) throw Object.assign(new Error("workspace does not belong uniquely to this owner"), { code: "MANAGED_WORKSPACE_OWNER_SCOPE" });
    const entry = entries[0];
    // 同一回执同时决定 client 与 proof；不得通过远端 listOwned 反推仓库。
    const client = resolveCoordinatorClient ? await resolveCoordinatorClient(entry) : coordinatorClient;
    const fresh: any = resolveTerminalProof?.(entry.run);
    const proof = fresh?.state === "observed" ? fresh : entry.terminalProof ?? fresh;
    return client[operation]({ ...input, ...(proof === undefined || proof === null ? {} : { terminalProof: proof }) });
  }
  return Object.freeze({
    ...localService,
    issueOwnedDisposition: (input: any) => dispatch("issueOwnedDisposition", input),
    disposeOwned: (input: any) => dispatch("disposeOwned", input),
    releaseOwned: (input: any) => dispatch("releaseOwned", input),
  });
}
