# README screenshots

The images embedded above the fold in [`README.md`](../../README.md) and
[`README.ja.md`](../../README.ja.md) are served from this directory. They are the only
visual evidence in the project for the two things it exists to do — a **vertical tab list
on the right**, and a **preview on every tab** — so a missing file here shows up as a
broken image on the repository's front page and behind the panel's own
*Settings → Documentation (README)* link.

| file | used as | produced by |
| --- | --- | --- |
| `10-showcase-dark.png` | lead image: the DEFAULT one column, dark theme, 380 px panel | `tests/specs/10-showcase.spec.js` |
| `10-showcase-light.png` | left cell of the two-column table: one column, light theme | the same spec |
| `10-showcase-grid.png` | right cell of the two-column table: three columns, 560 px panel | the same spec |

`10-showcase-list.png` comes out of the same run (two columns). Neither README embeds it;
copy it here as well if you want to reference it.

The lead image must show the default a user gets on a fresh profile. When the default
column count moves, regenerate these before shipping — a stale lead image advertises a
layout the product no longer has.

## Regenerating them

`tests/output/` is git-ignored, so the spec's output has to be copied here afterwards.
Everything runs in the test container — nothing is installed on the host. From the
repository root:

```bash
HOST_UID=$(id -u) HOST_GID=$(id -g) \
  docker compose -f tests/docker-compose.yml run --rm e2e \
  playwright test specs/10-showcase.spec.js --reporter=line

cp tests/output/screenshots/10-showcase-dark.png \
   tests/output/screenshots/10-showcase-light.png \
   tests/output/screenshots/10-showcase-grid.png \
   docs/screenshots/
```

Then commit `docs/screenshots/*.png` by name.

Redo this after any change to `extension/sidepanel/sidepanel.css` or to the card markup in
`extension/sidepanel/render.js`: a stale screenshot advertises a layout the extension no
longer has. `tests/specs/15-list-scroll.spec.js` guards the layout property these images
are supposed to demonstrate (a long list scrolls; it does not squeeze the previews away),
but it cannot tell you that the pictures are out of date.

---

## 日本語

このディレクトリの画像は [`README.md`](../../README.md) と
[`README.ja.md`](../../README.ja.md) の冒頭で参照されます。本拡張機能の 2 つの要件
（**右側の縦型タブ一覧**と**全タブのプレビュー**）を示す唯一の視覚的証拠なので、
ファイルが無いとリポジトリの先頭とパネルの *設定 → ドキュメント (README)* リンク先が
画像切れになります。

生成はテストコンテナ内で行います（ホストには何もインストールしません）。上のコマンドを
リポジトリのルートで実行し、`docs/screenshots/*.png` をファイル名を指定して commit して
ください。`extension/sidepanel/sidepanel.css` やカードのマークアップを変更したら必ず
撮り直してください。
