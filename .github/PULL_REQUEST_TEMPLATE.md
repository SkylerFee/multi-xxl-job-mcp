## 变更说明

<!-- 简要说明这个 PR 做了什么、为什么需要 -->

## 关联 issue

<!-- 例：Closes #12。无关联 issue 时可删除本节 -->

Closes #

## 变更类型

- [ ] Bug 修复（不改变既有行为的兼容性修复）
- [ ] 新功能（新增 MCP 工具或能力）
- [ ] 破坏性变更（既有调用方式或行为不兼容）
- [ ] 文档 / 工程配置

## 检查清单

> 新增或修改 MCP 工具时，按 AGENTS.md 约定需同步更新三处。

- [ ] 已运行 `npm run build` 且无报错
- [ ] 已运行 `npm run smoke` 且通过
- [ ] 已运行 `npm run test:integration` 且通过
- [ ] 若新增/修改工具：已同步 `src/server.ts` 的 `registerTool`
- [ ] 若新增/修改工具：已同步 `tests/smoke.ts` 的 `EXPECTED_TOOLS`
- [ ] 若新增/修改工具：已同步 `README.md` 的工具表
- [ ] 新增函数已带说明注释，关键判定处有日志
- [ ] 未提交任何真实凭据（.env、账号密码、私钥）

## 补充说明

<!-- 截图、测试输出、取舍理由等 -->
