// draft/draft.mjs — 下書きの action の本体
//
// Claude Code がコードを読み、完了条件の案と質問を Issue にコメントする。読むだけの工程なので、作業ディレクトリを変えさせない

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { input, inputNumber, log, mask, runnerTemp, setOutput } from "../shared/actions.mjs";
import { buildPrompt, buildSettings, claudeEnv, findHelpers, installClaude, runClaude, SCHEMAS, validate } from "../shared/claude.mjs";
import { LIMITS, MODELS } from "../shared/defaults.mjs";
import { comment, escalate, marker, readMarker, REASONS, Stop } from "../shared/escalation.mjs";
import { sha256 } from "../shared/git.mjs";
import { atLeastTriage, labels, latestLabeledEvent, makeGitHub, permissionOf, readEvent, repoFromEnv } from "../shared/github.mjs";
import { codeBlock, sanitizeOutbound, scrubSecrets, stripInvisible } from "../shared/sanitize.mjs";

// ---------- 下書き ----------


async function modeDraft() {
  const ev = readEvent();
  const gh = makeGitHub(input("github_token"));
  const L = labels();
  const issueN = ev.issue?.number;
  const done = () => setOutput("done", "true");
  if (!issueN || ev.issue.pull_request || ev.sender?.type !== "User" || ev.issue.state !== "open") return done();
  const issueLabels = (ev.issue.labels || []).map((l) => l.name);
  if (issueLabels.includes(L.trigger)) return done();
  const action = process.env.GITHUB_EVENT_NAME === "issue_comment" ? "comment" : ev.action;
  if (action === "labeled" && ev.label?.name !== L.draft) return done();
  if (action === "opened" && !issueLabels.includes(L.draft)) return done();
  if (action === "comment" && !issueLabels.includes(L.draft)) return done();

  const perms = new Map();
  const { owner, repo, full } = repoFromEnv();
  const ev2 = await latestLabeledEvent(gh, issueN, L.draft);
  const labeler = ev2?.actor?.login || ev.sender.login;
  const mention = labeler;
  const draftEscalate = async (reason, details) => {
    await escalate(gh, { issue: issueN, reason, mention, details, removeLabels: [L.draft] });
    done();
  };
  if (!atLeastTriage(await permissionOf(gh, ev.sender.login, perms))) return done();
  if (!atLeastTriage(await permissionOf(gh, labeler, perms))) return done();

  // 下書きラベルのあとに、triage 未満の人がタイトルか本文を変えていないか
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){title body lastEditedAt editor{login} timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:50){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}}}}`;
  const d = (await gh.graphql(q, { o: owner, r: repo, n: issueN })).repository.issue;
  const labeledAt = ev2 ? new Date(ev2.createdAt) : new Date(0);
  if (d.lastEditedAt && new Date(d.lastEditedAt) > labeledAt && d.editor && !atLeastTriage(await permissionOf(gh, d.editor.login, perms))) {
    return draftEscalate("cannot_start", "下書きラベルのあとに、triage 未満の人が Issue の本文を変えた");
  }
  for (const n of d.timelineItems.nodes) {
    if (new Date(n.createdAt) > labeledAt && n.actor && !atLeastTriage(await permissionOf(gh, n.actor.login, perms))) {
      return draftEscalate("cannot_start", "下書きラベルのあとに、triage 未満の人が Issue のタイトルを変えた");
    }
  }

  // 前の下書きと、そのあとの triage 以上の人のコメント
  const comments = await gh.paginate(`/repos/${full}/issues/${issueN}/comments`);
  const drafts = comments.filter((c) => c.user?.login === "github-actions[bot]" && readMarker(c.body)?.kind === "draft");
  const last = drafts.at(-1);
  const after = comments.filter((c) => (!last || new Date(c.created_at) > new Date(last.created_at)) && c.user?.type === "User");
  const answers = [];
  for (const c of after) if (atLeastTriage(await permissionOf(gh, c.user.login, perms))) answers.push(c);
  // 下書きラベルを付けた（付け直した）イベントでは、読むコメントが無くても下書きをし直す
  if (action === "comment" && last && answers.length === 0) return done(); // 読むコメントが無い（前の下書きのジョブが読んだ）
  const asked = drafts.filter((c) => new Date(c.created_at) > labeledAt && readMarker(c.body)?.questions > 0).length;
  if (asked >= inputNumber("max_draft_questions", LIMITS.max_draft_questions)) {
    return draftEscalate("criteria_insufficient", `下書きの質問が上限（${asked}回）に達した`);
  }

  const claudePath = await installClaude();
  const ws = process.env.GITHUB_WORKSPACE;
  const oauth = input("claude_code_oauth_token");
  mask(oauth);
  const prompt = buildPrompt("draft", {
    trusted: [],
    untrusted: [
      ["previous_draft", last ? stripInvisible(last.body) : "なし"],
      ["issue_title", stripInvisible(d.title)],
      ["issue_body", stripInvisible(d.body)],
      ...answers.map((c, i) => [`comment_${i + 1}`, stripInvisible(c.body)]),
    ],
  });
  const temp = runnerTemp();
  mkdirSync(join(temp, "merge-while-you-sleep"), { recursive: true });
  const cfgDir = mkdtempSync(join(temp, "merge-while-you-sleep", "claude-config-"));
  const tmp = mkdtempSync("/tmp/merge-while-you-sleep-");
  const settings = buildSettings({ ws, runnerTemp: temp, sandbox: false, tmp });
  writeFileSync(join(cfgDir, "settings.merge-while-you-sleep.json"), JSON.stringify(settings));
  const helpers = findHelpers(ws);
  if (helpers.length) return draftEscalate("cannot_start", `設定のファイルに helper のコマンドがある: ${helpers.join(", ")}`);
  const r = await runClaude(claudeEnv({ oauth, cfgDir, tmp, passEnv: [] }), {
    claudePath,
    args: [
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMAS.draft), "--model", input("model_draft", MODELS.draft),
      "--permission-mode", "dontAsk", "--settings", join(cfgDir, "settings.merge-while-you-sleep.json"), "--tools", "Read,Grep,Glob",
      "--strict-mcp-config", "--disallowedTools", "mcp__*",
      "--max-budget-usd", inputNumber("max_draft_cost_usd", LIMITS.max_draft_cost_usd).toFixed(2), "--no-session-persistence",
    ],
    prompt, cwd: ws, timeoutMs: inputNumber("max_draft_minutes", LIMITS.max_draft_minutes) * 60000, callId: 1,
  });
  log(`工程 draft: 終わった（コスト ${r.cost.toFixed(2)} USD）`);
  if (r.failure) return draftEscalate(r.failure.reason, r.failure.details);
  if (validate(SCHEMAS.draft, r.output)) return draftEscalate("undecidable", "下書きのレポートがスキーマに合わない");

  // コメントを書く直前に起動ラベルを確かめ直す
  const now = await gh.get(`/repos/${full}/issues/${issueN}`);
  if ((now.labels || []).some((l) => l.name === L.trigger)) return done();
  const body = draftComment(r.output, oauth, input("github_token"));
  const posted = await comment(gh, issueN, body);
  const dir = join(temp, "merge-while-you-sleep", "draft-artifact");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify({ comment_id: posted.id, body_sha256: sha256(posted.body) }));
  setOutput("artifact_dir", dir);
  done();
}

/** 下書きのコメントを、レポートから組み立てる。完了条件と今回やらないことはコードブロックに入れる */
export function draftComment(rep, ...secrets) {
  const s = (x) => sanitizeOutbound(x, secrets);
  const lines = ["## 完了条件の下書き", ""];
  if (rep.status === "cannot_proceed") lines.push(`下書きを作れなかった: ${s(rep.reason)}`, "");
  const clean = (x) => scrubSecrets(stripInvisible(x), secrets);
  rep = { ...rep, criteria: rep.criteria.map(clean), out_of_scope: rep.out_of_scope.map(clean) };
  lines.push("### 完了条件", "", codeBlock(rep.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n") || "なし"), "");
  lines.push("### 今回やらないこと", "", codeBlock(rep.out_of_scope.map((c) => `- ${c}`).join("\n") || "なし"), "");
  if (rep.outside_allowlist_risk.trim()) lines.push("### 自動マージの範囲の外", "", `人が PR を読む必要がありそう: ${s(rep.outside_allowlist_risk)}`, "");
  if (rep.split_suggestion.trim()) lines.push("### Issue を分ける案", "", s(rep.split_suggestion), "");
  if (rep.questions.length) {
    lines.push("### 質問", "", ...rep.questions.map((q, i) => `${i + 1}. ${s(q)}`), "", "コメントで答えると、下書きをし直す。");
  }
  lines.push("", "この完了条件でよければ、起動ラベルを付けて承認する。", "", marker("draft", { questions: rep.questions.length, criteria: rep.criteria, out_of_scope: rep.out_of_scope }));
  return lines.join("\n");
}

// ---------- 入り口 ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  modeDraft().catch((e) => {
    log(`止まった: ${e instanceof Stop ? REASONS[e.reason].title : "予期しない失敗"}`);
    process.exitCode = 1;
  });
}
