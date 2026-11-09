// shared/paths.mjs — パスのパターン（テストのファイル、変えさせないファイル、依存の定義、必ず外すファイル）と、CLAUDE.md と AGENTS.md の @ の取り込み

import { splitList } from "./actions.mjs";

// ---------- パターン ----------


/**
 * パターンを正規表現にする。`**` は0個以上の階層、`*` と `?` は `/` を越えない。
 * パターンは作業ディレクトリの根から合わせる。どの階層でも合わせるときは、先頭を「2つのアスタリスクとスラッシュ」にする
 */
export function globToRegExp(pattern, { nocase = false } = {}) {
  let p = pattern.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (p.endsWith("/")) p += "**";
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const slashAfter = p[i + 2] === "/";
        const atStart = i === 0 || p[i - 1] === "/";
        if (atStart && slashAfter) {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, nocase ? "i" : "");
}

export function matcher(patterns, opts) {
  const res = patterns.map((p) => globToRegExp(p, opts));
  return (path) => res.some((r) => r.test(path));
}

/** テストのファイルの既定のパターン（DESIGN.md のゲートの節） */
export const DEFAULT_TEST_PATHS = [
  "**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/spec/**", "**/__tests__/**",
  "**/test_*.*", "**/*_test.*", "**/*_spec.*", "**/*Test.*", "**/*Tests.*",
  "**/__snapshots__/**", "**/*.snap", "**/testdata/**", "**/fixtures/**", "**/__fixtures__/**",
  "**/testing/**", "**/test-utils.*", "**/test_utils.*", "**/testUtils.*", "**/*.cy.*",
];

/** 変えさせないファイル（必ず外すファイルのうち、Claude Code の振る舞いとワークフローを決めるもの） */
export const PROTECTED_PATHS = [
  "**/.github/**", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/**", "**/.mcp.json",
];

/** 依存とスクリプトの定義 ── 続きから進めるときに、PR のブランチで変わっていたら人に引き継ぐ */
export const DEPENDENCY_PATHS = [
  "**/package.json", "**/package-lock.json", "**/npm-shrinkwrap.json", "**/yarn.lock", "**/pnpm-lock.yaml",
  "**/pnpm-workspace.yaml", "**/bun.lock", "**/bun.lockb", "**/.npmrc", "**/.yarnrc", "**/.yarnrc.*", "**/.pnpmfile.cjs",
  "**/requirements*.txt", "**/constraints*.txt", "**/pyproject.toml", "**/setup.cfg", "**/setup.py",
  "**/Pipfile", "**/Pipfile.lock", "**/poetry.lock", "**/uv.lock",
  "**/go.mod", "**/go.sum", "**/go.work", "**/go.work.sum",
  "**/Cargo.toml", "**/Cargo.lock", "**/rust-toolchain", "**/rust-toolchain.toml",
  "**/Gemfile", "**/Gemfile.lock", "**/*.gemspec", "**/composer.json", "**/composer.lock",
  "**/pom.xml", "**/build.gradle", "**/build.gradle.kts", "**/settings.gradle", "**/settings.gradle.kts",
  "**/gradle.properties", "**/gradle/wrapper/**", "**/gradlew", "**/gradlew.bat",
  "**/Makefile", "**/makefile", "**/GNUmakefile", "**/*.mk", "**/justfile", "**/Justfile", "**/Taskfile.yml", "**/Taskfile.yaml",
  "**/.nvmrc", "**/.node-version", "**/.python-version", "**/.tool-versions",
];

/** 必ず外すファイル（どの階層にあっても外す。足せるが、減らせない）── DESIGN.md の自動マージの範囲 */
export const FIXED_DENY_PATHS = [
  ...PROTECTED_PATHS,
  "**/CODEOWNERS",
  // テストの設定と、全部のテストに効くファイル
  "**/jest.config.*", "**/jest.preset.*", "**/vitest.config.*", "**/vitest.workspace.*", "**/pytest.ini", "**/.pytest.ini",
  "**/conftest.py", "**/sitecustomize.py", "**/usercustomize.py", "**/.mocharc", "**/.mocharc.*",
  "**/setupTests.*", "**/jest.setup.*", "**/vitest.setup.*", "**/__mocks__/**", "**/vite.config.*",
  "**/tox.ini", "**/noxfile.py", "**/playwright.config.*", "**/cypress.config.*", "**/karma.conf.*",
  "**/babel.config.*", "**/.babelrc", "**/.babelrc.*", "**/.cargo/config", "**/.cargo/config.toml",
  "**/.coveragerc", "**/.nycrc", "**/.nycrc.*", "**/.c8rc", "**/.c8rc.*",
  "**/stryker.conf.*", "**/.stryker.conf.*", "**/stryker.config.*", "**/.stryker.config.*", "**/.cargo/mutants.toml",
  "**/phpunit.xml", "**/phpunit.xml.dist", "**/.rspec",
  // lint と型検査の設定
  "**/eslint.config.*", "**/.eslintrc", "**/.eslintrc.*", "**/.eslintignore", "**/tsconfig*.json", "**/jsconfig*.json",
  "**/mypy.ini", "**/.mypy.ini", "**/ruff.toml", "**/.ruff.toml", "**/.flake8", "**/.pylintrc", "**/pylintrc",
  "**/biome.json", "**/biome.jsonc", "**/.golangci.*", "**/clippy.toml", "**/.clippy.toml",
  "**/deno.json", "**/deno.jsonc",
  ...DEPENDENCY_PATHS,
  // git の設定
  "**/.gitattributes", "**/.gitmodules",
];

// ---------- CLAUDE.md と AGENTS.md の @ の取り込み ----------


/**
 * 本文から @ の取り込み先を拾う。コードブロックとインラインのコードの中は除く（Memory のページ）
 * @returns {string[]} 書かれたままのパス
 */
export function extractImports(text) {
  const out = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.replace(/`[^`]*`/g, " ");
    for (const m of line.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s`'"()<>[\]{}]+)/g)) {
      const p = m[1].replace(/[.,;:!?]+$/, "");
      if (p && !p.includes("@")) out.push(p);
    }
  }
  return out;
}

/** 取り込み元のファイルのパスから、取り込み先を作業ディレクトリの根からのパスにする。外を指すものは null */
export function resolveImport(fromFile, target) {
  if (target.startsWith("~/") || target.startsWith("/")) return null;
  const parts = fromFile.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

// ---------- ラベルと変数 ----------

export function testPaths() {
  const v = splitList(process.env.MERGE_WHILE_YOU_SLEEP_TEST_PATHS);
  return v.length ? v : DEFAULT_TEST_PATHS;
}
