# Why this update needs a full re-review

Short version: **the single purpose changed**, so this is not a routine version bump. The
listing has to be resubmitted and reviewed against a sentence the store has not seen
before. This was a deliberate decision, not an accident of wording, and this file exists so
that whoever handles the review afterwards knows why.

## What changed

The published listing declared:

> Show the browser's open tabs as a vertical list in the side panel, each with a preview
> image of the page, and let the user manage those tabs from it.

A `bookmarks` permission does not follow from that sentence. The dashboard rejects a
listing whose permissions do not follow from its stated single purpose, so quietly adding
the permission under the old wording was not an option. The new sentence is in
`permissions.md` and `listing.md`, and it names the one thing both halves have in common:
the panel is where you go to open a page, whether the page is already in a tab or saved as
a bookmark.

The permission itself is **optional** — declared in `optional_permissions`, requested at
runtime from a grant card in the bookmarks column, never at install. That is a weaker ask
than the store's install-time prompt, but it does not exempt the listing from the single
purpose rule, because the permission is still declared in the manifest.

## The part that may cost time: `<all_urls>`

`<all_urls>` was already the permission that gets the most scrutiny, and it was approved
against the old single purpose. Reopening the single purpose reopens everything justified
against it, so expect the host permission to be looked at again from scratch. **This was
weighed and accepted before the rewrite.**

The argument has not weakened, and the file now says so explicitly: host access pays for
the previews and nothing else. The bookmarks column never touches a web page. It reads the
bookmark tree through the optional permission and draws its icons from Chrome's own favicon
database, so if a reviewer removed `<all_urls>` entirely, the bookmarks half would still
work and only the previews would be lost. That is the sentence to point at if the question
comes back.

The two arguments repaired at the same time, because the rewrite made them incomplete
rather than wrong:

- **`tabs`** — it now also supplies the URL and title that "bookmark this tab" saves, and
  the match that puts a dot on a bookmark row whose page is already open.
- **`favicon`** — it now draws bookmark row icons as well as tab icons. Chrome's
  `_favicon/` endpoint answers for a URL the profile has never visited, which is what makes
  a long-dormant bookmark drawable without a network request.

`storage` gained a clause for the two new pieces of state (which layout the column is in,
and which bookmark folder it was left in). Every other justification is unchanged.

## Checklist before resubmitting

- [x] Bump `version` in `extension/manifest.json` above the published version. (The
      dashboard showed the published version as `1.0.0` on 2026-11-04, not `1.1.0`; the
      package being uploaded is `1.2.0`.)
- [x] Re-run the three greps the `bookmarks` justification invites a reviewer to run, on
      the package you are about to upload, not on this branch mid-implementation. Run on
      the contents of `vertical-tabs-1.2.0.zip` on 2026-11-04: `grep -rn "chrome\.bookmarks\." extension/`
      prints one comment and the five event registrations, no `create`/`update`/`move`/`remove`
      (the calls go through `bm()`, so read `grep -n "bm('" extension/sidepanel/bookmarks.js`:
      two call sites, `getChildren` and `create`); `grep -rn "bookmarks" extension/background/`
      prints two lines in `service-worker.js`, a comment and the comparison
      `name !== 'bookmarks'` (it is **not** empty, and the justification no longer says it is); and
      `grep -n "bookmarks" extension/manifest.json` prints one line, `optional_permissions`.
      If any of the three has stopped being true, fix the code or fix the justification —
      do not ship a claim a reviewer can disprove in one command.
- [ ] Paste the new single purpose from `permissions.md` → *Ready to paste* → 単一用途.
- [ ] Add the `bookmarks` justification. The dashboard shows a field for an optional
      permission only once it is in the uploaded package, so upload the ZIP first.
- [ ] Re-paste the `<all_urls>`, `tabs`, `favicon` and `storage` justifications — all four
      changed wording.
