# merge-while-you-sleep-trial

[merge-while-you-sleep](https://github.com/shumatsumonobu/merge-while-you-sleep) を導入した、試験用のリポジトリ。GitHub の runner の上で、骨格の動きを確かめるために使う。試験が終わったら、結果と導入の例を merge-while-you-sleep に移し、このリポジトリは消す

- `src/`、`test/`: 試験で Issue に書く材料になる、小さいライブラリとそのテスト
- `.github/actions/merge-while-you-sleep/`: merge-while-you-sleep の action 一式のコピー。ワークフローは、このリポジトリのコミットの SHA で指定する
- `.github/workflows/merge-while-you-sleep-*.yml`、`.github/ISSUE_TEMPLATE/`: merge-while-you-sleep の examples/ のコピー
- `.github/workflows/ci.yml`: 必須のステータスチェックにするテスト
