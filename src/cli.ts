/**
 * init 子命令：交互式生成配置文件。
 *
 * 设计要点：
 * - 交互与 IO 分离：提问逻辑通过 InitPrompter 接口注入，readline 只是默认适配层，
 *   因而单元测试可以直接喂脚本化的回答，不依赖真实终端
 * - 生成内容先按配置层的 buildConfig 自检，落盘后再用 loadConfigFile 回读校验，
 *   保证"生成的文件一定能被配置解析层读入"
 * - 已有文件绝不静默覆盖：先询问，回答非 y/yes 立即中止且不改动原文件
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { buildConfig, loadConfigFile, resolveConfigPath } from "./config.js";

/** 默认系统名 */
export const DEFAULT_SYSTEM_NAME = "order";
/** 默认环境名 */
export const DEFAULT_ENV_NAME = "dev";
/** 默认调度中心地址（与本地开发环境的 XXL-JOB 默认端口一致） */
export const DEFAULT_ADMIN_URL = "http://127.0.0.1:8080/xxl-job-admin";
/** 默认登录用户名 */
export const DEFAULT_USERNAME = "admin";
/** 配置文件权限：仅属主可读写（文件内可能含明文密码） */
export const CONFIG_FILE_MODE = 0o600;

/** 收集到的问答结果 */
export interface InitAnswers {
  /** 系统名，如 order */
  systemName: string;
  /** 环境名，如 dev */
  envName: string;
  /** 调度中心地址，如 http://127.0.0.1:8080/xxl-job-admin */
  url: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码（必填，无默认值） */
  password: string;
}

/** 交互接口：把 readline 的细节收敛到这一个抽象后面，便于单测注入 */
export interface InitPrompter {
  /** 输出一条提问并等待用户输入（返回原始输入，不做 trim） */
  question(message: string): Promise<string>;
  /** 输出普通提示（stdout） */
  print(line: string): void;
  /** 输出警告（stderr） */
  warn(line: string): void;
  /** 输出错误（stderr） */
  error(line: string): void;
}

/**
 * init 的下一步选择：继续添加一条、还是就此结束。
 *
 * 加这个选择是因为「一个系统多套环境」和「多系统」在真实使用里几乎必然发生，
 * 而旧版 init 生成单条配置后只能退出，用户要么手改 YAML，要么重跑 init 把整份覆盖掉。
 */
export type ContinueChoice = "instance" | "system" | "done";

/** init 的结果状态：新建 / 覆盖 / 用户主动中止 */
export type InitStatus = "created" | "overwritten" | "aborted";

/** init 的返回值 */
export interface InitResult {
  /** 结果状态 */
  status: InitStatus;
  /** 目标配置文件的绝对路径 */
  path: string;
}

/** runInit 的可注入选项，全部有默认值，仅供测试替换 */
export interface RunInitOptions {
  /** 目标路径；默认由 resolveConfigPath 按平台推导 */
  targetPath?: string;
  /** 交互实现；默认基于真实 stdin/stdout 的 readline */
  prompter?: InitPrompter;
  /** 平台标识，默认 process.platform */
  platform?: NodeJS.Platform;
  /** 环境变量表，用于推导默认路径与自检插值，默认 process.env */
  env?: Record<string, string | undefined>;
  /** 用户主目录，默认 os.homedir()；测试可注入 */
  home?: string;
}

/**
 * 把错误对象转成可读消息，避免各处重复 instanceof 判断。
 *
 * @param e 任意抛出物
 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 用真实 stdin/stdout 构造基于 readline 的交互层。
 *
 * 不用 rl.question()：它在 stdin 到达 EOF（管道读完、用户按 Ctrl-D）时会让事件循环空转，
 * 进程直接以退出码 0 静默结束，既没写出配置也没报错。改为把 readline 当异步行迭代器用，
 * 每行读一次，EOF 时由我们自己抛错，保证调用方能收到明确的中止信号。
 *
 * 返回的 close 必须在流程结束时调用，否则 Node 进程会因 stdin 未释放而挂住。
 */
