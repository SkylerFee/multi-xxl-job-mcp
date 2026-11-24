/**
 * 冒烟测试：不依赖真实 XXL-JOB 环境，
 * 通过 InMemoryTransport 连接 MCP Server，校验工具注册情况。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { TargetRegistry } from "../src/registry.js";
import { buildServer } from "../src/server.js";

/** 期望注册的全部工具。新增工具时必须同步此处，否则冒烟测试会漏测。 */
const EXPECTED_TOOLS = [
  "list_instances",
  "list_job_groups",
  "list_jobs",
  "get_job",
  "add_job",
  "update_job",
  "start_job",
  "stop_job",
  "remove_job",
  "trigger_job",
  "preview_next_trigger_times",
  "list_job_logs",
  "get_job_log_content",
];

/** 构造一份最小可用配置，仅用于注册工具，不会发起真实请求 */
function buildFakeConfig() {
  return {
    systems: {
      smoke: {
        alias: "冒烟测试",
        instances: {
          dev: {
            url: "http://127.0.0.1:8080/xxl-job-admin",
            username: "admin",
            password: "123456",
            timeoutMs: 15000,
          },
        },
      },
    },
  };
}

/**
 * 递归扫描所有工具的 inputSchema，找出 type 为数组的节点。
 *
 * 只认 "type 是数组" 这一种情况——它是最典型的跨客户端不兼容点；
 * 其余结构差异（如 oneOf vs anyOf）各家都能接受，不在此处裁决。
 *
 * @returns 形如 "工具名: a.b.c -> ["number","string"]" 的描述，供失败时打印
 */
function collectTypeArrays(tools: { name: string; inputSchema?: unknown }[]): string[] {
  const found: string[] = [];

  /** 深度优先遍历，path 用于在报错里指明具体位置 */
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, path + "[" + i + "]"));
      return;
    }
    if (node === null || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.type)) {
      found.push(path + " -> " + JSON.stringify(obj.type));
    }
    for (const [key, value] of Object.entries(obj)) {
      // 跳过 required / enum 这类本身就是字符串数组的字段，它们不是 type 声明
      if (key === "required" || key === "enum") continue;
      walk(value, path === "" ? key : path + "." + key);
    }
  };

  for (const tool of tools) {
    walk(tool.inputSchema, tool.name + ": inputSchema");
  }
  return found;
}

async function main(): Promise<void> {
  // 注册表在此只用于注册工具；静默 logger 避免污染测试输出
  const registry = new TargetRegistry(buildFakeConfig(), { logger: () => {} });

  const server = buildServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: "smoke-test", version: "1.0.0" });
  await mcpClient.connect(clientTransport);

  // 服务版本必须与 package.json 一致。
  // 这里曾经硬编码 0.0.1，而 package.json 已发到 0.1.0-beta.1，客户端握手看到的版本永远停在旧值。
  // 现在版本由 src/server.ts 运行时从 package.json 读取，这条断言守住「读取逻辑没被改坏」。
  const serverInfo = mcpClient.getServerVersion() as { version?: string } | undefined;
  const pkgVersion = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
  ).version as string;
  if (serverInfo?.version === pkgVersion) {
    console.log(`冒烟测试通过: 握手版本与 package.json 一致（${pkgVersion}）`);
  } else {
    console.error(`冒烟测试失败: 握手版本 ${serverInfo?.version} 与 package.json ${pkgVersion} 不一致`);
    process.exitCode = 1;
  }

  const { tools } = await mcpClient.listTools();
  const names = tools.map((t) => t.name);

  console.log(`已注册工具数: ${names.length}`);
  let missing = 0;
  for (const name of EXPECTED_TOOLS) {
    const found = names.includes(name);
    console.log(`  ${found ? "OK " : "MISS"} ${name}`);
    if (!found) missing++;
  }

  if (missing === 0) {
    console.log(`冒烟测试通过: 全部 ${EXPECTED_TOOLS.length} 个工具注册成功`);
  } else {
    console.error(`冒烟测试失败: 缺少 ${missing} 个工具`);
    process.exitCode = 1;
  }

  // 额外校验：所有工具都暴露了 system / env 两个必填参数
  const withoutTarget = tools.filter((t) => {
    if (t.name === "list_instances") return false;
    const props = (t.inputSchema as { required?: string[] })?.required ?? [];
    return !(props.includes("system") && props.includes("env"));
  });
  if (withoutTarget.length === 0) {
    console.log("冒烟测试通过: 所有操作类工具都要求 system / env");
  } else {
    console.error(`冒烟测试失败: 以下工具缺少 system/env 必填参数: ${withoutTarget.map((t) => t.name).join(", ")}`);
    process.exitCode = 1;
  }

  // 额外校验：schema 里不允许出现 type 数组（如 type: ["number","string"]）。
  //
  // 这种写法合法（JSON Schema draft-07 允许 type 为字符串数组），但把 tool schema 映射到
  // 「单一 type」方言的客户端——典型是 Gemini function declarations 用的 OpenAPI 子集——
  // 可能拒收整个工具，或静默丢掉那条约束。表现是「在 Inspector 里正常，换个客户端就不可用」，
  // 极难排查，所以在这里直接拦住。要表达「多种类型」时改用 anyOf / oneOf。
  const typeArrays = collectTypeArrays(tools);
  if (typeArrays.length === 0) {
    console.log("冒烟测试通过: 所有工具 schema 都不含 type 数组（跨客户端可移植）");
  } else {
    console.error("冒烟测试失败: 以下 schema 使用了 type 数组，部分客户端会拒收或丢约束：");
    for (const item of typeArrays) console.error("  " + item);
    console.error("  修法：改用 anyOf / oneOf，每个分支单一 type。");
    process.exitCode = 1;
  }

  await mcpClient.close();
  await server.close();
}

main().catch((e) => {
  console.error("冒烟测试异常:", e);
  process.exit(1);
});
