/**
 * add 子命令与 init「继续添加」的测试。
 *
 * 与 cli.test.ts 一样用脚本化 InitPrompter，不依赖真实终端；路径全部注入临时目录。
 *
 * 覆盖重点：
 * - add 只改目标节点，其余内容（含其它系统、其它环境、alias）原样保留
 * - 配置文件不存在时 add 报错而非新建
 * - init 的继续添加能累积多条并一次性写入
 * - 覆盖已有环境时给出提示
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfigFile } from "../src/config.js";
import {
  addInstanceToConfig,
  addSystemToConfig,
  parseConfigText,
  renderConfigDocument,
  runAdd,
  runInit,
  type InitPrompter,
} from "../src/cli.js";

let passed = 0;
let failed = 0;

/** 断言辅助 */
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log("  OK   " + name);
  } else {
    failed++;
    console.error("  FAIL " + name + (detail !== undefined ? " | " + JSON.stringify(detail) : ""));
  }
}

/** 脚本化交互层：按顺序返回预置回答，并记录全部提问与输出 */
class ScriptedPrompter implements InitPrompter {
  private readonly answers: string[];
  readonly questions: string[] = [];
  readonly lines: string[] = [];
  readonly messages: string[] = [];

  constructor(answers: string[]) {
    this.answers = [...answers];
  }

  async question(message: string): Promise<string> {
    this.questions.push(message);
    if (this.answers.length === 0) {
      throw new Error("脚本化回答已用尽，仍有提问: " + message);
    }
    return this.answers.shift() as string;
  }

  print(line: string): void {
    this.lines.push(line);
  }

  warn(line: string): void {
    this.messages.push(line);
  }

  error(line: string): void {
    this.messages.push(line);
  }
}