function createReadlinePrompter(): { prompter: InitPrompter; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  return {
    prompter: {
      // 打印提问后取下一行输入；EOF 表示输入被提前结束，抛出可读错误而非静默退出
      question: async (message: string): Promise<string> => {
        process.stdout.write(message);
        const next = await lines.next();
        if (next.done) {
          process.stdout.write("\n");
          throw new Error("输入已中断（stdin 到达 EOF），未生成配置文件");
        }
        return next.value;
      },
      print: (line: string): void => {
        process.stdout.write(line + "\n");
      },
      warn: (line: string): void => {
        process.stderr.write(line + "\n");
      },
      error: (line: string): void => {
        process.stderr.write(line + "\n");
      },
    },
    close: (): void => {
      rl.close();
    },
  };
}

/**
 * 提问并允许直接回车取默认值。
 *
 * @param prompter 交互实现
 * @param label 提问文案（不含默认值）
 * @param defaultValue 回车时采用的默认值
 */
async function askWithDefault(
  prompter: InitPrompter,
  label: string,
  defaultValue: string,
): Promise<string> {
  const answer = (await prompter.question(label + " [" + defaultValue + "]: ")).trim();
  return answer === "" ? defaultValue : answer;
}

/**
 * 询问系统名或环境名，非法字符集就重问。
 *
 * 合法性直接复用配置层的 buildConfig 校验（构造最小探针配置），
 * 避免在 CLI 里重复实现一份命名规则、与解析层口径不一致。
 *
 * @param prompter 交互实现
 * @param label 提问文案
 * @param defaultValue 默认值
 * @param kind system 校验系统名，env 校验环境名
 */
async function askName(
  prompter: InitPrompter,
  label: string,
  defaultValue: string,
  kind: "system" | "env",
): Promise<string> {
  for (;;) {
    const value = await askWithDefault(prompter, label, defaultValue);
    const problem = validateName(kind, value);
    if (problem === null) {
      return value;
    }
    prompter.error('"' + value + '" 不是合法的' + label + "（" + problem + "），请重新输入");
  }
}

/**
 * 用配置层的校验逻辑检查名字是否合法。
 *
 * 构造一个只含该名字的最小合法配置送进 buildConfig：能通过就说明名字合法。
 *
 * @param kind system 校验系统名，env 校验环境名
 * @param value 待校验的名字
 * @returns 合法返回 null，否则返回配置层给出的错误消息
 */
function validateName(kind: "system" | "env", value: string): string | null {
  const probeEnv = { url: DEFAULT_ADMIN_URL, username: DEFAULT_USERNAME, password: "probe" };
  const probeSystem = { instances: { [DEFAULT_ENV_NAME]: probeEnv } };
  const systems =
    kind === "system"
      ? { [value]: probeSystem }
      : { [DEFAULT_SYSTEM_NAME]: { instances: { [value]: probeEnv } } };
  try {
    buildConfig({ systems });
    return null;
  } catch (e) {
    return errorMessage(e);
  }
}

/**
 * 询问调度中心地址。
 *
 * 地址格式本身由配置层决定（只要求非空），这里只对常见笔误给出提醒，不拦截。
 *
 * @param prompter 交互实现
 */
async function askUrl(prompter: InitPrompter): Promise<string> {
  const url = await askWithDefault(prompter, "调度中心地址", DEFAULT_ADMIN_URL);
  if (!/^https?:\/\//i.test(url)) {
    prompter.warn("提示: 地址通常以 http:// 或 https:// 开头，已按原样写入配置: " + url);
  }
  return url;
}

/**
 * 询问登录密码（必填、无默认值）。
 *
 * 只拒绝全空白输入，不做 trim——密码可能包含首尾空格，裁剪会悄悄改掉真实密码。
 *
 * @param prompter 交互实现
 */
async function askPassword(prompter: InitPrompter): Promise<string> {
  for (;;) {
    const answer = await prompter.question("登录密码（必填，输入会回显在终端）: ");
    if (answer.trim() !== "") {
      return answer;
    }
    prompter.error("密码不能为空，请重新输入");
  }
}

/**
 * 依次收集系统名、环境名、调度中心地址、用户名、密码。
 *
 * 顺序固定且每项都有默认值（密码除外），一路回车即可完成。
 *
 * @param prompter 交互实现
 */
