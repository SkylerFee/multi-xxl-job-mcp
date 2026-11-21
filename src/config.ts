/**
 * 配置模块：从配置文件读取多系统 × 多环境的 XXL-JOB 连接信息。
 *
 * 设计要点：
 * - 主流程为纯函数，路径与平台均由调用方传入，便于单测
 * - 支持 YAML 与 JSON（YAML 是 JSON 超集，同一解析器即可）
 * - 字段值支持 ${VAR} 环境变量插值，未设置的变量直接报错而非静默传空串
 * - 结构错误在启动时即暴露；凭据有效性留到首次使用时由 client 校验
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** 单个环境（某系统下的一套调度中心连接） */
export interface EnvConfig {
  /** 调度中心地址，如 http://127.0.0.1:8080/xxl-job-admin（不带末尾斜杠） */
  url: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码（可能来自 ${VAR} 插值） */
  password: string;
  /** HTTP 超时（毫秒），默认 15000 */
  timeoutMs: number;
  /**
   * 该环境的 url / username / password 中是否有字段引用了 ${VAR} 环境变量。
   *
   * 解析后原始字符串已不可得，故在解析时就地标记，供 list_instances / describe 展示。
   * 仅表示"用过插值"，不代表变量值来自何处；不参与寻址，也不影响客户端行为。
   */
  usesEnvVars?: boolean;
}

/** 单个系统：一个业务系统下的一组环境 */
export interface SystemConfig {
  /** 系统的可读名称，仅用于展示，不参与寻址；缺省时由调用方回落到系统键名 */
  alias?: string;
  /** 环境名 -> 环境配置 */
  instances: Record<string, EnvConfig>;
}

/** 整份配置：系统名 -> 系统配置 */
export interface ConfigFile {
  systems: Record<string, SystemConfig>;
}

/** 配置目录名，三个平台统一使用 */
const APP_DIR = "multi-xxl-job-mcp";

/** 配置文件名 */
const CONFIG_FILE_NAME = "config.yaml";

/** 系统名与环境名的合法字符集（避免 YAML 键名与调用参数产生歧义） */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** 匹配 ${VAR} 形式的环境变量引用，用于判定某字段是否用了插值 */
const ENV_VAR_REF_PATTERN = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

/**
 * 判断某个原始字段值是否引用了 ${VAR} 环境变量。
 *
 * 只有字符串才可能带插值；YAML 把纯数字密码解析成 number 的情形必然不含变量。
 *
 * @param raw 插值前的原始值
 */
function hasEnvVarRef(raw: unknown): boolean {
  return typeof raw === "string" && ENV_VAR_REF_PATTERN.test(raw);
}

/** 默认 HTTP 超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 15000;

/** 权限检查掩码：除属主外任何权限位被置位都算宽松 */
const PERMISSIVE_MODE_MASK = 0o077;

/** 配置加载的附加选项，供测试与调用方控制 */
export interface LoadOptions {
  /** 环境变量表，默认 process.env */
  env?: Record<string, string | undefined>;
  /** 文件权限不安全时是否直接拒绝（默认 false，仅告警） */
  strictPermissions?: boolean;
}

/** 配置加载失败时抛出的错误，携带便于排查的上下文 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * 返回配置文件的标准路径。
 *
 * **三个平台使用同一条规则**：`$XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml`，
 * 未设置 XDG_CONFIG_HOME 时为 `~/.config/multi-xxl-job-mcp/config.yaml`。
 *
 * 为什么不按平台各用原生惯例（macOS 的 Application Support、Windows 的 APPDATA）：
 * 那会让同一份文档要写三套路径，用户跨平台时要重新记一遍，排查配置问题时
 * 也无法照着别人的路径去找。命令行工具不遵守 Apple 的 GUI 惯例是常态
 * （gh、opencode、redis-mcp 都用 ~/.config），本项目也一样。
 *
 * Windows 下 `~` 由 os.homedir() 解析为 %USERPROFILE%，路径形如
 * C:\Users\<user>\.config\multi-xxl-job-mcp\config.yaml。
 *
 * @param _platform 保留参数以便调用方显式传平台，路径本身已不再依赖它
 * @param env 环境变量表，用于读取 XDG_CONFIG_HOME
 * @param home 用户主目录，默认 os.homedir()；测试可注入
 */
