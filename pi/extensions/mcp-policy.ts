import { registerConfiguredToolRuntime } from "../../src/mcp-policy/index.ts";

// 入口仅绑定Host API，名单与业务实现在feature-owned模块。
export default registerConfiguredToolRuntime;