export async function collectAnswers(prompter: InitPrompter): Promise<InitAnswers> {
  prompter.print("");
  prompter.print("请按提示填写，方括号内为默认值，直接回车即可采用。");
  const systemName = await askName(prompter, "系统名", DEFAULT_SYSTEM_NAME, "system");
  const envName = await askName(prompter, "环境名", DEFAULT_ENV_NAME, "env");
  const connection = await collectConnection(prompter);
  return { systemName, envName, ...connection };
}

/**
 * 询问接下来做什么：继续加环境、继续加系统、还是结束。
 *
 * 默认选项是「结束」——用户在 init 里的主诉通常是"生成一份能用的配置"，
 * 继续添加是额外动作，默认应当收敛而不是继续追问。
 *
 * 输入容错：接受首字母 i/s 与完整单词，大小写不敏感；无法识别时按结束处理（不重问），
 * 因为这是在收尾阶段，反复纠错只会让人烦躁，且「结束」本来就是安全默认。
 *
 * @param prompter 交互实现
 */
export async function askContinueChoice(prompter: InitPrompter): Promise<ContinueChoice> {
  prompter.print("");
  prompter.print("接下来要做什么？");
  prompter.print("  i  在当前系统下再加一个环境（instance）");
  prompter.print("  s  再加一个系统（system）");
  prompter.print("  d  结束（默认）");

  // 输入已耗尽（stdin 到达 EOF、管道读完、或脚本化调用没给回答）时按「结束」处理，
  // 而不是抛错。理由：到达这一步说明基础配置已经问完了，此时中断的语义就是「够了」。
  // 若在这里抛错，所有「只给必要回答」的脚本化调用都会失败——那是把可选的追加问题
  // 变成了强制的第六问，属于破坏性变更。
  let raw: string;
  try {
    raw = (await prompter.question("请选择 [d]: ")).trim().toLowerCase();
  } catch {
    prompter.print("（输入已结束，按「结束」处理）");
    return "done";
  }

  if (raw === "" || raw === "d" || raw === "done") return "done";
  if (raw === "i" || raw === "instance") return "instance";
  if (raw === "s" || raw === "system") return "system";
  prompter.warn('无法识别的选择 "' + raw + '"，按结束处理。');
  return "done";
}

/** 一条连接配置的问答结果（不含系统名与环境名，便于「往已有系统里加环境」复用） */
export interface ConnectionAnswers {
  /** 调度中心地址 */
  url: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码 */
  password: string;
}

/**
 * 收集一条连接的地址、用户名、密码。
 *
 * 抽出来供三个场景复用：init 首条、init 继续添加、add 子命令。
 * 三处的提问文案与默认值必须一致，否则同一个字段在不同入口行为不同，很难解释。
 *
 * @param prompter 交互实现
 */
export async function collectConnection(prompter: InitPrompter): Promise<ConnectionAnswers> {
  const url = await askUrl(prompter);
  const username = await askWithDefault(prompter, "登录用户名", DEFAULT_USERNAME);
  const password = await askPassword(prompter);
  return { url, username, password };
}

/**
 * 把问答结果渲染成 YAML 文本（含顶部说明注释）。
 *
 * 用 yaml 库序列化而非手工拼字符串：密码里出现引号、冒号、纯数字等
 * 特殊情况时也能正确转义，保证生成的文本能被 loadConfigFile 读回。
 *
 * @param answers 问答结果
 */
export function renderConfigYaml(answers: InitAnswers): string {
  const doc = {
    systems: {
      [answers.systemName]: {
        instances: {
          [answers.envName]: {
            url: answers.url,
            username: answers.username,
            password: answers.password,
          },
        },
      },
    },
  };
  const header = [
    "# multi-xxl-job-mcp 配置文件",
    "#",
    "# 添加更多环境：在同一系统的 instances 下新增一个环境块，例如",
    "#   instances:",
    "#     dev:  { url: http://..., username: admin, password: ... }",
    "#     prod: { url: https://..., username: admin, password: ... }",
    "# 添加更多系统：在 systems 下与 " + answers.systemName + " 平级新增一个系统名。",
    "# 字段值支持 ${VAR} 环境变量插值，密码建议写成 ${MY_PASSWORD} 以免明文落盘。",
    "",
  ].join("\n");
  return header + stringifyYaml(doc, { lineWidth: 0 });
}

