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

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  const url = await askUrl(prompter);
  const username = await askWithDefault(prompter, "登录用户名", DEFAULT_USERNAME);
  const password = await askPassword(prompter);
  return { systemName, envName, url, username, password };
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

    const answers = await collectAnswers(prompter);
    const text = renderConfigYaml(answers);

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
    prompter.print("  系统/环境: " + answers.systemName + " / " + answers.envName);
    prompter.print("  调度中心: " + answers.url);
    prompter.print("  文件权限: 600（仅当前用户可读写）");
    prompter.print("");
    prompter.print("后续:");
    prompter.print("  - 服务启动时会按平台标准路径读取该文件，无需额外配置");
    prompter.print("  - 新增环境: 在 instances 下追加环境名及其 url/username/password");
    prompter.print("  - 新增系统: 在 systems 下追加系统名，结构同上");
    prompter.print("  - 密码当前为明文保存，建议改成 ${MY_PASSWORD} 并在启动环境中设置该变量");
    return { status, path };
  } finally {
    created?.close();
  }
}
