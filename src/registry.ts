/**
 * 目标注册表：把 (system, env) 二元组映射为一个可用的 XXL-JOB 客户端。
 *
 * 设计要点：
 * - 懒创建：只有被请求过的目标才构造客户端，注册表自身不做任何 IO
 * - 会话复用：同一目标多次 get 返回同一实例，从而复用 client 内部的登录 Cookie
 * - 会话隔离：不同目标各持一个实例，某个目标登录失效不波及其他目标
 * - 可测试：客户端工厂与日志均可注入，单测不需要配置文件与真实调度中心
 * - 日志走 stderr：server 的 stdout 承载 MCP JSON-RPC，写 stdout 会破坏协议
 */

import { XxlJobClient } from "./client.js";
import { ConfigFile, EnvConfig, XxlJobConfig } from "./config.js";

/** 日志前缀，与 config.ts / server.ts 保持一致 */
const LOG_PREFIX = "[multi-xxl-job-mcp]";

/** 客户端工厂：把一份连接配置变成客户端实例；测试可注入返回假实现的工厂 */
export type ClientFactory<TClient> = (config: XxlJobConfig) => TClient;

/** 日志输出函数：默认写 stderr，测试可传入收集器或静默实现 */
export type Logger = (message: string) => void;

/** 注册表构造选项 */
export interface RegistryOptions<TClient> {
  /** 客户端工厂，缺省构造真实的 XxlJobClient */
  createClient?: ClientFactory<TClient>;
  /** 日志输出，缺省写 stderr */
  logger?: Logger;
}

/** list() 的单行结果：一个系统及其下所有环境名（不含任何凭据） */
export interface TargetSummary {
  /** 系统键名，也是工具调用时要传的值 */
  system: string;
  /** 系统的可读名称，未配置时回落到系统键名 */
  alias: string;
  /** 该系统下所有环境名，顺序与配置文件一致 */
  envs: string[];
}

/** describe() 的结果：可安全展示给调用方的目标信息（刻意不含密码） */
export interface TargetDescription {
  /** 调度中心地址 */
  url: string;
  /** 登录用户名 */
  username: string;
  /** 该目标是否有字段引用了 ${VAR} 环境变量 */
  usesEnvVars: boolean;
}

/**
 * 目标寻址失败（未知系统 / 未知环境）。
 *
 * 消息中只出现系统名、环境名与可用值，绝不包含密码，可原样透传给调用方。
 */
export class TargetError extends Error {
  /**
   * @param message 面向用户的错误描述
   * @param system 出错的系统名（未知系统时为传入的原值）
   * @param env 出错的环境名（未知系统时为 undefined）
   */
  constructor(
    message: string,
    public readonly system?: string,
    public readonly env?: string,
  ) {
    super(message);
    this.name = "TargetError";
  }
}

/** 默认日志实现：写 stderr，避免污染 MCP 的 stdout 通道 */
function defaultLogger(message: string): void {
  console.error(LOG_PREFIX + " " + message);
}

/** 把 EnvConfig 映射成客户端需要的 XxlJobConfig（只有 url -> baseUrl 一处字段名差异） */
function toClientConfig(envConfig: EnvConfig): XxlJobConfig {
  return {
    baseUrl: envConfig.url,
    username: envConfig.username,
    password: envConfig.password,
    timeoutMs: envConfig.timeoutMs,
  };
}

/**
 * 目标注册表。
 *
 * 注册表只做三件事：校验 (system, env)、按需创建客户端、缓存客户端。
 * 配置怎么解析、客户端怎么登录都由外部负责，因此它可以在没有网络的情况下被完整单测。
 *
 * @typeParam TClient 客户端类型，默认真实的 XxlJobClient；测试可指定假客户端类型
 */
export class TargetRegistry<TClient = XxlJobClient> {
  /** 已创建的客户端，键为 "system/env"（合法键名不含 "/"，因此不会歧义） */
  private readonly clients = new Map<string, TClient>();

  /** 整份配置，构造后不再变化 */
  private readonly config: ConfigFile;

  /** 客户端工厂 */
  private readonly createClient: ClientFactory<TClient>;

  /** 日志输出 */
  private readonly logger: Logger;

