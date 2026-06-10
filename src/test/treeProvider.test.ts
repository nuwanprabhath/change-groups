import * as assert from 'assert';
import { Status } from '../git';
import { CHANGES_GROUP_ID, GroupStore } from '../groupStore';
import {
  ChangeGroupsTreeProvider,
  FileNode,
  GroupNode,
  RepoNode,
  STAGED_GROUP_ID,
  TreeNode
} from '../treeProvider';
import { FakeGit, FakeRepo, makeChange, makeGitApi, makeRepo, MemoryMemento } from './helpers';
import { DataTransfer, TreeItemCollapsibleState } from './mocks/vscode';

const MIME = 'application/vnd.code.tree.changegroupsview';

function groupNames(nodes: TreeNode[]): string[] {
  return nodes.filter((n): n is GroupNode => n.kind === 'group').map(n => n.name);
}

function filePaths(nodes: TreeNode[]): string[] {
  return nodes.filter((n): n is FileNode => n.kind === 'file').map(n => n.change.uri.fsPath);
}

describe('ChangeGroupsTreeProvider', () => {
  let repo: FakeRepo;
  let git: FakeGit;
  let store: GroupStore;
  let provider: ChangeGroupsTreeProvider;

  function createProvider(repos: FakeRepo[]): void {
    git = makeGitApi(repos);
    store = new GroupStore(new MemoryMemento() as never);
    provider = new ChangeGroupsTreeProvider(git.api, store);
  }

  beforeEach(() => {
    repo = makeRepo('/repo');
    createProvider([repo]);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('group sections', () => {
    it('shows Changes and Ignored (no Staged) when nothing is staged', () => {
      assert.deepStrictEqual(groupNames(provider.getChildren()), ['Changes', 'Ignored']);
    });

    it('shows Staged Changes first when files are staged', () => {
      repo.state.indexChanges.push(makeChange('/repo/a.ts', Status.INDEX_MODIFIED));
      assert.deepStrictEqual(groupNames(provider.getChildren()), [
        'Staged Changes',
        'Changes',
        'Ignored'
      ]);
    });

    it('respects the stored group order', async () => {
      await store.createGroup('WIP');
      await store.moveGroup('ignored', 1); // ignored below WIP
      assert.deepStrictEqual(groupNames(provider.getChildren()), ['Changes', 'WIP', 'Ignored']);
    });

    it('returns nothing when there are no repositories (welcome view)', () => {
      createProvider([]);
      assert.deepStrictEqual(provider.getChildren(), []);
    });
  });

  describe('file placement', () => {
    beforeEach(() => {
      repo.state.workingTreeChanges.push(
        makeChange('/repo/src/app.ts', Status.MODIFIED),
        makeChange('/repo/.env', Status.MODIFIED)
      );
      repo.state.untrackedChanges.push(makeChange('/repo/.DS_Store', Status.UNTRACKED));
    });

    function childrenOf(name: string): TreeNode[] {
      const group = provider
        .getChildren()
        .find((n): n is GroupNode => n.kind === 'group' && n.name === name);
      assert.ok(group, `group ${name} not found`);
      return provider.getChildren(group);
    }

    it('puts unassigned files in Changes, sorted by path', () => {
      assert.deepStrictEqual(filePaths(childrenOf('Changes')), [
        '/repo/.DS_Store',
        '/repo/.env',
        '/repo/src/app.ts'
      ]);
      assert.deepStrictEqual(filePaths(childrenOf('Ignored')), []);
    });

    it('moves assigned files to their group and back', async () => {
      await store.assign(['/repo/.env'], 'ignored');
      assert.deepStrictEqual(filePaths(childrenOf('Ignored')), ['/repo/.env']);
      assert.ok(!filePaths(childrenOf('Changes')).includes('/repo/.env'));

      await store.assign(['/repo/.env'], undefined);
      assert.ok(filePaths(childrenOf('Changes')).includes('/repo/.env'));
    });

    it('keeps staged files in Staged Changes regardless of assignment', async () => {
      await store.assign(['/repo/src/app.ts'], 'ignored');
      repo.state.indexChanges.push(makeChange('/repo/src/app.ts', Status.INDEX_MODIFIED));
      assert.deepStrictEqual(filePaths(childrenOf('Staged Changes')), ['/repo/src/app.ts']);
    });

    it('dedupes files reported as both working-tree and untracked', () => {
      repo.state.untrackedChanges.push(makeChange('/repo/.env', Status.UNTRACKED));
      const paths = filePaths(childrenOf('Changes')).filter(p => p === '/repo/.env');
      assert.strictEqual(paths.length, 1);
    });
  });

  describe('repository selection', () => {
    let other: FakeRepo;

    beforeEach(() => {
      other = makeRepo('/other');
      createProvider([repo, other]);
      repo.state.workingTreeChanges.push(makeChange('/repo/a.ts', Status.MODIFIED));
      other.state.workingTreeChanges.push(makeChange('/other/b.ts', Status.MODIFIED));
    });

    it('shows only the selected repository, flat', () => {
      repo.setSelected(true);
      other.setSelected(false);
      const roots = provider.getChildren();
      assert.deepStrictEqual(groupNames(roots), ['Changes', 'Ignored']);
      const changes = provider.getChildren(roots[0]);
      assert.deepStrictEqual(filePaths(changes), ['/repo/a.ts']);
    });

    it('nests one section per repository when several are selected', () => {
      repo.setSelected(true);
      other.setSelected(true);
      const roots = provider.getChildren();
      assert.deepStrictEqual(
        roots.map(n => n.kind),
        ['repo', 'repo']
      );
      const repoGroups = provider.getChildren(roots[0]);
      assert.deepStrictEqual(groupNames(repoGroups), ['Changes', 'Ignored']);
      assert.deepStrictEqual(filePaths(provider.getChildren(repoGroups[0])), ['/repo/a.ts']);
    });

    it('falls back to all repositories when none reports selection', () => {
      repo.setSelected(false);
      other.setSelected(false);
      const roots = provider.getChildren();
      assert.strictEqual(roots.length, 2);
      assert.ok(roots.every(n => n.kind === 'repo'));
    });
  });

  describe('tree items', () => {
    it('renders group items with count, context value and Ignored collapsed', () => {
      repo.state.workingTreeChanges.push(makeChange('/repo/a.ts', Status.MODIFIED));
      const [changes, ignored] = provider.getChildren() as GroupNode[];

      const changesItem = provider.getTreeItem(changes);
      assert.strictEqual(changesItem.description, '1');
      assert.strictEqual(changesItem.contextValue, 'group-changes');
      assert.strictEqual(changesItem.collapsibleState, TreeItemCollapsibleState.Expanded);

      const ignoredItem = provider.getTreeItem(ignored);
      assert.strictEqual(ignoredItem.contextValue, 'group-custom');
      assert.strictEqual(ignoredItem.collapsibleState, TreeItemCollapsibleState.Collapsed);
    });

    it('renders file items with status letter and group-specific context value', async () => {
      repo.state.workingTreeChanges.push(
        makeChange('/repo/src/app.ts', Status.MODIFIED),
        makeChange('/repo/.env', Status.MODIFIED)
      );
      await store.assign(['/repo/.env'], 'ignored');
      const [changes, ignored] = provider.getChildren() as GroupNode[];

      const appItem = provider.getTreeItem(provider.getChildren(changes)[0]);
      assert.strictEqual(appItem.label, 'app.ts');
      assert.strictEqual(appItem.description, 'src • M');
      assert.strictEqual(appItem.contextValue, 'file-changes');

      const envItem = provider.getTreeItem(provider.getChildren(ignored)[0]);
      assert.strictEqual(envItem.contextValue, 'file-grouped');
      assert.strictEqual(envItem.description, 'M');
    });

    it('marks staged files with the staged context value', () => {
      repo.state.indexChanges.push(makeChange('/repo/a.ts', Status.INDEX_MODIFIED));
      const staged = provider.getChildren()[0] as GroupNode;
      const item = provider.getTreeItem(provider.getChildren(staged)[0]);
      assert.strictEqual(item.contextValue, 'file-staged');
    });
  });

  describe('drag and drop', () => {
    function fileNode(fsPath: string, groupId: string): FileNode {
      return {
        kind: 'file',
        repo: repo as never,
        change: makeChange(fsPath, Status.MODIFIED),
        groupId
      };
    }

    function groupNode(id: string, name: string): GroupNode {
      return { kind: 'group', id, name, repos: [repo as never] };
    }

    function drag(nodes: TreeNode[]): DataTransfer {
      const transfer = new DataTransfer();
      provider.handleDrag(nodes, transfer as never);
      return transfer;
    }

    it('does not drag staged files or repository nodes', () => {
      const repoNode: RepoNode = { kind: 'repo', repo: repo as never };
      const transfer = drag([fileNode('/repo/a.ts', STAGED_GROUP_ID), repoNode]);
      assert.strictEqual(transfer.get(MIME), undefined);
    });

    it('assigns dropped files to the target group', async () => {
      const transfer = drag([fileNode('/repo/.env', CHANGES_GROUP_ID)]);
      await provider.handleDrop(groupNode('ignored', 'Ignored'), transfer as never);
      assert.strictEqual(store.groupOf('/repo/.env'), 'ignored');
    });

    it('clears the assignment when dropping onto Changes', async () => {
      await store.assign(['/repo/.env'], 'ignored');
      const transfer = drag([fileNode('/repo/.env', 'ignored')]);
      await provider.handleDrop(
        groupNode(CHANGES_GROUP_ID, 'Changes'),
        transfer as never
      );
      assert.strictEqual(store.groupOf('/repo/.env'), undefined);
    });

    it('stages files dropped onto Staged Changes', async () => {
      const transfer = drag([fileNode('/repo/a.ts', CHANGES_GROUP_ID)]);
      await provider.handleDrop(
        groupNode(STAGED_GROUP_ID, 'Staged Changes'),
        transfer as never
      );
      assert.deepStrictEqual(repo.added, [['/repo/a.ts']]);
    });

    it('reorders groups when dropping one group on another', async () => {
      const transfer = drag([groupNode('ignored', 'Ignored')]);
      await provider.handleDrop(
        groupNode(CHANGES_GROUP_ID, 'Changes'),
        transfer as never
      );
      assert.deepStrictEqual(
        store.groups.map(g => g.id),
        ['ignored', CHANGES_GROUP_ID]
      );
    });
  });

  describe('stageGroup', () => {
    function findGroup(name: string): GroupNode {
      const group = provider
        .getChildren()
        .find((n): n is GroupNode => n.kind === 'group' && n.name === name);
      assert.ok(group, `group ${name} not found`);
      return group;
    }

    beforeEach(async () => {
      repo.state.workingTreeChanges.push(
        makeChange('/repo/a.ts', Status.MODIFIED),
        makeChange('/repo/b.ts', Status.MODIFIED),
        makeChange('/repo/.env', Status.MODIFIED)
      );
      await store.assign(['/repo/.env'], 'ignored');
    });

    it('stages only the files in the Changes group', async () => {
      await provider.stageGroup(findGroup('Changes'));
      assert.deepStrictEqual(repo.added, [['/repo/a.ts', '/repo/b.ts']]);
    });

    it('stages only the files in a custom group', async () => {
      await provider.stageGroup(findGroup('Ignored'));
      assert.deepStrictEqual(repo.added, [['/repo/.env']]);
    });

    it('does nothing for an empty group', async () => {
      const id = await store.createGroup('Empty');
      await provider.stageGroup({ kind: 'group', id, name: 'Empty', repos: [repo as never] });
      assert.deepStrictEqual(repo.added, []);
    });

    it('stages per repository when multiple repos are in scope', async () => {
      const other = makeRepo('/other');
      other.state.workingTreeChanges.push(makeChange('/other/c.ts', Status.MODIFIED));
      createProvider([repo, other]);
      await provider.stageGroup({
        kind: 'group',
        id: CHANGES_GROUP_ID,
        name: 'Changes',
        repos: [repo as never, other as never]
      });
      // The new provider has a fresh store, so .env is unassigned and sorts first.
      assert.deepStrictEqual(repo.added, [['/repo/.env', '/repo/a.ts', '/repo/b.ts']]);
      assert.deepStrictEqual(other.added, [['/other/c.ts']]);
    });
  });

  describe('unstageGroup', () => {
    function stagedNode(repos: FakeRepo[]): GroupNode {
      return {
        kind: 'group',
        id: STAGED_GROUP_ID,
        name: 'Staged Changes',
        repos: repos as never[]
      };
    }

    it('unstages every staged file in scope', async () => {
      repo.state.indexChanges.push(
        makeChange('/repo/a.ts', Status.INDEX_MODIFIED),
        makeChange('/repo/b.ts', Status.INDEX_ADDED)
      );
      await provider.unstageGroup(stagedNode([repo]));
      assert.deepStrictEqual(repo.reverted, [['/repo/a.ts', '/repo/b.ts']]);
    });

    it('does nothing when nothing is staged', async () => {
      await provider.unstageGroup(stagedNode([repo]));
      assert.deepStrictEqual(repo.reverted, []);
    });

    it('unstages per repository when multiple repos are in scope', async () => {
      const other = makeRepo('/other');
      other.state.indexChanges.push(makeChange('/other/c.ts', Status.INDEX_MODIFIED));
      repo.state.indexChanges.push(makeChange('/repo/a.ts', Status.INDEX_MODIFIED));
      createProvider([repo, other]);
      await provider.unstageGroup(stagedNode([repo, other]));
      assert.deepStrictEqual(repo.reverted, [['/repo/a.ts']]);
      assert.deepStrictEqual(other.reverted, [['/other/c.ts']]);
    });

    it('returns unstaged files to their previous group', async () => {
      await store.assign(['/repo/.env'], 'ignored');
      // Staged: assignments are untouched while the file sits in the index.
      repo.state.indexChanges.push(makeChange('/repo/.env', Status.INDEX_MODIFIED));
      await provider.unstageGroup(stagedNode([repo]));
      // Simulate git reporting the file back in the working tree.
      repo.state.indexChanges.length = 0;
      repo.state.workingTreeChanges.push(makeChange('/repo/.env', Status.MODIFIED));
      repo.fireStateChange();

      const ignored = provider
        .getChildren()
        .find((n): n is GroupNode => n.kind === 'group' && n.name === 'Ignored');
      assert.ok(ignored);
      assert.deepStrictEqual(filePaths(provider.getChildren(ignored)), ['/repo/.env']);
    });
  });

  describe('refresh wiring', () => {
    function countRefreshes(run: () => void): number {
      let fired = 0;
      const subscription = provider.onDidChangeTreeData(() => fired++);
      run();
      subscription.dispose();
      return fired;
    }

    it('refreshes when the repository state changes', () => {
      assert.strictEqual(countRefreshes(() => repo.fireStateChange()), 1);
    });

    it('refreshes when the repository selection changes', () => {
      assert.strictEqual(countRefreshes(() => repo.setSelected(false)), 1);
    });

    it('refreshes when groups or assignments change', async () => {
      let fired = 0;
      const subscription = provider.onDidChangeTreeData(() => fired++);
      await store.createGroup('A');
      await store.assign(['/repo/x'], 'ignored');
      subscription.dispose();
      assert.strictEqual(fired, 2);
    });

    it('watches repositories opened after activation', () => {
      const late = makeRepo('/late');
      git.openRepo(late);
      assert.strictEqual(countRefreshes(() => late.fireStateChange()), 1);
    });
  });
});
