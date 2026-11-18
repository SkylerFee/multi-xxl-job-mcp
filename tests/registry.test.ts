/**
 * 目标注册表单元测试。
 *
 * 覆盖：按 (system, env) 取客户端、实例复用、目标隔离、懒创建、
 * 未知系统/未知环境的错误信息、错误与展示内容不含密码。
 * 全部使用注入的假客户端工厂与假日志，不依赖真实调度中心与网络。
 */

import { XxlJobClient } from "../src/client.js";
import { buildConfig, ConfigFile, XxlJobConfig } from "../src/config.js";
import { TargetError, TargetRegistry, TargetDescription, TargetSummary } from "../src/registry.js";

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

/** 断言某段代码抛出 TargetError，且消息包含 / 不包含指定片段 */
function expectTargetError(
  name: string,
  fn: () => unknown,
  mustInclude: string[],
  mustExclude: string[] = [],
): void {
  try {
    fn();
    check(name, false, "预期抛错但未抛");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTargetError = e instanceof TargetError;
    const included = mustInclude.every((f) => msg.includes(f));
    const excluded = mustExclude.every((f) => !msg.includes(f));
    check(name, isTargetError && included && excluded, {
      type: e instanceof Error ? e.name : typeof e,
      msg,
      mustInclude,
      mustExclude,
    });
  }
}

/** 假客户端：只记录自己由哪份配置造出来，以及"是否已登录"这个会话状态 */
interface FakeClient {
  /** 自增序号，用于区分不同实例 */
  id: number;
  /** 构造时收到的配置，用于断言字段映射 */
  config: XxlJobConfig;
  /** 模拟登录态：同一实例复用时应保持不变 */
  loggedIn: boolean;
}

/** 假工厂的调用记录 */
interface FactoryLog {
  /** 每次调用收到的配置 */
  calls: XxlJobConfig[];
  /** 造出来的实例，按创建顺序 */
  created: FakeClient[];
}

/** 造一个记录调用的假工厂 */
function makeFactory(): { factory: (config: XxlJobConfig) => FakeClient; log: FactoryLog } {
  const log: FactoryLog = { calls: [], created: [] };
  const factory = (config: XxlJobConfig): FakeClient => {
    log.calls.push(config);
    const client: FakeClient = { id: log.created.length + 1, config, loggedIn: false };
    log.created.push(client);
    return client;
  };
  return { factory, log };
}

/** 造一个收集日志的 logger，用于断言关键判定入口有日志且日志不含密码 */
function makeLogger(): { logger: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { logger: (message: string) => lines.push(message), lines };
}

/** 测试用密码，任何对外输出都不应出现它 */
const PASSWORD = "s3cret-P@ss";
/** 环境变量插值用的取值，同样不应出现在展示与错误里（它本身是密码） */
const ENV_PASSWORD = "env-only-pass";

/** 测试用配置：两个系统，order 有 dev/prod，payment 只有 dev */
const RAW_CONFIG = {
  systems: {
    order: {
      alias: "订单系统",
      instances: {
        dev: { url: "http://127.0.0.1:8080/xxl-job-admin", username: "admin", password: PASSWORD },
        prod: {
          url: "https://order.example.com/xxl-job-admin",
          username: "svc_order",
          password: "${ORDER_PROD_PASS}",
          timeoutMs: 30000,
        },
      },
    },
    payment: {
      instances: {
        dev: { url: "http://127.0.0.1:8081/xxl-job-admin", username: "admin", password: PASSWORD },
      },
    },
  },
};

/** 测试用的环境变量表 */
const ENV = { ORDER_PROD_PASS: ENV_PASSWORD };

/** 构建测试配置：走真实的 buildConfig，顺带验证 usesEnvVars 标记 */
function testConfig(): ConfigFile {
  return buildConfig(RAW_CONFIG, ENV);
}

