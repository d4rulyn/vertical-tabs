# Chrome Web Store — permission justifications

The dashboard asks for a justification per permission, and rejects a listing whose
permissions do not follow from its stated single purpose. Each answer below is written to
be checkable against the code, because a reviewer can read it.

**Single purpose**: show, in the side panel, the lists a user opens a page from — the
browser's open tabs as a vertical list with a preview image of each page and the controls
to manage them, and, in the column beside it, the user's saved bookmarks when they choose
that layout, as a list to browse, to open from, and to add the current tab to.

**単一用途（参考訳）**: ブラウザで開いているタブを、ページのプレビュー画像と操作を添えた
縦一列のリストとしてサイドパネルに表示し、その横の列には、ユーザーがそのレイアウトを
選んだときだけ、保存したブックマークを、たどって開いたり現在のタブを追加したりできる
一覧として表示する — 次に開くページを選ぶための場所です。

> This sentence was widened for the bookmarks update. It used to name only the tab list,
> and a bookmarks permission does not follow from that. See `resubmission-note.md` in this
> directory for what that means for the review.

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
> button to grant it; `chrome.permissions.request` is the first statement of that button's
> click handler, in the panel document, because Chrome requires a user gesture. Once
> granted, the extension **reads** the tree to draw the list — `chrome.bookmarks.get` and
> `getChildren`, one folder at a time — and **writes** in exactly one place:
> the "bookmark this tab" button, which calls `chrome.bookmarks.create` with the current
> tab's URL and title. There is no rename, no delete, no move and no drag-and-drop.
> Nothing read is sent anywhere, because the extension makes no network requests at all.
> The user can revoke it from `chrome://extensions` at any time; the extension listens on
> `chrome.permissions.onRemoved` and the column returns to the grant card.

Supporting facts a reviewer can verify:

- `manifest.json` lists `bookmarks` under `optional_permissions`, and nowhere else.
- Every call goes through one wrapper, `bm()` in `sidepanel/bookmarks.js`, which reaches
  the API by computed member access (`chrome.bookmarks[method](...)`) so that the revoke
  backstop sits in one place. A grep for `chrome.bookmarks.` therefore returns only the
  five event registrations, and neither proves nor disproves anything about the methods.
  What to read instead is `grep -n "bm('" extension/sidepanel/bookmarks.js`: six call
  sites, using `getChildren`, `get` and `create`, and `create` is the only one that
  mutates. There is no `remove`, `removeTree`, `update`, `move` or `search`.
- `grep -rn "bookmarks" extension/background/` returns nothing. Every bookmark call and
  every bookmark listener lives in the panel document, which is where Chrome will accept
  a permission request and where a listener can be registered after a grant.
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
> folder it was left in. `unlimitedStorage` applies to the preview cache in IndexedDB:
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
bookmark title or URL is copied into the extension's own storage or anywhere else. The one
thing kept is the id of the folder the column was left in, in `chrome.storage.session`, so
reopening the panel returns the reader to where they were; it dies with the browser. The
one write goes back into Chrome's bookmark tree, where the user can see it. Nothing leaves
the device, so there is nothing to declare as collected.

---

## Ready to paste into the dashboard

The dashboard caps each justification at 1,000 characters, so these are the trimmed
versions of the sections above. Every character count is under the cap.

### 単一用途 (Single purpose)

```
Show, in the side panel, the lists a user opens a page from: the browser's open tabs as a vertical list with a preview image of each page and the controls to manage them, and, in the column beside it, the user's saved bookmarks when they choose that layout, as a list to browse, to open from, and to add the current tab to.
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

The column beside the tab list shows tab tools by default. Switching it to bookmarks draws a card explaining the permission and a grant button; chrome.permissions.request is that handler's first statement, in the panel document.

Granted, it reads one folder at a time to draw the list; getTree and search are never called. It writes in one place: the "bookmark this tab" button, which calls chrome.bookmarks.create with the current tab's URL and title. No rename, no delete, no move, no drag-and-drop. Every call goes through one wrapper, bm() in sidepanel/bookmarks.js: grep "bm('" there for all six call sites, using getChildren, get and create only.

Nothing read is sent anywhere; the extension makes no network requests. A revoke in chrome://extensions is watched by chrome.permissions.onRemoved, and the column returns to the card.
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
storage holds the user's settings and small pieces of panel state: which tools the side column shows, whether that column is showing tools or bookmarks, and which bookmark folder it was left in. unlimitedStorage applies to the preview cache in IndexedDB: screenshots are larger than the default quota comfortably allows, and without it Chrome may evict the cache, which the user sees as previews disappearing for no reason. Nothing is stored anywhere but locally.
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
