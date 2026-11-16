/**
 * C05 资产只读清单（Task 10）。
 *
 * 规格：docs/specs/2026-11-17-phase-0.5c-control-plane-hardening.md §7.5。
 * 只读：只读 ~/.pi-workbench/assets.json，不回写 Agent 配置、不启动 MCP server。
 * 文件缺失 = 空清单；JSON 非法或结构不对 = E_ASSET_CONFIG_INVALID（HTTP 400）。
 */
import { existsSync, readFileSync } from "node:fs";

import { WorkbenchError } from "./errors.ts";

export type McpServerEntry = {
  name: string;
  transport: string;
  command?: string[];
  exists?: boolean;
};

export type SkillEntry = {
  name: string;
  path: string;
  exists: boolean;
};

export type AssetsInventory = {
  mcpServers: McpServerEntry[];
  skills: SkillEntry[];
  memory: { projection: "disabled" };
};

export type LoadAssetsOptions = {
  /** 覆盖「路径存在」判断（测试注入；默认 existsSync） */
  fileExists?: (path: string) => boolean;
};

const MEMORY_DISABLED = { projection: "disabled" } as const;

function emptyInventory(): AssetsInventory {
  return { mcpServers: [], skills: [], memory: { ...MEMORY_DISABLED } };
}

function invalid(filePath: string, reason: string): WorkbenchError {
  return new WorkbenchError("E_ASSET_CONFIG_INVALID", "assets.json 格式错误：" + reason, {
    path: filePath,
    reason,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpServers(value: unknown, filePath: string): McpServerEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid(filePath, "mcpServers 必须是数组");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw invalid(filePath, `mcpServers[${String(index)}] 必须是对象`);
    }
    const { name, transport, command } = item;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw invalid(filePath, `mcpServers[${String(index)}].name 必须是非空字符串`);
    }
    if (typeof transport !== "string" || transport.trim().length === 0) {
      throw invalid(filePath, `mcpServers[${String(index)}].transport 必须是非空字符串`);
    }
    if (command !== undefined && (!Array.isArray(command) || command.some((part) => typeof part !== "string"))) {
      throw invalid(filePath, `mcpServers[${String(index)}].command 必须是字符串数组`);
    }
    return {
      ...item,
      name,
      transport,
      ...(command === undefined ? {} : { command }),
    } as McpServerEntry;
  });
}

function parseSkills(
  value: unknown,
  filePath: string,
  fileExists: (path: string) => boolean,
): SkillEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalid(filePath, "skills 必须是数组");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw invalid(filePath, `skills[${String(index)}] 必须是对象`);
    }
    const { name, path } = item;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw invalid(filePath, `skills[${String(index)}].name 必须是非空字符串`);
    }
    if (typeof path !== "string") {
      throw invalid(filePath, `skills[${String(index)}].path 必须是字符串`);
    }
    return {
      ...item,
      name,
      path,
      exists: path.length > 0 && fileExists(path),
    } as SkillEntry;
  });
}

/**
 * 读资产清单。文件缺失返回空清单；其余读取 / 解析 / 结构错误统一抛
 * E_ASSET_CONFIG_INVALID（server 的错误映射表把它落成 400）。
 */
export function loadAssets(filePath: string, opts: LoadAssetsOptions = {}): AssetsInventory {
  const fileExists = opts.fileExists ?? existsSync;
  if (!fileExists(filePath)) {
    return emptyInventory();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw invalid(filePath, "JSON 解析失败：" + (err instanceof Error ? err.message : String(err)));
  }
  if (!isRecord(parsed)) {
    throw invalid(filePath, "顶层必须是 JSON 对象");
  }

  return {
    mcpServers: parseMcpServers(parsed.mcpServers, filePath),
    skills: parseSkills(parsed.skills, filePath, fileExists),
    memory: { ...MEMORY_DISABLED },
  };
}
