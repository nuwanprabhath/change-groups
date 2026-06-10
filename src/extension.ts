import * as path from 'path';
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

  register('changeGroups.createGroup', async () => {
    const name = await promptGroupName(store);
    if (name) {
      await store.createGroup(name);
    }
  });

  register('changeGroups.renameGroup', async (node: GroupNode) => {
    const name = await promptGroupName(store, store.getGroup(node.id)?.name);
    if (name) {
      await store.renameGroup(node.id, name);
    }
  });

  register('changeGroups.deleteGroup', async (node: GroupNode) => {
    const choice = await vscode.window.showWarningMessage(
      `Delete group "${node.name}"? Its files will move back to Changes.`,
      { modal: true },
      'Delete'
    );
    if (choice === 'Delete') {
      await store.deleteGroup(node.id);
    }
  });

  register('changeGroups.moveGroupUp', (node: GroupNode) => store.moveGroup(node.id, -1));
  register('changeGroups.moveGroupDown', (node: GroupNode) => store.moveGroup(node.id, 1));

  register('changeGroups.addToGroup', async (node: FileNode, nodes?: TreeNode[]) => {
    const files = selectedFiles(node, nodes);
    if (!files.length) {
      return;
    }
    const what = files.length === 1
      ? path.basename(files[0].change.uri.fsPath)
      : `${files.length} files`;
    const groupId = await pickGroup(store, `Add ${what} to group (type a new name to create one)`);
    if (!groupId) {
      return;
    }
    await store.assign(files.map(f => f.change.uri.fsPath), groupId);
  });

  register('changeGroups.removeFromGroup', (node: FileNode, nodes?: TreeNode[]) =>
    store.assign(selectedFiles(node, nodes).map(f => f.change.uri.fsPath), undefined)
  );

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
 * Quick pick over existing groups where typing a name that matches no group
 * offers a live "Create group …" item, so Enter on free text just works.
 */
function pickGroup(store: GroupStore, placeholder: string): Promise<string | undefined> {
  type GroupItem = vscode.QuickPickItem & { id?: string; createName?: string };
  return new Promise(resolve => {
    const qp = vscode.window.createQuickPick<GroupItem>();
    qp.placeholder = placeholder;
    const baseItems: GroupItem[] = store.groups
      .filter(g => g.id !== CHANGES_GROUP_ID)
      .map(g => ({ label: g.name, id: g.id, iconPath: new vscode.ThemeIcon('folder') }));
    const update = () => {
      const value = qp.value.trim();
      const items: GroupItem[] = [...baseItems];
      if (value && !store.groups.some(g => g.name.toLowerCase() === value.toLowerCase())) {
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
      if (picked.createName) {
        store.createGroup(picked.createName).then(resolve);
      } else {
        resolve(picked.id);
      }
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

async function promptGroupName(store: GroupStore, initial?: string): Promise<string | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: 'Change group name',
    placeHolder: 'e.g. Local config, WIP, Ignored',
    value: initial,
    validateInput: value => {
      const trimmed = value.trim();
      if (!trimmed) {
        return 'Name cannot be empty';
      }
      if (trimmed !== initial && store.groups.some(g => g.name === trimmed)) {
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