/** 配置文件顶层结构（与 config.ts 的 ConfigFile 同形，此处刻意用宽松类型以便合并） */
type RawConfig = {
  systems?: Record<string, RawSystem>;
  [key: string]: unknown;
};

/** 单个系统的原始结构 */
type RawSystem = {
  alias?: string;
  instances?: Record<string, RawInstance>;
  [key: string]: unknown;
};

/** 单条环境的原始结构 */
type RawInstance = {
  url?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
  [key: string]: unknown;
};

/**
 * 把一段 YAML 文本解析成可合并的对象；空文本视为空配置。
 *
 * 只在「读已有配置文件」时调用。解析失败会抛出，由调用方转成可读错误——
 * 不能因为原文件格式有问题就静默覆盖，那样会毁掉用户手写的注释与内容。
 *
 * @param text 配置文件原文
 * @param sourcePath 仅用于错误信息
 */
export function parseConfigText(text: string, sourcePath: string): RawConfig {
  const parsed = parseYaml(text);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置文件根节点不是对象，无法追加内容: " + sourcePath);
  }
  return parsed as RawConfig;
}

/**
 * 往配置里加一条环境（system + env + 连接信息）。
 *
 * 已存在的 env 会被新值**覆盖**，但同一系统下其它 env 原样保留。
 * 返回是否覆盖了已有条目，供调用方提示用户。
 *
 * @param config 待修改的配置（就地修改）
 * @param answers 问答结果
 * @returns true 表示覆盖了已存在的 env
 */
export function addInstanceToConfig(config: RawConfig, answers: InitAnswers): boolean {
  config.systems ??= {};
  const system = (config.systems[answers.systemName] ??= {});
  system.instances ??= {};
  const overwritten = Object.hasOwn(system.instances, answers.envName);
  system.instances[answers.envName] = {
    url: answers.url,
    username: answers.username,
    password: answers.password,
  };
  return overwritten;
}

/**
 * 往配置里加一个系统及其首个环境。
 *
 * 已存在的系统不会被替换，而是往它的 instances 里追加一条——这个取舍是刻意的：
 * 用户说「新增系统」时，如果那个系统已存在，最可能是他记错了名字、或想给同一个系统加环境，
 * 此时把整个系统替换掉会静默丢掉其它环境与 alias。
 *
 * @param config 待修改的配置（就地修改）
 * @param answers 问答结果
 * @param options.replace 是否允许替换已存在的系统（默认 false）
 * @returns 描述实际发生了什么，供调用方提示
 */
export function addSystemToConfig(
  config: RawConfig,
  answers: InitAnswers,
  options: { replace?: boolean } = {},
): { systemExisted: boolean; envOverwritten: boolean } {
  config.systems ??= {};
  const systemExisted = Object.hasOwn(config.systems, answers.systemName);
  if (!systemExisted || options.replace === true) {
    config.systems[answers.systemName] = {
      instances: { [answers.envName]: { url: answers.url, username: answers.username, password: answers.password } },
    };
    return { systemExisted, envOverwritten: false };
  }
  // 系统已存在：只追加环境，保留原有 instances 与 alias
  const system = config.systems[answers.systemName];
  system.instances ??= {};
  const envOverwritten = Object.hasOwn(system.instances, answers.envName);
  system.instances[answers.envName] = {
    url: answers.url,
    username: answers.username,
    password: answers.password,
  };
  return { systemExisted, envOverwritten };
}

/**
 * 把（可能已存在的）配置对象渲染成 YAML 文本。
 *
 * 与 renderConfigYaml 的区别：那个只负责「从零生成一条」，这个负责「把合并后的完整配置写回」。
 * 顶部说明注释同样保留，但会把「当前已有多少系统/环境」写进去，便于用户确认改动生效。
 *
 * @param config 完整配置
 */
export function renderConfigDocument(config: RawConfig | { systems: Record<string, { alias?: string; instances: Record<string, unknown> }> }): string {
  const systems = (config.systems ?? {}) as Record<string, { instances?: Record<string, unknown> }>;
  const systemCount = Object.keys(systems).length;
  const envCount = Object.values(systems).reduce(
    (sum, sys) => sum + Object.keys(sys.instances ?? {}).length,
    0,
  );
  const header = [
    "# multi-xxl-job-mcp 配置文件",
    "#",
    "# 当前包含 " + systemCount + " 个系统、" + envCount + " 个环境。",
    "# 可用 \"multi-xxl-job-mcp add\" 追加，或直接编辑本文件。",
    "# 字段值支持 ${VAR} 环境变量插值，密码建议写成 ${MY_PASSWORD} 以免明文落盘。",
    "",
  ].join("\n");
  return header + stringifyYaml(config, { lineWidth: 0 });
}

