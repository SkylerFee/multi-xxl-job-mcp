/**
 * 配置模块：从环境变量读取 XXL-JOB 调度中心连接信息。
 */

export interface XxlJobConfig {
  /** 调度中心地址，如 http://127.0.0.1:8080/xxl-job-admin（不带末尾斜杠） */
  baseUrl: string;
  /** 登录用户名 */
  username: string;
  /** 登录密码 */
  password: string;
  /** HTTP 超时（毫秒） */
  timeoutMs: number;
}

/**
 * 读取并校验环境变量配置，缺失时抛出带明确指引的错误。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): XxlJobConfig {
  const baseUrl = env.XXL_JOB_URL;
  const username = env.XXL_JOB_USERNAME;
  const password = env.XXL_JOB_PASSWORD;

  const missing: string[] = [];
  if (!baseUrl) missing.push("XXL_JOB_URL");
  if (!username) missing.push("XXL_JOB_USERNAME");
  if (!password) missing.push("XXL_JOB_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `缺少必需的环境变量: ${missing.join(", ")}。` +
        `请在 MCP 客户端配置中设置，例如 XXL_JOB_URL=http://127.0.0.1:8080/xxl-job-admin`,
    );
  }

  const timeoutRaw = env.XXL_JOB_TIMEOUT_MS;
  let timeoutMs = 15000;
  if (timeoutRaw) {
    const parsed = Number(timeoutRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`XXL_JOB_TIMEOUT_MS 必须是正整数（毫秒），当前值: ${timeoutRaw}`);
    }
    timeoutMs = parsed;
  }

  return {
    baseUrl: baseUrl!.replace(/\/+$/, ""),
    username: username!,
    password: password!,
    timeoutMs,
  };
}
