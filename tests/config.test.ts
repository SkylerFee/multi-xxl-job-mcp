/**
 * 配置解析层单元测试。
 *
 * 覆盖：YAML/JSON 双格式、插值、两层结构校验、权限检查、跨平台路径。
 * 全部使用临时文件与注入的环境变量表，不依赖真实用户目录与网络。
 */

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildConfig,
  interpolate,
  loadConfigFile,
  redactUrlCredentials,
  resolveConfigPath,
  ConfigError,
} from "../src/config.js";

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

/** 断言某段代码抛出 ConfigError，且消息包含给定片段 */
function expectConfigError(name: string, fn: () => unknown, fragment: string): void {
  try {
    fn();
    check(name, false, "预期抛错但未抛");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, e instanceof ConfigError && msg.includes(fragment), {
      type: e instanceof Error ? e.name : typeof e,
      msg,
    });
  }
}

/** 在临时目录写入文件并返回路径 */
function writeTemp(dir: string, name: string, content: string, mode?: number): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  if (mode !== undefined) chmodSync(p, mode);
  return p;
}

const YAML_OK = [
  "systems:",
  "  order:",
  "    alias: 订单系统",
  "    instances:",
  "      dev:",
  "        url: http://127.0.0.1:8080/xxl-job-admin/",
  "        username: admin",
  "        password: 123456",
  "      prod:",
  "        url: https://order.example.com/xxl-job-admin",
  "        username: ${ORDER_USER}",
  "        password: ${ORDER_PASS}",
  "        timeoutMs: 30000",
  "  payment:",
  "    instances:",
  "      dev:",
  "        url: http://127.0.0.1:8081/xxl-job-admin",
  "        username: admin",
  "        password: 123456",
  "",
].join("\n");

