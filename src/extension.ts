import { execFile } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { API, GitExtension, Repository, Status } from './git';
import { CHANGES_GROUP_ID, GroupStore } from './groupStore';
import { ChangeGroupsTreeProvider, FileNode, GroupNode, STAGED_GROUP_ID, TreeNode } from './treeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    void vscode.window.showErrorMessage('Change Groups: the built-in Git extension is not available.');
    return;
  }
  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const git = exports.getAPI(1);

  const store = new GroupStore(context.workspaceState);
  const provider = new ChangeGroupsTreeProvider(git, store);

  const view = vscode.window.createTreeView('changeGroupsView', {
    treeDataProvider: provider,
    dragAndDropController: provider,
    canSelectMany: true,
    showCollapseAll: true
  });
  context.subscriptions.push(view, provider);

  // Inline/context commands on multi-selectable views receive the clicked
  // node plus the full selection as a second argument.
  const selectedFiles = (node: FileNode, nodes?: TreeNode[]): FileNode[] => {
    const list = nodes?.length ? nodes : [node];
    return list.filter((n): n is FileNode => !!n && n.kind === 'file');
  };

  const byRepo = (files: FileNode[]): Map<Repository, string[]> => {
    const map = new Map<Repository, string[]>();
    for (const file of files) {
      const paths = map.get(file.repo) ?? [];
      paths.push(file.change.uri.fsPath);
      map.set(file.repo, paths);
    }
    return map;
  };

  const register = (command: string, callback: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));

  register('changeGroups.refresh', () => provider.refresh());

  const groupRepoRoot = (node: GroupNode): string => node.repos[0].rootUri.fsPath;

  register('changeGroups.createGroup', async () => {
    const repos = provider.selectedRepos();
    if (!repos.length) {
      void vscode.window.showWarningMessage('No git repository found.');
      return;
    }
    let repo = repos[0];
    if (repos.length > 1) {
      const picked = await vscode.window.showQuickPick(
        repos.map(r => ({ label: path.basename(r.rootUri.fsPath), repo: r })),
        { placeHolder: 'Create the group in which repository?' }
      );
      if (!picked) {
        return;
      }
      repo = picked.repo;
    }
    const root = repo.rootUri.fsPath;
    const name = await promptGroupName(store.groupsFor(root).map(g => g.name));
    if (name) {
      await store.createGroup(root, name);
    }
  });

  register('changeGroups.renameGroup', async (node: GroupNode) => {
    const root = groupRepoRoot(node);
    const name = await promptGroupName(
      store.groupsFor(root).map(g => g.name),
      store.getGroup(root, node.id)?.name
    );
    if (name) {
      await store.renameGroup(root, node.id, name);
    }
  });

  register('changeGroups.deleteGroup', async (node: GroupNode) => {
    const choice = await vscode.window.showWarningMessage(
      `Delete group "${node.name}"? Its files will move back to Changes.`,
      { modal: true },
      'Delete'
    );
    if (choice === 'Delete') {
      await store.deleteGroup(groupRepoRoot(node), node.id);
    }
  });

  register('changeGroups.moveGroupUp', (node: GroupNode) =>
    store.moveGroup(groupRepoRoot(node), node.id, -1)
  );
  register('changeGroups.moveGroupDown', (node: GroupNode) =>
    store.moveGroup(groupRepoRoot(node), node.id, 1)
  );

  register('changeGroups.addToGroup', async (node: FileNode, nodes?: TreeNode[]) => {
    const files = selectedFiles(node, nodes);
    if (!files.length) {
      return;
    }
    const roots = [...new Set(files.map(f => f.repo.rootUri.fsPath))];
    // Selections can span repositories; offer the union of their group
    // names and resolve per repo by name when assigning.
    const names = new Set<string>();
    for (const root of roots) {
      for (const group of store.groupsFor(root)) {
        if (group.id !== CHANGES_GROUP_ID) {
          names.add(group.name);
        }
      }
    }
    const what = files.length === 1
      ? path.basename(files[0].change.uri.fsPath)
      : `${files.length} files`;
    const name = await pickGroup([...names], `Add ${what} to group (type a new name to create one)`);
    if (!name) {
      return;
    }
    for (const root of roots) {
      const groupId = await store.ensureGroup(root, name);
      await store.assign(
        root,
        files.filter(f => f.repo.rootUri.fsPath === root).map(f => f.change.uri.fsPath),
        groupId
      );
    }
  });

  register('changeGroups.removeFromGroup', async (node: FileNode, nodes?: TreeNode[]) => {
    const files = selectedFiles(node, nodes);
    const roots = [...new Set(files.map(f => f.repo.rootUri.fsPath))];
    for (const root of roots) {
      await store.assign(
        root,
        files.filter(f => f.repo.rootUri.fsPath === root).map(f => f.change.uri.fsPath),
        undefined
      );
    }
  });

  register('changeGroups.stageGroup', (node: GroupNode) => provider.stageGroup(node));
  register('changeGroups.unstageGroup', (node: GroupNode) => provider.unstageGroup(node));

  // From the Staged Changes header the scope is the node's repos; from the
  // view title bar (or the palette) it is the selected repositories.
  register('changeGroups.stageAll', (node?: GroupNode) =>
    provider.stageAllChanges(node?.repos ?? provider.selectedRepos())
  );

  const execFileAsync = promisify(execFile);
  const runGit = async (cwd: string, args: string[]): Promise<void> => {
    await execFileAsync(git.git?.path ?? 'git', args, { cwd });
  };

  const promptStashMessage = (initial?: string): Thenable<string | undefined> =>
    vscode.window.showInputBox({
      prompt: 'Stash message (optional)',
      placeHolder: 'Stash message',
      value: initial
    });

  const showStashError = (err: unknown): void => {
    const gitError = err as { stderr?: string; message?: string };
    void vscode.window.showErrorMessage(
      `Stash failed: ${gitError.stderr?.trim() || gitError.message || String(err)}`
    );
  };

  register('changeGroups.stashGroup', async (node: GroupNode) => {
    const message = await promptStashMessage(node.id === CHANGES_GROUP_ID ? '' : node.name);
    if (message === undefined) {
      return; // cancelled
    }
    try {
      const stashed = await provider.stashGroup(node, message.trim() || undefined, runGit);
      if (!stashed) {
        void vscode.window.showInformationMessage('There are no changes to stash in this group.');
      }
    } catch (err) {
      showStashError(err);
    }
  });

  register('changeGroups.stashAll', async (node?: GroupNode) => {
    const repos = node?.repos ?? provider.selectedRepos();
    if (!repos.length) {
      void vscode.window.showWarningMessage('No git repository found.');
      return;
    }
    const message = await promptStashMessage();
    if (message === undefined) {
      return; // cancelled
    }
    try {
      const stashed = await provider.stashAllChanges(repos, message.trim() || undefined, runGit);
      if (!stashed) {
        void vscode.window.showInformationMessage('There are no changes to stash.');
      }
    } catch (err) {
      showStashError(err);
    }
  });

  register('changeGroups.stageFile', async (node: FileNode, nodes?: TreeNode[]) => {
    for (const [repo, paths] of byRepo(selectedFiles(node, nodes))) {
      await repo.add(paths);
    }
  });

  register('changeGroups.unstageFile', async (node: FileNode, nodes?: TreeNode[]) => {
    for (const [repo, paths] of byRepo(selectedFiles(node, nodes))) {
      await repo.revert(paths);
    }
  });

  register('changeGroups.discardFile', async (node: FileNode, nodes?: TreeNode[]) => {
    const files = selectedFiles(node, nodes);
    if (!files.length) {
      return;
    }
    const hasUntracked = files.some(f => isUntracked(f.change.status));
    const what = files.length === 1 ? path.basename(files[0].change.uri.fsPath) : `${files.length} files`;
    const detail = hasUntracked ? 'Untracked files will be DELETED. This is irreversible.' : 'This is irreversible.';
    const choice = await vscode.window.showWarningMessage(
      `Discard changes in ${what}?`,
      { modal: true, detail },
      'Discard Changes'
    );
    if (choice !== 'Discard Changes') {
      return;
    }
    for (const [repo, paths] of byRepo(files)) {
      await repo.clean(paths);
    }
  });

  register('changeGroups.openFile', async (node: FileNode, nodes?: TreeNode[]) => {
    for (const file of selectedFiles(node, nodes)) {
      if (file.change.status === Status.DELETED || file.change.status === Status.INDEX_DELETED) {
        continue;
      }
      await vscode.commands.executeCommand('vscode.open', file.change.uri, { preview: false });
    }
  });

  register('changeGroups.openChanges', (node: FileNode) => openChanges(git, node));
}

