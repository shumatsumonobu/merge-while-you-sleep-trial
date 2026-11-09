// shared/defaults.mjs — 工程ごとのモデルと、上限の既定値（DESIGN.md のモデルの節と、上限と繰り返しの検知の節）



// ---------- 既定値 ----------


export const MODELS = {
  draft: "opus", plan: "opus", write_tests: "opus", implement: "sonnet", fix: "sonnet", resolve_conflicts: "sonnet", review: "opus",
};

export const LIMITS = {
  max_rounds: 3, // レビュー → 修正の往復
  max_same_finding: 2, // 同じ ID の指摘が続けて「残っている」
  max_gate_failures: 3, // 1回の往復の中で、ゲートの失敗 → 修正
  max_test_returns: 1, // テスト作成に戻す
  max_draft_questions: 5, // 下書きの質問
  max_cost_usd: 15, // 1回の実行のコスト（Claude Code の推定）
  max_work_minutes: 120, // 作業のジョブの時間
  max_draft_minutes: 20, // 下書きのジョブの時間
  max_draft_cost_usd: 2, // 1回の下書きのコスト
};
