// 协议层测试：把一个真正的 server.js 子进程跑起来，用**最原始的 JSON-RPC**走一遍
// initialize → initialized → tools/list → tools/call。
// 目的：证明这个服务器能跟任何 MCP 客户端通话（我们故意不用 MCP 客户端库，
// 这样测的就是协议本身，而不是库）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

// ── 起一个临时仓库当语料 ──
const repo = mkdtempSync(join(tmpdir(), "archaeology-proto-"));
const g = (...args) =>
  execFileSync("git", ["-c", "user.name=Bob", "-c", "user.email=b@example.com", ...args], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
g("init", "-q");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src/thing.js"), "export const MAGIC = 42;\n", "utf8");
g("add", "-A");
g("commit", "-q", "-m", "feat: 引入 MAGIC 常量");

// ── 用原始 JSON-RPC 连服务器 ──
// 沙箱语料在系统临时目录里，用环境变量把这层"允许根目录"放给它
const proc = spawn(process.execPath, ["server.js"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ARCHAEOLOGY_ROOTS: tmpdir() },
});
const rl = createInterface({ input: proc.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const notify = (method) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
const callTool = async (name, args) => (await request("tools/call", { name, arguments: args })).result;

console.log("== 代码库考古 MCP · 协议测试 ==");

const init = await request("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "raw-jsonrpc-test", version: "1.0.0" },
});
check(init.result?.serverInfo?.name === "codebase-archaeology", `握手成功，服务器自称 ${init.result?.serverInfo?.name}`);
notify("notifications/initialized");

const listed = await request("tools/list");
const names = (listed.result?.tools || []).map((t) => t.name).sort();
const expected = [
  "churn_hotspots", "commit_info", "decision_log", "file_history",
  "find_introduction", "line_blame", "recent_changes", "search_history",
];
check(names.length === 8 && JSON.stringify(names) === JSON.stringify(expected), `tools/list 返回 8 个工具：${names.join(", ")}`);
check(
  (listed.result?.tools || []).every((t) => t.description && t.inputSchema),
  "每个工具都带 description 和 inputSchema",
);

const recent = await callTool("recent_changes", { repo, limit: 5 });
check(String(recent?.content?.[0]?.text || "").includes("引入 MAGIC 常量"), "通过 JSON-RPC 调 recent_changes 拿到了真实结果");

const intro = await callTool("find_introduction", { repo, pattern: "MAGIC" });
check(String(intro?.content?.[0]?.text || "").includes("最可能"), "通过 JSON-RPC 调 find_introduction 也正常");

// 第 1 层：参数不合 schema —— SDK 的 zod 校验会直接拒绝，压根不进我们的代码
const rawBad = await request("tools/call", { name: "file_history", arguments: { repo } });
check(
  rawBad.error !== undefined || rawBad.result?.isError === true,
  `缺必填参数被拦在协议层：${rawBad.error ? rawBad.error.message : "isError"}`,
);

// 第 2 层：参数合法、但目标不是仓库 —— 走我们自己的错误路径，返回 isError
const notRepo = mkdtempSync(join(tmpdir(), "archaeology-proto-nonrepo-"));
const bad = await callTool("recent_changes", { repo: notRepo });
check(
  bad?.isError === true && String(bad?.content?.[0]?.text || "").includes("不是一个 git 仓库"),
  "指向非仓库 → isError + 可读信息（服务器没崩）",
);

// 服务器还活着 —— 再调一次证明它没被上一步弄挂
const after = await callTool("recent_changes", { repo, limit: 1 });
check(!after?.isError, "出错之后服务器依然可用（优雅失败）");

proc.kill();
rmSync(repo, { recursive: true, force: true });
rmSync(notRepo, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
