// App のトークン（PR 用トークン）で確かめること（試験用のリポジトリだけに置く）
//   mhc: --match-head-commit（expectedHeadOid）が、予約のあと、マージする時点でも照らされるか
//   ub-create: main に .github/workflows の変更が入る前の PR を2つ作る
//   ub-update: main の変更のあと、update-branch と、main を取り込んだマージのコミットの push ができるか
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { makeTokenSource } from "../actions/merge-while-you-sleep/shared/pr-token.mjs";

const mode = process.env.MODE;
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const full = `${owner}/${repo}`;
const out = (k, v) => console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
const tokens = makeTokenSource({
  clientId: process.env.APP_CLIENT_ID, privateKey: process.env.APP_PRIVATE_KEY,
  permissions: { contents: "write", pull_requests: "write", actions: "write" },
});
const gh = await tokens.gh();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `${process.env.GITHUB_RUN_ID}`;

async function branchFromMain(name) {
  const main = await gh.get(`/repos/${full}/git/ref/heads/main`);
  await gh.post(`/repos/${full}/git/refs`, { ref: `refs/heads/${name}`, sha: main.object.sha });
}
async function putFile(branch, path, text) {
  const cur = await gh.get(`/repos/${full}/contents/${path}?ref=${branch}`, { allow404: true });
  const r = await gh.put(`/repos/${full}/contents/${path}`, { branch, message: `probe: ${path}`, content: Buffer.from(text).toString("base64"), ...(cur ? { sha: cur.sha } : {}) });
  return r.commit.sha;
}
async function prState(number) {
  const d = await gh.graphql(`query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){id state merged headRefOid autoMergeRequest{enabledAt}}}}`, { o: owner, r: repo, n: number });
  return d.repository.pullRequest;
}

try {
  if (mode === "mhc") {
    const br = `probe/mhc-${tag}`;
    await branchFromMain(br);
    const sha1 = await putFile(br, `probe-notes/mhc-${tag}.txt`, "1\n");
    const pr = await gh.post(`/repos/${full}/pulls`, { title: `probe mhc ${tag}`, head: br, base: "main", body: "match-head-commit の確認用" });
    out("mhc.pr", pr.number);
    const st = await prState(pr.number);
    await gh.graphql(`mutation($id:ID!,$h:GitObjectID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH,expectedHeadOid:$h}){clientMutationId}}`, { id: st.id, h: sha1 });
    out("mhc.enabled_with", sha1.slice(0, 7));
    const sha2 = await putFile(br, `probe-notes/mhc-${tag}.txt`, "2\n");
    out("mhc.pushed", sha2.slice(0, 7));
    for (let i = 0; i < 40; i++) {
      await sleep(15000);
      const s = await prState(pr.number);
      const checks = await gh.get(`/repos/${full}/commits/${sha2}/check-runs`);
      const ci = checks.check_runs.find((c) => c.name === "ci");
      out(`mhc.t${i}`, { state: s.state, merged: s.merged, head: s.headRefOid.slice(0, 7), automerge: !!s.autoMergeRequest, ci: ci ? `${ci.status}/${ci.conclusion}` : "none" });
      if (s.merged || (ci?.status === "completed" && i > 6)) break;
    }
    const ev = await gh.get(`/repos/${full}/issues/${pr.number}/events`);
    out("mhc.events", ev.map((e) => e.event));
  }
  if (mode === "ub-create") {
    for (const k of ["api", "push"]) {
      const br = `probe/ub-${k}-${tag}`;
      await branchFromMain(br);
      await putFile(br, `probe-notes/ub-${k}-${tag}.txt`, "x\n");
      const pr = await gh.post(`/repos/${full}/pulls`, { title: `probe ub-${k} ${tag}`, head: br, base: "main", body: "update-branch の確認用" });
      out(`ub-create.${k}`, `${pr.number} ${br}`);
    }
  }
  if (mode === "ub-update") {
    const prs = (await gh.get(`/repos/${full}/pulls?state=open&per_page=50`)).filter((p) => p.head.ref.startsWith("probe/ub-"));
    for (const p of prs) {
      if (p.head.ref.startsWith("probe/ub-api-")) {
        try {
          const r = await gh.put(`/repos/${full}/pulls/${p.number}/update-branch`, { expected_head_sha: p.head.sha });
          out("ub-update.api", { ok: true, message: r?.message });
        } catch (e) {
          out("ub-update.api", { ok: false, status: e.status, message: e.data?.message });
        }
        await sleep(5000);
        const after = await gh.get(`/repos/${full}/pulls/${p.number}`);
        out("ub-update.api_head_changed", after.head.sha !== p.head.sha);
      }
      if (p.head.ref.startsWith("probe/ub-push-")) {
        const dir = mkdtempSync(join(process.env.RUNNER_TEMP, "ub-"));
        const tok = await tokens.get();
        const auth = Buffer.from(`x-access-token:${tok}`).toString("base64");
        const git = (...a) => execFileSync("git", ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`, ...a], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        git("init", "-q");
        git("remote", "add", "origin", `https://github.com/${full}.git`);
        git("fetch", "-q", "origin", "main", p.head.ref);
        git("checkout", "-q", "-b", "w", `origin/${p.head.ref}`);
        git("-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "merge", "-q", "--no-edit", "origin/main");
        out("ub-update.merge_touches_workflows", git("diff", "--name-only", `origin/${p.head.ref}`, "HEAD").split("\n").filter((f) => f.startsWith(".github/workflows/")));
        try {
          git("push", "-q", "origin", `HEAD:refs/heads/${p.head.ref}`);
          out("ub-update.push", { ok: true });
        } catch (e) {
          out("ub-update.push", { ok: false, stderr: String(e.stderr).replace(/basic [A-Za-z0-9+/=]+/g, "basic <略>").slice(0, 300) });
        }
      }
    }
  }
} finally {
  await tokens.revoke();
}
