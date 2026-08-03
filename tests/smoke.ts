/**
 * 冒烟测试：不依赖真实 XXL-JOB 环境，
 * 通过 InMemoryTransport 连接 MCP Server，校验工具注册情况。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { XxlJobClient } from "../src/client.js";
import { buildServer } from "../src/server.js";

const EXPECTED_TOOLS = [
  "list_job_groups",
  "list_jobs",
  "get_job",
  "add_job",
  "update_job",
  "start_job",
  "stop_job",
  "trigger_job",
  "preview_next_trigger_times",
  "list_job_logs",
  "get_job_log_content",
];

async function main(): Promise<void> {
  // 构造一个不发起真实请求的 client（仅用于注册工具）
  const xxlClient = new XxlJobClient({
    baseUrl: "http://127.0.0.1:8080/xxl-job-admin",
    username: "admin",
    password: "123456",
    timeoutMs: 15000,
  });

  const server = buildServer(xxlClient);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const mcpClient = new Client({ name: "smoke-test", version: "1.0.0" });
  await mcpClient.connect(clientTransport);

  const { tools } = await mcpClient.listTools();
  const names = tools.map((t) => t.name);

  console.log(`已注册工具数: ${names.length}`);
  for (const name of EXPECTED_TOOLS) {
    const found = names.includes(name);
    console.log(`  ${found ? "OK " : "MISS"} ${name}`);
    if (!found) {
      process.exitCode = 1;
    }
  }

  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length === 0) {
    console.log("冒烟测试通过: 全部 11 个工具注册成功");
  } else {
    console.error(`冒烟测试失败: 缺少工具 ${missing.join(", ")}`);
  }

  await mcpClient.close();
  await server.close();
}

main().catch((e) => {
  console.error("冒烟测试异常:", e);
  process.exit(1);
});