const ENV = { ORDER_USER: "svc_order", ORDER_PASS: "s3cret" };

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "mxxl-cfg-"));
  try {
    console.log("[1] YAML 解析与插值");
    const yamlPath = writeTemp(dir, "config.yaml", YAML_OK, 0o600);
    const cfg = loadConfigFile(yamlPath, { env: ENV });
    check("两个系统", Object.keys(cfg.systems).length === 2, Object.keys(cfg.systems));
    check("alias 解析", cfg.systems.order.alias === "订单系统", cfg.systems.order.alias);
    check("无 alias 时为 undefined", cfg.systems.payment.alias === undefined, cfg.systems.payment.alias);
    check("url 去掉末尾斜杠", cfg.systems.order.instances.dev.url === "http://127.0.0.1:8080/xxl-job-admin", cfg.systems.order.instances.dev.url);
    check("变量插值生效", cfg.systems.order.instances.prod.username === "svc_order", cfg.systems.order.instances.prod.username);
    check("密码插值生效", cfg.systems.order.instances.prod.password === "s3cret");
    check("timeoutMs 使用配置值", cfg.systems.order.instances.prod.timeoutMs === 30000);
    check("timeoutMs 默认 15000", cfg.systems.order.instances.dev.timeoutMs === 15000);

    console.log("[2] JSON 解析");
    const jsonPath = writeTemp(dir, "config.json", JSON.stringify({
      systems: { only: { instances: { dev: { url: "http://h/a", username: "u", password: "p" } } } },
    }), 0o600);
    const jsonCfg = loadConfigFile(jsonPath, { env: {} });
    check("JSON 可解析", jsonCfg.systems.only.instances.dev.url === "http://h/a");

    console.log("[3] 插值错误");
    expectConfigError("未设置的变量报错", () => loadConfigFile(yamlPath, { env: {} }), "未设置的环境变量");
    expectConfigError("错误信息含字段路径", () => loadConfigFile(yamlPath, { env: {} }), "systems.order.instances.prod.username");
    check("interpolate 直接可用", interpolate("a-${X}-b", { X: "1" }, "f") === "a-1-b");

    console.log("[4] 结构校验");
    expectConfigError("缺少 systems", () => buildConfig({}), "缺少必需的 systems");
    expectConfigError("systems 为空", () => buildConfig({ systems: {} }), "不能为空");
    expectConfigError("缺 url", () => buildConfig({ systems: { s: { instances: { dev: { username: "u", password: "p" } } } } }), "url");
    expectConfigError("缺 password", () => buildConfig({ systems: { s: { instances: { dev: { url: "http://h", username: "u" } } } } }), "password");
    expectConfigError("空 username 字符串", () => buildConfig({ systems: { s: { instances: { dev: { url: "http://h", username: "", password: "p" } } } } }), "username");
    expectConfigError("instances 为空", () => buildConfig({ systems: { s: { instances: {} } } }), "instances 不能为空");
    expectConfigError("系统名非法字符", () => buildConfig({ systems: { "bad name": { instances: { dev: { url: "http://h", username: "u", password: "p" } } } } }), "系统名");
    expectConfigError("环境名非法字符", () => buildConfig({ systems: { s: { instances: { "bad env!": { url: "http://h", username: "u", password: "p" } } } } }), "环境名");
    expectConfigError("timeoutMs 非正整数", () => buildConfig({ systems: { s: { instances: { dev: { url: "http://h", username: "u", password: "p", timeoutMs: 0 } } } } }), "timeoutMs");

    console.log("[5] alias 规则");
    const aliasOk = buildConfig({
      systems: {
        a: { alias: "任意中文 别名!", instances: { dev: { url: "http://h", username: "u", password: "p" } } },
        b: { alias: "任意中文 别名!", instances: { dev: { url: "http://h", username: "u", password: "p" } } },
      },
    });
    check("alias 支持中文与符号", aliasOk.systems.a.alias === "任意中文 别名!");
    check("alias 允许重名", aliasOk.systems.a.alias === aliasOk.systems.b.alias);

    console.log("[6] 文件权限");
    const loose = writeTemp(dir, "loose.yaml", YAML_OK, 0o644);
    let warned = false;
    const origErr = console.error;
    console.error = () => { warned = true; };
    try {
      loadConfigFile(loose, { env: ENV });
    } finally {
      console.error = origErr;
    }
    check("644 时告警", warned);
    expectConfigError("strictPermissions 时拒绝", () => loadConfigFile(loose, { env: ENV, strictPermissions: true }), "权限过于宽松");

    console.log("[7] 文件缺失与格式错误");
    expectConfigError("文件缺失报错", () => loadConfigFile(join(dir, "nope.yaml"), {}), "配置文件不存在");
    const brokenPath = writeTemp(dir, "broken.yaml", "systems: [unclosed", 0o600);
    expectConfigError("YAML 语法错误", () => loadConfigFile(brokenPath, {}), "解析失败");

    console.log("[8] 统一配置路径（三平台同一规则）");
    const home = "/home/tester";
    const expected = "/home/tester/.config/multi-xxl-job-mcp/config.yaml";
    check("linux 默认 ~/.config", resolveConfigPath("linux", {}, home) === expected, resolveConfigPath("linux", {}, home));
    check("linux 尊重 XDG_CONFIG_HOME", resolveConfigPath("linux", { XDG_CONFIG_HOME: "/xdg" }, home) === "/xdg/multi-xxl-job-mcp/config.yaml", resolveConfigPath("linux", { XDG_CONFIG_HOME: "/xdg" }, home));
    check("darwin 与 linux 一致（不再用 Application Support）", resolveConfigPath("darwin", {}, home) === expected, resolveConfigPath("darwin", {}, home));
    check("win32 与 linux 一致（不再用 APPDATA）", resolveConfigPath("win32", {}, home) === expected, resolveConfigPath("win32", {}, home));
    check("darwin 也尊重 XDG_CONFIG_HOME", resolveConfigPath("darwin", { XDG_CONFIG_HOME: "/xdg" }, home) === "/xdg/multi-xxl-job-mcp/config.yaml", resolveConfigPath("darwin", { XDG_CONFIG_HOME: "/xdg" }, home));
    check("三平台返回同一路径", new Set(["linux", "darwin", "win32"].map((p) => resolveConfigPath(p as NodeJS.Platform, {}, home))).size === 1);

    console.log("[9] URL 凭据剥离（redactUrlCredentials）");
    // 这条函数是 list_instances / 日志 / 错误信息共用的脱敏入口，
    // 一旦它失效，凭据会同时从三个渠道泄漏出去，所以边界要逐个钉住。
    const cases: [string, string, string][] = [
      ["剥掉 user:pass", "http://admin:secret@host:8080/xxl-job-admin", "http://host:8080/xxl-job-admin"],
      ["剥掉只含 user 的写法", "https://token@host/xxl-job-admin", "https://host/xxl-job-admin"],
      ["剥掉百分号编码的密码", "http://u:p%40ss@host/x", "http://host/x"],
      ["无 userinfo 时原样返回", "http://host:8080/xxl-job-admin", "http://host:8080/xxl-job-admin"],
      ["https 保留 scheme", "https://a:b@h.com/p", "https://h.com/p"],
      ["空串原样返回", "", ""],
      ["不含 scheme 的字符串不动", "host:8080/xxl-job-admin", "host:8080/xxl-job-admin"],
    ];
    for (const [name, input, expected] of cases) {
      const actual = redactUrlCredentials(input);
      check(name, actual === expected, { input, expected, actual });
    }
    check("剥离后不再含密码", !redactUrlCredentials("http://admin:secret@h/x").includes("secret"));
    check("剥离后保留 host 与 path", redactUrlCredentials("http://admin:secret@h:8080/xxl-job-admin").includes("h:8080/xxl-job-admin"));
    check(
      "多次调用幂等",
      redactUrlCredentials(redactUrlCredentials("http://a:b@h/x")) === redactUrlCredentials("http://a:b@h/x"),
    );

  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log("========== 配置层测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main();