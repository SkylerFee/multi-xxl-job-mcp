/**
 * init 子命令单元测试。
 *
 * 交互与 IO 已分离：用脚本化的 InitPrompter 喂入回答，无需真实终端；
 * 目标路径与 HOME 全部注入临时目录，不污染真实用户配置。
 *
 * 覆盖：全默认值一路回车、生成结果可被 loadConfigFile 读入、拒绝覆盖时中止且内容不变、
 * 确认覆盖时文件被替换、文件权限 600，以及非法输入重问与默认路径推导。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfigFile, resolveConfigPath } from "../src/config.js";
import {
  CONFIG_FILE_MODE,
  DEFAULT_ADMIN_URL,
  DEFAULT_ENV_NAME,
  DEFAULT_SYSTEM_NAME,
  DEFAULT_USERNAME,
  renderConfigYaml,
  runInit,
  writeConfigFile,
  type InitPrompter,
} from "../src/cli.js";

let passed = 0;
let failed = 0;

/** 断言辅助：记录通过/失败并输出可读结果 */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log("  OK   " + name);
  } else {
    failed++;
    console.error("  FAIL " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
  }
}

/**
 * 脚本化交互层：按顺序吐出预设回答，并记录所有提问与输出。
 *
 * 回答用完后继续提问会抛错——测试里出现多余的提问说明流程跑偏了。
 */
class ScriptedPrompter implements InitPrompter {
  /** 依次被消费的回答 */
  private readonly answers: string[];
  /** 已提出的问题（按顺序） */
  readonly questions: string[] = [];
  /** 已输出的普通提示 */
  readonly lines: string[] = [];
  /** 已输出的警告与错误 */
  readonly messages: string[] = [];

  constructor(answers: string[]) {
    this.answers = [...answers];
  }

  /** 取下一个预置回答 */
  async question(message: string): Promise<string> {
    this.questions.push(message);
    if (this.answers.length === 0) {
      throw new Error("脚本化回答已用尽，仍有提问: " + message);
    }
    return this.answers.shift() as string;
  }

  /** 记录普通提示 */
  print(line: string): void {
    this.lines.push(line);
  }

  /** 记录警告 */
  warn(line: string): void {
    this.messages.push(line);
  }

  /** 记录错误 */
  error(line: string): void {
    this.messages.push(line);
  }
}

