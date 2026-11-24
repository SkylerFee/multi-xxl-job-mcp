/**
 * 发布前的版本、标签与制品校验。
 *
 * 刻意做成纯函数 + 单一入口：CI 的构建任务（无 OIDC 权限）与发布任务（有 OIDC 权限）
 * 都调用它，保证「发布出去的东西」与「构建验证过的东西」是同一份判断。
 *
 * 用法：
 *   node scripts/release-policy.mjs                    # 校验 package.json
 *   node scripts/release-policy.mjs <tarball>          # 校验已打好的 tgz
 *
 * 环境变量（由 workflow 注入）：
 *   RELEASE_TAG         GitHub Release 的 tag，必须等于 v<version>
 *   RELEASE_PRERELEASE  'true' / 'false'，必须与版本是否含 prerelease 段一致
 *   GITHUB_OUTPUT       若存在，则写入 version / distTag / sha256 供后续 job 使用
 */
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "@skylerfee/multi-xxl-job-mcp";

/** 严格 SemVer（不接受构建后缀 +xxx，避免 npm 规范化后产生同版本多标签） */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * 校验发布身份：包名、版本、tag 与 prerelease 标志必须自洽。
 *
 * @param manifest package.json 的内容
 * @param releaseTag GitHub Release 的 tag，如 v0.1.0-beta.1
 * @param prerelease GitHub Release 的预发布标志
 * @returns version 与应使用的 npm dist-tag
 * @throws 任一项不一致时抛错，错误信息可直接给人看
 */
export function releaseIdentity(manifest, releaseTag, prerelease) {
  if (manifest?.name !== PACKAGE_NAME) {
    throw new Error("发布包名不符：期望 " + PACKAGE_NAME + "，实际 " + String(manifest?.name));
  }
  const version = manifest.version;
  if (typeof version !== "string" || version !== version.trim()) {
    throw new Error("发布版本不能包含首尾空白");
  }
  const matched = STRICT_SEMVER.exec(version);
  if (!matched) throw new Error("发布版本必须是无构建后缀的严格 SemVer，实际: " + version);

  const identifiers = matched[4]?.split(".") ?? [];
  if (identifiers.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error("预发布数字标识不能带前导零");
  }
  if (releaseTag !== "v" + version) {
    throw new Error("Release 标签与包版本不符：tag " + String(releaseTag) + "，版本 " + version);
  }
  if (typeof prerelease !== "boolean" || prerelease !== (identifiers.length > 0)) {
    throw new Error("GitHub prerelease 标志与包版本不符（版本 " + version + "，标志 " + String(prerelease) + "）");
  }

  // 约定：预发布标识的第一段即 npm dist-tag（0.1.0-beta.1 -> beta），
  // 正式版固定为 latest。这样 `npm i <pkg>@beta` 能精确拿到预览版。
  const distTag = identifiers[0] ?? "latest";
  if (identifiers.length > 0 && (!/^[a-z][a-z0-9-]*$/.test(distTag) || distTag === "latest")) {
    throw new Error("预发布通道必须以小写字母开头且不能是 latest，实际: " + distTag);
  }
  return { version, distTag };
}

/**
 * 校验 tarball 内的文件清单。
 *
 * 目的是防「不该发布的东西被发出去」：测试产物、源码、临时文件、密钥。
 * 这里用白名单而非黑名单——新增文件必须显式批准。白名单漏判的代价是发布失败（可恢复），
 * 黑名单漏判的代价是泄漏（不可恢复）。
 *
 * @param entries tar -tzf 的输出行
 * @throws 出现白名单外文件，或缺少必需文件
 */
export function assertPackageEntries(entries) {
  const required = [
    "package/package.json",
    "package/LICENSE",
    "package/README.md",
    "package/dist/src/server.js",
    "package/dist/src/cli.js",
    "package/dist/src/client.js",
    "package/dist/src/config.js",
    "package/dist/src/registry.js",
    "package/dist/src/models.js",
  ];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) throw new Error("制品中存在重复路径：" + entry);
    seen.add(entry);
    const allowed =
      entry === "package/package.json" ||
      entry === "package/LICENSE" ||
      entry === "package/README.md" ||
      /^package\/dist\/src\/[a-zA-Z0-9_-]+\.js$/.test(entry);
    if (!allowed) {
      throw new Error("制品包含白名单外文件：" + entry + "（若是新增的合法产物，请更新 release-policy.mjs 的白名单）");
    }
  }
  for (const need of required) {
    if (!seen.has(need)) throw new Error("制品缺少必要文件：" + need);
  }
}

/**
 * 校验已打好的 tarball，不执行其中任何内容。
 *
 * @param path tgz 路径
 * @returns version / distTag / sha256
 */
function inspectTarball(path) {
  const entries = execFileSync("tar", ["-tzf", path], { encoding: "utf8" }).trim().split("\n");
  assertPackageEntries(entries);

  // 只接受普通文件：链接/设备节点可能指向包外路径，是打包阶段的危险信号
  const verbose = execFileSync("tar", ["-tvzf", path], { encoding: "utf8" }).trim().split("\n");
  if (verbose.some((line) => !line.startsWith("-"))) {
    throw new Error("制品只允许普通文件，不接受符号链接或特殊节点");
  }

  const manifest = JSON.parse(execFileSync("tar", ["-xOzf", path, "package/package.json"], { encoding: "utf8" }));
  const identity = releaseIdentity(manifest, process.env.RELEASE_TAG, process.env.RELEASE_PRERELEASE === "true");
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  return { ...identity, sha256 };
}

/** 入口：按是否传入 tgz 路径分派到身份校验或制品校验，并把结果写到 GITHUB_OUTPUT */
function main() {
  if (!["true", "false"].includes(process.env.RELEASE_PRERELEASE ?? "")) {
    throw new Error("缺少或不合法的 RELEASE_PRERELEASE（应为 true / false）");
  }
  const path = process.argv[2];
  const result =
    path === undefined
      ? releaseIdentity(JSON.parse(readFileSync("package.json", "utf8")), process.env.RELEASE_TAG, process.env.RELEASE_PRERELEASE === "true")
      : inspectTarball(path);

  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(result)) {
      appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
    }
  }
  console.log("[release-policy] 发布检查通过", JSON.stringify(result));
}

// 仅在被直接执行时运行 main，被测试 import 时不触发副作用
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error("[release-policy] 发布检查失败：" + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