/** 写一份含两个系统的既有配置，作为 add 的起点 */
function writeBaseConfig(path: string): string {
  // add 的测试要先用一份已存在的配置做起点，因此这里负责把目录建好
  mkdirSync(dirname(path), { recursive: true });
  const text = [
    "# 用户手写的配置，add 不应破坏",
    "systems:",
    "  order:",
    "    alias: 订单系统",
    "    instances:",
    "      dev:",
    "        url: http://dev/xxl-job-admin",
    "        username: admin",
    "        password: devpass",
    "  pay:",
    "    instances:",
    "      dev:",
    "        url: http://pay/xxl-job-admin",
    "        username: payuser",
    "        password: paypass",
    "",
  ].join("\n");
  writeFileSync(path, text);
  chmodSync(path, 0o600);
  return text;
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mxxl-add-"));
  try {
    // ----------------------------------------------------------------
    console.log("[1] 纯函数：加环境只动目标节点");
    // ----------------------------------------------------------------
    const base = parseConfigText(
      ["systems:", "  order:", "    alias: 订单系统", "    instances:", "      dev:", "        url: http://dev", "        username: u", "        password: p"].join("\n"),
      "inline",
    );
    const overwritten1 = addInstanceToConfig(base, {
      systemName: "order",
      envName: "prod",
      url: "http://prod",
      username: "pu",
      password: "pp",
    });
    check("新增环境不返回覆盖标记", overwritten1 === false, overwritten1);
    check("新环境已加入", base.systems?.order.instances?.prod?.url === "http://prod");
    check("原有环境保留", base.systems?.order.instances?.dev?.url === "http://dev");
    check("alias 保留", base.systems?.order.alias === "订单系统");

    const overwritten2 = addInstanceToConfig(base, {
      systemName: "order",
      envName: "dev",
      url: "http://dev2",
      username: "u2",
      password: "p2",
    });
    check("覆盖已有环境时返回 true", overwritten2 === true, overwritten2);
    check("环境值已更新", base.systems?.order.instances?.dev?.url === "http://dev2");

    // ----------------------------------------------------------------
    console.log("[2] 纯函数：加系统时同名系统不被整体替换");
    // ----------------------------------------------------------------
    const base2 = parseConfigText(
      ["systems:", "  order:", "    instances:", "      dev:", "        url: http://dev", "        username: u", "        password: p"].join("\n"),
      "inline",
    );
    const r1 = addSystemToConfig(base2, {
      systemName: "pay",
      envName: "dev",
      url: "http://pay",
      username: "pu",
      password: "pp",
    });
    check("新系统不算已存在", r1.systemExisted === false, r1);
    check("新系统已加入", base2.systems?.pay !== undefined);
    check("原系统保留", base2.systems?.order !== undefined);

    const r2 = addSystemToConfig(base2, {
      systemName: "order",
      envName: "prod",
      url: "http://order-prod",
      username: "ou",
      password: "op",
    });
    check("同名系统被识别为已存在", r2.systemExisted === true, r2);
    check("已存在系统的原有环境未被清掉", base2.systems?.order.instances?.dev?.url === "http://dev");
    check("新环境追加进已有系统", base2.systems?.order.instances?.prod?.url === "http://order-prod");

    // ----------------------------------------------------------------
    console.log("[3] add：往已有系统加环境，其余内容不变");
    // ----------------------------------------------------------------
    const addPath = join(dir, "plus", "config.yaml");
    writeBaseConfig(addPath);
    const p1 = new ScriptedPrompter(["i", "1", "prod", "http://order-prod/xxl-job-admin", "svc", "pw"]);
    const a1 = await runAdd({ targetPath: addPath, prompter: p1, env: {} });
    check("状态为 added", a1.status === "added", a1.status);
    check("系统为 order", a1.systemName === "order", a1.systemName);
    check("环境为 prod", a1.envName === "prod", a1.envName);
    const cfg1 = loadConfigFile(addPath, { env: {}, strictPermissions: true });
    check("order/prod 已写入", cfg1.systems.order.instances.prod.url === "http://order-prod/xxl-job-admin");
    check("order/dev 保留", cfg1.systems.order.instances.dev.password === "devpass");
    check("pay 系统保留", cfg1.systems.pay.instances.dev.url === "http://pay/xxl-job-admin");
    check("alias 保留", cfg1.systems.order.alias === "订单系统");

    // ----------------------------------------------------------------
    console.log("[4] add：加新系统");
    // ----------------------------------------------------------------
    const p2 = new ScriptedPrompter(["s", "stock", "dev", "http://stock/xxl-job-admin", "su", "sp"]);
    const a2 = await runAdd({ targetPath: addPath, prompter: p2, env: {} });
    check("状态为 added", a2.status === "added", a2.status);
    check("系统为 stock", a2.systemName === "stock", a2.systemName);
    const cfg2 = loadConfigFile(addPath, { env: {} });
    check("新系统已加入", cfg2.systems.stock !== undefined);
    check("既有 order 系统未被影响", cfg2.systems.order.instances.prod !== undefined);
    check("既有 pay 系统未被影响", cfg2.systems.pay !== undefined);

    // ----------------------------------------------------------------
    console.log("[5] add：选 d 取消则不修改文件");
    // ----------------------------------------------------------------
    const before = readFileSync(addPath, "utf8");
    const p3 = new ScriptedPrompter(["d"]);
    const a3 = await runAdd({ targetPath: addPath, prompter: p3, env: {} });
    check("状态为 aborted", a3.status === "aborted", a3.status);
    check("文件内容未变", readFileSync(addPath, "utf8") === before);
    check("明确告知已取消", p3.lines.some((l) => l.includes("已取消")), p3.lines);

    // ----------------------------------------------------------------
    console.log("[6] add：配置文件不存在时报错而非新建");
    // ----------------------------------------------------------------
    const missing = join(dir, "nope", "config.yaml");
    const p4 = new ScriptedPrompter([]);
    let threw = false;
    let msg = "";
    try {
      await runAdd({ targetPath: missing, prompter: p4, env: {} });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    check("抛错", threw);
    check("错误提到先运行 init", msg.includes("init"), msg);
    check("文件未被创建", !existsSync(missing));

    // ----------------------------------------------------------------
    console.log("[7] init：继续添加能累积多条并一次性写入");
    // ----------------------------------------------------------------
    const initPath = join(dir, "multi", "config.yaml");
    // 流程：首条 order/dev → i 加环境 prod → s 加系统 pay/dev → d 结束
    const p5 = new ScriptedPrompter([
      "", "", "", "", "pw1",
      "i", "prod", "http://prod/xxl-job-admin", "svc", "pw2",
      "s", "pay", "dev", "http://pay/xxl-job-admin", "u", "pw3",
      "d",
    ]);
    const r5 = await runInit({ targetPath: initPath, prompter: p5, env: {} });
    check("状态为 created", r5.status === "created", r5.status);
    const cfg5 = loadConfigFile(initPath, { env: {}, strictPermissions: true });
    check("首条 order/dev 已写入", cfg5.systems.order.instances.dev.password === "pw1");
    check("继续添加的 order/prod 已写入", cfg5.systems.order.instances.prod !== undefined);
    check("继续添加的 pay 系统已写入", cfg5.systems.pay !== undefined);
    check("输出了写入条数", p5.lines.some((l) => l.includes("共写入 3 个环境")), p5.lines);

    // ----------------------------------------------------------------
    console.log("[8] init：一路回车（不解继续添加）仍可用");
    // ----------------------------------------------------------------
    const simplePath = join(dir, "simple", "config.yaml");
    const p6 = new ScriptedPrompter(["", "", "", "", "pw", "d"]);
    const r6 = await runInit({ targetPath: simplePath, prompter: p6, env: {} });
    check("状态为 created", r6.status === "created", r6.status);
    const cfg6 = loadConfigFile(simplePath, { env: {} });
    check("只写入一条", Object.keys(cfg6.systems.order.instances).length === 1);

    // ----------------------------------------------------------------
    console.log("[9] init：继续添加时覆盖已存在环境会提示");
    // ----------------------------------------------------------------
    const dupPath = join(dir, "dup", "config.yaml");
    const p7 = new ScriptedPrompter(["", "", "", "", "pw1", "i", "dev", "http://new-dev", "u", "pw2", "d"]);
    const r7 = await runInit({ targetPath: dupPath, prompter: p7, env: {} });
    check("状态为 created", r7.status === "created", r7.status);
    check("警告提示覆盖了已有环境", p7.messages.some((m) => m.includes("已存在") && m.includes("覆盖")), p7.messages);
    check("最终值为新值", loadConfigFile(dupPath, { env: {} }).systems.order.instances.dev.url === "http://new-dev");

    // ----------------------------------------------------------------
    console.log("[10] renderConfigDocument 标注系统与环境数量");
    // ----------------------------------------------------------------
    const doc = renderConfigDocument(cfg5);
    check("含系统/环境计数", doc.includes("2 个系统") && doc.includes("3 个环境"), doc.split("\n").slice(0, 4));
    check("含 add 命令提示", doc.includes("multi-xxl-job-mcp add"), doc.split("\n").slice(0, 5));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log("========== CLI add/continue 测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试执行异常: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});
