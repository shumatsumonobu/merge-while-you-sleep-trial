// work/work.mjs — 作業の action の本体
//
// 土台のゲート → 計画 → テスト作成 → 赤先行 → 実装 → ゲート → レビュー → 修正 …
// post の step（action.yml の runs.post）では、作業の action が変えた作業ツリーを土台のコミットに戻す
//
// 判定はこのファイルのコードで決める。Claude Code の自己申告を合否に使わない ── 合否はゲートの終了コード
// ログには工程の名前、ゲートの終了コード、コストだけを出す（DESIGN.md の出口で消す）

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getState, input, inputBool, inputNumber, log, mask, runnerTemp, saveState, setOutput, splitList } from "../shared/actions.mjs";
import { buildPrompt, buildSettings, claudeEnv, findHelpers, installClaude, killAllCgroups, runClaude, SCHEMAS, SKILL_HOOKS_VERIFIED, validate } from "../shared/claude.mjs";
import { LIMITS, MODELS } from "../shared/defaults.mjs";
import { comment, escalate, marker, REASONS, Stop } from "../shared/escalation.mjs";
import { diffEntries, fetchRef, makeGit, sha256 } from "../shared/git.mjs";
import { labels, makeGitHub, repoFromEnv, runUrl, triggerLabelIfOurs } from "../shared/github.mjs";
import { DEPENDENCY_PATHS, extractImports, FIXED_DENY_PATHS, matcher, PROTECTED_PATHS, resolveImport, testPaths } from "../shared/paths.mjs";
import { baseEnv, exec, which } from "../shared/process.mjs";
import { sanitizeOutbound } from "../shared/sanitize.mjs";

// このリポジトリの根（deps/sandbox-runtime/ を読む）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------- 既定値 ----------

const GATE_ENV_NAMES = [
  "PATH", "HOME", "LANG", "LC_ALL", "TERM", "CI", "JAVA_HOME", "GOROOT", "GOPATH", "pythonLocation", "PKG_CONFIG_PATH",
];

const NEVER_PASS = (name) =>
  name.startsWith("INPUT_") || name.startsWith("ACTIONS_") ||
  ["GITHUB_TOKEN", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name);

export const GATE_SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

const GATE_TOOL_DIRS = [
  "/opt/hostedtoolcache", "~/.cache/pip", "~/.cache/uv", "~/.cache/go-build", "~/.cache/yarn", "~/.cache/ms-playwright",
  "~/.local/bin", "~/.local/lib", "~/go", "~/.cargo/bin", "~/.cargo/registry", "~/.cargo/git", "~/.rustup", "~/.npm",
];

// ---------- 指示文の組み立て ----------

export function criteriaText(approval) {
  return approval.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
}

// ---------- 作業ディレクトリを歩く ----------


/**
 * 作業ディレクトリを歩いて、パターンに合うファイルを集める（git の管理の外も含む）。
 * .git と workspace_keep のディレクトリの中には入らない
 */
