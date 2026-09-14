# Chrome Web Store — listing copy

Everything the Developer Dashboard asks for, ready to paste. Fill the publisher display
name in the dashboard (**Account → Publisher display name**); it is set per account and
does not have to match the GitHub owner.

The store shows one listing per language. Set **English** as the default and add
**日本語** as an additional locale; the extension already ships both.

---

## Single purpose

The dashboard requires one sentence, and a listing whose permissions do not follow from
it is rejected. This is the sentence everything else has to be consistent with:

> Show the browser's open tabs as a vertical list in the side panel, each with a preview
> image of the page, and let the user manage those tabs from it.

---

## English

**Name** (45 char limit)

```
Vertical Tabs
```

**Short description** (132 char limit — this one is 125)

```
A vertical tab list in Chrome's side panel, with a preview image of every page. Find, group and tidy tabs without leaving it.
```

**Category**: Workflow & Planning
**Language**: English

**Detailed description**

```
Chrome stacks tabs horizontally until the titles disappear. This puts them in a vertical
list in the side panel instead, and gives every tab a picture of the page it is showing,
so you recognise a tab by what is on it rather than by a favicon you have seen forty
times.

WHAT THE PREVIEW SHOWS IS YOUR CHOICE

A preview is a photograph of the visible part of a page, and Chrome puts you back where
you were when a page reloads — so a preview taken then can be a band of body text that
identifies nothing. You pick what happens:

• The top of the page (default) — the preview stays on the header, the part that makes a
  page recognisable at a glance.
• What it showed when it loaded — frozen until you navigate again.
• Wherever you are on the page — the preview follows you.

MANAGING TABS, NOT JUST LISTING THEM

• Search across titles and URLs — including tabs in your other windows, with one click
  to go there.
• Group by site: file loose tabs into one tab group per host, with undo.
• Lock a tab so nothing in the panel can close it by accident.
• A command palette on Ctrl+Shift+P for everything the panel can do, by name.
• Recently used tabs, in the order you were actually on them.
• Find duplicates, hibernate tabs you have not touched in days, save a set of tabs to
  reopen later, copy the window out as a Markdown list, open a pasted list of links, and
  keep a note that survives a restart.
• Drag to reorder, pin, group, or move a tab to another window. Full keyboard control.
• One to five columns, adjustable card size, light and dark themes, English and Japanese.
• Detach the list into a window of its own when you want it narrower than Chrome's side
  panel allows.

IT DOES NOT TALK TO ANYTHING

No servers, no analytics, no accounts, no network requests of any kind. Previews are
stored on your own machine and never leave it. An automated test asserts that every part
of the extension makes zero network requests, so this stays true rather than quietly
rotting.

WHAT IT NEEDS, AND WHY

Taking a picture of a page requires Chrome's permission to access that page — there is no
narrower way to do it. After installing, open chrome://extensions, click Details, and set
Site access to "On all sites", or no previews can be produced at all.

Requires Chrome 120 or later. The side panel's position (left or right) and its minimum
width are Chrome's settings, not the extension's.
```

---

## 日本語

**名前**

```
縦型タブ
```

**簡単な説明**（132 文字以内）

```
Chrome のサイドパネルにタブを縦一列で表示し、それぞれにページのプレビューを添えます。検索・グループ化・整理もここで完結します。
```

**カテゴリ**: ワークフローと計画
**言語**: 日本語

**詳しい説明**

```
Chrome はタブを横に並べ続け、やがてタイトルが読めなくなります。この拡張はタブをサイド
パネルに縦一列で並べ、さらに各タブへ「そのページの見た目」を添えます。何十回と見た同じ
ファビコンではなく、ページそのものでタブを見分けられます。

プレビューが何を写すかは選べます

プレビューはページの見えている部分を撮ったものです。再読み込みすると Chrome は元の
スクロール位置に戻すため、そこで撮ると本文の途中だけが写り、何のページか分からなく
なります。挙動を選べます。

・ページの先頭（既定）— 見出しが写った状態を保ちます。一目で見分けがつくのはここです。
・読み込んだときの表示 — 次に移動するまで固定されます。
・いま見ている位置 — 読んでいる場所に追従します。

並べるだけでなく、片づけられます

・タイトルと URL の検索。他のウィンドウにあるタブも出て、クリックでそこへ移動します。
・サイトごとの自動グループ化。取り消し付き。
・タブのロック。パネルの操作では閉じられなくなります。
・コマンドパレット（Ctrl+Shift+P）。パネルでできることを名前で探して実行します。
・最近使ったタブを、実際に見ていた順で。
・重複タブの検出、数日触っていないタブの休止、タブの保存と復元、一覧の Markdown 書き出し、
  貼り付けたリンクの一括オープン、再起動しても残るメモ。
・ドラッグで並べ替え・ピン留め・グループ化・別ウィンドウへ移動。キーボードだけでも操作できます。
・列数 1〜5、カード幅の調整、ライト／ダークテーマ、日本語と英語。
・Chrome のサイドパネルより細くしたいときは、別ウィンドウに切り離せます。

どこにも通信しません

サーバーもアナリティクスもアカウントもなく、ネットワーク通信を一切行いません。プレビューは
お使いの端末内にのみ保存され、外に出ることはありません。全機能を表示した状態で通信が
ゼロであることを自動テストで検証しているので、この約束は黙って形骸化しません。

必要な権限について

ページを撮影するには、そのページへのアクセス権が必要です。これより狭い方法はありません。
インストール後に chrome://extensions → 詳細 → 「サイトへのアクセス」を「すべてのサイト」に
してください。ここを設定しないとプレビューは 1 枚も作成されません。

Chrome 120 以降が必要です。サイドパネルの左右と最小幅は Chrome 側の設定で、拡張からは
変更できません。
```

---

## Assets the dashboard requires

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `extension/icons/icon128.png` — ready |
| Screenshot (1–5) | **1280×800** or 640×400 PNG | `docs/store/screenshots/` — generated, see below |
| Small promo tile | 440×280 PNG | optional; only needed to be featured |
| Marquee promo tile | 1400×560 PNG | optional |

Screenshots are regenerated with:

```
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml run --rm e2e \
  playwright test specs/31-store-shots.spec.js --reporter=line
```

## Fields that are a decision, not copy

- **Publisher display name** — the name buyers see. Set in Account settings.
- **Privacy policy URL** — required, because the extension requests host permissions. The
  text is `docs/privacy.html`; it needs to be reachable at a public URL (GitHub Pages on
  the repository serves it once the repository is public).
- **Support/contact email** — the dashboard requires a verified address. It is shown on
  the listing, so use one intended to be public.
