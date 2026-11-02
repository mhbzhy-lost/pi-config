// 旧 PI_COORDINATOR_* env 形协调进程入口：收敛为新 daemon 的 wrapper，
// 消灭「无登记、无归零退出」的旧 server 形态（D8）。env 协议保持兼容；
// 内部走 runCoordinatorDaemon 的完整生命周期（startupReady 登记由
// PI_COORDINATOR_COMMON_DIR 是否提供决定；归零宽限可用
// PI_COORDINATOR_IDLE_EXIT_GRACE_MS 覆盖；stdout 就绪行契约不变）。
import { runCoordinatorDaemon } from "./coordinator-daemon.ts";

export async function startCoordinatorProcess(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const endpoint = environment.PI_COORDINATOR_ENDPOINT;
  const repositoryId = environment.PI_COORDINATOR_REPOSITORY_ID;
  const storageRepositoryId = environment.PI_COORDINATOR_STORAGE_REPOSITORY_ID ?? repositoryId;
  const instanceId = environment.PI_COORDINATOR_INSTANCE_ID;
  const stateRoot = environment.PI_COORDINATOR_STATE_ROOT;
  const capability = environment.PI_COORDINATOR_CAPABILITY;
  const commonDir = environment.PI_COORDINATOR_COMMON_DIR;
  const graceText = environment.PI_COORDINATOR_IDLE_EXIT_GRACE_MS;
  // D8：wrapper 必须带 commonDir，daemon 自行登记 metadata（消灭无登记形态）。
  if (!endpoint || !repositoryId || !instanceId || !stateRoot || !capability || !commonDir) throw new Error("Coordinator process environment is incomplete");
  const idleExitGraceMs = graceText === undefined ? undefined : Number(graceText);
  if (idleExitGraceMs !== undefined && (!Number.isSafeInteger(idleExitGraceMs) || idleExitGraceMs <= 0)) {
    throw new Error("PI_COORDINATOR_IDLE_EXIT_GRACE_MS must be a positive integer");
  }
  // env 形态保留原始终端输出（stdout 就绪行由测试消费），不重定向日志文件。
  const code = await runCoordinatorDaemon({ stateRoot, repositoryId, storageRepositoryId, endpoint, instanceId, commonDir, idleExitGraceMs, logToFile: false });
  if (code !== 0) throw new Error(`Coordinator daemon exited with code ${code}`);
}

if (process.env.PI_COORDINATOR_ENDPOINT) await startCoordinatorProcess();
