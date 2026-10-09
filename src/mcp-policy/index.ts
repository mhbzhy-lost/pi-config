import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createCodemodeExtension, createMcpExtension, getAgentDir, type ExtensionAPI, type McpServerConfig, type LoadedMcpConfig } from '@earendil-works/pi-coding-agent';

type ServerPolicy = { connection: McpServerConfig; tools: Record<string, 'direct' | 'codemode'>; resources?: boolean };
type McpPolicy = { servers: Record<string, ServerPolicy> };
const NAME = /^[A-Za-z0-9_]+$/u;
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** 唯一配置来源是自有连接定义；不读取或合并本机global/project MCP文件。 */
export function loadMcpPolicy(agentDir: string): McpPolicy {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(join(agentDir, 'extensions/mcp-policy/config.json'), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return { servers: {} }; throw error; }
  if (!record(raw) || Object.keys(raw).some(key => key !== 'servers') || !record(raw.servers)) throw new Error('MCP策略必须提供servers对象');
  const servers: Record<string, ServerPolicy> = {};
  for (const [name, value] of Object.entries(raw.servers)) {
    if (!NAME.test(name) || !record(value) || Object.keys(value).some(key => !['connection', 'tools', 'resources'].includes(key)) || !record(value.connection) || !record(value.tools)) throw new Error('MCP server或tool名单非法');
    if (value.resources !== undefined && typeof value.resources !== 'boolean') throw new Error('MCP resources必须为boolean');
    if (Object.entries(value.tools).some(([tool, exposure]) => !NAME.test(tool) || !['direct', 'codemode'].includes(String(exposure)))) throw new Error('MCP tool名单只允许精确名称与direct/codemode');
    const connection = value.connection;
    if (Object.keys(connection).some(key => !['command', 'args', 'cwd', 'env', 'url', 'headers', 'timeout', 'description'].includes(key))) throw new Error('MCP连接含非允许字段');
    if ('command' in connection === ('url' in connection)) throw new Error('MCP连接必须且只能指定command或url');
    if ('command' in connection && (typeof connection.command !== 'string' || !isAbsolute(connection.command))) throw new Error('MCP command必须为绝对路径');
    if (connection.args !== undefined && (!Array.isArray(connection.args) || connection.args.some(x => typeof x !== 'string'))) throw new Error('MCP args非法');
    if ('url' in connection) {
      if (typeof connection.url !== 'string') throw new Error('MCP url非法');
      const url = new URL(connection.url);
      if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('MCP url不允许凭据或非安全传输');
    }
    servers[name] = { connection: connection as unknown as McpServerConfig, tools: value.tools as ServerPolicy['tools'], resources: value.resources === true };
  }
  return { servers };
}

/** 公开MCP扩展替换builtin:mcp，连接与工具授权共用同一份显式策略。 */
export function registerMcpPolicy(pi: ExtensionAPI, { agentDir = getAgentDir() }: { agentDir?: string } = {}) {
  let policy: McpPolicy = { servers: {} };
  const connectedNames = new Set<string>();
  const api = new Proxy(pi, { get(target, key, receiver) {
    // 连接来源只有策略的connection；extension动态注册不能覆盖同名连接。
    if (key === 'getMcpServers') return () => [];
    return Reflect.get(target, key, receiver);
  } });
  createMcpExtension({
    loadConfig(ctx): LoadedMcpConfig {
      policy = loadMcpPolicy(agentDir);
      connectedNames.clear();
      return { servers: Object.entries(policy.servers).map(([name, server]) => {
        connectedNames.add(name);
        return { name, scope: 'global', source: join(agentDir, 'extensions/mcp-policy/config.json'), config: { ...server.connection, exposure: server.resources ? 'codemode' : 'hidden', toolExposure: { ...server.tools, '*': 'hidden' } } };
      }), autoEnableCodemode: true, errors: [] };
    },
    // /mcp仅检查状态；连接或名单变化要求fresh Host，不允许内置manager修改authority。
    updateConfig() { throw new Error('MCP策略变化需要修改显式配置并启动fresh Host'); },
  })(api);
  pi.on('tool_call', event => {
    const tool = event.toolName;
    if (tool.startsWith('mcp__')) {
      const match = /^mcp__([A-Za-z0-9_]+)__([A-Za-z0-9_]+)$/u.exec(tool);
      if (!match || !connectedNames.has(match[1]) || !Object.hasOwn(policy.servers[match[1]].tools, match[2])) return { block: true, reason: 'MCP_TOOL_NOT_ALLOWED' };
    }
    if (['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(tool)) {
      const input = event.input as Record<string, unknown>;
      const server = typeof input?.server === 'string' ? input.server : undefined;
      if (server ? policy.servers[server]?.resources !== true : Object.values(policy.servers).some(s => s.resources !== true)) return { block: true, reason: 'MCP_RESOURCE_NOT_ALLOWED' };
    }
  });
}

/** 禁用脚本模型入口，官方codemode实现保持不变。 */
export function registerConfiguredToolRuntime(pi: ExtensionAPI): void {
  createCodemodeExtension({ mode: 'on', models: false })(pi);
  registerMcpPolicy(pi);
}