- [ ] Update both store descriptions from `listing.md`; the bookmarks column is described
      in the English and the Japanese copy.
- [ ] Data use: still tick nothing. Bookmarks are read and drawn, never copied or sent.
- [ ] Screenshots: the existing four per language still show the tools layout, which is
      still the default. A bookmarks-column shot is optional and not part of this change.
- [ ] `docs/privacy.html` is served from `main` and can be edited without resubmitting, but
      its 権限について section describes only the host permission. Add the optional
      bookmarks permission to it before the update goes live.

## If the review comes back

The likely question is why a tab extension reads bookmarks. The answer that is checkable
in the package: the column is one surface with two layouts, the permission is optional and
requested from a button in that column, the only write is `chrome.bookmarks.create` behind
a button labelled for it, and `grep -rn "chrome\.bookmarks\." extension/` shows no
`remove`, `update` or `move` anywhere in the tree.

---

# 1.3.0 addendum (2026-11-10): the bookmarks column can now organise

Everything above describes the **1.2.0 package that is in review**, and it stays true of
that package: none of it was rewritten. This section is what is different for a reviewer
who is looking at 1.3.0. If 1.3.0 replaces 1.2.0, the sentences above no longer describe
the package being reviewed, and this section does. The last paragraph above ("no `remove`,
`update` or `move` anywhere in the tree") is false for 1.3.0. The grep it names prints no
call of `remove`, `update` or `move` (only one comment that names `chrome.bookmarks.move`),
because every call goes through the `bm()` wrapper and that grep never saw the method
names; the greps below are the ones that do.

## What changed for the reviewer

- **No new permission, no new host, no new content-security-policy entry.** `bookmarks` is
  still only in `optional_permissions`, still asked for from the grant card in the column,
  never at install. `contextMenus` is still not requested: the row menu is the panel's own
  DOM. The manifest changes by its `version` and nothing else (the bump is its own commit).
- **The single purpose is widened by one clause**: "…as a list to browse, to open from, to
  add the current tab to, and to organise: create folders, rename, reorder and move
  bookmarks and folders." The sentence is in `permissions.md` and `listing.md`, and the
  *Ready to paste* single purpose and `bookmarks` justification in `permissions.md` are
  rewritten to match, so re-paste both. Deleting, searching and editing an address are not
  in the sentence because the column does none of them.
- **The extension now writes in more places, each one something the user does: pressing a
  button, or acting on a row.**
  Three calls are new (`get`, `update`, `move`) and `create` also makes folders:

  | The user does | The call |
  | --- | --- |
  | Draws the list (unchanged) | `getChildren` |
  | Presses *Bookmark this tab* (unchanged) | `create` with the tab's URL and title |
  | Makes a new folder (header button, or the row menu) | `create` with the folder title in the name field (what the user typed, or the default "New folder" when Enter is pressed on it untouched), after a `get` of the bookmark it goes beside when it goes beside one |
  | Renames a bookmark or a folder (F2, or the row menu) | `update`, `{ title }` only |
  | Moves a row inside its folder (drag, *Move up* / *Move down*, Alt+ArrowUp / Alt+ArrowDown) | `get` of the row, `getChildren` of its folder (except for a drop as the first child of the folder's own open row, which reads no children), then `move` |
  | Moves a row into another folder (drag, or *Move to…*, which appends it to the folder) | `get` of the row (and, for a folder, of the folders above the destination, to refuse a move into itself), `getChildren` of the destination when the position matters, then `move` |

  The set of names is exactly `{getChildren, get, create, update, move}`. Still no
  `remove`, `removeTree`, `search`, `getTree`, `getRecent` or `getSubTree`.
- **What the user sees does not change for anyone who does not use it.** Ungranted, there
  is no new control and `chrome.bookmarks` is never read. Granted, nothing is written until
  the user presses a button, commits a name, drops a row, or chooses a move from the menu
  or the keyboard: Escape in the name field writes nothing, and a drag that is cancelled
  writes nothing.
- **The tab list is untouched**, and there is still no drag-and-drop between it and the
  bookmark list.
- **A correction to the 1.2.0 wording above** (the line that says `storage` gained a
  clause for "which bookmark folder it was left in"): what the column keeps in
  `chrome.storage.session` is the ids of the open folders, the id of the folder the add
  button aims at, and the scroll offset: ids and a number, never a title or a URL. The
  `storage` justification in `permissions.md` now says "which bookmark folders were open
  (ids, not titles)"; re-paste it with the others.

## The greps for 1.3.0, which replace the three above

Run on 2026-11-10 on the package built by `tools/package.py` from the PR2 branch at
`20020fed` (the commits that follow it change documents only; the manifest still reads
1.2.0 because the version bump is separate). **Run them again on the zip you upload**: a
claim a reviewer can disprove in one command must not be shipped.

```
grep -rn "bm('" extension/
```

Prints 10 lines. Two are in `sidepanel/bookmarks.js` (`getChildren`, the list; `create`,
*Bookmark this tab*). Eight are in `sidepanel/bookmark-write.js`: one is prose in the
header comment (`host.bm('<method>', ...)`), and seven are calls (`get`, `create`,
`update`, `getChildren` twice, `move` twice). `create`, `update` and `move` mutate.

```
grep -rhoE "bm\('[A-Za-z]+'" extension/ | sort -u
```

Prints exactly `bm('create'`, `bm('get'`, `bm('getChildren'`, `bm('move'` and
`bm('update'`: the five names, and no others.

```
grep -rnE "bm\('(remove|removeTree|search|getTree|getRecent|getSubTree)'" extension/
```

Prints nothing.

```
grep -rn "chrome\.bookmarks\[" extension/
```

Prints one line, `bookmarks.js` `return await chrome.bookmarks[method](...args);`. That
is the only place in the extension that reaches the API, which is why a grep for
`chrome.bookmarks.` shows only the five event registrations and two comments, and says
nothing about methods.

```
grep -rn "bookmarks" extension/background/
grep -n "bookmarks" extension/manifest.json
```

The first prints the same two lines in `service-worker.js` as for 1.2.0 (a comment and
`name !== 'bookmarks'`), and nothing in `background/` calls `chrome.bookmarks`; the second
prints the one `optional_permissions` line.

`tests/unit/bookmark-claims.test.mjs` runs the same check on every test run: it reads every
source file under `extension/` with comments and strings masked, and fails on any method
name outside the five, and on any `chrome.bookmarks` reached by a second route.

## Checklist before submitting 1.3.0

- [ ] The owner has worked through `docs/release-check-1.3.0.html` in a real Chrome and
      reported. This is a submission gate: no automated run covers the real side panel.
- [ ] Bump `version` in `extension/manifest.json` above the version in review (the only
      change to the manifest), build the zip with `tools/package.py`, and re-run the
      greps above on that zip.
- [ ] Paste the new single purpose and the new `bookmarks` justification from
      `permissions.md` → *Ready to paste*.
- [ ] Update both store descriptions from `listing.md`: the bookmarks paragraph now
      mentions tidying (new folder, rename, reorder and move) and no longer says "no
      renaming, no reordering".
- [ ] Data use: still tick nothing. Every write goes back into Chrome's bookmark tree and
      nothing is copied or sent.
- [ ] `docs/privacy.html` has its 書き込み line rewritten in the repository. The public
      page is only updated when it is pushed to the public repository, which is the
      owner's step; do it before the update goes live.

## If the review comes back about 1.3.0

The likely question is why a tab extension now changes bookmarks. The answer that is
checkable in the package: the permission is the same optional one, each write is the
direct result of something the user did (a button, a committed name, a drop, a menu choice
or a key), the whole set of calls is the five names above and `grep -rn "bm('" extension/`
lists every one of them, and nothing in the column can delete.