/**
 * 把配置文本写入目标路径：按需建目录、写文件、把权限收紧到 600。
 *
 * @param path 目标文件绝对路径
 * @param text 配置文件内容
 */
export function writeConfigFile(path: string, text: string): void {
  // 配置目录里只有本文件，权限同样收紧到仅属主可访问
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { encoding: "utf8", mode: CONFIG_FILE_MODE });
  // writeFileSync 的 mode 只在新建文件时生效，覆盖已有文件时必须显式 chmod
  chmodSync(path, CONFIG_FILE_MODE);
}

/**
 * 回读校验刚写入的配置文件，确保 loadConfigFile 能原样读入。
 *
 * 权限严格性按平台区分：Windows 没有 POSIX 权限位，statSync 的 mode 恒带着 0666，
 * 若照搬 strictPermissions，Windows 上的每一次 init 都会在自检时被判失败；
 * POSIX 平台则保持严格——文件里可能含明文密码，权限没真正收紧就应该暴露出来。
 *
 * @param path 配置文件绝对路径
 * @param env 环境变量表，用于插值自检
 * @param platform 平台标识，默认当前平台
 */
export function verifyConfigFile(
  path: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  loadConfigFile(path, { env, strictPermissions: platform !== "win32" });
}

/**
 * 收集「继续添加」时的一条新条目，并合并进累积中的配置。
 *
 * 与首条的差别：
 * - 加环境时**不再问系统名**（就是当前那个系统），避免重复输入与输错
 * - 加系统时问系统名，但默认值给当前系统名之外的值，减少误覆盖
 *
 * @param prompter 交互实现
 * @param config 累积中的配置（就地修改）
 * @param choice 用户选的是加环境还是加系统
 * @param lastSystem 上一条所属的系统名（加环境时作为目标）
 * @returns 本次添加的系统名与环境名，供后续提示
 */
async function collectNextEntry(
  prompter: InitPrompter,
  config: RawConfig,
  choice: Exclude<ContinueChoice, "done">,
  lastSystem: string,
): Promise<{ systemName: string; envName: string }> {
  promptBlank(prompter);
  if (choice === "instance") {
    // 往同一系统追加环境：系统名固定，只问环境名
    prompter.print("在系统 \"" + lastSystem + "\" 下新增一个环境。");
    const envName = await askName(prompter, "环境名", suggestNextEnvName(config, lastSystem), "env");
    const connection = await collectConnection(prompter);
    const answers: InitAnswers = { systemName: lastSystem, envName, ...connection };
    const overwritten = addInstanceToConfig(config, answers);
    if (overwritten) {
      prompter.warn("注意: 环境 \"" + envName + "\" 已存在，已用新值覆盖。");
    }
    return { systemName: lastSystem, envName };
  }
  // 新增系统：系统名可自定义，默认建议一个不与现有系统冲突的名字
  const systemName = await askName(prompter, "系统名", suggestNextSystemName(config), "system");
  const envName = await askName(prompter, "环境名", DEFAULT_ENV_NAME, "env");
  const connection = await collectConnection(prompter);
  const answers: InitAnswers = { systemName, envName, ...connection };
  const result = addSystemToConfig(config, answers);
  if (result.systemExisted) {
    prompter.warn(
      "注意: 系统 \"" + systemName + "\" 已存在，已把环境 \"" + envName + "\" 追加进去（保留原有环境）。",
    );
  }
  return { systemName, envName };
}

/**
 * 给「加环境」建议一个默认环境名：按现有环境名往后找 dev2 / dev3 …，避免直接撞车。
 *
 * 只是建议值，用户可以覆盖。存在的意义是让「一路回车」也能得到合法且不冲突的结果。
 *
 * @param config 累积中的配置
 * @param systemName 目标系统
 */
