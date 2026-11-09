// shared/pr-token.mjs — PR 用トークン（GitHub App のインストールトークン）の発行と取り消し
//
// 開始の確認と提出のジョブだけが使う。Claude Code を呼ぶジョブには App の秘密鍵を渡さない（DESIGN.md の提出を別のジョブにする）

import { createSign } from "node:crypto";
import { input, mask } from "./actions.mjs";
import { Halt } from "./escalation.mjs";
import { makeGitHub, repoFromEnv } from "./github.mjs";

// ---------- PR 用トークン ----------


/** App の秘密鍵で JWT を作る（RS256、期限は10分より短く）*/
export function appJwt(clientId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  const body = enc({ iat: now - 60, exp: now + 540, iss: clientId });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/** 使うたびに発行する PR 用トークン。1時間の期限より前に発行し直す */
export function makeTokenSource({ token, clientId, privateKey, permissions }) {
  const { owner, repo } = repoFromEnv();
  let cached = null;
  let owner_login = null;
  return {
    async get() {
      if (token) return token;
      if (cached && cached.until > Date.now()) return cached.token;
      const jwt = appJwt(clientId, privateKey);
      const app = makeGitHub(jwt);
      const inst = await app.get(`/repos/${owner}/${repo}/installation`);
      const t = await app.post(`/app/installations/${inst.id}/access_tokens`, { repositories: [repo], permissions });
      mask(t.token);
      cached = { token: t.token, until: Date.now() + 45 * 60000 };
      return t.token;
    },
    /** PR 用トークンの持ち主（App なら App の bot のアカウント、個人用アクセストークンなら発行した人） */
    async login() {
      if (owner_login) return owner_login;
      if (token) owner_login = (await makeGitHub(token).get("/user")).login;
      else owner_login = `${(await makeGitHub(appJwt(clientId, privateKey)).get("/app")).slug}[bot]`;
      return owner_login;
    },
    async gh() {
      return makeGitHub(await this.get());
    },
    async revoke() {
      if (token || !cached) return;
      try {
        await makeGitHub(cached.token).del("/installation/token");
      } catch {}
    },
  };
}

export function tokenSourceFromInputs(permissions) {
  const token = input("token");
  const clientId = input("app_client_id");
  const privateKey = input("app_private_key");
  if (token) mask(token);
  if (!token && (!clientId || !privateKey)) throw new Halt("cannot_start", "PR 用トークンを発行できない（app_client_id と app_private_key か、token が要る）");
  return makeTokenSource({ token, clientId, privateKey, permissions });
}