export function resolveConfigPath(
  _platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() ? xdg : join(home, ".config");
  return join(base, APP_DIR, CONFIG_FILE_NAME);
}

/**
 * 把字段值中的 ${VAR} 替换为环境变量的值。
 *
 * 变量缺失时抛错，避免把空串当密码静默提交给调度中心。
 *
 * @param value 原始字符串
 * @param env 环境变量表
 * @param fieldPath 用于错误信息的字段位置描述
 */
export function interpolate(
  value: string,
  env: Record<string, string | undefined>,
  fieldPath: string,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new ConfigError(
        "配置字段 " + fieldPath + " 引用了未设置的环境变量 ${" + name + "}",
      );
    }
    return resolved;
  });
}

/**
 * 断言某个值可转为非空字符串，否则抛出带位置信息的错误。
 *
 * 允许数字是有意为之：YAML 会把形如 123456 的纯数字密码解析成 number，
 * 若直接拒绝会让用户得到一条难以理解的错误，而这类密码很常见。
 *
 * @param raw 原始值
 * @param fieldPath 用于错误信息的字段位置
 */
function requireString(raw: unknown, fieldPath: string): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new ConfigError("配置字段 " + fieldPath + " 必须是非空字符串");
  }
  return raw;
}

/**
 * 校验并规范化单个环境配置。
 *
 * @param raw 原始值
 * @param path 字段路径（如 systems.order.instances.dev）
 * @param env 环境变量表
 */
function parseEnvConfig(
  raw: unknown,
  path: string,
  env: Record<string, string | undefined>,
): EnvConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("配置字段 " + path + " 必须是对象");
  }
  const obj = raw as Record<string, unknown>;

  // 插值前先记录"是否用过环境变量"，插值后原始字符串就丢了
  const usesEnvVars =
    hasEnvVarRef(obj.url) || hasEnvVarRef(obj.username) || hasEnvVarRef(obj.password);

  const url = interpolate(requireString(obj.url, path + ".url"), env, path + ".url").replace(/\/+$/, "");
  const username = interpolate(requireString(obj.username, path + ".username"), env, path + ".username");
  if (username.trim() === "") {
    throw new ConfigError("配置字段 " + path + ".username 插值后不能为空");
  }
  const password = interpolate(requireString(obj.password, path + ".password"), env, path + ".password");
  if (password === "") {
    throw new ConfigError("配置字段 " + path + ".password 插值后不能为空");
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (obj.timeoutMs !== undefined && obj.timeoutMs !== null) {
    const n = Number(obj.timeoutMs);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ConfigError(
        "配置字段 " + path + ".timeoutMs 必须是正整数（毫秒），当前值: " + String(obj.timeoutMs),
      );
    }
    timeoutMs = n;
  }

  return { url, username, password, timeoutMs, usesEnvVars };
}

/**
 * 从已解析的对象构建并校验整份配置。
 *
 * 与文件读写分离，便于直接对对象做单测。
 *
 * @param raw 已解析的配置对象
 * @param env 环境变量表，用于插值
 * @param sourcePath 配置来源路径，仅用于错误信息
 */
