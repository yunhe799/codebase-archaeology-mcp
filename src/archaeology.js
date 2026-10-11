// 代码库考古：把 git 的历史变成 agent 能直接读的"考古报告"。
//
// 这个模块只做两件事：
//   1) 安全地调 git（execFile + 参数数组，不经 shell，所以路径/正则注入不了）
//   2) 把 git 的输出整理成**结论式**文本（谁改的 / 什么时候 / 为什么 / 哪里最容易出事）
//
// 每个工具都返回一段纯文本——agent 读它就像读一份调查报告。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

// git 的字段分隔符：用控制字符，避免和提交信息里的字符冲突
const F = "\u001f";
const R = "\u001e";

const MAX_TEXT = 18000;          // 单个工具结果的上限，防止把 agent 的上下文撑爆
const GIT_TIMEOUT_MS = 20000;

export class ArchaeologyError extends Error {}

/** 允许被考古的根目录：默认**只有服务器自己的工作目录**。
 *  要放开，设环境变量 ARCHAEOLOGY_ROOTS（分号分隔的多个根）。 */
export function allowedRoots() {
  const raw = process.env.ARCHAEOLOGY_ROOTS;
  const roots = (raw ? raw.split(";") : [process.cwd()])
    .map((r) => resolve(r.trim().replace(/^["']|["']$/g, "")))
    .filter(Boolean);
  return roots.length ? roots : [process.cwd()];
}

/** 把 agent 给的 repo 解析成绝对路径（默认用进程 cwd），并做**路径逃逸防护**：
 *  只能看白名单根目录以内的仓库。MCP server 不该被模型指到哪就读哪——
 *  不然一句 `repo=C:\Users\你\.ssh` 就能去翻别人的 git 历史。 */
export function resolveRepo(repo) {
  const abs = !repo ? process.cwd() : isAbsolute(repo) ? repo : resolve(process.cwd(), repo);
  const roots = allowedRoots();
  const inside = roots.some((root) => abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep));
  if (!inside) {
    throw new ArchaeologyError(
      `拒绝访问 ${abs}：它不在允许的根目录内。当前允许：${roots.join(" ; ")}。` +
        `要考古别的仓库，给服务器设环境变量 ARCHAEOLOGY_ROOTS（分号分隔）。`,
    );
  }
  return abs;
}

/** 跑一条 git 命令。用 execFile + 数组传参，**不经过 shell**——路径、正则、
 *  提交信息里的任何字符都不会被当成命令执行。失败时把 git 的 stderr 原样抛出去，
 *  因为 git 的报错通常比我们编的更有用（比如 "not a git repository"）。 */
export function git(repo, args, { timeout = GIT_TIMEOUT_MS } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = String(e.stderr || e.stdout || e.message || "").trim().split("\n").slice(0, 4).join("\n");
    throw new ArchaeologyError(detail || `git ${args[0]} failed`);
  }
}

/** 检查路径是个 git 仓库；不是就抛一个"告诉你为什么"的错。 */
export function assertRepo(repo) {
  if (!existsSync(repo)) throw new ArchaeologyError(`路径不存在：${repo}`);
  try {
    git(repo, ["rev-parse", "--git-dir"]);
  } catch {
    throw new ArchaeologyError(`${repo} 不是一个 git 仓库（没有 .git）。把 repo 参数指到仓库根目录，或先用 git init。`);
  }
  return repo;
}

export function clip(text, max = MAX_TEXT) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const half = Math.floor((max - 40) / 2);
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - half * 2} 字符）…\n${s.slice(-half)}`;
}

/** 统一的"空结果"提示，避免 agent 把"没找到"误判成工具坏了。 */
const none = (what) => `（没有找到${what}）`;

function logLines(repo, args) {
  const out = git(repo, ["log", `--pretty=format:%h${F}%ad${F}%an${F}%s${R}`, "--date=short", ...args]);
  return out
    .split(R)
    .map((r) => r.replace(/^\n/, "").trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, date, author, subject] = r.split(F);
      return { sha, date, author, subject };
    });
}

function formatCommits(commits, indent = "  ") {
  return commits.map((c) => `${indent}- ${c.sha} ${c.date} ${c.author} — ${c.subject}`).join("\n");
}

// ─── 工具 1：最近发生了什么 ────────────────────────────────────────────────
export function recentChanges({ repo, limit = 10, path } = {}) {
  const r = assertRepo(resolveRepo(repo));
  const args = [`-n`, String(limit)];
  if (path) args.push("--", path);
  const commits = logLines(r, args);
  if (commits.length === 0) return none("提交记录");
  const branch = git(r, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  return [
    `仓库：${r}`,
    `当前分支：${branch}`,
    `最近 ${commits.length} 次提交${path ? `（只看 ${path}）` : ""}：`,
    formatCommits(commits),
  ].join("\n");
}

// ─── 工具 2：这个文件的历史 ───────────────────────────────────────────────
export function fileHistory({ repo, path, limit = 15, follow = true } = {}) {
  const r = assertRepo(resolveRepo(repo));
  if (!path) throw new ArchaeologyError("必须给 path（相对仓库根目录的文件路径）");
  const args = [`-n`, String(limit)];
  if (follow) args.push("--follow");
  args.push("--", path);
  const commits = logLines(r, args);
  const exists = existsSync(join(r, path));
  if (commits.length === 0) {
    return exists
      ? `${path} 存在，但没有任何提交碰过它（可能是新文件、还没提交）。`
      : `${path} 现在不存在，历史里也没有改名前的记录。`;
  }
  return [
    `${path} 的历史（${commits.length} 次提交${follow ? "，已跟随重命名" : ""}）：`,
    formatCommits(commits),
    exists ? "" : "\n注意：这个文件**当前已不存在**（被删或被改名了）。",
    "\n想深入某一次，用 commit_info(sha=...)。",
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── 工具 3：这行是谁写的、什么时候 ──────────────────────────────────────
export function lineBlame({ repo, path, start, end } = {}) {
  const r = assertRepo(resolveRepo(repo));
  if (!path) throw new ArchaeologyError("必须给 path（文件路径）");
  const range = start ? (end ? `-L${start},${end}` : `-L${start},+1`) : "";
  const args = ["blame", "--line-porcelain", "--date=short"];
  if (range) args.push(range);
  args.push("--", path);
  const out = git(r, args);

  const rows = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("\t")) {
      if (cur) rows.push({ ...cur, text: line.slice(1) });
      cur = null;
      continue;
    }
    const head = line.match(/^([0-9a-f]{7,40})\s+(\d+)\s+(\d+)/);
    if (head) {
      cur = { sha: head[1], line: Number(head[3]), author: "?", date: "?", summary: "" };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("author ")) cur.author = line.slice(7);
    else if (line.startsWith("author-time ")) cur.date = new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
    else if (line.startsWith("summary ")) cur.summary = line.slice(8);
  }
  if (rows.length === 0) return `${path} 在这个范围里没有已提交的行（可能还没提交）。`;

  const perLine = rows
    .map((r0) => `${String(r0.line).padStart(5)}  ${r0.sha.slice(0, 8)}  ${r0.date}  ${r0.author.padEnd(10).slice(0, 10)}  ${r0.text}`)
    .join("\n");

  // 把这些行归到各自的提交上——考古时真正想知道的是"哪几次提交留下了这些行"
  const byCommit = new Map();
  for (const row of rows) {
    const e = byCommit.get(row.sha) || { ...row, n: 0, lines: [] };
    e.n++;
    e.lines.push(row.line);
    byCommit.set(row.sha, e);
  }
  const summary = [...byCommit.values()]
    .sort((a, b) => b.n - a.n)
    .map((e) => `  - ${e.sha.slice(0, 8)} ${e.date} ${e.author} — ${e.summary || "(无提交标题)"}  [${e.n} 行: ${e.lines.join(",")}]`)
    .join("\n");

  return [
    `${path} 的 blame（${rows.length} 行）：`,
    perLine,
    "",
    "这些行来自以下提交（按行数排序）：",
    summary,
    "",
    "想看某次改动的原因，用 commit_info(sha=...)；想知道某段字符串何时引入，用 find_introduction。",
  ].join("\n");
}

// ─── 工具 4：这段代码/这个字符串是什么时候引入的（pickaxe）───────────────
export function findIntroduction({ repo, pattern, path, regex = false, limit = 10 } = {}) {
  const r = assertRepo(resolveRepo(repo));
  if (!pattern) throw new ArchaeologyError("必须给 pattern（要追的字符串或正则）");
  const args = [regex ? "-G" : "-S", pattern, `-n`, String(limit)];
  if (path) args.push("--", path);
  const commits = logLines(r, args);
  if (commits.length === 0) {
    return `在${path ? ` ${path} ` : "整个仓库"}的历史里，没有找到任何一次提交${regex ? "匹配正则" : "增加或删除该字符串"}：${pattern}\n（可能拼写不同，或它一直都在第一个提交里。）`;
  }
  // git log 默认新 → 旧，所以**最后一条就是最早的那次**，不用再跑一次。
  // 注意：别用 `--reverse -n 1` 去取最早——git 这两个参数一起用会返回空集（实测踩过）。
  const oldest = commits[commits.length - 1];
  const maybeTruncated = commits.length >= limit;
  return [
    `追"${pattern}"${regex ? "（按正则匹配）" : ""}${path ? `，限 ${path}` : ""}：`,
    `共 ${commits.length} 次提交改动了它（出现/消失各算一次，最多列 ${limit} 次）。`,
    "",
    `最早的那次，最可能是『引入它』的提交：\n  - ${oldest.sha} ${oldest.date} ${oldest.author} — ${oldest.subject}`,
    maybeTruncated ? `  （列表可能被 limit=${limit} 截断，真正的第一次未必是这条——把 limit 调大确认。）` : "",
    "",
    "全部相关提交（新 → 旧）：",
    formatCommits(commits),
    "",
    `下一步：用 commit_info(sha="${oldest.sha}") 看它当时是怎么写的。`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ─── 工具 5：某个提交到底干了什么 ─────────────────────────────────────────
export function commitInfo({ repo, sha, include_diff = false } = {}) {
  const r = assertRepo(resolveRepo(repo));
  if (!sha) throw new ArchaeologyError("必须给 sha（提交哈希或 HEAD~2 这类引用）");
  const head = git(r, ["show", "-s", `--pretty=format:%H${F}%an${F}%ae${F}%ad${F}%s${F}%b`, "--date=short", sha]).split(F);
  const [full, author, email, date, subject, body = ""] = head;
  const stat = git(r, ["show", "--stat", "--oneline", "--pretty=format:", sha]).trim();
  const parts = [
    `提交 ${full.slice(0, 12)}`,
    `作者：${author} <${email}>`,
    `日期：${date}`,
    `标题：${subject}`,
  ];
  if (body.trim()) parts.push("", "完整提交信息（『为什么』通常写在这里）：", body.trim());
  parts.push("", "改动统计：", stat || "(无文件改动)");
  if (include_diff) {
    const diff = git(r, ["show", "--pretty=format:", "--unified=3", sha]);
    parts.push("", "diff：", clip(diff, 12000));
  }
  return parts.join("\n");
}

// ─── 工具 6：从提交信息里找"为什么" ──────────────────────────────────────
export function searchHistory({ repo, query, path, author, limit = 15 } = {}) {
  const r = assertRepo(resolveRepo(repo));
  const args = [`-n`, String(limit), "-i", "--grep", query || ""];
  if (author) args.push("--author", author);
  if (path) args.push("--", path);
  // 带 body，因为"为什么"经常在正文里
  const out = git(r, ["log", `--pretty=format:%h${F}%ad${F}%an${F}%s${F}%b${R}`, "--date=short", ...args]);
  const items = out
    .split(R)
    .map((x) => x.replace(/^\n/, "").trim())
    .filter(Boolean)
    .map((x) => {
      const [sha, date, authorName, subject, body = ""] = x.split(F);
      return { sha, date, author: authorName, subject, body: body.trim() };
    });
  if (items.length === 0) return `提交信息里没有匹配 "${query ?? ""}" 的${author ? `（作者限 ${author}）` : ""}。换关键词试试，比如 "revert" / "perf" / "instead of"。`;
  return [
    `提交信息里匹配 "${query ?? "(全部)"}" 的结果（${items.length} 条，忽略大小写）：`,
    ...items.map((c) => {
      const head = `  - ${c.sha} ${c.date} ${c.author} — ${c.subject}`;
      const bodyLines = c.body ? c.body.split("\n").slice(0, 8).map((l) => `      ${l}`).join("\n") : "";
      return bodyLines ? `${head}\n${bodyLines}` : head;
    }),
  ].join("\n");
}

// ─── 工具 7：决策记录（ADR / WHY 注释 / 声称理由的提交）──────────────────
const ADR_DIRS = ["docs/adr", "docs/decisions", "docs/rfc", "adr", "decisions", "architecture/decisions"];

export function decisionLog({ repo, query, limit = 10 } = {}) {
  const r = assertRepo(resolveRepo(repo));
  const sections = [];

  // (a) 决策文档：常见 ADR 目录下的 markdown
  const docs = [];
  for (const d of ADR_DIRS) {
    const abs = join(r, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const f of readdirSync(abs).slice(0, 50)) {
      if (!/\.(md|mdx|txt)$/i.test(f)) continue;
      const rel = `${d}/${f}`;
      if (query) {
        const text = readFileSync(join(r, rel), "utf-8");
        if (!text.toLowerCase().includes(String(query).toLowerCase())) continue;
      }
      docs.push(rel);
    }
  }
  sections.push(
    docs.length
      ? `【决策文档】找到 ${docs.length} 份（ADR 之类，通常写明"为什么选它"）：\n${docs.map((d) => `  - ${d}`).join("\n")}`
      : `【决策文档】没有找到常见 ADR 目录（${ADR_DIRS.join(" / ")}）。`,
  );

  // (b) 代码里的"为什么"注释
  try {
    const hits = git(r, ["grep", "-n", "-I", "-E", "WHY:|DECISION:|NOTE:|因为|之所以", "--", "*.ts", "*.js", "*.py", "*.md"]);
    const lines = hits.trim().split("\n").slice(0, 25);
    sections.push(lines.length ? `【代码里的解释性注释】\n${lines.map((l) => `  ${l}`).join("\n")}` : "【代码里的解释性注释】没有命中。");
  } catch {
    sections.push("【代码里的解释性注释】没有命中（或仓库里没有这些后缀的文件）。");
  }

  // (c) 提交信息里明确给出理由的
  const commits = logLines(r, ["-i", "-E", "--grep", "because|why |tradeoff|instead of|reason|revert", "-n", String(limit)]);
  sections.push(
    commits.length
      ? `【提交信息里给了理由的】共 ${commits.length} 条：\n${formatCommits(commits)}`
      : "【提交信息里给了理由的】没有命中。",
  );

  return [`仓库：${r}`, ...sections].join("\n\n");
}

// ─── 工具 8：哪里最容易出事（改动热点）───────────────────────────────────
export function churnHotspots({ repo, days = 90, limit = 10 } = {}) {
  const r = assertRepo(resolveRepo(repo));
  const out = git(r, ["log", `--since=${days} days ago`, "--numstat", "--pretty=format:%h"]);
  const files = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim() || line.startsWith("commit ")) continue;
    const cols = line.split("\t");
    if (cols.length !== 3) continue;
    const [add, del, path] = cols;
    const e = files.get(path) || { commits: 0, add: 0, del: 0 };
    e.commits++;
    e.add += add === "-" ? 0 : Number(add);
    e.del += del === "-" ? 0 : Number(del);
    files.set(path, e);
  }
  if (files.size === 0) return `最近 ${days} 天没有任何提交。`;
  const top = [...files.entries()]
    .sort((a, b) => b[1].add + b[1].del - (a[1].add + a[1].del))
    .slice(0, limit);
  return [
    `改动最频繁的文件（最近 ${days} 天，共 ${files.size} 个文件被改过）：`,
    "  次数  +行  -行   文件",
    ...top.map(([p, e]) => `  ${String(e.commits).padStart(4)} ${String(e.add).padStart(5)} ${String(e.del).padStart(5)}   ${p}`),
    "",
    "改动越频繁的地方，越值得用 file_history 和 line_blame 去看它为什么这么不稳定。",
  ].join("\n");
}

// ─── 工具清单（MCP 注册用；schema 用 zod）───────────────────────────────
import { z } from "zod";

const repoArg = z.string().optional().describe("仓库路径（默认：服务器进程的工作目录）");

export const TOOLS = [
  {
    name: "recent_changes",
    title: "最近发生了什么",
    description:
      "列出仓库最近的提交（谁、什么时候、改了什么）。考古的第一步：先看这个仓库最近在动什么。",
    inputSchema: { repo: repoArg, limit: z.number().int().positive().optional().describe("返回几条（默认 10）"), path: z.string().optional().describe("只看某个路径下的改动") },
    handler: recentChanges,
  },
  {
    name: "file_history",
    title: "文件的历史",
    description:
      "一个文件的提交历史（默认跟随重命名）。回答『这个文件是谁、什么时候、改了多少次』。",
    inputSchema: {
      repo: repoArg,
      path: z.string().describe("相对仓库根目录的文件路径，例如 src/context.ts"),
      limit: z.number().int().positive().optional().describe("返回几条（默认 15）"),
      follow: z.boolean().optional().describe("是否跟随重命名（默认 true）"),
    },
    handler: fileHistory,
  },
  {
    name: "line_blame",
    title: "这行是谁写的",
    description:
      "逐行 blame：某几行分别是谁、在哪次提交里写的（并把这些行归到各自的提交上）。回答『这行代码的来历』。",
    inputSchema: {
      repo: repoArg,
      path: z.string().describe("文件路径"),
      start: z.number().int().positive().optional().describe("起始行（不填就从头开始）"),
      end: z.number().int().positive().optional().describe("结束行"),
    },
    handler: lineBlame,
  },
  {
    name: "find_introduction",
    title: "什么时候引入的",
    description:
      "pickaxe：追踪某个字符串/正则是在哪次提交里被加入或删除的，并指出最早的那次（最可能是『引入它』的提交）。回答『这个函数/配置是什么时候加进来的』。",
    inputSchema: {
      repo: repoArg,
      pattern: z.string().describe("要追的字符串（如某个函数名、某个常量），或正则"),
      path: z.string().optional().describe("限制在某个路径内查找"),
      regex: z.boolean().optional().describe("把 pattern 当正则（默认 false，按字面字符串）"),
      limit: z.number().int().positive().optional().describe("最多返回几条（默认 10）"),
    },
    handler: findIntroduction,
  },
  {
    name: "commit_info",
    title: "某个提交到底干了什么",
    description:
      "看某次提交的完整信息：作者、日期、完整提交信息（『为什么』通常写在这里）、改动统计，可选带 diff。",
    inputSchema: {
      repo: repoArg,
      sha: z.string().describe("提交哈希，或 HEAD~2 这类引用"),
      include_diff: z.boolean().optional().describe("是否附上 diff（默认 false）"),
    },
    handler: commitInfo,
  },
  {
    name: "search_history",
    title: "从提交信息里找理由",
    description:
      "在提交信息（含正文）里搜索关键词，找『为什么这么改』的讨论。例如搜 revert / perf / instead of / 因为。",
    inputSchema: {
      repo: repoArg,
      query: z.string().optional().describe("关键词（忽略大小写）"),
      path: z.string().optional().describe("只看某个路径的历史"),
      author: z.string().optional().describe("只看某个作者"),
      limit: z.number().int().positive().optional().describe("最多返回几条（默认 15）"),
    },
    handler: searchHistory,
  },
  {
    name: "decision_log",
    title: "决策记录",
    description:
      "把散落各处的『决策』搜集出来：ADR 决策文档、代码里的 WHY/NOTE 解释性注释、提交信息里明确给了理由的那些。回答『当初为什么这么定』。",
    inputSchema: {
      repo: repoArg,
      query: z.string().optional().describe("按关键词过滤（不填就全列出）"),
      limit: z.number().int().positive().optional().describe("提交部分最多几条（默认 10）"),
    },
    handler: decisionLog,
  },
  {
    name: "churn_hotspots",
    title: "哪里最容易出事",
    description:
      "按改动量排出最『动荡』的文件（最近 N 天的提交次数与增删行数）。这些地方通常最值得考古。",
    inputSchema: {
      repo: repoArg,
      days: z.number().int().positive().optional().describe("看最近多少天（默认 90）"),
      limit: z.number().int().positive().optional().describe("返回几个文件（默认 10）"),
    },
    handler: churnHotspots,
  },
];
