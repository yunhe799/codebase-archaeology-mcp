# 代码库考古 MCP（codebase-archaeology-mcp）

一个跑在 **stdio** 上的 MCP 服务器：把 git 的历史整理成 agent 能直接读的「考古报告」——
**谁改的、什么时候、为什么、哪里最容易出事**。

接进任何支持 MCP 的 coding agent 后，它就能回答这类问题了：

- 「这个文件为什么这么乱？」→ `file_history` + `line_blame`
- 「这个阈值当初为什么设成 20？」→ `find_introduction` + `commit_info`
- 「我们为什么没用向量库？」→ `decision_log`
- 「最近谁在动这块代码？」→ `recent_changes` + `churn_hotspots`

## 8 个工具

| 工具 | 回答什么问题 |
| --- | --- |
| `recent_changes` | 这个仓库最近在动什么（考古第一步） |
| `file_history` | 某个文件的历史（默认跟随重命名） |
| `line_blame` | 这几行分别是谁、在哪次提交里写的（并把行归到各自的提交上） |
| `find_introduction` | 这个字符串/正则是**什么时候**被引入或删掉的（pickaxe；指出最早那一次） |
| `commit_info` | 那次提交到底干了什么（完整提交正文 + 改动统计，可选 diff） |
| `search_history` | 从提交信息里搜「为什么这么改」的讨论 |
| `decision_log` | 把散落的决策搜集起来：ADR 文档 + 代码里的 `WHY:` 注释 + 给了理由的提交 |
| `churn_hotspots` | 改动最频繁的文件（越动荡越值得考古） |

## 跑起来

```bash
cd codebase-archaeology-mcp
npm install
npm test          # 24 项工具断言 + 8 项 MCP 协议断言，全离线
node server.js    # 直接跑也行（它只会等 stdin 上的 JSON-RPC）
```

## 接进 Agent

在 agent 的 `.mcp.json` 里加一段，重启即可：

```json
{
  "mcpServers": {
    "archaeology": {
      "command": "node",
      "args": ["../codebase-archaeology-mcp/server.js"]
    }
  }
}
```

接上之后每个工具会以 `mcp__archaeology__<工具名>` 的名字出现在 agent 的工具表里。

## 效果示例

让 agent 查它自己仓库里一个阈值的来历：

```
> 为什么 src/context.ts 里的压缩阈值现在设成 20？用考古工具查出来龙去脉

  → mcp__archaeology__find_introduction({"pattern":"20","path":"src/context.ts"})
  → mcp__archaeology__file_history({"path":"src/context.ts"})
  → mcp__archaeology__commit_info({"sha":"9c8fe55","include_diff":true})
  → mcp__archaeology__commit_info({"sha":"a24447e"})

阈值 20 来自提交 9c8fe55「fix: 压缩阈值过低导致模型编造文件行数」，原来的 6 是
a24447e（第 7 章）引入的教程演示值。6 太小：读 9 个文件就触发压缩，刚读到的内容
当场被摘要掉，模型于是编数字（实测把 104 行说成 496 行，还编出个不存在的 src/index.ts）。
```

## 几个设计决定

| 决定 | 为什么 |
| --- | --- |
| 用 `execFile` + 参数数组调 git，**不经过 shell** | 路径、正则、提交信息里的任何字符都不会被当成命令执行（无注入面） |
| 工具出错返回 `isError` 而不是抛异常 | agent 能读到「为什么失败」并自己换参数/换工具，服务器不会崩 |
| 所有输出都做长度截断 | 一份巨大的 `git log` 不能把 agent 的上下文撑爆 |
| 把行 blame 结果**按提交分组** | 考古真正想知道的是「哪几次提交留下了这些行」，而不是逐行罗列 |
| 用官方 `@modelcontextprotocol/sdk` + zod | 参数校验在进业务代码之前就完成，协议握手/错误包装不用自己写 |

## 安全边界（为什么可以放心接）

这几条都是**自己就能验证**的，不用信任何第三方的"信任徽章"：

| 边界 | 具体做法 |
| --- | --- |
| **只读** | 只用 `git log` / `show` / `blame` / `rev-parse` / `grep` / `numstat`，**没有任何写命令**（没有 push / commit / reset / checkout / clean） |
| **路径白名单** | `repo` 只能指到 `ARCHAEOLOGY_ROOTS` 允许的根目录以内（默认只有服务器自己的工作目录）；越界直接拒，并在错误里告诉你怎样放开 |
| **不经过 shell** | `execFile("git", [参数数组])`——路径、正则、提交信息里的任何字符都不会被当成命令执行 |
| **凭证不出门** | 不联网、无网络请求；只读本地 git 仓库 |
| **失败不穿透** | 工具出错返回 `isError` + 可读信息，**不让异常穿透 stdio 污染 JSON-RPC 流**，服务器不崩 |
| **资源有上限** | 每个 git 调用 20 秒超时；单个工具结果头尾截断并标注省略字数 |

这些都有测试钉着（`npm test`：工具层 25 项 + 协议层 8 项），其中两条专门验安全属性：
「白名单之外的路径被拒」和「出错之后服务器依然可用」。

## 依赖

`@modelcontextprotocol/sdk`（官方 SDK）+ `zod`（参数校验）。除此之外只用 Node 内置模块。