/** 读取文件权限位（如 0o600） */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** 主流程：全部为异步断言 */
async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mxxl-cli-"));
  try {
    // ----------------------------------------------------------------
    console.log("[1] 全默认值一路回车生成新配置");
    // ----------------------------------------------------------------
    const newPath = join(dir, "fresh", "config.yaml");
    const p1 = new ScriptedPrompter(["", "", "", "", "s3cret"]);
    const r1 = await runInit({ targetPath: newPath, prompter: p1, env: {} });
    check("状态为 created", r1.status === "created", r1.status);
    check("返回路径与目标一致", r1.path === newPath, r1.path);
    check("文件已创建", existsSync(newPath));

    const cfg1 = loadConfigFile(newPath, { env: {}, strictPermissions: true });
    check("系统名默认 order", cfg1.systems[DEFAULT_SYSTEM_NAME] !== undefined, Object.keys(cfg1.systems));
    const env1 = cfg1.systems[DEFAULT_SYSTEM_NAME].instances[DEFAULT_ENV_NAME];
    check("环境名默认 dev", env1 !== undefined);
    check("地址默认本地调度中心", env1.url === DEFAULT_ADMIN_URL, env1.url);
    check("用户名默认 admin", env1.username === DEFAULT_USERNAME, env1.username);
    check("密码来自输入", env1.password === "s3cret");
    check("打印了配置文件的绝对路径", p1.lines.some((l) => l.includes(newPath)), p1.lines);
    // 旧版这里提示「手动编辑 YAML 的新增系统/新增环境」；现在提供了 add 子命令，
    // 提示改为指向它。断言跟着改为「给出了可执行的继续添加方式」，
    // 而不是绑死某个具体措辞——否则每次文案调整都要改测试。
    check(
      "提示了如何继续添加系统/环境",
      p1.lines.some((l) => l.includes("add")) && p1.lines.some((l) => l.includes("编辑")),
      p1.lines,
    );

    // ----------------------------------------------------------------
    console.log("[2] 文件权限 600");
    // ----------------------------------------------------------------
    check("文件权限为 600", modeOf(newPath) === CONFIG_FILE_MODE, modeOf(newPath).toString(8));

    // ----------------------------------------------------------------
    console.log("[3] 自定义输入");
    // ----------------------------------------------------------------
    const customPath = join(dir, "custom", "config.yaml");
    const p2 = new ScriptedPrompter(["pay", "prod", "https://pay.example.com/xxl-job-admin", "svc", "p@ss:word #1"]);
    const r2 = await runInit({ targetPath: customPath, prompter: p2, env: {} });
    check("状态为 created", r2.status === "created", r2.status);
    const cfg2 = loadConfigFile(customPath, { env: {} });
    const env2 = cfg2.systems.pay.instances.prod;
    check("自定义系统名生效", cfg2.systems.pay !== undefined);
    check("自定义环境名生效", env2 !== undefined);
    check("自定义地址生效", env2.url === "https://pay.example.com/xxl-job-admin", env2.url);
    check("自定义用户名生效", env2.username === "svc", env2.username);
    check("含空格/冒号/# 的密码原样保留", env2.password === "p@ss:word #1", env2.password);

    // ----------------------------------------------------------------
    console.log("[4] 拒绝覆盖则中止且内容不变");
    // ----------------------------------------------------------------
    const legacy = "# 原有配置，不能被覆盖\nsystems:\n  keep:\n    instances:\n      dev:\n        url: http://old\n        username: u\n        password: p\n";
    writeFileSync(customPath, legacy);
    chmodSync(customPath, 0o600);
    const p3 = new ScriptedPrompter(["n"]);
    const r3 = await runInit({ targetPath: customPath, prompter: p3, env: {} });
    check("状态为 aborted", r3.status === "aborted", r3.status);
    check("文件内容未被修改", readFileSync(customPath, "utf8") === legacy);
    check("中止后不再提问其他字段", p3.questions.length === 1, p3.questions);
    check("明确告知已取消", p3.lines.some((l) => l.includes("已取消")), p3.lines);

    // ----------------------------------------------------------------
    console.log("[5] 确认覆盖则文件被替换");
    // ----------------------------------------------------------------
    const p4 = new ScriptedPrompter(["yes", "order", "uat", "http://uat/xxl-job-admin", "root", "newpass"]);
    const r4 = await runInit({ targetPath: customPath, prompter: p4, env: {} });
    check("状态为 overwritten", r4.status === "overwritten", r4.status);
    const replaced = readFileSync(customPath, "utf8");
    check("旧内容已消失", !replaced.includes("原有配置"), replaced.slice(0, 60));
    const cfg4 = loadConfigFile(customPath, { env: {} });
    check("新内容可解析", cfg4.systems.order.instances.uat.url === "http://uat/xxl-job-admin");
    check("覆盖后权限仍为 600", modeOf(customPath) === CONFIG_FILE_MODE, modeOf(customPath).toString(8));

    // ----------------------------------------------------------------
    console.log("[6] 非法输入重问");
    // ----------------------------------------------------------------
    const badPath = join(dir, "bad", "config.yaml");
    const p5 = new ScriptedPrompter(["bad name!", "", "dev", "", "", "", "pw"]);
    const r5 = await runInit({ targetPath: badPath, prompter: p5, env: {} });
    check("状态为 created", r5.status === "created", r5.status);
    const cfg5 = loadConfigFile(badPath, { env: {} });
    check("非法系统名被拒绝后取默认值", cfg5.systems[DEFAULT_SYSTEM_NAME] !== undefined, Object.keys(cfg5.systems));
    check("重问时给出错误提示", p5.messages.some((m) => m.includes("不是合法的系统名")), p5.messages);

    // ----------------------------------------------------------------
    console.log("[7] 默认路径由 resolveConfigPath 推导（统一 XDG）");
    // ----------------------------------------------------------------
    const home = join(dir, "home");
    const p6 = new ScriptedPrompter(["", "", "", "", "pw"]);
    const r6 = await runInit({ prompter: p6, platform: "linux", env: {}, home });
    const expectPath = resolveConfigPath("linux", {}, home);
    check("落在平台标准路径", r6.path === expectPath, { got: r6.path, want: expectPath });
    check("标准路径下文件存在", existsSync(expectPath));

    // ----------------------------------------------------------------
    console.log("[8] 渲染的 YAML 可被解析层读入");
    // ----------------------------------------------------------------
    const yamlText = renderConfigYaml({
      systemName: "order",
      envName: "dev",
      url: DEFAULT_ADMIN_URL,
      username: DEFAULT_USERNAME,
      password: "123456",
    });
    const roundTripPath = join(dir, "round", "config.yaml");
    writeConfigFile(roundTripPath, yamlText);
    const cfg6 = loadConfigFile(roundTripPath, { env: {}, strictPermissions: true });
    check("纯数字密码按字符串读入", cfg6.systems.order.instances.dev.password === "123456", cfg6.systems.order.instances.dev.password);
    check("含添加更多系统/环境的说明注释", yamlText.includes("# 添加更多系统"), yamlText.split("\n").slice(0, 3));

    // ----------------------------------------------------------------
    console.log("[9] 交互中断时不写入任何文件");
    // ----------------------------------------------------------------
    const interruptedPath = join(dir, "interrupted", "config.yaml");
    const p7 = new ScriptedPrompter(["", ""]);
    let threw = false;
    try {
      // 回答提前用尽，ScriptedPrompter 会抛错，等价于真实场景下 stdin 到达 EOF
      await runInit({ targetPath: interruptedPath, prompter: p7, env: {} });
    } catch {
      threw = true;
    }
    check("异常向上抛出", threw);
    check("异常时未创建文件", !existsSync(interruptedPath), interruptedPath);

    // ----------------------------------------------------------------
    console.log("[10] win32 回读自检不因权限位失败（路径已与 posix 统一）");
    // ----------------------------------------------------------------
    // Windows 无 POSIX 权限位，statSync 恒报 0o644 一类值；自检必须放行而不是判失败
    // 路径已统一为 XDG 风格，win32 下 ~/.config 由 os.homedir() 解析（此处注入 home）
    const winHome = join(dir, "winhome");
    const p8 = new ScriptedPrompter(["", "", "", "", "pw"]);
    await runInit({ prompter: p8, platform: "win32", env: {}, home: winHome });
    const winPath = resolveConfigPath("win32", {}, winHome);
    check("win32 路径下文件已生成", existsSync(winPath), winPath);
    check("win32 路径为 ~/.config 而非 APPDATA", winPath.includes(join(".config", "multi-xxl-job-mcp")), winPath);
    check("win32 回读可解析", loadConfigFile(winPath, { env: {} }).systems[DEFAULT_SYSTEM_NAME] !== undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log("========== init 子命令测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试执行异常: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});