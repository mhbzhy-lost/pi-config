import { createCoordinatorServer } from "./coordinator-server.ts";

export async function startCoordinatorProcess(environment: NodeJS.ProcessEnv = process.env) {
  const endpoint = environment.PI_COORDINATOR_ENDPOINT;
  const repositoryId = environment.PI_COORDINATOR_REPOSITORY_ID;
  const storageRepositoryId = environment.PI_COORDINATOR_STORAGE_REPOSITORY_ID ?? repositoryId;
  const instanceId = environment.PI_COORDINATOR_INSTANCE_ID;
  const stateRoot = environment.PI_COORDINATOR_STATE_ROOT;
  const capability = environment.PI_COORDINATOR_CAPABILITY;
  if (!endpoint || !repositoryId || !instanceId || !stateRoot || !capability) throw new Error("Coordinator process environment is incomplete");
  const instance = createCoordinatorServer({ endpoint, repositoryId, storageRepositoryId, instanceId, stateRoot, capability });
  await instance.listen();
  process.stdout.write(`${JSON.stringify({ protocol: "repository-workspace-coordinator.v1", repositoryId, storageRepositoryId, instanceId, endpoint })}\n`);
  const stop = () => void instance.close();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  return instance;
}

if (process.env.PI_COORDINATOR_ENDPOINT) await startCoordinatorProcess();
