// 用一个人造的临时 git 仓库当语料，验证 8 个考古工具都能挖出该挖的事实。
// 完全离线、可重复：不联网，也不依赖任何真实仓库。
// 语料放在系统临时目录里，所以在跑之前先把它加进允许根目录（否则会被路径防护拦下）。
process.env.ARCHAEOLOGY_ROOTS = tmpdir();
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recentChanges, fileHistory, lineBlame, findIntroduction,
  commitInfo, searchHistory, decisionLog, churnHotspots, resolveRepo,
} from "../src/archaeology.js";

let pass = 0;
let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? "✅" : "❌"} ${msg}`);
  ok ? pass++ : fail++;
};

// ── 造一个"有故事"的仓库：每一次提交都留下一条可考古的线索 ──
const repo = mkdtempSync(join(tmpdir(), "archaeology-"));
const g = (...args) =>
  execFileSync("git", ["-c", "user.name=Alice", "-c", "user.email=a@example.com", ...args], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
const write = (rel, text) => {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text, "utf8");
};

g("init", "-q");
write("package.json", '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n');
write("src/app.js", "export function main() {\n  return 1;\n}\n");
g("add", "-A");
g("commit", "-q", "-m", "chore: 初始化项目");

write("src/context.js", "export const KEEP_RECENT = 2;\nexport function compact() {\n  return KEEP_RECENT;\n}\n");
g("add", "-A");
g("commit", "-q", "-m", "feat: 添加上下文压缩");

// 这次提交把阈值加上去，并在**正文**里写明原因（考古要挖的就是正文）
write(
  "src/context.js",
  "export const COMPACT_THRESHOLD = 20;\nexport const KEEP_RECENT = 2;\nexport function compact() {\n  return KEEP_RECENT;\n}\n",
);
g("add", "-A");
g(
  "commit", "-q", "-m", "fix: 压缩阈值过低导致模型编造行数",
  "-m", "因为读 9 个文件就会触发压缩，刚读到的东西当场被摘要掉，模型只能凭有损摘要回忆，于是开始编数字。",
);

write(
  "docs/adr/0001-no-vector-store.md",
  "# ADR 0001：记忆召回不用向量库\n\n因为这是个教学项目，关键词重合（中文按 bigram 切）已经够用，引入向量库会让依赖变重。\n",
);
g("add", "-A");
g("commit", "-q", "-m", "docs: 加一份 ADR 说明记忆召回为什么不用向量库");

write(
  "src/app.js",
  "export function main() {\n  // WHY: 这里必须用 split/join，不能用 replace，否则 new_string 里的 $ 会被当成替换语法\n  return 1;\n}\n",
);
g("add", "-A");
g("commit", "-q", "-m", "fix: 编辑文件时 $ 被当成替换语法");

const allShas = g("log", "--format=%h", "--reverse").trim().split("\n");
const thresholdSha = allShas[2];   // 第 3 次提交 = 引入 COMPACT_THRESHOLD 的那次

console.log("== 代码库考古 MCP · 工具测试 ==");

// ── 1) recent_changes ──
const recent = recentChanges({ repo, limit: 10 });
check(recent.includes("最近 5 次提交"), "recent_changes 数出 5 次提交");
check(recent.indexOf("编辑文件时 $ 被当成替换语法") < recent.indexOf("初始化项目"), "recent_changes 按新→旧排列");

// ── 2) file_history ──
const fh = fileHistory({ repo, path: "src/context.js" });
check(fh.includes("压缩阈值过低"), "file_history 找到改过 context.js 的那次提交");
check(fh.includes("2 次提交"), "file_history 数出该文件被提交过 2 次");

// ── 3) line_blame ──
const blame = lineBlame({ repo, path: "src/context.js", start: 1, end: 1 });
check(blame.includes("COMPACT_THRESHOLD = 20"), "line_blame 定位到第 1 行的内容");
check(blame.includes(thresholdSha), `line_blame 把这一行归到引入它的提交 ${thresholdSha}`);
check(blame.includes("按行数排序"), "line_blame 给出了按提交分组的汇总");

// ── 4) find_introduction（pickaxe）──
const intro = findIntroduction({ repo, pattern: "COMPACT_THRESHOLD" });
check(intro.includes(thresholdSha), `find_introduction 指认出引入 COMPACT_THRESHOLD 的提交 ${thresholdSha}`);
check(intro.includes("最可能"), "find_introduction 明确标出哪次最可能是引入");
const introRegex = findIntroduction({ repo, pattern: "COMPACT_\\w+", regex: true });
check(introRegex.includes(thresholdSha), "find_introduction 支持按正则追（-G）");

// ── 5) commit_info ──
const info = commitInfo({ repo, sha: thresholdSha });
check(info.includes("因为读 9 个文件就会触发压缩"), "commit_info 带出了完整提交正文（为什么就在这里）");
check(info.includes("改动统计") && info.includes("src/context.js"), "commit_info 给出了改动统计");
check(commitInfo({ repo, sha: thresholdSha, include_diff: true }).includes("+export const COMPACT_THRESHOLD"), "commit_info(include_diff) 带上了 diff");

// ── 6) search_history ──
const found = searchHistory({ repo, query: "阈值" });
check(found.includes(thresholdSha), "search_history 在提交信息里搜到『阈值』");
check(found.includes("因为读 9 个文件"), "search_history 带出了正文（找为什么的关键）");
check(searchHistory({ repo, query: "绝对搜不到的词xyz" }).includes("没有匹配"), "search_history 搜不到时给出可读提示");

// ── 7) decision_log ──
const dl = decisionLog({ repo });
check(dl.includes("docs/adr/0001-no-vector-store.md"), "decision_log 找到了 ADR 决策文档");
check(dl.includes("WHY:"), "decision_log 找到了代码里的 WHY 解释性注释");
check(decisionLog({ repo, query: "向量库" }).includes("0001"), "decision_log 支持按关键词过滤决策文档");

// ── 8) churn_hotspots ──
const churn = churnHotspots({ repo, days: 3650, limit: 5 });
check(churn.includes("src/context.js") && churn.includes("src/app.js"), "churn_hotspots 排出了被改动最多的文件");
check(churn.includes("次数"), "churn_hotspots 给出了表头（次数/增删行）");

// ── 9) 错误路径：优雅失败，不崩 ──
const notRepo = mkdtempSync(join(tmpdir(), "archaeology-nonrepo-"));
let err = "";
try {
  recentChanges({ repo: notRepo });
} catch (e) {
  err = e.message;
}
check(err.includes("不是一个 git 仓库"), "指向非仓库时给出可读错误");
let err2 = "";
try {
  fileHistory({ repo });
} catch (e) {
  err2 = e.message;
}
check(err2.includes("必须给 path"), "缺必填参数时给出可读错误");
check(resolveRepo(repo) === repo, "resolveRepo 对绝对路径原样返回");

// 路径逃逸防护：白名单之外的路径必须被拒（Day 13 那条）
let err3 = "";
try {
  recentChanges({ repo: join(tmpdir(), "..", "definitely-not-allowed") });
} catch (e) {
  err3 = e.message;
}
check(err3.includes("拒绝访问"), "白名单之外的路径被拒（路径逃逸防护生效）");

rmSync(repo, { recursive: true, force: true });
rmSync(notRepo, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
