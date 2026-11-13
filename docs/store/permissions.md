# Chrome Web Store — permission justifications

The dashboard asks for a justification per permission, and rejects a listing whose
permissions do not follow from its stated single purpose. Each answer below is written to
be checkable against the code, because a reviewer can read it.

**Single purpose**: show, in the side panel, the lists a user opens a page from — the
browser's open tabs as a vertical list with a preview image of each page and the controls
to manage them, and, in the column beside it, the user's saved bookmarks when they choose
that layout, as a list to browse, to open from, to add the current tab to, and to organise:
create folders, rename, reorder and move bookmarks and folders.

**単一用途（参考訳）**: ブラウザで開いているタブを、ページのプレビュー画像と操作を添えた
縦一列のリストとしてサイドパネルに表示し、その横の列には、ユーザーがそのレイアウトを
選んだときだけ、保存したブックマークを、たどって開いたり、現在のタブを追加したり、
フォルダの作成・名前の変更・並べ替え・移動で整理したりできる一覧として表示する —
次に開くページを選ぶための場所です。

> This sentence was widened for the bookmarks update. It used to name only the tab list,
> and a bookmarks permission does not follow from that. See `resubmission-note.md` in this
> directory for what that means for the review. It was widened a second time for 1.3.0, by
> the clause "and to organise: create folders, rename, reorder and move bookmarks and
> folders", which is the whole of what the 1.3.0 column adds. Deleting, searching and
> editing a bookmark's address are not in it, because the column does none of them.

---

## `host_permissions: <all_urls>` — the one that gets scrutiny

> The extension's core feature is a preview image of each open tab, produced with
> `chrome.tabs.captureVisibleTab`. Chrome refuses that call unless the extension holds
> access to the page being captured, and a tab can be on any site, so the capability has
> to cover all of them. The extension does not read, inject into, or modify page content
> anywhere: the only thing it does with this access is ask Chrome for a screenshot of the
> tab the user is already looking at, and read `window.scrollY` (see `scripting` below).
> Captured images are downscaled and stored in local IndexedDB. They are never
> transmitted — the extension makes no network requests of any kind.

Supporting facts a reviewer can verify:

- `background/capture.js` is the only caller of `captureVisibleTab`, and never calls it
  for an incognito tab, a minimised window, or a host the user excluded in settings.
- No `content_scripts` are declared.
- `tests/specs/22-widgets.spec.js` asserts zero network requests with every tool mounted,
  and `tests/specs/32-bookmarks-rail.spec.js` asserts the same for the panel with a
  bookmark folder and its favicons on screen (22-widgets runs in the default `tools`
  layout, so it does not reach the bookmark column).
- The second half of the single purpose does **not** rest on this permission. The
  bookmarks column never touches a web page: it reads the bookmark tree through the
  optional `bookmarks` permission and draws its row icons from Chrome's own favicon
  database. Revoking host access would cost the previews and nothing else.

## `optional_permissions: bookmarks` — asked for at runtime, never at install

> Declared in `optional_permissions`, not in `permissions`. It is **not** requested when
> the extension is installed, and a user who never opens the bookmarks layout is never
> asked for it at all: ungranted, `chrome.bookmarks` is `undefined` and
> `chrome.permissions.contains({permissions:['bookmarks']})` is `false`. The column beside
> the tab list shows the tab tools by default (`settings.railMode` is `'tools'`).
> Switching it to bookmarks draws a card explaining what the permission is for and a
> button to grant it; the button's click handler calls `askForPermission()` synchronously
> and `chrome.permissions.request` is the first statement of that function, in the panel
> document, because Chrome requires a user gesture. Once
> granted, the extension **reads** the tree to draw the list — `chrome.bookmarks.getChildren`,
> one folder at a time, and `get` to look at a node before a write needs it — and **writes**
> only when the user presses a button or acts on a row they are looking at: the "bookmark
> this tab" button and a new folder (`chrome.bookmarks.create`, with the current tab's URL
> and title, or with the folder title in the name field: what the user typed, or the
> default "New folder" if Enter is pressed on it untouched); a rename, from F2
> or the row menu (`update`, the title only); and a move (`move`): inside a folder by
> dragging the row, by the row menu's Move up / Move down, or by Alt+ArrowUp /
> Alt+ArrowDown, and into another folder by dragging the row there or by the row menu's
> Move to…, which puts it at the end of the folder chosen. There is no delete,
> no search and no edit of an address, and no drag-and-drop between the bookmark list and
> the tab list.
> Nothing read is sent anywhere, because the extension makes no network requests at all.
> The user can revoke it from `chrome://extensions` at any time; the extension listens on
> `chrome.permissions.onRemoved` and the column returns to the grant card.

