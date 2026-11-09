// cleanup/cleanup.mjs — 終わりの確認の action の本体
//
// ほかのジョブが、引き継ぎも提出の完了もせずに終わったとき、人に引き継ぐ

import { pathToFileURL } from "node:url";
import { input, log } from "../shared/actions.mjs";
import { escalate } from "../shared/escalation.mjs";
import { labels, latestLabeledEvent, makeGitHub, readEvent, repoFromEnv, triggerLabelIfOurs } from "../shared/github.mjs";

// ---------- 終わりの確認 ----------


async function modeCleanup() {
  const needs = JSON.parse(input("needs", "{}"));
  const target = input("target", "run");
  const gh = makeGitHub(input("github_token"));
  const L = labels();
  const ev = readEvent();
  const issueN = ev.issue?.number;
  const jobs = Object.values(needs);
  if (!issueN || jobs.length === 0) return;
  if (jobs.every((j) => j.result === "skipped")) return;
  if (jobs.some((j) => j.outputs?.done === "true")) return;
  let mention = ev.sender?.login;
  let details = "ジョブが、引き継ぎも提出の完了もせずに終わった";
  const results = Object.entries(needs).map(([k, j]) => `${k}: ${j.result}`).join("、");
  details += `（${results}）`;
  if (target === "run") {
    try {
      const approval = JSON.parse(needs.preflight?.outputs?.approval || "null");
      if (approval?.labeled_by) mention = approval.labeled_by;
    } catch {}
    if (needs.submit && needs.submit.result !== "skipped") {
      const { owner, full } = repoFromEnv();
      const branch = `merge-while-you-sleep/issue-${issueN}-${process.env.GITHUB_RUN_ID}`;
      try {
        let resumeN = null;
        try {
          resumeN = JSON.parse(needs.preflight?.outputs?.resume || "null")?.pr_number ?? null;
        } catch {}
        const n = Number(needs.submit.outputs?.pr_number) || resumeN;
        const pr = n ? await gh.get(`/repos/${full}/pulls/${n}`) : (await gh.get(`/repos/${full}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}`))[0];
        if (pr) details += `\n\nPR: #${pr.number}（自動マージの予約: ${pr.auto_merge ? "あり。CI が通るとマージされる" : "なし"}）`;
      } catch {}
    }
    await escalate(gh, { issue: issueN, reason: "interrupted", mention, details, removeLabels: await triggerLabelIfOurs(gh, issueN, L) });
  } else {
    try {
      const e = await latestLabeledEvent(gh, issueN, L.draft);
      if (e?.actor?.login) mention = e.actor.login;
    } catch {}
    await escalate(gh, { issue: issueN, reason: "interrupted", mention, details, removeLabels: [L.draft] });
  }
}

// ---------- 入り口 ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  modeCleanup().catch(() => {
    log("止まった: 予期しない失敗");
    process.exitCode = 1;
  });
}