  /**
   * @param config 已校验的整份配置（通常来自 config.ts 的 loadConfigFile / buildConfig）
   * @param options 客户端工厂与日志，均可选；测试用它注入假实现
   */
  constructor(config: ConfigFile, options: RegistryOptions<TClient> = {}) {
    this.config = config;
    // 默认工厂造真实客户端；断言只是把默认值塞进泛型槽位，运行期无影响
    this.createClient =
      options.createClient ??
      (((clientConfig: XxlJobConfig) => new XxlJobClient(clientConfig)) as unknown as ClientFactory<TClient>);
    this.logger = options.logger ?? defaultLogger;

    // 启动时只报告配置规模，不构造任何客户端（懒创建）
    const names = Object.keys(config.systems);
    this.logger(
      "目标注册表已就绪: " + names.length + " 个系统 (" + names.join(", ") + ")，客户端将在首次使用时创建",
    );
  }

  /**
   * 取得 (system, env) 对应的客户端。
   *
   * 同一目标重复调用返回同一实例（复用登录态）；不同目标互不相同（会话隔离）。
   * 全程同步执行，因此并发调用不会重复创建实例。
   *
   * @param system 系统名（配置中的键名，不是 alias）
   * @param env 环境名
   * @throws TargetError 未知系统或未知环境，消息中列出该维度的可用值
   */
  get(system: string, env: string): TClient {
    const key = system + "/" + env;
    const cached = this.clients.get(key);
    if (cached !== undefined) {
      this.logger("复用已有客户端: " + key);
      return cached;
    }

    // 先校验再创建：未知目标不会留下任何副作用
    const envConfig = this.requireTarget(system, env);
    const client = this.createClient(toClientConfig(envConfig));
    this.clients.set(key, client);
    // 日志只打地址与用户名，绝不打密码
    this.logger("创建客户端: " + key + " -> " + envConfig.url + "（用户名 " + envConfig.username + "）");
    return client;
  }

  /**
   * 列出所有系统及其环境名，供调用方发现可用目标。
   *
   * 不构造任何客户端，也不返回任何凭据，可安全展示给 AI。
   */
  list(): TargetSummary[] {
    const summaries = Object.entries(this.config.systems).map(([system, sys]) => {
      const alias = sys.alias !== undefined && sys.alias.trim() !== "" ? sys.alias : system;
      return { system, alias, envs: Object.keys(sys.instances) };
    });
    this.logger("列举目标: " + summaries.length + " 个系统");
    return summaries;
  }

  /**
   * 描述某个目标：地址、用户名、是否用了环境变量插值。
   *
   * 刻意不返回密码，调用方可以原样展示或写入日志。
   *
   * @param system 系统名
   * @param env 环境名
   * @throws TargetError 未知系统或未知环境
   */
  describe(system: string, env: string): TargetDescription {
    const envConfig = this.requireTarget(system, env);
    return {
      url: envConfig.url,
      username: envConfig.username,
      usesEnvVars: envConfig.usesEnvVars === true,
    };
  }

  /**
   * 校验并取出目标配置。
   *
   * 判定入口：先查系统、再查环境；两者都失败时优先报系统未知（调用方应据此逐步定位）。
   * 用 Object.hasOwn 而非直接取值，避免 "__proto__" 之类的键命中原型链。
   *
   * @param system 系统名
   * @param env 环境名
   * @throws TargetError 未知系统或未知环境，消息中列出该维度的可用值
   */
  private requireTarget(system: string, env: string): EnvConfig {
    const systems = this.config.systems;
    if (!Object.hasOwn(systems, system)) {
      const available = Object.keys(systems).join(", ") || "（无）";
      this.logger("拒绝未知系统: " + system + "，可用系统: " + available);
      throw new TargetError("未知系统 '" + system + "'，可用系统: " + available, system);
    }

    const sys = systems[system];
    if (!Object.hasOwn(sys.instances, env)) {
      const available = Object.keys(sys.instances).join(", ") || "（无）";
      this.logger("拒绝未知环境: " + system + "/" + env + "，该系统可用环境: " + available);
      throw new TargetError(
        "未知环境 '" + env + "'（系统 " + system + " 下可用环境: " + available + "）",
        system,
        env,
      );
    }

    return sys.instances[env];
  }
}
