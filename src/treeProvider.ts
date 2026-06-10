import * as path from 'path';
import * as vscode from 'vscode';
import { API, Change, Repository, Status } from './git';
import { CHANGES_GROUP_ID, GroupStore } from './groupStore';

export const STAGED_GROUP_ID = '__staged__';

export interface RepoNode {
  kind: 'repo';
  repo: Repository;
}

export interface GroupNode {
  kind: 'group';
  id: string;
  name: string;
  /** Repositories this group node is scoped to. */
  repos: Repository[];
}

export interface FileNode {
  kind: 'file';
  repo: Repository;
  change: Change;
  /** STAGED_GROUP_ID, CHANGES_GROUP_ID or a custom group id. */
  groupId: string;
}

export type TreeNode = RepoNode | GroupNode | FileNode;

const STATUS_INFO: Partial<Record<Status, { letter: string; label: string }>> = {
  [Status.INDEX_MODIFIED]: { letter: 'M', label: 'Modified' },
  [Status.INDEX_ADDED]: { letter: 'A', label: 'Added' },
  [Status.INDEX_DELETED]: { letter: 'D', label: 'Deleted' },
  [Status.INDEX_RENAMED]: { letter: 'R', label: 'Renamed' },
  [Status.INDEX_COPIED]: { letter: 'C', label: 'Copied' },
  [Status.MODIFIED]: { letter: 'M', label: 'Modified' },
  [Status.DELETED]: { letter: 'D', label: 'Deleted' },
  [Status.UNTRACKED]: { letter: 'U', label: 'Untracked' },
  [Status.IGNORED]: { letter: 'I', label: 'Ignored' },
  [Status.INTENT_TO_ADD]: { letter: 'A', label: 'Intent to Add' },
  [Status.INTENT_TO_RENAME]: { letter: 'R', label: 'Intent to Rename' },
  [Status.TYPE_CHANGED]: { letter: 'T', label: 'Type Changed' },
  [Status.ADDED_BY_US]: { letter: '!', label: 'Conflict: Added by Us' },
  [Status.ADDED_BY_THEM]: { letter: '!', label: 'Conflict: Added by Them' },
  [Status.DELETED_BY_US]: { letter: '!', label: 'Conflict: Deleted by Us' },
  [Status.DELETED_BY_THEM]: { letter: '!', label: 'Conflict: Deleted by Them' },
  [Status.BOTH_ADDED]: { letter: '!', label: 'Conflict: Both Added' },
  [Status.BOTH_DELETED]: { letter: '!', label: 'Conflict: Both Deleted' },
  [Status.BOTH_MODIFIED]: { letter: '!', label: 'Conflict: Both Modified' }
};