/** 主流程：按验收标准分组断言 */
function main(): void {
  console.log("[1] 按 (system, env) 取客户端与字段映射");
  {
    const { factory, log } = makeFactory();
    const { logger } = makeLogger();
    const registry = new TargetRegistry(testConfig(), { createClient: factory, logger });

    const client = registry.get("order", "dev");
    check("get 返回客户端", client !== undefined && client !== null);
    check("工厂只被调用一次", log.calls.length === 1, log.calls.length);

    const sent = log.calls[0];
    check("url 映射为 baseUrl", sent.baseUrl === "http://127.0.0.1:8080/xxl-job-admin", sent.baseUrl);
    check("username 透传", sent.username === "admin", sent.username);
    check("password 透传", sent.password === PASSWORD);
    check("timeoutMs 透传默认值", sent.timeoutMs === 15000, sent.timeoutMs);

    // 工厂收到的配置里应该只有 XxlJobConfig 的四个字段，不应额外泄漏内部结构
    check("工厂收到的是纯连接配置", Object.keys(sent).sort().join(",") === "baseUrl,password,timeoutMs,username", Object.keys(sent));
  }

  console.log("[2] 同一目标复用同一实例（登录态复用）");
  {
    const { factory, log } = makeFactory();
    const registry = new TargetRegistry(testConfig(), { createClient: factory, logger: () => {} });

    const first = registry.get("order", "dev");
    first.loggedIn = true; // 模拟一次登录
    const second = registry.get("order", "dev");
    const third = registry.get("order", "dev");

    check("同一实例", first === second && second === third);
    check("工厂只调用一次", log.calls.length === 1, log.calls.length);
    check("登录态得以复用", second.loggedIn === true);
  }

  console.log("[3] 不同目标会话隔离");
  {
    const { factory } = makeFactory();
    const registry = new TargetRegistry(testConfig(), { createClient: factory, logger: () => {} });

    const orderDev = registry.get("order", "dev");
    const orderProd = registry.get("order", "prod");
    const paymentDev = registry.get("payment", "dev");

    check("order/dev 与 order/prod 不同实例", orderDev !== orderProd);
    check("order/dev 与 payment/dev 不同实例", orderDev !== paymentDev);
    check("order/prod 与 payment/dev 不同实例", orderProd !== paymentDev);

    orderDev.loggedIn = true;
    check("一个目标登录不影响另一个", orderProd.loggedIn === false && paymentDev.loggedIn === false);
    check("order/prod 用了自定义 timeoutMs", orderProd.config.timeoutMs === 30000, orderProd.config.timeoutMs);
    check("order/prod 密码来自环境变量插值", orderProd.config.password === ENV_PASSWORD);
  }

  console.log("[4] 懒创建");
  {
    const { factory, log } = makeFactory();
    const registry = new TargetRegistry(testConfig(), { createClient: factory, logger: () => {} });

    check("构造注册表不创建客户端", log.created.length === 0, log.created.length);
    const summaries = registry.list();
    check("list 不创建客户端", log.created.length === 0, log.created.length);
    registry.describe("order", "prod");
    check("describe 不创建客户端", log.created.length === 0, log.created.length);
    expectTargetError("未知目标探测不创建客户端", () => registry.get("nope", "dev"), ["未知系统"]);
    check("失败的 get 不创建客户端", log.created.length === 0, log.created.length);

    registry.get("payment", "dev");
    check("只用过一个目标，也只创建一个", log.created.length === 1, log.created.length);
    check("只创建被请求的那个目标", log.calls[0].baseUrl === "http://127.0.0.1:8081/xxl-job-admin", log.calls[0].baseUrl);
    check("list 覆盖 2 个系统", summaries.length === 2, summaries.length);
  }

  console.log("[5] 未知系统报错并列出可用系统");
  {
    const registry = new TargetRegistry(testConfig(), { createClient: makeFactory().factory, logger: () => {} });
    expectTargetError(
      "未知系统抛出 TargetError",
      () => registry.get("ordr", "dev"),
      ["未知系统", "ordr", "order", "payment"],
      [PASSWORD, ENV_PASSWORD],
    );
    expectTargetError(
      "未知系统错误含全部系统名",
      () => registry.describe("x", "dev"),
      ["order, payment"],
    );
    expectTargetError(
      "__proto__ 不命中原型链",
      () => registry.get("__proto__", "dev"),
      ["未知系统", "__proto__"],
    );

    // 错误对象本身携带定位信息，便于工具层包装
    try {
      registry.get("ordr", "dev");
    } catch (e) {
      check("错误携带 system", e instanceof TargetError && e.system === "ordr", e instanceof TargetError ? e.system : typeof e);
    }
  }

  console.log("[6] 未知环境报错并列出该系统下可用环境");
  {
    const registry = new TargetRegistry(testConfig(), { createClient: makeFactory().factory, logger: () => {} });
    expectTargetError(
      "未知环境抛出 TargetError",
      () => registry.get("order", "prd"),
      ["未知环境", "prd", "order", "dev, prod"],
      [PASSWORD, ENV_PASSWORD],
    );
    expectTargetError(
      "只列该系统自己的环境",
      () => registry.get("payment", "prod"),
      ["dev"],
    );
    try {
      registry.get("payment", "prod");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // 只截"可用环境"之后的部分，避免被回显的请求参数 prod 干扰
      const available = msg.slice(msg.indexOf("可用环境"));
      check("payment 的环境列表不含 order 的 dev, prod", !available.includes("dev, prod") && available.includes("dev"), msg);
    }
    expectTargetError("describe 同样校验环境", () => registry.describe("order", "staging"), ["未知环境", "staging"]);
  }

  console.log("[7] 对外内容不含密码");
  {
    const loggerSink = makeLogger();
    const registry = new TargetRegistry(testConfig(), {
      createClient: makeFactory().factory,
      logger: loggerSink.logger,
    });

    const listJson = JSON.stringify(registry.list());
    check("list 结果不含密码", !listJson.includes(PASSWORD) && !listJson.includes(ENV_PASSWORD), listJson);

    const description = registry.describe("order", "prod");
    const descJson = JSON.stringify(description);
    check("describe 结果不含密码", !descJson.includes(PASSWORD) && !descJson.includes(ENV_PASSWORD), descJson);
    check("describe 无 password 字段", !("password" in description), Object.keys(description));

    registry.get("order", "dev");
    registry.get("order", "dev");
    registry.get("order", "prod");
    const allLogs = loggerSink.lines.join("\n");
    check("日志不含密码", !allLogs.includes(PASSWORD) && !allLogs.includes(ENV_PASSWORD), allLogs);
    check("日志记录了创建", allLogs.includes("创建客户端"), allLogs.slice(0, 200));
    check("日志记录了复用", allLogs.includes("复用已有客户端"), allLogs.slice(0, 200));
    check("日志记录了创建与复用之外还有启动信息", allLogs.includes("目标注册表已就绪"), loggerSink.lines.slice(0, 1));

    // 关键判定入口（拒绝未知目标）也必须留痕
    try {
      registry.get("ordr", "dev");
    } catch {
      // 预期抛错，只关心日志
    }
    const allLogs2 = loggerSink.lines.join("\n");
    check("拒绝未知系统有日志", allLogs2.includes("拒绝未知系统"), allLogs2.slice(-200));
  }

  console.log("[8] describe 与 list 的字段");
  {
    const registry = new TargetRegistry(testConfig(), { createClient: makeFactory().factory, logger: () => {} });

    const dev: TargetDescription = registry.describe("order", "dev");
    check("describe.url", dev.url === "http://127.0.0.1:8080/xxl-job-admin", dev.url);
    check("describe.username", dev.username === "admin", dev.username);
    check("无插值时 usesEnvVars 为 false", dev.usesEnvVars === false, dev.usesEnvVars);
    check("describe 只有三个字段", Object.keys(dev).sort().join(",") === "url,username,usesEnvVars", Object.keys(dev));

    const prod: TargetDescription = registry.describe("order", "prod");
    check("有插值时 usesEnvVars 为 true", prod.usesEnvVars === true, prod.usesEnvVars);

    const summaries: TargetSummary[] = registry.list();
    check("list 覆盖 2 个系统", summaries.length === 2, summaries);
    const order = summaries.find((s) => s.system === "order");
    const payment = summaries.find((s) => s.system === "payment");
    check("list 带别名", order?.alias === "订单系统", order?.alias);
    check("无别名时回落到系统键名", payment?.alias === "payment", payment?.alias);
    check("list 带环境列表", order?.envs.join(",") === "dev,prod", order?.envs);
    check("list 每项只有三个字段", JSON.stringify(Object.keys(summaries[0]).sort()) === JSON.stringify(["alias", "envs", "system"]), Object.keys(summaries[0]));
  }

  console.log("[9] 默认工厂构造真实客户端");
  {
    const { logger } = makeLogger();
    const registry = new TargetRegistry(testConfig(), { logger });
    const client = registry.get("order", "dev");
    check("未注入工厂时得到真实 XxlJobClient", client instanceof XxlJobClient);
    check("再次取得同一实例", registry.get("order", "dev") === client);
    check("不同目标得到不同真实实例", registry.get("payment", "dev") !== client);
  }

  console.log("");
  console.log("========== 目标注册表测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main();
