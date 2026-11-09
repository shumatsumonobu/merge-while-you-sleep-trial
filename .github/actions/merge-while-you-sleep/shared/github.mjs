// shared/github.mjs — GitHub の API の呼び方、イベント、ラベルの名前、権限とラベルのイベントの確かめ

import { readFileSync } from "node:fs";

// ---------- GitHub の API ----------


/**
 * GitHub の REST と GraphQL を呼ぶ。トークンは呼ぶ側が渡す ── 子プロセスには渡さない
 */
export function makeGitHub(token, { apiUrl = process.env.GITHUB_API_URL || "https://api.github.com", fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "merge-while-you-sleep",
  };
  async function request(method, path, body, { allow404 = false, raw = false } = {}) {
    const url = path.startsWith("http") ? path : `${apiUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, {
        method,
        headers: body !== undefined ? { ...headers, "content-type": "application/json" } : headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: raw ? "manual" : "follow",
      });
      if (raw) return res;
      if (res.status === 404 && allow404) return null;
      if ((res.status >= 500 || res.status === 429) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      const text = await res.text();
      const data = text ? safeJson(text) : null;
      if (!res.ok) {
        const e = new Error(`GitHub API ${method} ${path.split("?")[0]} が ${res.status} で失敗`);
        e.status = res.status;
        e.data = data;
        throw e;
      }
      return data;
    }
  }
  async function paginate(path) {
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await request("GET", `${path}${sep}per_page=100&page=${page}`);
      const items = Array.isArray(data) ? data : data?.workflow_runs || data?.artifacts || data?.jobs || data?.labels || [];
      all.push(...items);
      if (items.length < 100) break;
    }
    return all;
  }
  async function graphql(query, variables = {}) {
    const data = await request("POST", "/graphql", { query, variables });
    if (data?.errors?.length) {
      const e = new Error(`GitHub GraphQL が失敗: ${data.errors.map((x) => x.type || "error").join(",")}`);
      e.data = data;
      throw e;
    }
    return data.data;
  }
  return {
    get: (p, o) => request("GET", p, undefined, o),
    post: (p, b, o) => request("POST", p, b, o),
    patch: (p, b, o) => request("PATCH", p, b, o),
    put: (p, b, o) => request("PUT", p, b, o),
    del: (p, o) => request("DELETE", p, undefined, o),
    raw: (m, p, o) => request(m, p, undefined, { ...o, raw: true }),
    paginate,
    graphql,
  };
}

function safeJson(t) {
  try {
    return JSON.parse(t);
  } catch {
    return { message: "JSON ではない応答" };
  }
}

export function repoFromEnv() {
  const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "/").split("/");
  return { owner, repo, full: `${owner}/${repo}` };
}

export function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p) return {};
  return JSON.parse(readFileSync(p, "utf8"));
}

export function runUrl() {
  const { full } = repoFromEnv();
  return `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${full}/actions/runs/${process.env.GITHUB_RUN_ID}`;
}

// ---------- ラベルと変数 ----------


export function labels() {
  return {
    draft: process.env.MERGE_WHILE_YOU_SLEEP_DRAFT_LABEL || "merge-while-you-sleep: draft",
    trigger: process.env.MERGE_WHILE_YOU_SLEEP_TRIGGER_LABEL || "merge-while-you-sleep: run",
    escalation: process.env.MERGE_WHILE_YOU_SLEEP_ESCALATION_LABEL || "merge-while-you-sleep: needs-human",
  };
}

// ---------- 権限とラベルのイベント ----------


/** 権限を確かめる。write（admin か write）、triage、none のどれか（DESIGN.md の下書きの始め方） */
export async function permissionOf(gh, login, cache = new Map()) {
  if (cache.has(login)) return cache.get(login);
  const { full } = repoFromEnv();
  let level = "none";
  try {
    const p = await gh.get(`/repos/${full}/collaborators/${encodeURIComponent(login)}/permission`);
    if (p.permission === "admin" || p.permission === "write") level = "write";
    else if (p.role_name === "triage") level = "triage";
  } catch {}
  cache.set(login, level);
  return level;
}

export const atLeastTriage = (l) => l === "write" || l === "triage";

/** 今の起動ラベルを付けた LabeledEvent が、この実行を起こしたものと同じなら、起動ラベルを外す一覧を返す */
export async function triggerLabelIfOurs(gh, issue, L) {
  try {
    const { owner, repo } = repoFromEnv();
    const run = await gh.get(`/repos/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`);
    const ev = await latestLabeledEvent(gh, issue, L.trigger);
    if (ev && new Date(ev.createdAt) > new Date(run.created_at)) return [];
  } catch {}
  return [L.trigger];
}

export async function latestLabeledEvent(gh, issue, labelName) {
  const { owner, repo } = repoFromEnv();
  const q = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){timelineItems(itemTypes:[LABELED_EVENT],last:100){nodes{... on LabeledEvent{createdAt actor{login} label{name}}}}}}}`;
  const d = await gh.graphql(q, { o: owner, r: repo, n: issue });
  const nodes = d.repository.issue.timelineItems.nodes.filter((n) => n.label?.name === labelName);
  return nodes.at(-1) || null;
}
