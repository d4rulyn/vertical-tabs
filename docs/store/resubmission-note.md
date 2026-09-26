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

- [ ] Bump `version` in `extension/manifest.json` above the published `1.1.0`.
- [ ] Re-run the three greps the `bookmarks` justification invites a reviewer to run, on
      the package you are about to upload, not on this branch mid-implementation:
      `grep -rn "chrome\.bookmarks\." extension/` (only `create` mutates),
      `grep -rn "bookmarks" extension/background/` (empty), and
      `grep -n "bookmarks" extension/manifest.json` (one line, `optional_permissions`).
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