export function deactivate(): void {}

/**
 * Quick pick over existing group names where typing a name that matches no
 * group offers a live "Create group …" item, so Enter on free text just
 * works. Resolves with the chosen (or newly typed) group name.
 */
function pickGroup(names: string[], placeholder: string): Promise<string | undefined> {
  type GroupItem = vscode.QuickPickItem & { createName?: string };
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<GroupItem>();
    qp.placeholder = placeholder;
    const baseItems: GroupItem[] = names.map(name => ({
      label: name,
      iconPath: new vscode.ThemeIcon('folder')
    }));
    const update = () => {
      const value = qp.value.trim();
      const items: GroupItem[] = [...baseItems];
      if (value && !names.some(name => name.toLowerCase() === value.toLowerCase())) {
        items.push({
          label: `$(plus) Create group "${value}"`,
          createName: value,
          alwaysShow: true
        });
      }
      qp.items = items;
    };
    update();

    let accepted = false;
    qp.onDidChangeValue(update);
    qp.onDidAccept(() => {
      const picked = qp.selectedItems[0] ?? qp.activeItems[0];
      if (!picked) {
        return;
      }
      accepted = true;
      qp.hide();
      resolve(picked.createName ?? picked.label);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });
    qp.show();
  });
}

async function promptGroupName(
  existingNames: string[],
  initial?: string
): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Change group name',
    placeHolder: 'e.g. Local config, WIP, Ignored',
    value: initial,
    validateInput: value => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Name cannot be empty';
      }
      if (trimmed !== initial && existingNames.includes(trimmed)) {
        return 'A group with this name already exists';
      }
      return undefined;
    }
  });
  return name?.trim();
}