export function buildConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
  sourcePath?: string,
): ConfigFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("配置根节点必须是对象", sourcePath);
  }
  const root = raw as Record<string, unknown>;
  const systemsRaw = root.systems;
  if (systemsRaw === null || typeof systemsRaw !== "object" || Array.isArray(systemsRaw)) {
    throw new ConfigError("配置缺少必需的 systems 字段（应为对象）", sourcePath);
  }
  const systemEntries = Object.entries(systemsRaw as Record<string, unknown>);
  if (systemEntries.length === 0) {
    throw new ConfigError("配置字段 systems 不能为空，至少需要一个系统", sourcePath);
  }

  const systems: Record<string, SystemConfig> = {};
  for (const [systemName, systemRaw] of systemEntries) {
    const systemPath = "systems." + systemName;
    if (!NAME_PATTERN.test(systemName)) {
      throw new ConfigError(
        '系统名 "' + systemName + '" 只能包含字母、数字、下划线和连字符',
        sourcePath,
      );
    }
    if (systemRaw === null || typeof systemRaw !== "object" || Array.isArray(systemRaw)) {
      throw new ConfigError("配置字段 " + systemPath + " 必须是对象", sourcePath);
    }
    const sysObj = systemRaw as Record<string, unknown>;

    // alias 不受命名规则限制，也不校验唯一性
    let alias: string | undefined;
    if (sysObj.alias !== undefined && sysObj.alias !== null) {
      if (typeof sysObj.alias !== "string") {
        throw new ConfigError("配置字段 " + systemPath + ".alias 必须是字符串", sourcePath);
      }
      alias = sysObj.alias;
    }

    const instancesRaw = sysObj.instances;
    if (instancesRaw === null || typeof instancesRaw !== "object" || Array.isArray(instancesRaw)) {
      throw new ConfigError(
        "配置字段 " + systemPath + ".instances 必须是对象（环境名 -> 配置）",
        sourcePath,
      );
    }
    const instEntries = Object.entries(instancesRaw as Record<string, unknown>);
    if (instEntries.length === 0) {
      throw new ConfigError("配置字段 " + systemPath + ".instances 不能为空，至少需要一个环境", sourcePath);
    }

    const instances: Record<string, EnvConfig> = {};
    for (const [envName, envRaw] of instEntries) {
      const envPath = systemPath + ".instances." + envName;
      if (!NAME_PATTERN.test(envName)) {
        throw new ConfigError(
          '环境名 "' + envName + '" 只能包含字母、数字、下划线和连字符',
          sourcePath,
        );
      }
      instances[envName] = parseEnvConfig(envRaw, envPath, env);
    }

    systems[systemName] = { alias, instances };
  }

  return { systems };
}

export function loadConfigFile(path: string, options: LoadOptions = {}): ConfigFile {
  const env = options.env ?? process.env;

  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new ConfigError(
      '配置文件不存在: ' + path + '。请运行 "multi-xxl-job-mcp init" 生成，或手动创建',
      path,
    );
  }
  if (!stat.isFile()) {
    throw new ConfigError("配置路径不是文件: " + path, path);
  }

  // 权限检查：配置文件可能存放明文密码
  if ((stat.mode & PERMISSIVE_MODE_MASK) !== 0) {
    const mode = (stat.mode & 0o777).toString(8);
    const message =
      "配置文件权限过于宽松（" + mode + "），其中可能包含明文密码。建议执行: chmod 600 " + path;
    if (options.strictPermissions) {
      throw new ConfigError(message, path);
    }
    console.error("[multi-xxl-job-mcp] 警告: " + message);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError("读取配置文件失败: " + path + ": " + msg, path);
  }

  let raw: unknown;
  try {
    raw = path.toLowerCase().endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ConfigError("配置文件解析失败（" + path + "）: " + msg, path);
  }

  return buildConfig(raw, env, path);
}

/**
 * 按平台解析路径并加载配置的便捷入口。
 *
 * 启动日志应打印返回的 path，便于排查"到底读了哪个文件"。
 *
 * @param platform 平台标识，默认当前平台
 * @param options 附加选项
 * @param home 主目录覆盖，测试用
 */
export function loadConfigFromDefaultPath(
  platform: NodeJS.Platform = process.platform,
  options: LoadOptions = {},
  home?: string,
): { config: ConfigFile; path: string } {
  const env = options.env ?? process.env;
  const path = resolveConfigPath(platform, env, home);
  return { config: loadConfigFile(path, options), path };
}
/** 客户端构造所需的连接配置：EnvConfig 经字段映射（url -> baseUrl）后的形态 */
export interface XxlJobConfig {
  /** 调度中心地址，如 http://127.0.0.1:8080/xxl-job-admin（不带末尾斜杠） */
  baseUrl: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码 */
  password: string;
  /** HTTP 超时（毫秒） */
  timeoutMs: number;
}