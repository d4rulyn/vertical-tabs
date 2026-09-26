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

> Show, in the side panel, the lists a user opens a page from — the browser's open tabs as
> a vertical list with a preview image of each page and the controls to manage them, and,
> in the column beside it, the user's saved bookmarks when they choose that layout, as a
> list to browse, to open from, and to add the current tab to.

参考訳（ダッシュボードに入れるのは上の英文ひとつ）:

> ブラウザで開いているタブを、ページのプレビュー画像と操作を添えた縦一列のリストとして
> サイドパネルに表示し、その横の列には、ユーザーがそのレイアウトを選んだときだけ、保存した
> ブックマークを、たどって開いたり現在のタブを追加したりできる一覧として表示する —
> 次に開くページを選ぶための場所です。

It was widened for the bookmarks update; the old wording named only the tab list.
`permissions.md` justifies each permission against this sentence, and
`resubmission-note.md` records what the change means for the review.

---

## English

**Name** (45 char limit)

```
Vertical Tabs
```

**Short description** (132 char limit — this one is 129)

```
A vertical tab list in Chrome's side panel, with a preview image of every page. Find and tidy tabs, or browse bookmarks, from it.
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

BOOKMARKS IN THAT COLUMN INSTEAD, IF YOU WANT THEM

The column beside the tab list holds those tools by default. Switch it to bookmarks and it
becomes your own folders, one level at a time: click a row to open it, see a dot on
anything already open in a tab, and press one button to bookmark the tab you are on.
Chrome asks for the bookmarks permission at that moment rather than at install, and you
can refuse it or take it back later. The extension reads your bookmarks to draw the list
and does nothing else with them — no renaming, no deleting, no reordering. Switch back and
your tools return exactly as you had them.

IT DOES NOT TALK TO ANYTHING

No servers, no analytics, no accounts, no network requests of any kind. Previews are
stored on your own machine and never leave it. Bookmarks are no different: they are read
out of Chrome, drawn on the screen, and never copied anywhere. An automated test asserts
that every part of the extension makes zero network requests, so this stays true rather
than quietly rotting.

WHAT IT NEEDS, AND WHY

Taking a picture of a page requires Chrome's permission to access that page — there is no
narrower way to do it. After installing, open chrome://extensions, click Details, and set
Site access to "On all sites", or no previews can be produced at all.

The bookmarks column is the only part that asks for anything beyond that, and it asks the
first time you switch to it, not at install. Say no and everything else works unchanged;
say yes and you can still take it back from chrome://extensions, which puts the column
back to asking.

Requires Chrome 120 or later. The side panel's position (left or right) and its minimum
width are Chrome's settings, not the extension's.
```

---

## 日本語

**名前**

```
縦型タブ
```

**簡単な説明**（132 文字以内 — この文は 70 文字）

```
Chrome のサイドパネルにタブを縦一列で表示し、それぞれにページのプレビューを添えます。横の列はツールとブックマークを切り替えられます。
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

同じ列にブックマークも出せます（切り替え式）

タブ一覧の横にある列は、既定ではいま挙げたツールが並びます。ここをブックマークに切り替えると、
自分のフォルダを一段ずつたどって開ける一覧になります。クリックで開き、すでに開いているページには
印が付き、「このタブを追加」ボタンひとつで今見ているページを保存できます。ブックマークの権限を
Chrome が尋ねるのは切り替えたそのときで、インストール時ではありません。断ることも、後から
取り消すこともできます。拡張が行うのは一覧を描くための読み取りだけで、名前の変更・削除・
並べ替えはしません。ツールに戻せば、選んでいたツールがそのまま復活します。

どこにも通信しません

サーバーもアナリティクスもアカウントもなく、ネットワーク通信を一切行いません。プレビューは
お使いの端末内にのみ保存され、外に出ることはありません。ブックマークも同じで、Chrome から
読んで画面に描くだけです。どこにも送りませんし、コピーも残しません。全機能を表示した状態で
通信がゼロであることを自動テストで検証しているので、この約束は黙って形骸化しません。

必要な権限について

ページを撮影するには、そのページへのアクセス権が必要です。これより狭い方法はありません。
インストール後に chrome://extensions → 詳細 → 「サイトへのアクセス」を「すべてのサイト」に
してください。ここを設定しないとプレビューは 1 枚も作成されません。

これ以外に権限を求めるのはブックマーク列だけで、初めて切り替えたときに尋ねます。断っても
他の機能はそのまま使えますし、許可した後でも chrome://extensions から取り消せます。

Chrome 120 以降が必要です。サイドパネルの左右と最小幅は Chrome 側の設定で、拡張からは
変更できません。
```

---

## Assets the dashboard requires

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128×128 PNG | `extension/icons/icon128.png` — ready |
| Screenshot (1–5) | **1280×800** or 640×400 PNG | `docs/store/screenshots/en/` and `/ja/` — four each. A screenshot carries its own words, so upload them per language under *Localized assets*, not under *assets for all languages* |
| Small promo tile | 440×280 PNG | optional; only needed to be featured |
| Marquee promo tile | 1400×560 PNG | optional |

Screenshots are regenerated with:

```
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose -f tests/docker-compose.yml run --rm e2e \
  playwright test specs/31-store-shots.spec.js --reporter=line
```

## Fields that are a decision, not copy

- **Publisher display name** — the name buyers see. Set in Account settings.
- **Privacy policy URL** — required, because the extension requests host permissions.
  Paste this, it is live:

  ```
  https://d4rulyn.github.io/vertical-tabs/privacy.html
  ```

  It is `docs/privacy.html` served by GitHub Pages from `main`. Editing that file and
  pushing updates the URL; nothing else has to be re-submitted for a policy wording
  change.
- **Support/contact email** — the dashboard requires a verified address. It is shown on
  the listing, so use one intended to be public.
