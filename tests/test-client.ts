/**
 * 联调脚本：连接真实 XXL-JOB 调度中心，逐步验证只读类接口。
 *
 * 运行前提：设置环境变量 XXL_JOB_URL / XXL_JOB_USERNAME / XXL_JOB_PASSWORD
 * 运行方式：npm run build && npm run test:client
 *
 * 注意：本脚本只执行【只读】操作（登录、查组、查任务、查日志），
 * 不会新增/修改/触发任何任务，可放心在生产环境运行。
 */

import { XxlJobClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { pageTotal } from "../src/models.js";

function step(title: string): void {
  console.log(`\n========== ${title} ==========`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`目标调度中心: ${config.baseUrl}，用户: ${config.username}`);

  const client = new XxlJobClient(config);

  step("1. 登录");
  await client.login();
  console.log("登录成功");

  step("2. 查询执行器组");
  const groups = await client.listJobGroups(1, 10);
  console.log(`共 ${pageTotal(groups)} 个执行器组:`);
  for (const g of groups.data) {
    console.log(`  - id=${g.id} appname=${g.appname} title=${g.title}`);
  }

  step("3. 查询任务列表");
  const jobs = await client.listJobs(1, 10);
  console.log(`共 ${pageTotal(jobs)} 个任务:`);
  for (const j of jobs.data) {
    console.log(
      `  - id=${j.id} [${j.triggerStatus === 1 ? "运行中" : "停止"}] ${j.jobDesc} handler=${j.executorHandler} ${j.scheduleType}=${j.scheduleConf}`,
    );
  }

  if (jobs.data.length > 0) {
    const first = jobs.data[0];
    step(`4. 查询任务详情 (id=${first.id})`);
    const detail = await client.getJobById(first.id);
    console.log(JSON.stringify(detail, null, 2));

    step(`5. 查询任务执行日志 (jobId=${first.id})`);
    const logs = await client.listJobLogs(1, 5, { jobId: first.id });
    console.log(`共 ${pageTotal(logs)} 条日志:`);
    for (const l of logs.data) {
      console.log(
        `  - logId=${l.id} triggerTime=${l.triggerTime} triggerCode=${l.triggerCode} handleCode=${l.handleCode} addr=${l.executorAddress}`,
      );
    }

    const finished = logs.data.find((l) => l.executorAddress && l.handleCode !== 2);
    if (finished && finished.triggerTime) {
      step(`6. 拉取日志正文 (logId=${finished.id})`);
      const detail2 = await client.logDetailCat(
        finished.id,
        finished.executorAddress!,
        new Date(finished.triggerTime).getTime() || finished.triggerTime,
        1,
      );
      console.log(`行范围: ${detail2.fromLineNum}-${detail2.toLineNum}，isEnd=${detail2.isEnd}`);
      console.log(detail2.logContent.slice(0, 1000));
    } else {
      console.log("（没有已完成的日志记录，跳过日志正文拉取）");
    }
  }

  console.log("\n联调脚本执行完毕");
}

main().catch((e) => {
  console.error("联调失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
