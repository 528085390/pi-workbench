import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DEFAULT_PORT } from "@pi-workbench/shared";

/** 权限模式：auto_allow = 自动 allow_once；deny = 一律拒绝，留给人工接管 */
export type PermissionMode = "auto_allow" | "deny";

/** 控制面配置（后续任务消费：host / port / home / authToken / leaseTtlMs / claude.*） */
export type Config = {
  host: string;
  port: number;
  home: string;
  authToken: string | null;
  leaseTtlMs: number;
  claude: {
    adapterCmd: string[];
    permissionMode: PermissionMode;
  };
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto_allow";
/** A00 实测的 Claude ACP adapter（见 docs/evidence/phase-0.5a-a00.md） */
export const DEFAULT_ADAPTER_CMD: string[] = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
export const CONFIG_FILE_NAME = "config.yaml";
export const DEFAULT_HOME_DIRNAME = ".pi-workbench";

/** home 解析：PI_WORKBENCH_HOME 覆盖，默认 ~/.pi-workbench */
export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_WORKBENCH_HOME?.trim();
  return override !== undefined && override.length > 0 ? resolve(override) : join(homedir(), DEFAULT_HOME_DIRNAME);
}

/** config.yaml 的绝对路径 */
export function configPathOf(home: string): string {
  return join(resolve(home), CONFIG_FILE_NAME);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

function readToken(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return undefined;
}

function readPermissionMode(value: unknown, configPath: string): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto_allow" || value === "deny") return value;
  throw new Error(`配置错误：${configPath} 中 claude.permissionMode 必须是 "auto_allow" 或 "deny"，实际为 ${JSON.stringify(value)}`);
}

function readAdapterCmd(value: unknown, configPath: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0)) {
    return value as string[];
  }
  throw new Error(`配置错误：${configPath} 中 claude.adapterCmd 必须是非空字符串数组，实际为 ${JSON.stringify(value)}`);
}

function assertPort(port: number, origin: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`配置错误：${origin} 端口必须是 1-65535 的整数，实际为 ${String(port)}`);
  }
  return port;
}

function assertLeaseTtl(ttl: number, configPath: string): number {
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`配置错误：${configPath} 中 leaseTtlMs 必须是正整数，实际为 ${String(ttl)}`);
  }
  return ttl;
}

function readConfigFile(configPath: string): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  const text = readFileSync(configPath, "utf8");
  try {
    return asRecord(parseYaml(text));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`配置解析失败：${configPath} 不是合法 YAML（${reason}）。请修正该文件，或删除后由程序重新生成。`, {
      cause: err,
    });
  }
}

function toFileShape(cfg: Config): Record<string, unknown> {
  return {
    host: cfg.host,
    port: cfg.port,
    leaseTtlMs: cfg.leaseTtlMs,
    authToken: cfg.authToken,
    claude: {
      adapterCmd: cfg.claude.adapterCmd,
      permissionMode: cfg.claude.permissionMode,
    },
  };
}

/**
 * 读配置：$PI_WORKBENCH_HOME/config.yaml（缺省创建默认文件）。
 * env 覆盖 host / port / authToken（不写回文件）；文件缺字段时回填默认值并回写。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env);
  const configPath = configPathOf(home);
  mkdirSync(home, { recursive: true });

  const file = readConfigFile(configPath);
  const values = file ?? {};
  const claude = asRecord(values["claude"]);

  const fileHost = readString(values, "host");
  const filePort = readInt(values, "port");
  const fileTtl = readInt(values, "leaseTtlMs");
  const fileToken = readToken(values["authToken"]);
  const fileAdapter = readAdapterCmd(claude["adapterCmd"], configPath);
  const fileMode = readPermissionMode(claude["permissionMode"], configPath);

  // 落盘口径：只含文件值 + 默认值，不吸收 env 覆盖
  const persisted: Config = {
    host: fileHost ?? DEFAULT_HOST,
    port: assertPort(filePort ?? DEFAULT_PORT, configPath),
    home,
    authToken: fileToken ?? null,
    leaseTtlMs: assertLeaseTtl(fileTtl ?? DEFAULT_LEASE_TTL_MS, configPath),
    claude: {
      adapterCmd: fileAdapter ?? [...DEFAULT_ADAPTER_CMD],
      permissionMode: fileMode ?? DEFAULT_PERMISSION_MODE,
    },
  };

  const envHost = env.PI_WORKBENCH_HOST?.trim();
  const envPortRaw = env.PI_WORKBENCH_PORT?.trim();
  const envToken = env.PI_WORKBENCH_AUTH_TOKEN?.trim();

  const cfg: Config = {
    ...persisted,
    host: envHost !== undefined && envHost.length > 0 ? envHost : persisted.host,
    port:
      envPortRaw !== undefined && envPortRaw.length > 0
        ? assertPort(Number(envPortRaw), "PI_WORKBENCH_PORT")
        : persisted.port,
    authToken: envToken !== undefined && envToken.length > 0 ? envToken : persisted.authToken,
  };

  const needsWrite =
    file === null ||
    fileHost === undefined ||
    filePort === undefined ||
    fileTtl === undefined ||
    fileToken === undefined ||
    fileAdapter === undefined ||
    fileMode === undefined;

  if (needsWrite) {
    const header = `# pi-workbench 控制面配置（缺失字段会被自动回填）\n# home: ${home}\n`;
    writeFileSync(configPath, `${header}${stringifyYaml(toFileShape(persisted))}`, "utf8");
  }

  return cfg;
}