function suggestNextEnvName(config: RawConfig, systemName: string): string {
  const used = new Set(Object.keys(config.systems?.[systemName]?.instances ?? {}));
  if (!used.has(DEFAULT_ENV_NAME)) return DEFAULT_ENV_NAME;
  for (let i = 2; i <= 99; i++) {
    const candidate = DEFAULT_ENV_NAME + i;
    if (!used.has(candidate)) return candidate;
  }
  return DEFAULT_ENV_NAME + Date.now();
}

/**
 * 给「加系统」建议一个默认系统名：order / order2 / order3 …，同样避开已有名字。
 *
 * @param config 累积中的配置
 */
function suggestNextSystemName(config: RawConfig): string {
  const used = new Set(Object.keys(config.systems ?? {}));
  if (!used.has(DEFAULT_SYSTEM_NAME)) return DEFAULT_SYSTEM_NAME;
  for (let i = 2; i <= 99; i++) {
    const candidate = DEFAULT_SYSTEM_NAME + i;
    if (!used.has(candidate)) return candidate;
  }
  return DEFAULT_SYSTEM_NAME + Date.now();
}

/** 在提问之间留一个空行，纯为可读性 */
function promptBlank(prompter: InitPrompter): void {
  prompter.print("");
}
/**
 * 执行 init 全流程：确认覆盖 → 收集回答 → 生成文本 → 自检 → 落盘 → 回读校验 → 打印提示。
 *
 * @param options 可注入选项（目标路径、交互实现、平台等）
 * @returns 结果状态与目标路径
 */
