import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DEFAULT_PORT } from "@pi-workbench/shared";

/** 权限模式：auto_allow = 自动 allow_once；deny = 一律拒绝，留给人工接管 */
export type PermissionMode = "auto_allow" | "deny";

/** 控制面配置（后续任务消费：host / port / home / authToken / leaseTtlMs / claude.* / codex.* / pi.*） */
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
  codex: {
    adapterCmd: string[];
    permissionMode: PermissionMode;
  };
  pi: {
    rpcCmd: string[];
    provider?: string;
    model?: string;
  };
};

export const DEFAULT_HOST = "127.0.0.1";
/** 默认租约 TTL（毫秒）：唯一来源，`lease.ts` 直接 import 复用，勿另起同名常量。 */
export const DEFAULT_LEASE_TTL_MS = 30_000;
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto_allow";
/**
 * Claude ACP adapter 的回落启动命令：本地装不到 `@agentclientprotocol/claude-agent-acp` 时才用。
 * A00 实测入口见 docs/evidence/phase-0.5a-a00.md；优先走 `resolveDefaultAdapterCmd` 的本地入口。
 */
export const FALLBACK_ADAPTER_CMD: string[] = ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
/** Codex ACP adapter 的回落启动命令（规格 §8：npm 包锁定 2.6.0）。 */
export const FALLBACK_CODEX_ADAPTER_CMD: string[] = ["npx", "-y", "@agentclientprotocol/codex-acp@2.6.0"];
/** Pi 的 RPC 子进程启动命令（规格 §9：`pi --mode rpc`）。 */
export const DEFAULT_PI_RPC_CMD: string[] = ["pi", "--mode", "rpc"];
/** 包路径解析器（默认 createRequire；测试注入以覆盖两条分支） */
export type ModuleResolver = (specifier: string) => string;

const requireFromHere = createRequire(import.meta.url);

/**
 * 惰性解析默认 adapter 命令（R14）：
 * - 能解析到 `@agentclientprotocol/claude-agent-acp` 包 → `[node, <包入口>]`（省掉 npx 冷启动）；
 * - 解析不到（未安装 / 解析器抛错）→ 回落 `["npx","-y","@agentclientprotocol/claude-agent-acp"]`。
 * 入口取 package.json 的 `bin`（对象取第一个值）或 `main`，拼成包内绝对路径。
 */
export function resolveDefaultAdapterCmd(resolveModule: ModuleResolver = requireFromHere.resolve): string[] {
  return resolvePackageCmd(ADAPTER_PKG_SPECIFIER, FALLBACK_ADAPTER_CMD, resolveModule);
}

/** Codex ACP 的同款解析（0.5-B B01-a；装不到 codex-acp 时回落 npx 2.6.0） */
export function resolveDefaultCodexAdapterCmd(resolveModule: ModuleResolver = requireFromHere.resolve): string[] {
  return resolvePackageCmd(CODEX_ADAPTER_PKG_SPECIFIER, FALLBACK_CODEX_ADAPTER_CMD, resolveModule);
}

function resolvePackageCmd(specifier: string, fallback: string[], resolveModule: ModuleResolver): string[] {
  try {
    const pkgPath = resolveModule(specifier);
    const entry = readPackageEntry(JSON.parse(readFileSync(pkgPath, "utf8")) as unknown);
    if (entry !== undefined) {
      return [process.execPath, join(dirname(pkgPath), entry)];
    }
  } catch {
    // 未安装 / package.json 不可读：走 npx 回落
  }
  return [...fallback];
}

const ADAPTER_PKG_SPECIFIER = "@agentclientprotocol/claude-agent-acp/package.json";
const CODEX_ADAPTER_PKG_SPECIFIER = "@agentclientprotocol/codex-acp/package.json";

/** 从 package.json 里挑一个可执行的入口：bin（对象取第一个值 / 字符串直接用）优先，其次 main */
function readPackageEntry(pkg: unknown): string | undefined {
  if (typeof pkg !== "object" || pkg === null) {
    return undefined;
  }
  const record = pkg as { bin?: unknown; main?: unknown };
  const bin = record.bin;
  if (typeof bin === "string" && bin.length > 0) {
    return bin;
  }
  if (typeof bin === "object" && bin !== null) {
    for (const value of Object.values(bin as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return typeof record.main === "string" && record.main.length > 0 ? record.main : undefined;
}
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

function readPermissionMode(
  value: unknown,
  configPath: string,
  key: string = "claude.permissionMode",
): PermissionMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto_allow" || value === "deny") return value;
  throw new Error(`配置错误：${configPath} 中 ${key} 必须是 "auto_allow" 或 "deny"，实际为 ${JSON.stringify(value)}`);
}

function readCommand(value: unknown, configPath: string, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.length > 0)) {
    return value as string[];
  }
  throw new Error(`配置错误：${configPath} 中 ${key} 必须是非空字符串数组，实际为 ${JSON.stringify(value)}`);
}

function readAdapterCmd(value: unknown, configPath: string): string[] | undefined {
  return readCommand(value, configPath, "claude.adapterCmd");
}

/**
 * env 命令覆盖：接受 JSON 数组（`["codex-acp","--stdio"]`）或空白分隔的命令字符串。
 * 只影响运行值，不写回 config.yaml（与 host / port / token 的 env 口径一致）。
 */
