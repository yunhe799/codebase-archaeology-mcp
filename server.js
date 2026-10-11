#!/usr/bin/env node
// 代码库考古 MCP —— 一个跑在 stdio 上的 MCP 服务器。
//
// 它只做一件事：把 git 的历史整理成 agent 能直接读的"考古报告"（谁改的 / 什么时候 /
// 为什么 / 哪里最容易出事），然后用 MCP 把 8 个工具暴露出去。
//
// 用官方 SDK（@modelcontextprotocol/sdk）注册工具，参数校验、错误包装、协议握手
// 都由 SDK 负责，我们只写业务。
//
// ⚠️ stdout 是 JSON-RPC 通道，任何日志都必须走 stderr。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, ArchaeologyError } from "./src/archaeology.js";

const server = new McpServer(
  { name: "codebase-archaeology", version: "0.1.0" },
  {
    instructions:
      "代码库考古：查一个 git 仓库的历史与决策。先 recent_changes 看全貌，再用 file_history / line_blame / find_introduction 定位，最后用 commit_info / search_history / decision_log 挖出『为什么』。",
  },
);

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
    async (args) => {
      try {
        return { content: [{ type: "text", text: tool.handler(args ?? {}) }] };
      } catch (e) {
        // 工具出错不崩服务器：把错误当成一条"结果"交回给 agent，
        // 让它自己决定换参数还是换工具（这就是第 14 章讲的"优雅失败"）。
        const detail = e instanceof ArchaeologyError ? e.message : `内部错误：${e?.message ?? e}`;
        return { content: [{ type: "text", text: `考古失败：${detail}` }], isError: true };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`[archaeology] ready — ${TOOLS.length} tools, cwd=${process.cwd()}`);
