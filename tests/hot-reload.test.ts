/**
 * 配置热加载测试。
 *
 * 覆盖三层：
 * - TargetRegistry.reload：换配置、清缓存、丢弃计数
 * - buildServer 的 configPath 开关：不传时行为不变
 * - 端到端：改文件后下一次工具调用读到新配置；配置写错时保留旧配置
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildConfig } from "../src/config.js";
import { TargetRegistry } from "../src/registry.js";
import { buildServer } from "../src/server.js";

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

/** 构造一份最小合法配置对象 */
function makeConfig(systemNames: string[]): ReturnType<typeof buildConfig> {
  return buildConfig({
    systems: Object.fromEntries(
      systemNames.map((n) => [n, { instances: { dev: { url: "http://127.0.0.1:8080/x", username: "u", password: "p" } } }]),
    ),
  });
}

/** 把配置写成 YAML 文件（内容由调用方给） */
function writeYaml(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o600);
}

/** 生成一份含指定系统名的合法 YAML 文本 */
function yamlFor(systems: string[]): string {
  const blocks = systems.map(
    (s) =>
      "  " + s + ":\n    instances:\n      dev:\n        url: http://127.0.0.1:8080/x\n        username: u\n        password: p",
  );
  return "systems:\n" + blocks.join("\n") + "\n";
}

/** 建一个连到内存传输的客户端，方便直接调工具 */
async function connect(configPath?: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const registry = new TargetRegistry(makeConfig(["demo"]), { logger: () => {} });
  const server = buildServer(registry, configPath === undefined ? {} : { configPath });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "hot-reload-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** 调 list_instances 并返回纯文本 */
async function listInstances(client: Client): Promise<string> {
  const result = await client.callTool({ name: "list_instances", arguments: {} });
  return (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mxxl-reload-"));
  try {
    // ----------------------------------------------------------------
    console.log("[1] TargetRegistry.reload：换配置并清缓存");
    // ----------------------------------------------------------------
    const registry = new TargetRegistry(makeConfig(["a"]), { logger: () => {} });
    check("初始只有 a", registry.list().length === 1, registry.list());
    registry.get("a", "dev");
    check("取过一次后有缓存", registry.list().length === 1);

    const dropped = registry.reload(makeConfig(["b", "c"]));
    check("返回新配置的系统数", dropped.systems === 2, dropped);
    check("返回丢弃的客户端数", dropped.droppedClients === 1, dropped);
    check("新配置生效", registry.list().map((s) => s.system).join(",") === "b,c", registry.list());
    check("旧系统已不可用", (() => { try { registry.get("a", "dev"); return false; } catch { return true; } })());

    // ----------------------------------------------------------------
    console.log("[2] reload 后客户端重建（不复用旧实例）");
    // ----------------------------------------------------------------
    const created: string[] = [];
    const reg2 = new TargetRegistry(makeConfig(["x"]), {
      createClient: (cfg) => {
        created.push(cfg.baseUrl);
        return { baseUrl: cfg.baseUrl };
      },
      logger: () => {},
    });
    reg2.get("x", "dev");
    check("构造了一次客户端", created.length === 1, created);
    reg2.get("x", "dev");
    check("同目标复用，不再构造", created.length === 1, created);
    reg2.reload(makeConfig(["x"]));
    reg2.get("x", "dev");
    check("reload 后重新构造客户端", created.length === 2, created);

    // ----------------------------------------------------------------
    console.log("[3] 不传 configPath 时不启用热加载（行为与旧版一致）");
    // ----------------------------------------------------------------
    const noReloadPath = join(dir, "noreload", "config.yaml");
    writeYaml(noReloadPath, yamlFor(["demo"]));
    const c1 = await connect();
    try {
      const before = await listInstances(c1.client);
      writeYaml(noReloadPath, yamlFor(["demo", "extra"]));
      const after = await listInstances(c1.client);
      check("结果不含重载提示", !after.includes("已自动重载"), after.slice(0, 120));
      check("两次结果一致（未重载）", before === after);
    } finally {
      await c1.close();
    }

    // ----------------------------------------------------------------
    console.log("[4] 端到端：改配置后下一次调用读到新内容");
    // ----------------------------------------------------------------
    const livePath = join(dir, "live", "config.yaml");
    writeYaml(livePath, yamlFor(["demo"]));
    const c2 = await connect(livePath);
    try {
      const before = await listInstances(c2.client);
      check("初始只有 demo", before.includes("demo") && !before.includes("added"), before);

      // 改文件内容（mtime 与 size 都会变）
      writeYaml(livePath, yamlFor(["demo", "added"]));
      const after = await listInstances(c2.client);
      check("出现重载提示", after.includes("已自动重载"), after.slice(0, 160));
      check("新系统已可见", after.includes("added"), after);

      const again = await listInstances(c2.client);
      check("再次调用不再重复提示", !again.includes("已自动重载"), again.slice(0, 120));
    } finally {
      await c2.close();
    }

    // ----------------------------------------------------------------
    console.log("[5] 配置写错时保留旧配置且不崩溃");
    // ----------------------------------------------------------------
    const brokenPath = join(dir, "broken", "config.yaml");
    writeYaml(brokenPath, yamlFor(["good"]));
    const c3 = await connect(brokenPath);
    try {
      await listInstances(c3.client);
      writeYaml(brokenPath, "systems:\n  bad:\n    instances:\n      dev:\n        url: http://x\n        username: u\n");
      const after = await listInstances(c3.client);
      check("提示重载失败", after.includes("重载失败"), after.slice(0, 160));
      check("错误信息含具体字段", after.includes("password"), after.slice(0, 200));
      // 这里保留的是「进程启动时的配置」，即 connect() 用 makeConfig(["demo"]) 建的那份。
      // 文件里的 good 从未被成功读入（那份文件本身就是拿来做重载目标用的），
      // 所以断言的是 demo 仍在，而不是 good。
      check("旧配置（demo）仍然可用", after.includes("demo"), after);
    } finally {
      await c3.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("");
  console.log("========== 配置热加载测试: " + passed + " 通过, " + failed + " 失败 ==========");
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("测试执行异常: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});