function isUntracked(status: Status): boolean {
  return status === Status.UNTRACKED || status === Status.INTENT_TO_ADD;
}

async function openChanges(git: API, node: FileNode): Promise<void> {
  const { change } = node;
  const uri = change.uri;
  const name = path.basename(uri.fsPath);

  if (node.groupId === STAGED_GROUP_ID) {
    switch (change.status) {
      case Status.INDEX_ADDED:
        await vscode.commands.executeCommand('vscode.open', git.toGitUri(uri, ''));
        return;
      case Status.INDEX_DELETED:
        await vscode.commands.executeCommand('vscode.open', git.toGitUri(change.originalUri, 'HEAD'));
        return;
      default:
        await vscode.commands.executeCommand(
          'vscode.diff',
          git.toGitUri(change.originalUri ?? uri, 'HEAD'),
          git.toGitUri(uri, ''),
          `${name} (Index)`
        );
        return;
    }
  }

  switch (change.status) {
    case Status.UNTRACKED:
    case Status.INTENT_TO_ADD:
      await vscode.commands.executeCommand('vscode.open', uri);
      return;
    case Status.DELETED:
      await vscode.commands.executeCommand('vscode.open', git.toGitUri(uri, 'HEAD'));
      return;
    default:
      // '~' resolves to the index version, so this matches the built-in
      // git extension's working-tree diff.
      await vscode.commands.executeCommand('vscode.diff', git.toGitUri(uri, '~'), uri, `${name} (Working Tree)`);
      return;
  }
}
