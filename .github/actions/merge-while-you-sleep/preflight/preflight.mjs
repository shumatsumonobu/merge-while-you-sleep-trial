// preflight/preflight.mjs — 開始の確認の action の本体
//
// 権限、設定、承認を確かめ、承認を記録し、土台のコミットを決める。続きから進める PR も探す
// App の秘密鍵を扱う。Claude Code も、対象プロジェクトのコードも実行しない（DESIGN.md の骨格の形）

import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { input, log, setOutput } from "../shared/actions.mjs";
import { comment, escalate, Halt, marker, readMarker, REASONS, removeLabel } from "../shared/escalation.mjs";
import { sha256 } from "../shared/git.mjs";
import { labels, latestLabeledEvent, makeGitHub, permissionOf, readEvent, repoFromEnv } from "../shared/github.mjs";
import { tokenSourceFromInputs } from "../shared/pr-token.mjs";
import { codeBlock, scrubSecrets, stripInvisible } from "../shared/sanitize.mjs";

const PREFLIGHT_PERMISSIONS = { contents: "write", pull_requests: "write", actions: "write", administration: "read" };

// ---------- artifact の zip ----------


/** zip から1つのファイルを取り出す（格納と deflate だけ）── 依存を持たないため自分で読む */
export function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip の終わりが見つからない");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip の目次が壊れている");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    if (name !== wanted) continue;
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    if (method === 0) return data;
    if (method === 8) return inflateRawSync(data);
    throw new Error("zip の圧縮の方法に対応していない");
  }
  return null;
}

async function downloadArtifact(gh, artifactId) {
  const { full } = repoFromEnv();
  const res = await gh.raw("GET", `/repos/${full}/actions/artifacts/${artifactId}/zip`);
  const loc = res.headers.get("location");
  if (!loc) throw new Error("artifact の取得先が返らない");
  const z = await fetch(loc); // 取得先には GitHub のトークンを送らない
  if (!z.ok) throw new Error("artifact を取得できない");
  return Buffer.from(await z.arrayBuffer());
}

// ---------- 開始の確認 ----------


const ISSUE_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){
  issue(number:$n){title body lastEditedAt state author{login}
    timelineItems(itemTypes:[RENAMED_TITLE_EVENT],last:100){nodes{... on RenamedTitleEvent{createdAt actor{login}}}}}}}`;

/** Issue forms の本文から、見出しの欄を切り出す */
export function formField(body, label) {
  const lines = String(body || "").split("\n");
  const i = lines.findIndex((l) => l.trim() === `### ${label}`);
  if (i < 0) return null;
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^### /.test(lines[j])) break;
    out.push(lines[j]);
  }
  const t = out.join("\n").trim();
  return t && t !== "_No response_" ? t : null;
}