function parseCommandEnv(raw: string | undefined, name: string): string[] | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  let parsed: unknown;
  if (trimmed.startsWith("[")) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`配置错误：${name} 不是合法 JSON 数组（${reason}）`);
    }
  } else {
    parsed = trimmed.split(/\s+/);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part): part is string => typeof part === "string" && part.length > 0)) {
    throw new Error(`配置错误：${name} 必须是非空命令数组或命令字符串`);
  }
  return parsed;
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
  const pi: Record<string, unknown> = { rpcCmd: cfg.pi.rpcCmd };
  if (cfg.pi.provider !== undefined) {
    pi["provider"] = cfg.pi.provider;
  }
  if (cfg.pi.model !== undefined) {
    pi["model"] = cfg.pi.model;
  }
  return {
    host: cfg.host,
    port: cfg.port,
    leaseTtlMs: cfg.leaseTtlMs,
    authToken: cfg.authToken,
    claude: {
      adapterCmd: cfg.claude.adapterCmd,
      permissionMode: cfg.claude.permissionMode,
    },
    codex: {
      adapterCmd: cfg.codex.adapterCmd,
      permissionMode: cfg.codex.permissionMode,
    },
    pi,
  };
}

/**
 * 读配置：$PI_WORKBENCH_HOME/config.yaml（缺省创建默认文件）。
 * env 覆盖 host / port / authToken / codex.adapterCmd / pi.rpcCmd（不写回文件）；
 * 文件缺字段时回填默认值并回写。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env);
  const configPath = configPathOf(home);
  mkdirSync(home, { recursive: true });

  const file = readConfigFile(configPath);
  const values = file ?? {};
  const claude = asRecord(values["claude"]);
  const codex = asRecord(values["codex"]);
  const pi = asRecord(values["pi"]);

  const fileHost = readString(values, "host");
  const filePort = readInt(values, "port");
  const fileTtl = readInt(values, "leaseTtlMs");
  const fileToken = readToken(values["authToken"]);
  const fileAdapter = readAdapterCmd(claude["adapterCmd"], configPath);
  const fileMode = readPermissionMode(claude["permissionMode"], configPath, "claude.permissionMode");
  const fileCodexAdapter = readCommand(codex["adapterCmd"], configPath, "codex.adapterCmd");
  const fileCodexMode = readPermissionMode(codex["permissionMode"], configPath, "codex.permissionMode");
  const filePiCmd = readCommand(pi["rpcCmd"], configPath, "pi.rpcCmd");
  const filePiProvider = readString(pi, "provider");
  const filePiModel = readString(pi, "model");

  // 落盘口径：只含文件值 + 默认值，不吸收 env 覆盖
  const persisted: Config = {
    host: fileHost ?? DEFAULT_HOST,
    port: assertPort(filePort ?? DEFAULT_PORT, configPath),
    home,
    authToken: fileToken ?? null,
    leaseTtlMs: assertLeaseTtl(fileTtl ?? DEFAULT_LEASE_TTL_MS, configPath),
    claude: {
      adapterCmd: fileAdapter ?? resolveDefaultAdapterCmd(),
      permissionMode: fileMode ?? DEFAULT_PERMISSION_MODE,
    },
    codex: {
      adapterCmd: fileCodexAdapter ?? resolveDefaultCodexAdapterCmd(),
      permissionMode: fileCodexMode ?? DEFAULT_PERMISSION_MODE,
    },
    pi: {
      rpcCmd: filePiCmd ?? [...DEFAULT_PI_RPC_CMD],
      ...(filePiProvider === undefined ? {} : { provider: filePiProvider }),
      ...(filePiModel === undefined ? {} : { model: filePiModel }),
    },
  };

  const envHost = env.PI_WORKBENCH_HOST?.trim();
  const envPortRaw = env.PI_WORKBENCH_PORT?.trim();
  // 兼容两个名字：daemon 侧历史上用 PI_WORKBENCH_AUTH_TOKEN，客户端/CLI/e2e 用 PI_WORKBENCH_TOKEN。
  // 只认前者时，用后者启动的 daemon 会「静默无鉴权」——所以两个都认，AUTH_TOKEN 优先。
  const envToken = (env.PI_WORKBENCH_AUTH_TOKEN ?? env.PI_WORKBENCH_TOKEN)?.trim();
  const envCodexCmd = parseCommandEnv(env.PI_WORKBENCH_CODEX_CMD, "PI_WORKBENCH_CODEX_CMD");
  const envPiCmd = parseCommandEnv(env.PI_WORKBENCH_PI_CMD, "PI_WORKBENCH_PI_CMD");

  const cfg: Config = {
    ...persisted,
    host: envHost !== undefined && envHost.length > 0 ? envHost : persisted.host,
    port:
      envPortRaw !== undefined && envPortRaw.length > 0
        ? assertPort(Number(envPortRaw), "PI_WORKBENCH_PORT")
        : persisted.port,
    authToken: envToken !== undefined && envToken.length > 0 ? envToken : persisted.authToken,
    codex: {
      ...persisted.codex,
      adapterCmd: envCodexCmd ?? persisted.codex.adapterCmd,
    },
    pi: {
      ...persisted.pi,
      rpcCmd: envPiCmd ?? persisted.pi.rpcCmd,
    },
  };

  const needsWrite =
    file === null ||
    fileHost === undefined ||
    filePort === undefined ||
    fileTtl === undefined ||
    fileToken === undefined ||
    fileAdapter === undefined ||
    fileMode === undefined ||
    fileCodexAdapter === undefined ||
    fileCodexMode === undefined ||
    filePiCmd === undefined;

  if (needsWrite) {
    const header = `# pi-workbench 控制面配置（缺失字段会被自动回填）\n# home: ${home}\n`;
    writeFileSync(configPath, `${header}${stringifyYaml(toFileShape(persisted))}`, "utf8");
  }

  return cfg;
}
