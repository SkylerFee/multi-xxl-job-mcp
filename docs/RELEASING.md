# 发布流程

本包发布到 npm：**`@skylerfee/multi-xxl-job-mcp`**。

发布自动化，但有一个**必须先跨过的门槛**。

## 关键限制：首次发布不能用 OIDC

npm **不支持为尚不存在的包预配置 Trusted Publisher**。配置入口挂在包自己的 Settings 页
（`npmjs.com/package/<name>/access`）上；包不存在，就没有那个页面。

一手证据：npm 官方 issue
[#1926 "Missing guidance for first-time package publishing with Trusted Publishers (OIDC)"](https://github.com/npm/documentation/issues/1926)
（2026-03-26 创建，至今 OPEN）原文：

> attempting to publish a package for the first time using a GitHub Actions workflow
> with OIDC **failed**. The publish step did not succeed when the package did not yet
> exist on NPM. As a workaround, we had to: **Perform the first publish manually**
> (outside of OIDC / Trusted Publishers) … After the initial release existed on npm,
> subsequent releases using the GitHub Action with Trusted Publishers **worked as expected**

对照：PyPI 和 NuGet 都支持「pending trusted publisher」（为未来的包预配置），npm 没有。

**结论：首次手动，之后全自动。**

---

## 一次性引导（只有第一次）

### 1. 账号必须启用 2FA

npm 政策要求发布包时必须有 2FA。`npm profile get` 显示 `two-factor auth: disabled` 时，
**手动发布也会被拒**：

```
403 Two-factor authentication or granular access token with bypass 2fa enabled
    is required to publish packages.
```

启用方式：npmjs.com → Account → Two-Factor Authentication。

### 2. 刷新本地登录

```bash
npm login --auth-type=web
npm whoami          # 确认身份
```

> 本仓库此前的 token 已失效（`npm whoami` 返回 401），必须重新登录。

### 3. 手动发布首个版本

```bash
npm whoami                          # 确认为 skylerfee
npm publish --access public         # 启用 2FA 后会提示输入 OTP
```

> `publishConfig.access` 已设为 `public`，理论上可省略 `--access public`，
> 但首次发布显式写出更稳妥（scope 包默认是 restricted）。

确认已上架：

```bash
npm view @skylerfee/multi-xxl-job-mcp version
```

### 4. 配置 Trusted Publisher

包存在后，在 npm 包设置里绑定本仓库与工作流文件：

```bash
npm trust github @skylerfee/multi-xxl-job-mcp \
  --file publish.yml \
  --repository SkylerFee/multi-xxl-job-mcp \
  --allow-publish
```

先加 `--dry-run` 可校验参数而不写入：

```bash
npm trust github @skylerfee/multi-xxl-job-mcp \
  --file publish.yml --repository SkylerFee/multi-xxl-job-mcp --allow-publish --dry-run
```

核对：

```bash
npm trust list @skylerfee/multi-xxl-job-mcp
```

预期看到 `type: github`、`file: publish.yml`、`repository: SkylerFee/multi-xxl-job-mcp`。

<details>
<summary>或：用网页配置</summary>

包页面 → **Settings** → **Trusted Publisher** → **GitHub Actions**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `SkylerFee` |
| Repository | `multi-xxl-job-mcp` |
| Workflow filename | `publish.yml` |
| Environment name | `npm-publish` |

> Workflow filename **只写文件名**，不加 `.github/workflows/` 前缀。
> Environment name 必须填 `npm-publish`——`publish.yml` 的发布 job 用了同名 environment，
> 填空或不一致会导致 OIDC 声明不匹配。

</details>

---

## 之后的每次发布（全自动）

### 1. 改版本号

```bash
npm version 0.1.0-beta.2 --no-git-tag-version
# 或正式版
npm version 0.1.0 --no-git-tag-version
```

### 2. 走 PR 流程合并

版本号改动同样走分支 + PR（见 [AGENTS.md](../AGENTS.md) 的强制流程）。

### 3. 在 GitHub 上创建 Release

**tag 必须等于 `v<version>`，预发布标志必须与版本是否含 `-` 一致。**
`publish.yml` 会硬性校验这两项，不一致直接失败。

```bash
gh release create v0.1.0-beta.2 \
  --prerelease \
  --title 'v0.1.0-beta.2' \
  --notes '预览版本'
```

正式版去掉 `--prerelease`。

### 4. 等待 workflow 完成

```bash
gh run watch
```

---

## dist-tag 规则

| 版本 | dist-tag | 用户的安装方式 |
| --- | --- | --- |
| `0.1.0-beta.1` | `beta` | `npm i @skylerfee/multi-xxl-job-mcp@beta` |
| `0.1.0-alpha.1` | `alpha` | `npm i @skylerfee/multi-xxl-job-mcp@alpha` |
| `0.1.0` | `latest` | `npm i @skylerfee/multi-xxl-job-mcp` |

规则：**预发布标识的第一段就是 dist-tag**，正式版固定 `latest`。
这样预览版不会污染 `latest`，普通用户不会误装到未验证的版本。

### 各 tag 之间互不影响

发布一个新版本**只移动它自己的 tag**，其它 tag 保持原位：

- 发布 `0.1.0` → `latest` 指向 0.1.0；`beta` 仍指向最后一个预览版（如 `0.1.0-beta.2`）
- 发布 `0.2.0-beta.1` → `beta` 前移；`latest` 仍是 0.1.0

这意味着正式版发布后，`npm i <pkg>@beta` 拿到的**不是**最新代码，而是上一轮预览。
需要最新稳定版就直接不带 tag 安装。

---

## 自动发布做了什么

`publish.yml` 的两个 job 是**刻意分离**的：

### build（无 OIDC 权限）

1. 校验发布提交属于 `master` 历史（防止从未合并的分支或伪造 tag 发布）
2. 校验版本 / tag / prerelease 标志三者自洽（`scripts/release-policy.mjs`）
3. `npm ci` + `build` + `smoke` + `npm test` 完整验证
4. 打包，并按**白名单**校验产物内容（拒绝测试文件、源码、意外文件）
5. 计算 SHA-256，作为 artifact 上传

这个 job **拿不到发布身份**：即使依赖链被投毒，也无法发布。

### publish（有 OIDC 权限）

1. 下载 artifact，**核对 SHA-256** 与构建输出一致
2. 解开 tgz 读 `package.json`，核对包名与版本
3. `npm publish <tarball> --provenance --tag <distTag>`
4. 轮询 registry 直到版本可见

这个 job **不 checkout、不安装依赖、不执行仓库脚本**：即使发布身份被滥用，
也没有代码执行面。

---

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `403 ... 2FA ... is required` | 账号未启用 2FA，或 token 未勾选 Bypass 2FA |
| `E404` 发布失败 | scope 未创建，或 `--access public` 缺失 |
| `Release 标签与包版本不符` | tag 应为 `v<version>`，逐字一致 |
| `GitHub prerelease 标志与包版本不符` | 含 `-beta` 的版本必须勾选 prerelease |
| `制品包含白名单外文件` | 新增了产物文件，需更新 `scripts/release-policy.mjs` 的白名单 |
| `404 Not Found - PUT` 且是首次发布 | Trusted Publisher 无法用于不存在的包，按上文手动首发 |

---

## 为什么不直接在 CI 里用 NPM_TOKEN

OIDC 的优势是**不留长期凭据**：GitHub 签发短期令牌，npm 校验它来自配置过的
repo + workflow 文件。相比一个能长期发布任意版本、一旦泄漏就难以察觉的 token，
OIDC 把「凭据」变成了「一次性的身份声明」。

代价是首次发布必须手动——但这个代价只付一次。