/** 欄の中身を1行1項目に分ける。行頭の箇条書きの印と番号は取る */
export function formLines(text) {
  return stripInvisible(text)
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

export function approvalHash(a) {
  return sha256(JSON.stringify({ title: a.title, criteria: a.criteria, out_of_scope: a.out_of_scope }));
}

async function modePreflight() {
  const ev = readEvent();
  const gh = makeGitHub(input("github_token"));
  const L = labels();
  const { owner, repo, full } = repoFromEnv();
  const issueN = ev.issue?.number;
  const quiet = () => {
    setOutput("proceed", "false");
    setOutput("done", "true");
  };
  if (!issueN || ev.sender?.type !== "User") return quiet();
  const relevant = ev.action === "labeled" ? ev.label?.name === L.trigger : ev.action === "opened" && (ev.issue.labels || []).some((l) => l.name === L.trigger);
  if (!relevant) return quiet();

  // 起動ラベルが今も付いていて、Issue が開いているか
  const now = await gh.get(`/repos/${full}/issues/${issueN}`);
  if (now.state !== "open" || !(now.labels || []).some((l) => l.name === L.trigger)) return quiet();

  // 今付いている起動ラベルを付けた、最新の LabeledEvent 1つで、付けた人と時刻を見る
  const run = await gh.get(`/repos/${full}/actions/runs/${process.env.GITHUB_RUN_ID}`);
  const lev = await latestLabeledEvent(gh, issueN, L.trigger);
  if (!lev) return quiet();
  if (new Date(lev.createdAt) > new Date(run.created_at)) return quiet(); // 付け直されたラベルの実行に任せる
  const labeler = lev.actor?.login;
  const labeledAt = new Date(lev.createdAt);
  const stop = async (reason, details) => {
    await escalate(gh, { issue: issueN, reason, mention: labeler, details, removeLabels: [L.trigger] });
    setOutput("proceed", "false");
    setOutput("done", "true");
  };
  // 書き込み権限以上か ── ほかの確かめより先に、GITHUB_TOKEN で確かめる。満たさなければ PR 用トークンを発行しない
  if (!labeler || (await permissionOf(gh, labeler)) !== "write") {
    return stop("cannot_start", "起動ラベルを付けた人が、書き込み権限を持っていない");
  }
  await removeLabel(gh, issueN, L.escalation);

  let tokens;
  try {
    tokens = tokenSourceFromInputs(PREFLIGHT_PERMISSIONS);
    await tokens.get();
  } catch (e) {
    return stop("cannot_start", e instanceof Halt ? e.details : "PR 用トークンを発行できない（App の設定の誤り）");
  }
  try {
    const pr = await tokens.gh();
    const repoInfo = await pr.get(`/repos/${full}`);
    const branch = repoInfo.default_branch;
    const missing = await checkSettings(pr, { full, branch, owner, repo });
    if (missing.length) return stop("cannot_start", `足りない設定:\n${missing.map((m) => `- ${m}`).join("\n")}`);
    await ensureLabels(gh, full, L);

    // 承認の記録
    const d = (await gh.graphql(ISSUE_QUERY, { o: owner, r: repo, n: issueN })).repository.issue;
    if (d.timelineItems.nodes.some((n) => new Date(n.createdAt) > labeledAt)) {
      return stop("cannot_start", "起動ラベルを付けたあとに、Issue のタイトルが変えられた");
    }
    const approval = await buildApproval(gh, { d, labeler, labeledAt, full, branch, issueN, L });
    if (approval.halt) return stop(approval.halt.reason, approval.halt.details);

    // 前の実行の PR を探す
    const tokenOwner = await tokens.login();
    const prs = await pr.paginate(`/repos/${full}/pulls?state=all&sort=created&direction=desc`);
    const ours = prs.filter((p) => p.head?.ref?.startsWith(`merge-while-you-sleep/issue-${issueN}-`) && p.head?.repo?.full_name === full && p.user?.login === tokenOwner);
    const merged = ours.find((p) => p.merged_at && readMarker(p.body)?.approval_hash === approval.hash);
    if (merged) {
      await comment(gh, issueN, `この承認の記録の PR #${merged.number} は、すでにマージされている。実行せずに終える。\n\n${marker("merged")}`);
      await removeLabel(gh, issueN, L.trigger);
      return quiet();
    }
    let resume = null;
    for (const p of ours.filter((x) => x.state === "open")) {
      const m = readMarker(p.body);
      if (!resume && m?.approval_hash === approval.hash) {
        resume = { pr_number: p.number, head_ref: p.head.ref, head_sha: p.head.sha, findings: m.findings || [], ci_log: await failedCiLog(gh, full, p.head.sha) };
      } else {
        await comment(pr, p.number, `承認の記録が変わったので、この PR を閉じる。新しい実行が、新しいブランチで最初からやり直す。\n\n${marker("closed")}`);
        await pr.patch(`/repos/${full}/pulls/${p.number}`, { state: "closed" });
      }
    }

    await recordApproval(gh, issueN, approval, [input("github_token"), await tokens.get()]);
    await removeLabel(gh, issueN, L.draft);
    const head = await pr.get(`/repos/${full}/commits/${encodeURIComponent(branch)}`);
    setOutput("base_commit", head.sha);
    setOutput("approval", approval);
    setOutput("resume", resume ? resume : "");
    setOutput("proceed", "true");
    setOutput("done", "false");
    log(`開始の確認: 進めてよい（${resume ? "続きから進める" : "最初から"}）`);
  } catch (e) {
    if (e instanceof Halt) return stop(e.reason, e.details);
    throw e;
  } finally {
    await tokens?.revoke();
  }
}

/** 導入する側の前提を確かめる。足りないものの一覧を返す */
async function checkSettings(pr, { full, branch, owner, repo }) {
  const missing = [];
  const info = await pr.get(`/repos/${full}`);
  if (!info.allow_auto_merge) missing.push("リポジトリの設定で auto-merge が有効になっていない");
  const method = input("merge_method", "squash");
  const allowed = { squash: info.allow_squash_merge, merge: info.allow_merge_commit, rebase: info.allow_rebase_merge }[method];
  if (!allowed) missing.push(`マージの方法 ${method} が、リポジトリの設定で許可されていない`);
  const wp = await pr.get(`/repos/${full}/actions/permissions/workflow`);
  if (wp.default_workflow_permissions !== "read") missing.push("ワークフローの GITHUB_TOKEN の既定の権限が、読み取りになっていない");
  if (wp.can_approve_pull_request_reviews) missing.push("GitHub Actions に PR の作成と承認を許している");
  let required = false;
  let signatures = false;
  let queue = false;
  const rules = (await pr.get(`/repos/${full}/rules/branches/${encodeURIComponent(branch)}`, { allow404: true })) || [];
  for (const r of rules) {
    if (r.type === "required_status_checks" && (r.parameters?.required_status_checks || []).length) required = true;
    if (r.type === "required_signatures") signatures = true;
    if (r.type === "merge_queue") queue = true;
  }
  const prot = await pr.get(`/repos/${full}/branches/${encodeURIComponent(branch)}/protection`, { allow404: true });
  if (prot) {
    const rs = prot.required_status_checks;
    if (rs && ((rs.contexts || []).length || (rs.checks || []).length)) required = true;
    if (prot.required_signatures?.enabled) signatures = true;
  }
  const mq = await pr.graphql(`query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){mergeQueue(branch:$b){id}}}`, { o: owner, r: repo, b: branch });
  if (mq.repository.mergeQueue) queue = true;
  if (!required) missing.push(`マージ先のブランチ ${branch} に、必須のステータスチェックが無い`);
  if (signatures) missing.push("署名付きのコミットの必須がある（対応しない）");
  if (queue) missing.push("マージキューがある（対応しない）");
  return missing;
}

async function ensureLabels(gh, full, L) {
  const have = new Set((await gh.paginate(`/repos/${full}/labels`)).map((l) => l.name));
  const colors = { [L.draft]: "c5def5", [L.trigger]: "0e8a16", [L.escalation]: "d93f0b" };
  for (const name of [L.draft, L.trigger, L.escalation]) {
    if (!have.has(name)) await gh.post(`/repos/${full}/labels`, { name, color: colors[name] });
  }
}

/** 承認の記録を組み立てる。halt を返したら、実行せずに人に引き継ぐ */
async function buildApproval(gh, { d, labeler, labeledAt, full, branch, issueN, L }) {
  const halt = (reason, details) => ({ halt: { reason, details } });
  const title = stripInvisible(d.title);
  const formCriteria = formField(d.body, "完了条件");
  const author = d.author?.login;
  if (formCriteria && labeler === author) {
    // 完了条件を人が書いた Issue（テンプレート）── Issue を書いて出すことが承認を兼ねる
    if (d.lastEditedAt && new Date(d.lastEditedAt) > labeledAt) return halt("cannot_start", "起動ラベルを付けたあとに、承認の対象（Issue の本文）が編集された");
    const oos = formField(d.body, "今回やらないこと");
    const a = {
      issue: issueN, title, source: "template", labeled_by: labeler, labeled_at: labeledAt.toISOString(),
      criteria: formLines(formCriteria), out_of_scope: oos ? formLines(oos) : [],
    };
    a.hash = approvalHash(a);
    return a;
  }
  const comments = await gh.paginate(`/repos/${full}/issues/${issueN}/comments`);
  const drafts = comments.filter((c) => c.user?.login === "github-actions[bot]" && readMarker(c.body)?.kind === "draft");
  if (drafts.some((c) => new Date(c.created_at) > labeledAt)) return halt("cannot_start", "起動ラベルを付けたあとに、新しい下書きが書かれた");
  const last = drafts.filter((c) => new Date(c.created_at) < labeledAt).at(-1);
  if (!last) {
    return halt("cannot_start", `承認する完了条件が無い。下書きラベル（${L.draft}）を付ければ、下書きを始める`);
  }
  const m = readMarker(last.body);
  const drun = await gh.get(`/repos/${full}/actions/runs/${Number(m.run_id)}`, { allow404: true });
  const wf = input("draft_workflow", "merge-while-you-sleep-draft.yml");
  const runPath = String(drun?.path || "").replace(/@.*$/, "");
  if (!drun || runPath !== `.github/workflows/${wf}` || !["issues", "issue_comment"].includes(drun.event) || drun.head_branch !== branch || drun.repository?.full_name !== full) {
    return halt("cannot_start", "下書きのコメントが、下書き用のワークフローのものと確かめられない");
  }
  const arts = await gh.get(`/repos/${full}/actions/runs/${drun.id}/artifacts?per_page=100`);
  const art = (arts.artifacts || []).find((a) => a.name === "merge-while-you-sleep-draft" && !a.expired);
  if (!art) return halt("cannot_start", "下書きの artifact が期限で消えた。下書きラベルを付け直せば、新しい下書きから始められる");
  let rec;
  try {
    rec = JSON.parse(unzipEntry(await downloadArtifact(gh, art.id), "draft.json").toString("utf8"));
  } catch {
    return halt("cannot_start", "下書きの artifact を読めない");
  }
  if (rec.comment_id !== last.id || rec.body_sha256 !== sha256(last.body)) return halt("cannot_start", "下書きの artifact が、下書きのコメントと合わない");
  const edited = await gh.graphql(`query($id:ID!){node(id:$id){... on IssueComment{lastEditedAt}}}`, { id: last.node_id });
  if (edited.node?.lastEditedAt && new Date(edited.node.lastEditedAt) > labeledAt) {
    return halt("cannot_start", "起動ラベルを付けたあとに、承認の対象（下書きのコメント）が編集された");
  }
  if (!Array.isArray(m.criteria) || m.criteria.length === 0) return halt("cannot_start", "承認する完了条件が無い（下書きに完了条件が無い）");
  const a = {
    issue: issueN, title, source: "draft", labeled_by: labeler, labeled_at: labeledAt.toISOString(), draft_comment_id: last.id,
    criteria: m.criteria.map(stripInvisible), out_of_scope: (m.out_of_scope || []).map(stripInvisible),
  };
  a.hash = approvalHash(a);
  return a;
}

async function recordApproval(gh, issueN, a, secrets = []) {
  const body = [
    "## 承認の記録",
    "",
    `起動ラベルを付けた人: ${a.labeled_by}（${a.labeled_at}）。これより後の工程は、この記録だけを採点の基準にする。`,
    "",
    "### タイトル",
    "",
    codeBlock(a.title),
    "",
    "### 完了条件",
    "",
    codeBlock(scrubSecrets(a.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n"), secrets)),
    "",
    "### 今回やらないこと",
    "",
    codeBlock(scrubSecrets(a.out_of_scope.map((c) => `- ${c}`).join("\n") || "なし", secrets)),
    "",
    marker("approval", { hash: a.hash }),
  ].join("\n");
  await comment(gh, issueN, body);
}

/** 落ちた CI のログの末尾（続きから進めるときに、信頼できないデータとして Claude Code に渡す） */
async function failedCiLog(gh, full, sha) {
  try {
    const runs = await gh.get(`/repos/${full}/actions/runs?head_sha=${sha}&per_page=50`);
    const out = [];
    for (const r of (runs.workflow_runs || []).filter((x) => x.conclusion === "failure")) {
      const jobs = await gh.get(`/repos/${full}/actions/runs/${r.id}/jobs?per_page=50`);
      for (const j of (jobs.jobs || []).filter((x) => x.conclusion === "failure")) {
        const res = await gh.raw("GET", `/repos/${full}/actions/jobs/${j.id}/logs`);
        const loc = res.headers.get("location");
        if (!loc) continue;
        const t = await (await fetch(loc)).text();
        out.push(`## ${r.name} / ${j.name}\n${t.split("\n").slice(-150).join("\n")}`);
      }
    }
    return out.join("\n\n").slice(-30000);
  } catch {
    return "";
  }
}

// ---------- 入り口 ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  modePreflight().catch((e) => {
    log(`止まった: ${e instanceof Halt ? REASONS[e.reason].title : "予期しない失敗"}`);
    process.exitCode = 1;
  });
}