export function walk(ws, { skip = new Set(), onFile }) {
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let names;
    try {
      names = readdirSync(join(ws, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === ".git" || skip.has(r)) continue;
      let st;
      try {
        st = lstatSync(join(ws, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        onFile(r, st, true);
        stack.push(r);
      } else onFile(r, st, false);
    }
  }
}

/** 変えさせないファイルの、パスとハッシュの一覧 */
export function protectedSnapshot(ws, { keep, imports }) {
  const isProtected = matcher(PROTECTED_PATHS, { nocase: true });
  const snap = new Map();
  walk(ws, {
    skip: new Set(keep),
    onFile(r, st, isDir) {
      // ディレクトリとシンボリックリンクは、その名前自体も照合する
      // ── `.claude` を外を指すシンボリックリンクにしても、パターン `**/.claude/**` は名前だけでは合わない
      const named = isProtected(r) || imports.has(r);
      const asDir = isProtected(`${r}/`);
      if (isDir) {
        if (asDir) snap.set(r, "dir");
        return;
      }
      if (!named && !(st.isSymbolicLink() && asDir)) return;
      const content = st.isSymbolicLink() ? `symlink:${readlinkSync(join(ws, r))}` : readFileSync(join(ws, r));
      snap.set(r, sha256(content));
    },
  });
  return snap;
}

export function compareSnapshots(before, after) {
  const diff = [];
  for (const [p, h] of before) if (after.get(p) !== h) diff.push(p);
  for (const p of after.keys()) if (!before.has(p)) diff.push(p);
  return diff;
}

/**
 * CLAUDE.md と AGENTS.md から @ の取り込み先をたどる（最大5段。Memory のページの上限は4段）。
 * 取り込み先がまだ無いパスでも一覧に入れる（DESIGN.md の必ず外すファイル）
 * @param readFile (relPath) => string | null
 * @param roots 取り込み元の CLAUDE.md、CLAUDE.local.md、AGENTS.md のパス
 */
export function traceImports(roots, readFile) {
  const found = new Set();
  let frontier = roots.map((p) => [p, 0]);
  while (frontier.length) {
    const next = [];
    for (const [file, depth] of frontier) {
      if (depth >= 5) continue;
      const text = readFile(file);
      if (text == null) continue;
      for (const t of extractImports(text)) {
        const p = resolveImport(file, t);
        if (!p || found.has(p)) continue;
        found.add(p);
        next.push([p, depth + 1]);
      }
    }
    frontier = next;
  }
  return found;
}

// ---------- ゲートのコマンドを隔離する（bubblewrap）----------


export function gateEnv(passEnv) {
  const env = {};
  for (const n of [...GATE_ENV_NAMES, ...passEnv]) {
    if (NEVER_PASS(n)) continue;
    if (process.env[n] !== undefined) env[n] = process.env[n];
  }
  env.TMPDIR = "/tmp";
  return env;
}

const expandHome = (p) => (p.startsWith("~/") ? join(process.env.HOME || "/home/runner", p.slice(2)) : p);

/** bubblewrap の引数を組み立てる（DESIGN.md の隔離の中身） */
export function bwrapArgs({ ws, readOnlyInWs, readPaths, network, home }) {
  const a = ["--die-with-parent", "--new-session", "--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try"];
  if (!network) a.push("--unshare-net");
  for (const d of GATE_SYSTEM_DIRS) {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) a.push("--symlink", readlinkSync(d), d);
    else a.push("--ro-bind", d, d);
  }
  a.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");
  a.push("--tmpfs", home);
  for (const p of readPaths) a.push("--ro-bind-try", p, p);
  a.push("--bind", ws, ws);
  for (const p of readOnlyInWs) a.push("--ro-bind-try", join(ws, p), join(ws, p));
  a.push("--chdir", ws, "--cap-drop", "ALL");
  return a;
}

// ---------- 作業 ----------


/**
 * 作業の流れ。deps で Claude Code の呼び出しとゲートの実行を差し替えられる（test/ のテスト）
 *
 * ctx に要るもの
 *   ws, git, approval, cfg（コマンド、上限、モデル）, deps.claude(stage, opts), deps.gate(name, command, opts),
 *   deps.progress(text), resume（続きから進めるとき）
 * @returns {Promise<{head:string, automerge:boolean, report:object, stop:Stop|null}>}
 */
export async function workFlow(ctx) {
  const { git } = ctx;
  const st = (ctx.state = {
    cost: 0,
    started: ctx.now(),
    stages: [],
    newTests: new Set(),
    testReturns: 0,
    automerge: true,
    notes: [],
    suggestions: [],
    findings: [],
    tests: [],
    callId: 0,
    claudeChanged: false, // Claude Code の工程が、作業用のコミットを変えたか（続きから進めるときの「変更が無い」）
  });
  // テストのパターンは大文字小文字を区別する ── 区別しないと `*Test.*` が src/latest.js に合う
  const isTest = matcher(ctx.cfg.testPaths);
  const head = async () => (await git(["rev-parse", "HEAD"])).out.trim();

  let current = ctx.start;
  const result = (stop) => ({ head: current, automerge: st.automerge && !stop, report: report(ctx, stop), stop });

  try {
    if (ctx.resume) {
      current = await resumeFlow(ctx, { isTest, head });
    } else {
      current = await freshFlow(ctx, { isTest, head });
    }
    return result(null);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    current = await head().catch(() => current);
    return result(e);
  }
}

function report(ctx, stop) {
  const st = ctx.state;
  return {
    resume: Boolean(ctx.resume),
    stages: st.stages,
    tests: st.tests,
    suggestions: st.suggestions,
    findings: st.findings,
    notes: st.notes,
    cost_usd: Math.round(st.cost * 100) / 100,
    escalation: stop && stop.keepChanges ? { reason: stop.reason, details: stop.details } : null,
  };
}

function checkLimits(ctx) {
  const st = ctx.state;
  const elapsed = (ctx.now() - st.started) / 60000;
  if (elapsed >= ctx.cfg.limits.max_work_minutes) throw new Stop("limit_reached", "作業のジョブの時間の上限に達した");
  if (st.cost >= ctx.cfg.limits.max_cost_usd) throw new Stop("limit_reached", "実行のコストの上限に達した");
}

function remainingMs(ctx) {
  return ctx.cfg.limits.max_work_minutes * 60000 - (ctx.now() - ctx.state.started);
}

/** Claude Code の工程を1回呼ぶ。呼ぶ前に、変えさせないファイルを確かめる */
async function callStage(ctx, stage, prompt) {
  checkLimits(ctx);
  await ctx.checkProtected();
  ctx.state.stages.push(stage);
  ctx.state.callId++;
  const r = await ctx.deps.claude(stage, {
    prompt,
    schema: SCHEMAS[stage],
    model: ctx.cfg.models[stage],
    budget: Math.max(0.01, ctx.cfg.limits.max_cost_usd - ctx.state.cost),
    timeoutMs: remainingMs(ctx),
    callId: ctx.state.callId,
  });
  ctx.state.cost += r.cost || 0;
  log(`工程 ${stage}: 終わった（コスト ${(r.cost || 0).toFixed(2)} USD、合計 ${ctx.state.cost.toFixed(2)} USD）`);
  if (r.failure) throw r.failure;
  const err = validate(SCHEMAS[stage], r.output);
  if (err) throw new Stop("undecidable", `工程 ${stage} のレポートがスキーマに合わない`);
  return r.output;
}

/**
 * 工程の変更を作業用のコミットにし、作業ツリーをそのコミットと同じにする（ゲートの節）
 * 新しく作ったファイルも入れ、ignore されたファイルは入れない
 */
async function commitStage(ctx, stage) {
  const { git } = ctx;
  await ctx.checkProtected();
  const excludes = ctx.keep.map((k) => `:(exclude,top)${k}`);
  await git(["add", "-A", "--", ".", ...excludes]);
  const staged = await git(["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.code === 1) await git(["commit", "--no-verify", "-q", "-m", `merge-while-you-sleep: ${stage}`]);
  else if (staged.code !== 0) throw new Stop("guard_tripped", "作業用のコミットを作れない");
  const sha = (await git(["rev-parse", "HEAD"])).out.trim();
  await resetTree(ctx, sha);
  return sha;
}

/**
 * 作業ツリーをコミットに戻す。workspace_keep のディレクトリのほかの git の管理の外のファイルを、
 * ignore されたものも含めて消す。消したあとに残っていれば、守りが働いたとして止める
 */
export async function resetTree(ctx, sha) {
  const { git } = ctx;
  await git(["reset", "-q", "--hard", sha]);
  const ex = ctx.keep.flatMap((k) => ["-e", `/${k}/`]);
  await git(["clean", "-ffdxq", ...ex]);
  const s = await git(["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"]);
  const left = s.out.split("\0").filter(Boolean).map((l) => l.slice(3).replace(/\/$/, ""));
  const extra = left.filter((p) => !ctx.keep.includes(p));
  if (extra.length) throw new Stop("guard_tripped", "作業ツリーを戻したあとに、管理の外のファイルが残った");
}

async function changedEntries(ctx, from, to) {
  return diffEntries(ctx.git, from, to);
}

/**
 * ゲートを1つ実行し、終わったら作業ツリーをゲートの前のコミットに戻す
 * redFirstOf: その木に、この実行で書いたテストのファイルだけを足した木で実行する（赤先行）
 * removeFiles: そのファイルを除いた木で実行する（既存のテストだけの木）
 */
async function runGate(ctx, name, command, sha, { redFirstOf = null, removeFiles = [], args = [] } = {}) {
  checkLimits(ctx);
  if (redFirstOf) {
    await ctx.git(["checkout", "-q", "-f", "--detach", redFirstOf]);
    await ctx.git(["checkout", "-q", sha, "--", ...ctx.state.newTests]);
  }
  for (const f of removeFiles) rmSync(join(ctx.ws, f), { force: true });
  const r = await ctx.deps.gate(name, command, { timeoutMs: remainingMs(ctx), args });
  log(`ゲート ${name}: 終了コード ${r.code}`);
  await resetTree(ctx, sha);
  return r;
}

/** 実装と修正のあとのゲート。安い順に実行し、落ちたらそこで止める */
async function afterImplementGates(ctx, prev, sha, { isTest }) {
  const changed = await changedEntries(ctx, prev, sha);
  const touched = changed.filter((e) => isTest(e.path));
  if (touched.length) {
    return { ok: false, name: "テストの凍結", output: `実装と修正の工程で、テストのファイルを変えた: ${touched.map((e) => e.path).join(", ")}`, revert: true };
  }
  const c = ctx.cfg.commands;
  for (const [name, cmd] of [["lint", c.lint], ["型検査", c.typecheck], ["テスト", c.test]]) {
    if (!cmd) continue;
    const r = await runGate(ctx, name, cmd, sha);
    if (r.code !== 0) return { ok: false, name, output: r.tail };
  }
  if (ctx.state.newTests.size) {
    const r = await runGate(ctx, "既存のテストだけの木", c.test, sha, { removeFiles: [...ctx.state.newTests] });
    if (r.code !== 0) return { ok: false, name: "既存のテストだけの木", output: `この実行で足したテストのファイルを除くと、テストが落ちた\n${r.tail}` };
  }
  return { ok: true };
}

/** テスト作成のあとのゲート: テスト作成の変更範囲と赤先行 */
async function afterTestGates(ctx, prev, sha, { isTest, skipRedFirst }) {
  const changed = await changedEntries(ctx, prev, sha);
  const bad = changed.filter((e) => {
    if (!isTest(e.path)) return true;
    if (ctx.baseTests.has(e.path)) return true; // 土台のコミットにあったテストは変えない
    if (e.status !== "A" && !ctx.state.newTests.has(e.path)) return true;
    return false;
  });
  if (bad.length) {
    return { ok: false, name: "テスト作成の変更範囲", output: `テスト作成の工程で変えてよいのは、新しく作ったテストのファイルだけ。範囲の外: ${bad.map((e) => e.path).join(", ")}` };
  }
  for (const e of changed) {
    if (e.status === "D") ctx.state.newTests.delete(e.path);
    else ctx.state.newTests.add(e.path);
  }
  if (ctx.state.newTests.size === 0) return { ok: false, name: "テスト作成の変更範囲", output: "新しいテストのファイルが無い" };
  if (skipRedFirst) return { ok: true };
  const files = [...ctx.state.newTests];
  const c = ctx.cfg.commands;
  if (c.testFile) {
    const passed = [];
    for (const f of files) {
      const r = await runGate(ctx, `赤先行 ${f}`, c.testFile, sha, { redFirstOf: ctx.base, args: [f] });
      if (r.code === 0) passed.push(f);
    }
    if (passed.length) return { ok: false, name: "赤先行", output: `実装が無いのに通るテストのファイルがある: ${passed.join(", ")}` };
  } else {
    const r = await runGate(ctx, "赤先行", c.test, sha, { redFirstOf: ctx.base });
    if (r.code === 0) return { ok: false, name: "赤先行", output: "実装が無いのに、テストのコマンドが通った" };
  }
  return { ok: true };
}

async function freshFlow(ctx, { isTest }) {
  const { approval } = ctx;
  const criteria = ["完了条件", criteriaText(approval)];
  const outOfScope = approval.out_of_scope?.length ? [["今回やらないこと", approval.out_of_scope.map((x) => `- ${x}`).join("\n")]] : [];
  const title = ["issue_title", approval.title];

  // 計画
  const plan = await callStage(ctx, "plan", buildPrompt("plan", { trusted: [criteria, ...outOfScope], untrusted: [title] }));
  await resetTree(ctx, ctx.start); // 計画の工程は読むだけ。何か変えていても捨てる
  if (plan.status === "cannot_proceed") {
    throw new Stop(plan.reason_kind === "criteria_insufficient" ? "criteria_insufficient" : "undecidable", "計画の工程が、進められないと返した");
  }
  const isProtected = matcher(PROTECTED_PATHS, { nocase: true });
  const protectedPlanned = plan.files.filter((f) => isProtected(f) || ctx.imports.has(f));
  if (protectedPlanned.length) {
    throw new Stop("outside_allowlist", "計画の工程が、変えさせないファイルを変える見込みと返した", { keepChanges: false });
  }
  if (plan.files.some((f) => !ctx.inAllowlist(f, isTest))) {
    ctx.state.automerge = false;
    ctx.state.notes.push("計画の工程が、自動マージの範囲の外を変える見込みと返した。提出で自動マージを予約しない");
    await ctx.deps.progress("計画の工程が、自動マージの範囲の外を変える見込みと返した。PR は作るが、自動マージは予約しない");
  }
  const planText = ["計画", plan.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")];

  // テスト作成 → 赤先行
  let prev = ctx.start;
  let sha = await testStage(ctx, { prev, criteria, planText, title, isTest });
  prev = sha;

  // 実装 → ゲート → レビュー → 修正 …
  return implementLoop(ctx, { prev, criteria, planText, title, isTest });
}

/** テスト作成の工程。ゲートが落ちたら出力を渡してやり直す（ゲートの失敗の上限に数える） */
async function testStage(ctx, { prev, criteria, planText, title, isTest, extra = [], skipRedFirst = false }) {
  let feedback = null;
  for (let attempt = 0; ; attempt++) {
    const untrusted = [title, ...extra];
    if (feedback) untrusted.push(["gate_output", feedback]);
    const rep = await callStage(ctx, "write_tests", buildPrompt("write_tests", { trusted: [criteria, planText, ["既存のテストのファイル（変えない）", [...ctx.baseTests].join("\n") || "なし"]].filter(Boolean), untrusted })); // 続きから進めるときは計画が無い
    if (rep.status === "already_satisfied") throw new Stop("no_change", "テスト作成の工程が「完了条件はすでに満たされている」と返した", { keepChanges: false });
    if (rep.status === "cannot_proceed") {
      throw new Stop(rep.reason_kind === "criteria_insufficient" ? "criteria_insufficient" : "undecidable", "テスト作成の工程が、進められないと返した");
    }
    const sha = await commitStage(ctx, "write_tests");
    if (sha !== prev) ctx.state.claudeChanged = true;
    const g = await afterTestGates(ctx, prev, sha, { isTest, skipRedFirst });
    if (g.ok) {
      ctx.state.tests = rep.tests;
      await ctx.deps.progress(`テスト作成と赤先行を通った（新しいテストのファイル ${ctx.state.newTests.size} 個）`);
      return sha;
    }
    // 落ちた変更は捨てる ── 範囲の外のファイルを次に持ち越さない
    await resetTree(ctx, prev);
    await recountNewTests(ctx, prev, isTest);
    if (attempt + 1 >= ctx.cfg.limits.max_gate_failures) throw new Stop("limit_reached", `テスト作成のゲート（${g.name}）が上限まで落ちた`);
    feedback = `ゲート「${g.name}」が落ちた\n${g.output}`;
  }
}

/** この実行で足したテストのファイルを、土台のコミットとの差分から数え直す */
async function recountNewTests(ctx, rev, isTest) {
  ctx.state.newTests = new Set();
  for (const e of await diffEntries(ctx.git, ctx.base, rev)) {
    if (isTest(e.path) && e.status !== "D" && !ctx.baseTests.has(e.path)) ctx.state.newTests.add(e.path);
  }
}

async function implementLoop(ctx, { prev, criteria, planText, title, isTest, resumeContext = [] }) {
  const L = ctx.cfg.limits;
  let lastFindings = [];
  const openStreak = new Map();
  let rounds = 0;
  let stage = ctx.resume ? null : "implement";
  let gateFeedback = null;
  let reviewFeedback = null;
  let approvedSha = null;
  let mutationDone = !ctx.cfg.commands.mutation;

  for (;;) {
    // 実装か修正（続きから進めるときは、最初にゲートだけを通す）
    let gateFailures = 0;
    let sha = prev;
    for (;;) {
      if (stage) {
        const untrusted = [title, ...resumeContext];
        if (gateFeedback) untrusted.push(["gate_output", gateFeedback]);
        if (reviewFeedback) untrusted.push(["review_findings", JSON.stringify(reviewFeedback, null, 2)]);
        const trusted = [criteria];
        if (planText) trusted.push(planText);
        trusted.push(["ゲートの結果", gateFeedback ? "前のゲートが落ちた。出力は gate_output にある" : "前のゲートは通っている"]);
        const rep = await callStage(ctx, stage, buildPrompt(stage, { trusted, untrusted }));
        if (rep.status === "cannot_proceed") {
          await resetTree(ctx, sha);
          if (rep.reason_kind === "tests_wrong" && ctx.state.testReturns < L.max_test_returns) {
            ctx.state.testReturns++;
            await ctx.deps.progress("実装の工程が「テストが間違っている」と返した。テスト作成の工程に1回だけ戻す");
            const tsha = await testStage(ctx, { prev: sha, criteria, planText, title, isTest, extra: [["implement_reason", rep.reason]] });
            prev = tsha;
            sha = tsha;
            gateFeedback = null;
            continue;
          }
          if (rep.reason_kind === "tests_wrong") throw new Stop("limit_reached", "テスト作成に戻す上限に達した");
          throw new Stop(rep.reason_kind === "criteria_insufficient" ? "criteria_insufficient" : "undecidable", `工程 ${stage} が、進められないと返した`);
        }
        const before = sha;
        sha = await commitStage(ctx, stage);
        if (sha !== before) ctx.state.claudeChanged = true;
      }
      const g = await afterImplementGates(ctx, prev, sha, { isTest });
      if (g.ok) break;
      if (g.revert) {
        // テストの凍結が落ちた変更は捨てる
        await resetTree(ctx, prev);
        sha = prev;
      }
      gateFailures++;
      if (gateFailures >= L.max_gate_failures) throw new Stop("limit_reached", `ゲート（${g.name}）の失敗が、1回の往復の中で上限に達した`);
      gateFeedback = `ゲート「${g.name}」が落ちた\n${g.output}`;
      stage = "fix";
      prev = sha;
    }
    gateFeedback = null;

    // レビュー
    const diff = (await ctx.git(["diff", "--no-ext-diff", "--no-textconv", ctx.reviewBase, sha])).out;
    const rev = await callStage(ctx, "review", buildPrompt("review", {
      trusted: [criteria, ["ゲートの結果", "テストの凍結、lint、型検査、テスト、既存のテストだけの木を、全部通った"]],
      untrusted: [["previous_findings", JSON.stringify(lastFindings, null, 2)], ["diff", truncate(diff, 200000)]],
    }));
    await resetTree(ctx, sha); // レビューの工程は読むだけ
    const mustFix = rev.findings.filter((f) => f.severity === "must_fix" && f.status !== "resolved");
    ctx.state.findings = rev.findings;
    ctx.state.suggestions = rev.findings.filter((f) => f.severity === "suggestion" && f.status !== "resolved");
    if (rev.conclusion === "request_changes" && mustFix.length === 0) {
      throw new Stop("undecidable", "レビューの結論が修正を求めるのに、「修正が要る」の指摘が無い");
    }
    for (const f of mustFix) {
      const n = f.status === "open" ? (openStreak.get(f.id) || 0) + 1 : 0;
      openStreak.set(f.id, n);
      if (n >= L.max_same_finding) throw new Stop("limit_reached", `同じ指摘（${sanitizeOutbound(f.id)}）が、${n}回続けて残っている`);
    }
    for (const id of [...openStreak.keys()]) if (!mustFix.some((f) => f.id === id)) openStreak.delete(id);
    lastFindings = rev.findings;

    if (mustFix.length === 0) {
      approvedSha = sha;
      if (!mutationDone) {
        mutationDone = true;
        const m = await runGate(ctx, "ミューテーションテスト", ctx.cfg.commands.mutation, sha);
        if (m.code !== 0) {
          if (ctx.state.testReturns >= L.max_test_returns) throw new Stop("limit_reached", "ミューテーションテストが落ち、テスト作成に戻す上限に達していた");
          ctx.state.testReturns++;
          await ctx.deps.progress("ミューテーションテストが落ちた。テスト作成の工程でテストを足し、ゲートとレビューをもう一度通す");
          const tsha = await testStage(ctx, { prev: sha, criteria, planText, title, isTest, extra: [["mutation_output", m.tail]], skipRedFirst: true });
          prev = tsha;
          stage = null; // テストを足しただけなので、まずゲートを通す
          mutationDone = false;
          continue;
        }
      }
      if (ctx.resume && !ctx.state.claudeChanged) throw new Stop("no_change", "続きから進める実行で、Claude Code が何も変えなかった", { keepChanges: false });
      await ctx.deps.progress("レビューが承認した");
      return approvedSha;
    }
    if (rounds >= L.max_rounds) throw new Stop("limit_reached", `レビュー → 修正の往復が上限（${L.max_rounds}回）に達した`);
    rounds++;
    await ctx.deps.progress(`レビューが修正を求めた（「修正が要る」の指摘 ${mustFix.length} 件）。修正に進む`);
    reviewFeedback = mustFix;
    stage = "fix";
    prev = sha;
  }
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}\n…（長いので切った）` : s;
}

/** 続きから進める: PR のブランチに土台のコミットを取り込み、ゲート → レビュー → 修正 */
async function resumeFlow(ctx, { isTest }) {
  const { git, approval } = ctx;
  const criteria = ["完了条件", criteriaText(approval)];
  const title = ["issue_title", approval.title];
  const merge = await git(["merge", "--no-ff", "--no-edit", "-m", "merge-while-you-sleep: 土台のコミットを取り込む", ctx.base], { allowFail: true });
  // 取り込んだ main の変えさせないファイルを基準にする（中身が前の PR の先頭か土台のコミットと同じかは、提出のジョブが確かめる）
  ctx.refreshProtected();
  if (merge.code !== 0) {
    const conflicted = (await git(["diff", "--name-only", "--diff-filter=U", "-z"])).out.split("\0").filter(Boolean);
    if (conflicted.length === 0) throw new Stop("guard_tripped", "土台のコミットを取り込めない");
    const deny = matcher([...FIXED_DENY_PATHS, ...ctx.cfg.denyPaths], { nocase: true });
    if (conflicted.some((p) => isTest(p) || deny(p) || ctx.imports.has(p))) {
      throw new Stop("not_merged", "競合した（テストのファイルか、必ず外すファイルで競合したので、Claude Code に解かせない）", { keepChanges: false });
    }
    const rep = await callStage(ctx, "resolve_conflicts", buildPrompt("resolve_conflicts", { trusted: [criteria, ["競合したファイル", conflicted.join("\n")]], untrusted: [title] }));
    if (rep.status !== "resolved") throw new Stop("not_merged", "競合した（競合の解消の工程が、解けないと返した）", { keepChanges: false });
    await ctx.checkProtected();
    const unstaged = (await git(["diff", "--name-only", "-z"])).out.split("\0").filter(Boolean);
    const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).out.split("\0").filter(Boolean);
    const outside = [...unstaged, ...untracked].filter((p) => !conflicted.includes(p));
    if (outside.length) throw new Stop("not_merged", "競合した（競合の解消の工程が、競合したファイルのほかも変えた）", { keepChanges: false });
    for (const p of conflicted) {
      const text = existsSync(join(ctx.ws, p)) ? readFileSync(join(ctx.ws, p), "utf8") : "";
      if (/^(<{7}|>{7})( |$)/m.test(text)) throw new Stop("not_merged", "競合した（競合の印が残っている）", { keepChanges: false });
    }
    await git(["add", "--", ...conflicted]);
    // --no-edit だと「# Conflicts:」とパスがメッセージに残り、パスの @ が提出のジョブの照合に掛かる
    await git(["commit", "--no-verify", "-q", "--cleanup=strip", "-m", "merge-while-you-sleep: 土台のコミットを取り込む"]);
    ctx.state.claudeChanged = true;
  }
  const merged = (await git(["rev-parse", "HEAD"])).out.trim();
  await resetTree(ctx, merged);
  ctx.start = merged;
  // この実行の前に PR が足したテストのファイル
  await recountNewTests(ctx, merged, isTest);
  const resumeContext = [];
  if (ctx.resume.ci_log) resumeContext.push(["failed_ci_log", ctx.resume.ci_log]);
  if (ctx.resume.findings?.length) resumeContext.push(["remaining_findings", JSON.stringify(ctx.resume.findings, null, 2)]);
  return implementLoop(ctx, { prev: merged, criteria, planText: null, title, isTest, resumeContext });
}

// ---------- 作業のジョブの外側（準備、bundle、出力）----------

/** sandbox に要るもの（bubblewrap、socat、seccomp フィルタ）を入れて確かめる */
async function installSandboxDeps() {
  const env = baseEnv({ DEBIAN_FRONTEND: "noninteractive" });
  if (!(await which("bwrap")) || !(await which("socat"))) {
    await exec("sudo", ["-n", "apt-get", "update", "-qq"], { env, timeout: 300000 });
    const r = await exec("sudo", ["-n", "apt-get", "install", "-y", "-qq", "bubblewrap", "socat"], { env, timeout: 300000 });
    if (r.code !== 0) throw new Stop("cannot_start", "bubblewrap と socat を入れられない");
  }
  // Ubuntu 24.04 は、権限の無い user namespace を AppArmor で止める（claude-code-action も同じ設定を変えている）
  await exec("sudo", ["-n", "sysctl", "-w", "kernel.apparmor_restrict_unprivileged_userns=0"], { env });
  // seccomp フィルタ: action に持たせた package-lock.json で入れる。install のスクリプトは実行しない
  const work = join(runnerTemp(), "merge-while-you-sleep", "srt");
  mkdirSync(work, { recursive: true });
  for (const f of ["package.json", "package-lock.json"]) cpSync(join(ROOT, "deps", "sandbox-runtime", f), join(work, f));
  const npm = await exec("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: work, env: baseEnv({ npm_config_cache: join(runnerTemp(), "merge-while-you-sleep", "npm-cache") }), timeout: 300000,
  });
  if (npm.code !== 0) throw new Stop("cannot_start", "seccomp フィルタ（@anthropic-ai/sandbox-runtime）を入れられない");
  const src = join(work, "node_modules", "@anthropic-ai", "sandbox-runtime");
  const dest = "/usr/local/lib/node_modules/@anthropic-ai";
  await exec("sudo", ["-n", "mkdir", "-p", dest], { env });
  await exec("sudo", ["-n", "rm", "-rf", `${dest}/sandbox-runtime`], { env });
  const cp = await exec("sudo", ["-n", "cp", "-r", src, `${dest}/sandbox-runtime`], { env });
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const bin = `${dest}/sandbox-runtime/vendor/seccomp/${arch}/apply-seccomp`;
  if (cp.code !== 0 || !existsSync(bin)) throw new Stop("cannot_start", "seccomp フィルタが無い");
  const probe = await exec("bwrap", ["--ro-bind", "/", "/", "--unshare-net", "--die-with-parent", "true"], { env: baseEnv() });
  if (probe.code !== 0) throw new Stop("cannot_start", "bubblewrap が起動できない");
}

/** 作業の最初に作業ディレクトリにあった、git の管理の外のファイルを、workspace_keep のほかは外へ移す */
async function moveUntracked(git, ws, keepNames) {
  const s = await git(["status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=normal"]);
  const entries = s.out.split("\0").filter(Boolean).map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/\/$/, "") }));
  const dirty = entries.filter((e) => e.code !== "??" && e.code !== "!!");
  if (dirty.length) throw new Stop("cannot_start", "作業の最初に、git の管理の中のファイルが土台のコミットから変わっている");
  const keep = [];
  const movedDir = join(runnerTemp(), "merge-while-you-sleep", "moved");
  const moved = [];
  let i = 0;
  for (const e of entries) {
    const base = e.path.split("/").pop();
    let st;
    try {
      st = lstatSync(join(ws, e.path));
    } catch {
      continue;
    }
    if (keepNames.includes(base) && st.isDirectory() && !st.isSymbolicLink()) {
      keep.push(e.path);
      continue;
    }
    const to = join(movedDir, String(i++));
    mkdirSync(to, { recursive: true });
    const dest = join(to, base);
    try {
      renameSync(join(ws, e.path), dest);
    } catch {
      cpSync(join(ws, e.path), dest, { recursive: true, verbatimSymlinks: true });
      rmSync(join(ws, e.path), { recursive: true, force: true });
    }
    moved.push({ from: e.path, to: dest });
  }
  writeFileSync(join(runnerTemp(), "merge-while-you-sleep", "moved.json"), JSON.stringify(moved));
  return keep;
}

/** 外へ移したファイルを戻す（作業の最後と post の step）── 準備の action の post の step が、自分の置いたファイルを片付けられる */
function restoreMoved(ws) {
  const f = join(runnerTemp(), "merge-while-you-sleep", "moved.json");
  if (!existsSync(f)) return;
  for (const m of JSON.parse(readFileSync(f, "utf8"))) {
    if (!existsSync(m.to)) continue;
    mkdirSync(dirname(join(ws, m.from)), { recursive: true });
    try {
      renameSync(m.to, join(ws, m.from));
    } catch {}
  }
  rmSync(f, { force: true });
}

/** 作業の最初に、変えさせないファイルの元になる一覧を作る（土台のコミットから） */
async function memoryRoots(git, rev) {
  const files = (await git(["ls-tree", "-r", "-z", "--name-only", rev])).out.split("\0").filter(Boolean);
  return files.filter((p) => /(^|\/)(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/i.test(p));
}

async function importsAt(git, rev) {
  const roots = await memoryRoots(git, rev);
  const cache = new Map();
  for (const p of roots) cache.set(p, null);
  const readAt = async (p) => {
    const r = await git(["show", `${rev}:${p}`], { allowFail: true });
    return r.code === 0 ? r.out : null;
  };
  // traceImports は同期で読むので、たどりながら先に読んでおく
  const texts = new Map();
  let frontier = [...roots];
  for (let depth = 0; depth < 6 && frontier.length; depth++) {
    const next = [];
    for (const p of frontier) {
      if (texts.has(p)) continue;
      const t = await readAt(p);
      texts.set(p, t);
      if (t == null) continue;
      for (const x of extractImports(t)) {
        const q = resolveImport(p, x);
        if (q && !texts.has(q)) next.push(q);
      }
    }
    frontier = next;
  }
  return traceImports(roots, (p) => texts.get(p) ?? null);
}

/** 秘密の値（この実行が持つ鍵）を集める ── 差分の照合と、外に出す文面から消すため */
function secretValues() {
  const vals = new Set();
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || v.length < 16) continue;
    if (k.startsWith("INPUT_") || k.startsWith("ACTIONS_") || /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|PRIVATE/i.test(k)) {
      if (/^(true|false|\d+)$/.test(v)) continue;
      if (k === "INPUT_APPROVAL" || k === "INPUT_RESUME" || k.endsWith("_COMMAND") || k === "INPUT_BASE_COMMIT") continue;
      vals.add(v);
    }
  }
  return [...vals];
}

function workConfig() {
  const limits = {};
  for (const [k, v] of Object.entries(LIMITS)) limits[k] = inputNumber(k, v);
  const models = {};
  for (const [k, v] of Object.entries(MODELS)) models[k] = input(`model_${k}`, v);
  return {
    limits,
    models,
    commands: {
      test: input("test_command"),
      lint: input("lint_command"),
      typecheck: input("typecheck_command"),
      mutation: input("mutation_command"),
      testFile: input("test_file_command"),
    },
    testPaths: testPaths(),
    allowPaths: splitList(process.env.MERGE_WHILE_YOU_SLEEP_ALLOW_PATHS),
    denyPaths: splitList(process.env.MERGE_WHILE_YOU_SLEEP_DENY_PATHS),
    passEnv: splitList(input("pass_env")),
    keepNames: splitList(input("workspace_keep", "node_modules,.venv,venv,vendor")),
    readPaths: [...GATE_TOOL_DIRS.map(expandHome), ...splitList(input("gate_read_paths")).map(expandHome)],
    network: inputBool("gate_network", false),
    allowDomains: splitList(input("network_allow_domains")),
    allowTools: splitList(input("allow_tools")),
  };
}

/** 自動マージの範囲（提出のジョブと同じ規則）── 計画の見込みの判定に使う */
export function makeInAllowlist({ allowPaths, denyPaths, imports, baseTests }) {
  const allow = matcher(allowPaths);
  const deny = matcher([...FIXED_DENY_PATHS, ...denyPaths], { nocase: true });
  return (path, isTest) => allow(path) && !deny(path) && !imports.has(path) && !(isTest(path) && baseTests.has(path));
}

async function modeWork() {
  saveState("work_started", "1");
  const ws = process.env.GITHUB_WORKSPACE;
  const gh = makeGitHub(input("github_token"));
  const approval = JSON.parse(input("approval"));
  const resume = input("resume") ? JSON.parse(input("resume")) : null;
  const base = input("base_commit");
  const issue = approval.issue;
  const cfg = workConfig();
  const L = labels();
  const oauth = input("claude_code_oauth_token");
  mask(oauth);
  const secrets = secretValues();
  const git = makeGit(ws);
  let progressId = null;
  const progress = async (text) => {
    const body = `作業の進捗（${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC）: ${text}\n\n実行のログ: ${runUrl()}\n\n${marker("progress")}`;
    try {
      if (progressId) await gh.patch(`/repos/${repoFromEnv().full}/issues/comments/${progressId}`, { body });
      else progressId = (await comment(gh, issue, body)).id;
    } catch {}
  };
  const finishEscalation = async (stop) => {
    await escalate(gh, {
      issue, reason: stop.reason, mention: approval.labeled_by,
      details: sanitizeOutbound(stop.details, secrets), removeLabels: await triggerLabelIfOurs(gh, issue, L),
    });
    setOutput("done", "true");
    setOutput("submit", "false");
  };

  mkdirSync(join(runnerTemp(), "merge-while-you-sleep"), { recursive: true });
  if (!cfg.commands.test) return finishEscalation(new Stop("cannot_start", "入力 test_command が無い"));
  if (!cfg.allowPaths.length) return finishEscalation(new Stop("cannot_start", "変数 MERGE_WHILE_YOU_SLEEP_ALLOW_PATHS が無い"));

  let ctx;
  try {
    await progress(resume ? "続きから進める（承認の記録が前の実行と同じで、開いている PR がある）" : "最初から作業を始める");
    const head = (await git(["rev-parse", "HEAD"])).out.trim();
    if (head !== base) throw new Stop("cannot_start", "checkout したコミットが土台のコミットと違う");
    saveState("base_commit", base);
    const keep = await moveUntracked(git, ws, cfg.keepNames);
    saveState("keep", Buffer.from(JSON.stringify(keep)).toString("hex"));
    const helpers = findHelpers(ws);
    if (helpers.length) throw new Stop("cannot_start", `設定のファイルに helper のコマンドがある: ${helpers.join(", ")}`);

    const isTest = matcher(cfg.testPaths);
    const baseFiles = (await git(["ls-files", "-z"])).out.split("\0").filter(Boolean);
    const baseTests = new Set(baseFiles.filter(isTest));
    if (baseTests.size === 0) throw new Stop("cannot_start", "土台のコミットに、テストのパターンに合うファイルが無い（変数 MERGE_WHILE_YOU_SLEEP_TEST_PATHS で直す）");
    const imports = await importsAt(git, base);

    const claudePath = await installClaude();
    await installSandboxDeps();

    ctx = {
      ws, git, approval, cfg, base, start: base, reviewBase: base, keep, imports, baseTests, resume,
      now: () => Date.now(),
      inAllowlist: makeInAllowlist({ allowPaths: cfg.allowPaths, denyPaths: cfg.denyPaths, imports, baseTests }),
    };
    ctx.deps = {
      progress,
      gate: (name, command, opts) => realGate(ctx, name, command, opts),
      claude: (stage, opts) => realClaude(ctx, claudePath, oauth, stage, opts),
    };

    // 土台のゲート。落ちたら Claude Code を呼ばずに止める
    for (const [name, cmd] of [["テスト", cfg.commands.test], ["lint", cfg.commands.lint], ["型検査", cfg.commands.typecheck]]) {
      if (!cmd) continue;
      const r = await realGate(ctx, `土台のゲート ${name}`, cmd, { timeoutMs: 30 * 60000 });
      log(`土台のゲート ${name}: 終了コード ${r.code}`);
      await resetTree(ctx, base);
      if (r.code !== 0) throw new Stop("cannot_start", `土台のゲート（${name}）が落ちる`);
    }

    if (resume) {
      const fetched = await fetchRef(git, gh, input("github_token"), resume.head_ref);
      if (fetched !== resume.head_sha) throw new Stop("not_merged", "作業の間に人が PR のブランチへ push していた", { keepChanges: false });
      const depMatch = matcher(DEPENDENCY_PATHS, { nocase: true });
      // PR が main から分かれた点からの差分で見る ── 土台との差分だと、main で変わった依存の定義まで拾う
      const fork = (await git(["merge-base", base, resume.head_sha])).out.trim();
      const depChanged = (await diffEntries(git, fork, resume.head_sha)).filter((e) => depMatch(e.path));
      if (depChanged.length) throw new Stop("outside_allowlist", "続きから進めるときに、PR のブランチの依存の定義が土台のコミットと違う", { keepChanges: false });
      await git(["checkout", "-q", "--detach", resume.head_sha]);
      await resetTree(ctx, resume.head_sha);
      ctx.start = resume.head_sha;
      ctx.reviewBase = base;
    }

    let snapshot = protectedSnapshot(ws, { keep, imports });
    ctx.checkProtected = async () => {
      const d = compareSnapshots(snapshot, protectedSnapshot(ws, { keep, imports }));
      if (d.length) throw new Stop("guard_tripped", "変えさせないファイルが変わったか、増えた");
    };
    ctx.refreshProtected = () => {
      snapshot = protectedSnapshot(ws, { keep, imports });
    };

    const res = await workFlow(ctx);
    const stop = res.stop;
    if (stop && !stop.keepChanges) throw stop;
    const changedFromStart = res.head !== (resume ? resume.head_sha : base);
    if (!changedFromStart) {
      if (stop) throw stop;
      throw new Stop("no_change", resume ? "続きから進める実行で、Claude Code が何も変えなかった" : "変更が無い", { keepChanges: false });
    }
    // 差分に鍵の文字列が無いか（この実行が持つ鍵をそのまま書き写した場合だけを見つける）
    const fullDiff = (await git(["diff", "--text", "--no-ext-diff", "--no-textconv", base, res.head])).out;
    const msgs = (await git(["log", "--format=%B", res.head, `^${base}`])).out;
    if (secrets.some((s) => fullDiff.includes(s) || msgs.includes(s))) throw new Stop("guard_tripped", "差分に鍵の文字列があった");

    // bundle を作る。上げるのは examples/ のワークフローの step（actions/upload-artifact）
    const bdir = join(runnerTemp(), "merge-while-you-sleep", "bundle");
    mkdirSync(bdir, { recursive: true });
    await git(["update-ref", "refs/merge-while-you-sleep/bundle", res.head]);
    const prereq = resume ? [`^${base}`, `^${resume.head_sha}`] : [`^${base}`];
    await git(["bundle", "create", "-q", join(bdir, "work.bundle"), "refs/merge-while-you-sleep/bundle", ...prereq]);
    await git(["update-ref", "-d", "refs/merge-while-you-sleep/bundle"]);
    setOutput("bundle_dir", bdir);
    setOutput("bundle_head", res.head);
    setOutput("resume_pr_head", resume ? resume.head_sha : "");
    setOutput("automerge", res.automerge ? "true" : "false");
    setOutput("work_report", sanitizeReport(res.report, secrets));
    setOutput("submit", "true");
    setOutput("done", "false");
    await progress(stop ? `止まった（${REASONS[stop.reason].title}）。変更を PR にして残す` : "作業を終えた。提出のジョブに渡す");
  } catch (e) {
    if (!(e instanceof Stop)) {
      log(`作業のジョブが落ちた: ${e.message}`);
      throw e;
    }
    await finishEscalation(e);
  } finally {
    await finishWorkTree(ws);
  }
}

function sanitizeReport(rep, secrets) {
  // レポートの文字列から鍵の文字列を消す。外に出す形への消毒は、提出のジョブが PR の本文を組み立てるときにする
  const s = JSON.stringify(rep);
  let t = s;
  for (const k of secrets) t = t.split(k).join("[消した]");
  return JSON.parse(t);
}

/** 作業の最後と post の step: 作業ツリーを土台のコミットに戻し、外へ移したファイルを戻す */
async function finishWorkTree(ws) {
  const base = getState("base_commit") || input("base_commit");
  if (!ws || !base) return;
  await killAllCgroups();
  const git = makeGit(ws);
  await git(["checkout", "-q", "-f", "--detach", base], { allowFail: true });
  await git(["clean", "-ffdxq"], { allowFail: true });
  restoreMoved(ws);
}

/** 作業ディレクトリの中で、読み取りだけにするパス（すでにあるパスだけ） */
function readOnlyPathsInWs(ws, keep, imports) {
  const out = new Set([".git", ...keep]);
  walk(ws, {
    skip: new Set(keep),
    onFile(r, st, isDir) {
      const name = r.split("/").pop();
      if (isDir && (name === ".claude" || name === ".github")) out.add(r);
      if (!isDir && ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json", "CODEOWNERS"].includes(name)) out.add(r);
    },
  });
  for (const p of imports) if (existsSync(join(ws, p))) out.add(p);
  return [...out].filter((p) => existsSync(join(ws, p)));
}

/** ゲートのコマンドを bubblewrap の中で実行する。出力はファイルにだけ書き、末尾を返す */
async function realGate(ctx, name, command, { timeoutMs, args = [] } = {}) {
  const { ws, cfg } = ctx;
  const home = process.env.HOME || "/home/runner";
  const bw = bwrapArgs({ ws, readOnlyInWs: readOnlyPathsInWs(ws, ctx.keep, ctx.imports), readPaths: cfg.readPaths, network: cfg.network, home });
  const r = await exec("bwrap", [...bw, "--", "/bin/sh", "-c", args.length ? `${command} "$@"` : command, "sh", ...args], {
    cwd: ws, env: gateEnv(cfg.passEnv), timeout: Math.max(1000, timeoutMs),
  });
  const dir = join(runnerTemp(), "merge-while-you-sleep", "logs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${name.replace(/[^\w.-]+/g, "_")}.log`);
  writeFileSync(file, `${r.out}\n${r.err}`);
  // 作業ツリーと HEAD を戻すのは呼ぶ側（resetTree）
  const tail = `${r.out}\n${r.err}`.split("\n").slice(-200).join("\n").slice(-20000);
  return { code: r.timedOut ? 124 : r.code, tail, file };
}

async function realClaude(ctx, claudePath, oauth, stage, { prompt, schema, model, budget, timeoutMs, callId }) {
  const { ws, cfg } = ctx;
  const temp = runnerTemp();
  const cfgDir = mkdtempSync(join(temp, "merge-while-you-sleep", "claude-config-"));
  const tmp = mkdtempSync("/tmp/merge-while-you-sleep-");
  const readOnly = readOnlyPathsInWs(ws, ctx.keep, ctx.imports);
  const readOnlyStage = stage === "plan" || stage === "review";
  const tools = readOnlyStage ? ["Read", "Grep", "Glob"] : ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
  if (SKILL_HOOKS_VERIFIED && !readOnlyStage) tools.push("Skill");
  if (!readOnlyStage) tools.push(...cfg.allowTools); // 読むだけの工程は sandbox なしで動くので、足さない
  const settings = buildSettings({
    ws, runnerTemp: temp, sandbox: !readOnlyStage, readPaths: cfg.readPaths,
    denyWrite: readOnly.map((p) => join(ws, p)),
    editDeny: [...ctx.keep.map((k) => `Edit(${k}/**)`), ...[...ctx.imports].map((p) => `Edit(${p})`)],
    allowDomains: cfg.allowDomains, skills: [], tmp,
  });
  const settingsFile = join(cfgDir, "settings.merge-while-you-sleep.json");
  writeFileSync(settingsFile, JSON.stringify(settings));
  const env = claudeEnv({ oauth, cfgDir, tmp, passEnv: cfg.passEnv });
  const args = [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema), "--model", model,
    "--permission-mode", "dontAsk", "--settings", settingsFile, "--tools", tools.join(","),
    "--strict-mcp-config", "--disallowedTools", "mcp__*", "--max-budget-usd", budget.toFixed(2), "--no-session-persistence",
  ];
  const r = await runClaude(env, { claudePath, args, prompt, cwd: ws, timeoutMs, callId });
  rmSync(cfgDir, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  if (readOnlyStage) await resetTree(ctx, (await ctx.git(["rev-parse", "HEAD"])).out.trim());
  return r;
}

// ---------- 入り口 ----------

async function main() {
  if (getState("main_ran") === "1") {
    // post の step
    if (getState("work_started") === "1") await finishWorkTree(process.env.GITHUB_WORKSPACE);
    return;
  }
  saveState("main_ran", "1");
  return modeWork();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log(`止まった: ${e instanceof Stop ? REASONS[e.reason].title : "予期しない失敗"}`);
    process.exitCode = 1;
  });
}