export async function runInit(options: RunInitOptions = {}): Promise<InitResult> {
  const env = options.env ?? process.env;
  const ownsPrompter = options.prompter === undefined;
  const created = ownsPrompter ? createReadlinePrompter() : undefined;
  const prompter = options.prompter ?? created!.prompter;

  try {
    const path =
      options.targetPath ??
      resolveConfigPath(options.platform ?? process.platform, env, options.home);
    const exists = existsSync(path);

    prompter.print("[multi-xxl-job-mcp] 生成配置文件");
    prompter.print("目标路径: " + path + (exists ? "（已存在）" : "（新建）"));

    // 先确认覆盖再收集回答：避免用户填完一堆信息才发现要放弃
    if (exists) {
      prompter.warn("警告: 配置文件已存在: " + path);
      const answer = (await prompter.question("是否覆盖？[y/N]: ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        prompter.print("已取消，未修改任何文件。");
        return { status: "aborted", path };
      }
    }

    const first = await collectAnswers(prompter);

    // 累积所有条目后再一次性落盘。
    // 若边问边写，用户在「继续添加」中途 Ctrl-D 会留下只有半数的配置；
    // 统一在最后写，中断就什么都不写。
    const config: RawConfig = { systems: {} };
    addSystemToConfig(config, first);

    // 记录最后一条的系统名：加环境时默认往这个系统里加，符合「刚配完哪个就继续配哪个」的直觉
    let lastSystem = first.systemName;
    const added: { systemName: string; envName: string }[] = [
      { systemName: first.systemName, envName: first.envName },
    ];

    // 继续添加循环：直到用户选结束
    for (;;) {
      const choice = await askContinueChoice(prompter);
      if (choice === "done") break;
      const entry = await collectNextEntry(prompter, config, choice, lastSystem);
      added.push(entry);
      lastSystem = entry.systemName;
      prompter.print("");
      prompter.print("已添加: " + entry.systemName + " / " + entry.envName);
    }

    const text = renderConfigDocument(config);

    // 自检一：先把生成文本按配置层规则解析+校验，不合法就绝不落盘
    try {
      buildConfig(parseYaml(text), env, path);
    } catch (e) {
      // cause 保留原始错误：message 里只有可读摘要，栈与字段细节留给上层排查
      throw new Error("生成的配置未通过配置层校验，已放弃写入: " + errorMessage(e), { cause: e });
    }

    writeConfigFile(path, text);

    // 自检二：从磁盘回读，确认文件本身能被 loadConfigFile 直接读入
    try {
      verifyConfigFile(path, env, options.platform ?? process.platform);
    } catch (e) {
      // 同上：把磁盘回读失败的原始错误挂到 cause 上
      throw new Error("写入后回读校验失败（" + path + "）: " + errorMessage(e), { cause: e });
    }

    const status: InitStatus = exists ? "overwritten" : "created";
    prompter.print("");
    prompter.print("[multi-xxl-job-mcp] 配置文件已" + (status === "created" ? "生成" : "覆盖") + ": " + path);
    prompter.print("  共写入 " + added.length + " 个环境:");
    for (const entry of added) {
      prompter.print("    - " + entry.systemName + " / " + entry.envName);
    }
    prompter.print("  文件权限: 600（仅当前用户可读写）");
    prompter.print("");
    prompter.print("后续:");
    prompter.print("  - 服务启动时会按平台标准路径读取该文件，无需额外配置");
    prompter.print("  - 继续追加: multi-xxl-job-mcp add（按提示选加环境或加系统）");
    prompter.print("  - 也可直接编辑文件（YAML 结构：systems -> instances）");
    prompter.print("  - 密码当前为明文保存，建议改成 ${MY_PASSWORD} 并在启动环境中设置该变量");
    return { status, path };
  } finally {
    created?.close();
  }
}
/** 帮助文本。命令、参数与退出码集中在这里，改分发逻辑时同步改这一段。 */
export const HELP_TEXT = [
  "multi-xxl-job-mcp — MCP Server for XXL-JOB Admin",
  "",
  "用法:",
  "  multi-xxl-job-mcp                启动 stdio MCP 服务（默认，供 MCP 客户端调用）",
  "  multi-xxl-job-mcp init           交互式生成配置文件",
  "  multi-xxl-job-mcp add            在已有配置上追加一个环境或一个系统",
  "  multi-xxl-job-mcp help           显示本帮助",
  "  multi-xxl-job-mcp --help         同上",
  "",
  "配置文件:",
  "  $XDG_CONFIG_HOME/multi-xxl-job-mcp/config.yaml",
  "  未设置 XDG_CONFIG_HOME 时为 ~/.config/multi-xxl-job-mcp/config.yaml",
  "",
  "说明:",
  "  init 在同一次会话里可以连续添加多个环境/系统，结束后一次性写入。",
  "  add  只改目标节点，其余内容原样保留；配置文件不存在时会报错而非新建。",
  "",
  "退出码:",
  "  0  成功",
  "  1  失败，或用户主动取消（init 拒绝覆盖、add 选择取消）",
  "",
].join("\n");

/** add 子命令的结果状态 */
export type AddStatus = "added" | "aborted";

/** add 子命令的返回值 */
export interface AddResult {
  /** 结果状态 */
  status: AddStatus;
  /** 目标配置文件的绝对路径 */
  path: string;
  /** 实际写入的系统名（aborted 时为空串） */
  systemName?: string;
  /** 实际写入的环境名（aborted 时为空串） */
  envName?: string;
}

/**
 * 执行 add 子命令：在**已有配置**上追加一个环境或一个系统。
 *
 * 与 init 的关键差别：
 * - 绝不覆盖整份文件：读原文 → 只改对应节点 → 写回，其余内容（含用户手写的注释以外的结构）保持不变
 * - 文件不存在时直接报错并提示先 init，而不是顺手创建一份——那会掩盖用户的路径配置错误
 * - 写完同样做两道自检（渲染后按配置层校验、落盘后回读），保证文件始终可被服务读入
 *
 * @param options 可注入选项，与 runInit 同形
 * @returns 结果状态、路径与实际写入的系统/环境名
 */
export async function runAdd(options: RunInitOptions = {}): Promise<AddResult> {
  const env = options.env ?? process.env;
  const ownsPrompter = options.prompter === undefined;
  const created = ownsPrompter ? createReadlinePrompter() : undefined;
  const prompter = options.prompter ?? created!.prompter;

  try {
    const path =
      options.targetPath ??
      resolveConfigPath(options.platform ?? process.platform, env, options.home);

    // 不存在就报错：add 的前提是「已有一份可用配置」，凭空造一份属于 init 的职责
    if (!existsSync(path)) {
      throw new Error(
        "配置文件不存在: " + path + '。请先运行 "multi-xxl-job-mcp init" 生成，或用 config 命令指定路径',
      );
    }

    prompter.print("[multi-xxl-job-mcp] 追加配置");
    prompter.print("目标路径: " + path);

    // 读原文并解析。解析失败必须停下来：贸然写回会把用户手写的内容冲掉
    const original = readFileSync(path, "utf8");
    let config: RawConfig;
    try {
      config = parseConfigText(original, path);
    } catch (e) {
      throw new Error("现有配置无法解析，已放弃修改: " + errorMessage(e), { cause: e });
    }
    if (config.systems === undefined || Object.keys(config.systems).length === 0) {
      throw new Error("现有配置里没有任何系统，请先用 init 生成一份基础配置: " + path);
    }

    const systems = Object.keys(config.systems);
    prompter.print("现有 " + systems.length + " 个系统: " + systems.join(", "));

    // 先让用户选加环境还是加系统，再按选择收集
    const choice = await askContinueChoiceForAdd(prompter);
    if (choice === "done") {
      prompter.print("已取消，未修改任何文件。");
      return { status: "aborted", path };
    }

    // 加环境时必须明确目标系统：只有一个系统就直接用，多个则让用户选。
    // 不加这一步的话，多系统配置下「加环境」会静默加到最后一个系统，很容易配错地方。
    let targetSystem = systems[systems.length - 1];
    if (choice === "instance" && systems.length > 1) {
      targetSystem = await askExistingSystem(prompter, systems);
    }
    const entry = await collectNextEntry(prompter, config, choice, targetSystem);

    const text = renderConfigDocument(config);

    // 自检一：渲染结果必须能被配置层接受，否则不写
    try {
      buildConfig(parseYaml(text), env, path);
    } catch (e) {
      throw new Error("追加后的配置未通过配置层校验，已放弃写入: " + errorMessage(e), { cause: e });
    }

    writeConfigFile(path, text);

    // 自检二：从磁盘回读，确认文件仍能被服务读入
    try {
      verifyConfigFile(path, env, options.platform ?? process.platform);
    } catch (e) {
      throw new Error("写入后回读校验失败（" + path + "）: " + errorMessage(e), { cause: e });
    }

    prompter.print("");
    prompter.print("[multi-xxl-job-mcp] 已追加: " + entry.systemName + " / " + entry.envName);
    prompter.print("  文件: " + path);
    prompter.print("  其余内容保持不变。");
    return { status: "added", path, systemName: entry.systemName, envName: entry.envName };
  } finally {
    created?.close();
  }
}

/**
 * 让用户从现有系统里挑一个作为「加环境」的目标。
 *
 * 支持输入序号或系统名直接匹配，两者都做了容错；无法识别时重问，
 * 而不是猜一个——加错系统意味着把凭据写进不合适的环境，代价不小。
 *
 * @param prompter 交互实现
 * @param systems 现有系统名列表
 */
async function askExistingSystem(prompter: InitPrompter, systems: string[]): Promise<string> {
  prompter.print("");
  prompter.print("要把新环境加到哪个系统？");
  systems.forEach((name, i) => {
    prompter.print("  " + (i + 1) + ") " + name);
  });
  for (;;) {
    const raw = (await prompter.question("请输入序号或系统名 [" + systems[0] + "]: ")).trim();
    if (raw === "") return systems[0];
    const byIndex = Number(raw);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= systems.length) {
      return systems[byIndex - 1];
    }
    if (systems.includes(raw)) return raw;
    prompter.error('"' + raw + '" 不在现有系统列表里，请重新输入。');
  }
}

/**
 * add 场景下的「加环境还是加系统」选择。
 *
 * 与 init 里的 askContinueChoice 区别：这里没有「结束」以外的默认语境，
 * 且加环境必须先确定目标系统（仅一个系统时自动选中，多个时让用户选）。
 *
 * 目标系统的选择放在调用方（askExistingSystem）里做，这个函数只负责问「加什么」。
 *
 * @param prompter 交互实现
 */
async function askContinueChoiceForAdd(prompter: InitPrompter): Promise<ContinueChoice> {
  promptBlank(prompter);
  prompter.print("要追加什么？");
  prompter.print("  i  在现有系统下加一个环境（instance）");
  prompter.print("  s  加一个新系统（system）");
  prompter.print("  d  取消（默认）");
  const raw = (await prompter.question("请选择 [d]: ")).trim().toLowerCase();
  if (raw === "i" || raw === "instance") return "instance";
  if (raw === "s" || raw === "system") return "system";
  return "done";
}

