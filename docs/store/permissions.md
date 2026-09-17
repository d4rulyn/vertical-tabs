# Chrome Web Store — permission justifications

The dashboard asks for a justification per permission, and rejects a listing whose
permissions do not follow from its stated single purpose. Each answer below is written to
be checkable against the code, because a reviewer can read it.

**Single purpose**: show the browser's open tabs as a vertical list in the side panel,
each with a preview image of the page, and let the user manage those tabs from it.

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
- `tests/specs/22-widgets.spec.js` asserts zero network requests with every feature on.

## `scripting`

> Used for exactly one call: reading `window.scrollY` from the tab being captured, so the
> preview can be kept on the top of the page. Chrome restores a page's scroll offset when
> it reloads, so without this a reload half way down an article replaces a recognisable
> preview of the header with a band of body text. The injected function returns a number
> and changes nothing on the page. It is `background/capture.js`'s `viewportPosition()`.

## `tabs`

> The list is the product. This permission is what makes `url`, `title` and `favIconUrl`
> readable on a tab object; without it Chrome returns them empty and there is nothing to
> draw. It is also what the reorder, close, pin, mute and activate actions use.

## `tabGroups`

> Chrome's tab groups are rendered in the list as collapsible coloured sections, and the
> "group by site" tool creates one group per host. Reading a group's title and colour, and
> creating or updating a group, both require this permission.

## `sessions`

> The panel offers a list of recently closed tabs and restores them —
> `chrome.sessions.getRecentlyClosed` and `chrome.sessions.restore`.

## `storage` and `unlimitedStorage`

> `storage` holds the user's settings and small pieces of panel state. `unlimitedStorage`
> applies to the preview cache in IndexedDB: screenshots are larger than the default quota
> comfortably allows, and without it Chrome may evict the cache, which shows up to the
> user as previews disappearing for no reason. Nothing is stored anywhere but locally.

## `favicon`

> Draws each tab's site icon from Chrome's own favicon database (`chrome://favicon2`)
> rather than fetching `tab.favIconUrl` over the network. This is a privacy improvement,
> not a convenience: fetching the page-declared icon URL would send a credentialed request
> to that site every time the panel draws a row, including for tabs in the closed-tab
> list. See the comment above `applyFavicon()` in `sidepanel/render.js`.

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

---

## Ready to paste into the dashboard

The dashboard caps each justification at 1,000 characters, so these are the trimmed
versions of the sections above. Every character count is under the cap.

### 単一用途 (Single purpose)

```
Show the browser's open tabs as a vertical list in the side panel, each with a preview image of the page, and let the user manage those tabs from it.
```

### ホスト権限 が必要な理由 (host_permissions: <all_urls>)

```
The core feature is a preview image of each open tab, produced with chrome.tabs.captureVisibleTab. Chrome refuses that call unless the extension holds access to the page being captured, and a tab can be on any site, so the capability has to cover all of them.

The extension does not read, inject into, or modify page content. The only two things it does with this access are: ask Chrome for a screenshot of the tab the user is already looking at, and read window.scrollY so the preview can be kept on the top of the page.

background/capture.js is the only caller of captureVisibleTab. It never captures an incognito tab, a minimised window, or a host the user excluded in settings. No content scripts are declared. Captured images are downscaled and stored in local IndexedDB; they are never transmitted. The extension makes no network requests of any kind.
```

### scripting

```
Used for exactly one call: reading window.scrollY from the tab being captured, so the preview can be kept on the top of the page. Chrome restores a page's scroll offset when it reloads, so without this, reloading half way down an article replaces a recognisable preview of the header with a band of body text.

The injected function is defined inside the extension package (background/capture.js, viewportPosition()). It returns a number and changes nothing on the page. No remote or generated code is involved.
```

### tabs

```
The tab list is the product. This permission is what makes url, title and favIconUrl readable on a tab object; without it Chrome returns them empty and there is nothing to draw. It also backs the reorder, close, pin, mute and activate actions the panel offers.
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
storage holds the user's settings and small pieces of panel state. unlimitedStorage applies to the preview cache in IndexedDB: screenshots are larger than the default quota comfortably allows, and without it Chrome may evict the cache, which the user sees as previews disappearing for no reason. Nothing is stored anywhere but locally.
```

### favicon

```
Draws each tab's site icon from Chrome's own favicon database rather than fetching the page-declared favIconUrl over the network. This is a privacy measure: fetching that URL would send a credentialed request to the site every time the panel draws a row.
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
The extension collects nothing and transmits nothing.