Supporting facts a reviewer can verify:

- `manifest.json` lists `bookmarks` under `optional_permissions`, and nowhere else.
- Every call goes through one wrapper, `bm()` in `sidepanel/bookmarks.js`, which reaches
  the API by computed member access (`chrome.bookmarks[method](...)`) so that the revoke
  backstop sits in one place. A grep for `chrome.bookmarks.` therefore returns only the
  five event registrations and two comments, and neither proves nor disproves anything
  about the methods.
  What to read instead is `grep -rn "bm('" extension/`: the call sites are `getChildren`
  and `create` in `sidepanel/bookmarks.js`, and `get`, `getChildren`, `create`, `update`
  and `move` in `sidepanel/bookmark-write.js`, plus one line of prose in that file's header
  comment. The set of names is exactly `{getChildren, get, create, update, move}`, and
  `tests/unit/bookmark-claims.test.mjs` reads the source and fails if any other name
  appears. `create`, `update` and `move` mutate. There is no `remove`, `removeTree`,
  `search`, `getTree`, `getRecent` or `getSubTree`. (For the 1.2.0 package, whose only
  call sites were `getChildren` and `create`, see `resubmission-note.md`.)
- `grep -rn "bookmarks" extension/background/` returns two lines, both in
  `service-worker.js`: a doc comment and the string comparison `name !== 'bookmarks'`,
  which only stops pressing Allow on the bookmarks card from triggering a preview re-scan.
  The worker never calls `chrome.bookmarks`. (Corrected 2026-11-04: this said "returns
  nothing".) Every bookmark call and every bookmark listener lives in the panel document,
  which is where Chrome will accept a permission request and where a listener can be
  registered after a grant.
- The code never gates on `if (chrome.bookmarks)`. After a revoke that object stays alive
  and throws on use, so the gate is `await chrome.permissions.contains(...)`.
- `chrome.bookmarks.getTree` is never called: it reads the whole tree at once (measured at
  59 ms and 1 MB on a 5,041-node profile), and the list only ever needs one folder.

## `scripting`

> Used for exactly one call: reading `window.scrollY` from the tab being captured, so the
> preview can be kept on the top of the page. Chrome restores a page's scroll offset when
> it reloads, so without this a reload half way down an article replaces a recognisable
> preview of the header with a band of body text. The injected function returns a number
> and changes nothing on the page. It is `background/capture.js`'s `viewportPosition()`.

## `tabs`

> The tab list is the larger half of the product. This permission is what makes `url`,
> `title` and `favIconUrl` readable on a tab object; without it Chrome returns them empty
> and there is nothing to draw. It is also what the reorder, close, pin, mute and activate
> actions use, what lets a bookmark row show a dot when that page is already open in a
> tab, and what supplies the URL and title that "bookmark this tab" saves.

## `tabGroups`

> Chrome's tab groups are rendered in the list as collapsible coloured sections, and the
> "group by site" tool creates one group per host. Reading a group's title and colour, and
> creating or updating a group, both require this permission.

## `sessions`

> The panel offers a list of recently closed tabs and restores them —
> `chrome.sessions.getRecentlyClosed` and `chrome.sessions.restore`.

## `storage` and `unlimitedStorage`

> `storage` holds the user's settings and small pieces of panel state — which tools the
> column shows, whether that column is showing tools or bookmarks, and which bookmark
> folders were open (ids, not titles). `unlimitedStorage` applies to the preview cache in IndexedDB:
> screenshots are larger than the default quota comfortably allows, and without it Chrome
> may evict the cache, which shows up to the user as previews disappearing for no reason.
> Nothing is stored anywhere but locally.

## `favicon`

> Draws the site icon for each row — a tab's, and a bookmark's — from Chrome's own favicon
> database rather than fetching an icon URL over the network. This is a privacy
> improvement, not a convenience: fetching the page-declared icon URL would send a
> credentialed request to that site every time the panel draws a row, including for tabs
> in the closed-tab list and for bookmarks the user has not opened in years. The endpoint
> is `chrome-extension://<id>/_favicon/?pageUrl=…`, which Chrome answers locally even for a
> URL this profile has never visited — that is what makes a years-old bookmark drawable
> without touching the network. See the comment above `applyFavicon()` in
> `sidepanel/render.js`.

## `sidePanel`

> The extension is a side panel. This is the API that puts it there.

## `alarms`

> Two periodic jobs: refreshing the visible tab's preview at the interval the user chose,
> and a maintenance pass that prunes stale entries from the preview cache. A service
> worker cannot hold a timer across its own shutdown, which is what alarms are for.

---

## Data use disclosure

The dashboard asks you to tick what the extension collects. **Tick nothing**, and certify:

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

The extension collects nothing, transmits nothing, and has no server. Screenshots,
settings and notes stay in the profile's own storage and are deleted with the extension.

Bookmarks do not change that answer. They are read out of Chrome and drawn on screen; no
bookmark title or URL is copied into the extension's own storage or anywhere else. What is
kept is the ids of the open folders, the id of the folder the add button aims at, and the
scroll offset (ids and a number, no titles or URLs), in `chrome.storage.session`, so
reopening the panel returns the reader to where they were; it dies with the browser. Every
write goes back into Chrome's bookmark tree, where the user can see it: the bookmark a
button adds, a folder the user creates (typed name, or the default "New folder"), a name the user changes, the place a row is moved
to. Nothing leaves the device, so there is nothing to declare as collected.

---

## Ready to paste into the dashboard

The dashboard caps each justification at 1,000 characters, so these are the trimmed
versions of the sections above. Every character count is under the cap.

### 単一用途 (Single purpose)

```
Show, in the side panel, the lists a user opens a page from: the browser's open tabs as a vertical list with a preview image of each page and the controls to manage them, and, in the column beside it, the user's saved bookmarks when they choose that layout, as a list to browse, to open from, to add the current tab to, and to organise: create folders, rename, reorder and move bookmarks and folders.
```

### ホスト権限 が必要な理由 (host_permissions: <all_urls>)

```
The core feature is a preview image of each open tab, produced with chrome.tabs.captureVisibleTab. Chrome refuses that call unless the extension holds access to the page being captured, and a tab can be on any site, so the capability has to cover all of them.

The extension does not read, inject into, or modify page content. The only two things it does with this access are: ask Chrome for a screenshot of the tab the user is already looking at, and read window.scrollY so the preview can be kept on the top of the page.

background/capture.js is the only caller of captureVisibleTab. It never captures an incognito tab, a minimised window, or a host the user excluded in settings. No content scripts are declared. Captured images are downscaled and stored in local IndexedDB; they are never transmitted. The extension makes no network requests of any kind.

The optional bookmarks column does not use host access at all.
```

### bookmarks (optional)

```
Optional: declared in optional_permissions, not permissions, and never requested at install. Ungranted, chrome.bookmarks is undefined and nothing changes.

The column shows tab tools by default. Switching it to bookmarks draws a card and a grant button; the click handler calls askForPermission(), whose first statement is chrome.permissions.request.

Granted, it reads one folder at a time. It writes only on a button press or a row action: "bookmark this tab" and a new folder, typed or default name (create), a rename (update, title only), a move (move) by drag, the menu's Move up/down/to, or Alt+Arrow. No delete, no search, no edit of an address, no getTree. Every call goes through one wrapper, bm() in bookmarks.js: grep -rn "bm('" extension/ lists them; the names are exactly getChildren, get, create, update, move.

Nothing is sent anywhere: no network requests. A revoke in chrome://extensions is watched by chrome.permissions.onRemoved, and the column returns to the card.
```

### scripting

```
Used for exactly one call: reading window.scrollY from the tab being captured, so the preview can be kept on the top of the page. Chrome restores a page's scroll offset when it reloads, so without this, reloading half way down an article replaces a recognisable preview of the header with a band of body text.

The injected function is defined inside the extension package (background/capture.js, viewportPosition()). It returns a number and changes nothing on the page. No remote or generated code is involved.
```

### tabs

```
The tab list is the larger half of the product. This permission is what makes url, title and favIconUrl readable on a tab object; without it Chrome returns them empty and there is nothing to draw. It also backs the reorder, close, pin, mute and activate actions the panel offers, lets a bookmark row show a dot when that page is already open, and supplies the URL and title that "bookmark this tab" saves.
```

### tabGroups

```
Chrome's tab groups are rendered in the list as collapsible coloured sections, and the "group by site" tool creates one group per host. Reading a group's title and colour, and creating or updating a group, both require this permission.
```

### sessions

```
The panel shows a list of recently closed tabs and restores them, using chrome.sessions.getRecentlyClosed and chrome.sessions.restore.
```

### storage / unlimitedStorage

```
storage holds the user's settings and small pieces of panel state: which tools the side column shows, whether that column is showing tools or bookmarks, and which bookmark folders were open (ids, not titles). unlimitedStorage applies to the preview cache in IndexedDB: screenshots are larger than the default quota comfortably allows, and without it Chrome may evict the cache, which the user sees as previews disappearing for no reason. Nothing is stored anywhere but locally.
```

### favicon

```
Draws the site icon for each row — a tab's, and a bookmark's — from Chrome's own favicon database rather than fetching an icon URL over the network. This is a privacy measure: fetching the page-declared URL would send a credentialed request to the site every time the panel draws a row, including for bookmarks the user has not opened in years. The endpoint is chrome-extension://<id>/_favicon/?pageUrl=..., which Chrome answers locally even for a URL the profile has never visited.
```

### sidePanel

```
The extension is a side panel. This is the API that puts it there.
```

### alarms

```
Two periodic jobs: refreshing the visible tab's preview at the interval the user chose, and a maintenance pass that prunes stale entries from the preview cache. A service worker cannot hold a timer across its own shutdown, which is what alarms are for.
```

### リモートコードを使用していますか？

**いいえ、リモートコードを使用していません。**

Verified in the source rather than assumed:

- no `eval()`, `new Function`, `WebAssembly` or `importScripts` anywhere in `extension/`
- the only `<script src>` tags are `sidepanel.js` and `welcome.js`, both inside the package
- the one dynamic `import()` iterates a hard-coded list of relative paths inside the package
- `scripting.executeScript` is called with `func:` — a function defined in
  `background/capture.js` — never with a file from elsewhere and never with a string
- no custom `content_security_policy`, so MV3's default applies and `eval` is refused

### データ使用

Tick **nothing** in the list, then tick all three certifications: no sale or transfer to
third parties, no use unrelated to the single purpose, no creditworthiness or lending use.
The extension collects nothing and transmits nothing — including the bookmarks it reads,
which are drawn on screen and never copied anywhere.
