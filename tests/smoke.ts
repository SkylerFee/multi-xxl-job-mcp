/**
 * 冒烟测试：不依赖真实 XXL-JOB 环境，
 * 通过 InMemoryTransport 连接 MCP Server，校验工具注册情况。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

async function main(): Promise<void> {
  // 注册表在此只用于注册工具；静默 logger 避免污染测试输出
  const registry = new TargetRegistry(buildFakeConfig(), { logger: () => {} });

  const server = buildServer(registry);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: "smoke-test", version: "1.0.0" });
  await mcpClient.connect(clientTransport);

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

  await mcpClient.close();
  await server.close();
}

main().catch((e) => {
  console.error("冒烟测试异常:", e);
  process.exit(1);
});