export class ChangeGroupsTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>, vscode.Disposable
{
  // Must match the view id, lowercased, per the TreeDragAndDropController contract.
  private static readonly MIME = 'application/vnd.code.tree.changegroupsview';
  readonly dragMimeTypes = [ChangeGroupsTreeProvider.MIME];
  readonly dropMimeTypes = [ChangeGroupsTreeProvider.MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<Repository, vscode.Disposable>();

  constructor(
    private readonly git: API,
    private readonly store: GroupStore
  ) {
    this.disposables.push(
      this.store.onDidChange(() => this.refresh()),
      this.git.onDidChangeState(() => this.refresh()),
      this.git.onDidOpenRepository(repo => {
        this.watch(repo);
        this.refresh();
      }),
      this.git.onDidCloseRepository(repo => {
        this.repoListeners.get(repo)?.dispose();
        this.repoListeners.delete(repo);
        this.refresh();
      })
    );
    this.git.repositories.forEach(repo => this.watch(repo));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.repoListeners.forEach(d => d.dispose());
    this.repoListeners.clear();
  }

  private watch(repo: Repository): void {
    if (!this.repoListeners.has(repo)) {
      const listeners = [repo.state.onDidChange(() => this.refresh())];
      // ui.selected tracks the checkboxes in the built-in "Repositories"
      // section; refresh so this view follows the same selection.
      if (repo.ui?.onDidChange) {
        listeners.push(repo.ui.onDidChange(() => this.refresh()));
      }
      this.repoListeners.set(repo, vscode.Disposable.from(...listeners));
    }
  }

  /** Stages every file currently shown in the given group. */
  async stageGroup(node: GroupNode): Promise<void> {
    const byRepo = new Map<Repository, string[]>();
    for (const file of this.getFilesIn(node.id, node.repos)) {
      const paths = byRepo.get(file.repo) ?? [];
      paths.push(file.change.uri.fsPath);
      byRepo.set(file.repo, paths);
    }
    for (const [repo, paths] of byRepo) {
      await repo.add(paths);
    }
  }

  /**
   * Unstages every staged file in the group's scope. Unstaged files land
   * back in whichever group they were assigned to, since assignments are
   * sticky and keyed by path.
   */
  async unstageGroup(node: GroupNode): Promise<void> {
    for (const repo of node.repos) {
      const paths = repo.state.indexChanges.map(change => change.uri.fsPath);
      if (paths.length) {
        await repo.revert(paths);
      }
    }
  }

  /** Repositories selected in the built-in Repositories section (all, if none report selection). */
  private selectedRepos(): Repository[] {
    const all = this.git.repositories;
    const selected = all.filter(repo => repo.ui?.selected);
    return selected.length ? selected : all;
  }

  // --- TreeDataProvider ---

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const repos = this.selectedRepos();
      if (repos.length === 0) {
        return []; // viewsWelcome kicks in
      }
      if (repos.length === 1) {
        return this.getGroupNodes(repos);
      }
      // Multiple repositories selected: one section per repo, like the
      // built-in Source Control view.
      return repos.map<RepoNode>(repo => ({ kind: 'repo', repo }));
    }
    if (element.kind === 'repo') {
      return this.getGroupNodes([element.repo]);
    }
    if (element.kind === 'group') {
      return this.getFilesIn(element.id, element.repos);
    }
    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      return this.repoItem(node);
    }
    return node.kind === 'group' ? this.groupItem(node) : this.fileItem(node);
  }

  private getGroupNodes(repos: Repository[]): GroupNode[] {
    const nodes: GroupNode[] = [];
    if (repos.some(r => r.state.indexChanges.length > 0)) {
      nodes.push({ kind: 'group', id: STAGED_GROUP_ID, name: 'Staged Changes', repos });
    }
    for (const group of this.store.groups) {
      nodes.push({ kind: 'group', id: group.id, name: group.name, repos });
    }
    return nodes;
  }

  private getFilesIn(groupId: string, repos: Repository[]): FileNode[] {
    const files: FileNode[] = [];
    for (const repo of repos) {
      if (groupId === STAGED_GROUP_ID) {
        for (const change of repo.state.indexChanges) {
          files.push({ kind: 'file', repo, change, groupId });
        }
        continue;
      }
      for (const change of this.workingChanges(repo)) {
        const assigned = this.store.groupOf(change.uri.fsPath) ?? CHANGES_GROUP_ID;
        if (assigned === groupId) {
          files.push({ kind: 'file', repo, change, groupId });
        }
      }
    }
    return files.sort((a, b) => a.change.uri.fsPath.localeCompare(b.change.uri.fsPath));
  }

  /** Working tree + merge + untracked changes, deduped by path. */
  private workingChanges(repo: Repository): Change[] {
    const seen = new Set<string>();
    const out: Change[] = [];
    const all = [
      ...repo.state.mergeChanges,
      ...repo.state.workingTreeChanges,
      ...repo.state.untrackedChanges
    ];
    for (const change of all) {
      if (!seen.has(change.uri.fsPath)) {
        seen.add(change.uri.fsPath);
        out.push(change);
      }
    }
    return out;
  }

  private repoItem(node: RepoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(node.repo.rootUri.fsPath),
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.id = `repo:${node.repo.rootUri.fsPath}`;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.contextValue = 'repo';
    return item;
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const count = this.getFilesIn(node.id, node.repos).length;
    // "Ignored" starts collapsed so it stays out of the way; VS Code then
    // remembers whatever the user last did per item id.
    const initialState =
      node.id === 'ignored'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;
    const item = new vscode.TreeItem(node.name, initialState);
    const scope = node.repos.length === 1 ? node.repos[0].rootUri.fsPath : 'all';
    item.id = `group:${scope}:${node.id}`;
    item.description = String(count);
    if (node.id === STAGED_GROUP_ID) {
      item.contextValue = 'group-staged';
    } else if (node.id === CHANGES_GROUP_ID) {
      item.contextValue = 'group-changes';
    } else {
      item.contextValue = 'group-custom';
    }
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const fsPath = node.change.uri.fsPath;
    const status = STATUS_INFO[node.change.status] ?? { letter: '?', label: 'Unknown' };
    const item = new vscode.TreeItem(path.basename(fsPath));
    item.id = `file:${node.groupId}:${fsPath}`;
    item.resourceUri = node.change.uri;
    const relativeDir = path.relative(node.repo.rootUri.fsPath, path.dirname(fsPath));
    item.description = relativeDir ? `${relativeDir} • ${status.letter}` : status.letter;
    item.tooltip = `${path.relative(node.repo.rootUri.fsPath, fsPath)} — ${status.label}`;
    if (node.groupId === STAGED_GROUP_ID) {
      item.contextValue = 'file-staged';
    } else if (node.groupId === CHANGES_GROUP_ID) {
      item.contextValue = 'file-changes';
    } else {
      item.contextValue = 'file-grouped';
    }
    item.command = {
      command: 'changeGroups.openChanges',
      title: 'Open Changes',
      arguments: [node]
    };
    return item;
  }

  // --- TreeDragAndDropController ---

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const draggable = source.filter(node => {
      if (node.kind === 'repo') {
        return false;
      }
      return node.kind === 'file' ? node.groupId !== STAGED_GROUP_ID : node.id !== STAGED_GROUP_ID;
    });
    if (draggable.length) {
      dataTransfer.set(ChangeGroupsTreeProvider.MIME, new vscode.DataTransferItem(draggable));
    }
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(ChangeGroupsTreeProvider.MIME);
    if (!item || !target) {
      return;
    }
    const source = item.value as TreeNode[];
    if (target.kind === 'repo') {
      return;
    }
    const targetGroupId = target.kind === 'group' ? target.id : target.groupId;

    const draggedGroup = source.find((n): n is GroupNode => n.kind === 'group');
    if (draggedGroup) {
      if (targetGroupId !== STAGED_GROUP_ID) {
        await this.store.reorderGroup(draggedGroup.id, targetGroupId);
      }
      return;
    }

    const files = source.filter((n): n is FileNode => n.kind === 'file');
    if (!files.length) {
      return;
    }
    if (targetGroupId === STAGED_GROUP_ID) {
      // Dropping on Staged Changes stages the files, mirroring the + action.
      const byRepo = new Map<Repository, string[]>();
      for (const file of files) {
        const paths = byRepo.get(file.repo) ?? [];
        paths.push(file.change.uri.fsPath);
        byRepo.set(file.repo, paths);
      }
      for (const [repo, paths] of byRepo) {
        await repo.add(paths);
      }
      return;
    }
    await this.store.assign(
      files.map(f => f.change.uri.fsPath),
      targetGroupId === CHANGES_GROUP_ID ? undefined : targetGroupId
    );
  }
}
