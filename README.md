# Git Change Groups

Group your git changes into collapsible groups to de-clutter the Source Control view.

Ever have files like `.env` or local config tweaks that always show up in **Changes** but
you never intend to commit? Change Groups adds a view to the Source Control sidebar where you
can move those files into groups (a default **Ignored** group is provided) and collapse
them out of sight. Group assignments are sticky — `.env` stays in **Ignored** the next time
it changes.

## Features

### Groups

- **Change Groups view** in the Source Control sidebar showing Staged Changes, Changes, and
  your custom groups — each collapsible with a file count.
- **Default "Ignored" group**, collapsed by default — park files like `.env` or `.DS_Store`
  there and stop seeing them.
- **Sticky assignments**: groups remember their files by path, so a grouped file goes back
  to its group every time it changes again (and after staging/unstaging round-trips).
- **Create / rename / delete groups** via the view toolbar and the group right-click menu
  (deleting a group moves its files back to Changes).
- **Reorder groups** by drag & drop, or with *Move Group Up / Down* in the group
  right-click menu.

### File actions (hover over a file)

- **Open File**, **Discard Changes**, **Stage Changes** — like the built-in view.
- **Add to Group** (next to the familiar `+`) — pick an existing group or just type a new
  name in the picker to create it on the fly.
- **Remove from Group** (`−` on grouped files) — moves the file back to Changes.
- **Multi-select** works for all of the above.
- Click a file to open its diff; drag files between groups (dropping on *Staged Changes*
  stages them).

### Group actions (hover over a group header)

- **Stage All Changes in Group** (`+`) — stages only that group's files. Available on
  Changes and every custom group.
- **Stash All Changes in Group** (stash icon) — stashes only that group's files
  (untracked included), with an optional stash message. The stash lands in the regular
  git stash list, and popped files return to their groups.
- **Unstage All Changes** (`−` on Staged Changes) — unstages everything; files return to
  the groups they came from.
- **Stage All Changes** (`+` on Staged Changes and in the view title bar) — stages every
  change in the repository across all groups, untracked files included.
- **Stash All Changes** (stash icon in the view title bar) — stashes everything in the
  repository (staged, unstaged and untracked) with an optional message.

### Repository awareness

- Follows the repository selection in the built-in **Repositories** section: one repo
  selected shows a flat list; several selected show one section per repository.
- **Groups are per-repository** — each repo keeps its own groups, order and file
  assignments, so switching repositories shows that repo's groups only.

Everything else works like normal Source Control — committing, branches, sync and the rest
stay with the built-in git extension, which Change Groups drives through the official
`vscode.git` API.

## How it works with the built-in Source Control

VS Code does not let extensions modify the built-in git **Changes** list, so Change Groups
adds its own view right below it (same sidebar). Suggested setup: collapse the built-in
repository section and use the Change Groups view to browse changes; keep using the built-in
commit message box and toolbar as usual. You can drag the views to reorder them within the
sidebar.

Groups and assignments are stored per-workspace (in VS Code workspace state) — nothing is
written into your repository.

## Development

```bash
cd change-groups
npm install
npm run compile
```

Open the `change-groups` folder in VS Code and press **F5** to launch an Extension
Development Host with the extension loaded.

Run the test suite (plain mocha — the `vscode` module is mocked, no VS Code download
needed):

```bash
npm test
```

Tests live in `src/test/` and cover the group store (create/rename/delete/reorder,
assignments, persistence) and the tree provider (sections, file placement, repository
selection, tree item rendering, drag & drop, refresh wiring).

To install it permanently:

```bash
npx @vscode/vsce package
code --install-extension change-groups-0.0.1.vsix
```
