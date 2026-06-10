# Git Change Groups

Group your git changes into collapsible groups to de-clutter the Source Control view.

Ever have files like `.env` or local config tweaks that always show up in **Changes** but
you never intend to commit? Change Groups adds a view to the Source Control sidebar where you
can move those files into groups (a default **Ignored** group is provided) and collapse
them out of sight. Group assignments are sticky — `.env` stays in **Ignored** the next time
it changes.

## Features

- **Change Groups view** in the Source Control sidebar showing Staged Changes, Changes, and
  your custom groups — each collapsible with a file count.
- **Add to Group** inline action (next to the familiar *Stage Changes* `+`) — pick an
  existing group or create a new one on the fly.
- **Default "Ignored" group**, collapsed by default.
- **Create / rename / delete groups** (deleting a group moves its files back to Changes).
- **Reorder groups** with the inline ▲ / ▼ buttons or by drag & drop.
- **Drag & drop files** between groups; dropping on *Staged Changes* stages them.
- Everything else works like normal Source Control: click a file to open its diff, stage,
  unstage and discard inline, multi-select supported. Staging, commits, branches etc. via
  the built-in git extension are untouched.

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
