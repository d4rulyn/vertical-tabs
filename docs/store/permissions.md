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
