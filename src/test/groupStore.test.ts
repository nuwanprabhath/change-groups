import * as assert from 'assert';
import { CHANGES_GROUP_ID, GroupStore } from '../groupStore';
import { MemoryMemento } from './helpers';

const REPO = '/repo';

describe('GroupStore', () => {
  let memento: MemoryMemento;
  let store: GroupStore;

  beforeEach(() => {
    memento = new MemoryMemento();
    store = new GroupStore(memento as never);
  });

  it('seeds the default Changes and Ignored groups per repository', () => {
    assert.deepStrictEqual(
      store.groupsFor(REPO).map(g => ({ id: g.id, name: g.name })),
      [
        { id: CHANGES_GROUP_ID, name: 'Changes' },
        { id: 'ignored', name: 'Ignored' }
      ]
    );
  });

  it('keeps groups independent between repositories', async () => {
    await store.createGroup('/a', 'Only in A');
    assert.ok(store.groupsFor('/a').some(g => g.name === 'Only in A'));
    assert.ok(!store.groupsFor('/b').some(g => g.name === 'Only in A'));
  });

  it('keeps assignments independent between repositories', async () => {
    await store.assign('/a', ['/a/.env'], 'ignored');
    assert.strictEqual(store.groupOf('/a', '/a/.env'), 'ignored');
    assert.strictEqual(store.groupOf('/b', '/a/.env'), undefined);
  });

  it('creates groups at the end of the order and persists them', async () => {
    const id = await store.createGroup(REPO, 'WIP');
    assert.strictEqual(store.groupsFor(REPO)[2].id, id);
    assert.strictEqual(store.groupsFor(REPO)[2].name, 'WIP');

    const reloaded = new GroupStore(memento as never);
    assert.strictEqual(reloaded.groupsFor(REPO)[2].name, 'WIP');
  });

  it('ensureGroup returns the existing group by name, case-insensitively', async () => {
    const id = await store.createGroup(REPO, 'Local');
    assert.strictEqual(await store.ensureGroup(REPO, 'local'), id);
    const created = await store.ensureGroup(REPO, 'Brand new');
    assert.notStrictEqual(created, id);
    assert.ok(store.groupsFor(REPO).some(g => g.id === created && g.name === 'Brand new'));
  });

  it('renames custom groups but never the built-in Changes group', async () => {
    await store.renameGroup(REPO, 'ignored', 'Local only');
    assert.strictEqual(store.getGroup(REPO, 'ignored')?.name, 'Local only');

    await store.renameGroup(REPO, CHANGES_GROUP_ID, 'Hacked');
    assert.strictEqual(store.getGroup(REPO, CHANGES_GROUP_ID)?.name, 'Changes');
  });

  it('deletes a group and releases its file assignments', async () => {
    const id = await store.createGroup(REPO, 'Temp');
    await store.assign(REPO, ['/repo/a.txt'], id);
    assert.strictEqual(store.groupOf(REPO, '/repo/a.txt'), id);

    await store.deleteGroup(REPO, id);
    assert.strictEqual(store.getGroup(REPO, id), undefined);
    assert.strictEqual(store.groupOf(REPO, '/repo/a.txt'), undefined);
  });

  it('refuses to delete the built-in Changes group', async () => {
    await store.deleteGroup(REPO, CHANGES_GROUP_ID);
    assert.ok(store.getGroup(REPO, CHANGES_GROUP_ID));
  });

  it('moves groups up and down with clamping at the edges', async () => {
    await store.moveGroup(REPO, 'ignored', -1);
    assert.deepStrictEqual(store.groupsFor(REPO).map(g => g.id), ['ignored', CHANGES_GROUP_ID]);

    // Already at the top: no change.
    await store.moveGroup(REPO, 'ignored', -1);
    assert.deepStrictEqual(store.groupsFor(REPO).map(g => g.id), ['ignored', CHANGES_GROUP_ID]);

    await store.moveGroup(REPO, 'ignored', 1);
    assert.deepStrictEqual(store.groupsFor(REPO).map(g => g.id), [CHANGES_GROUP_ID, 'ignored']);

    // Already at the bottom: no change.
    await store.moveGroup(REPO, 'ignored', 1);
    assert.deepStrictEqual(store.groupsFor(REPO).map(g => g.id), [CHANGES_GROUP_ID, 'ignored']);
  });

  it('reorders a dragged group to the target position', async () => {
    const a = await store.createGroup(REPO, 'A');
    const b = await store.createGroup(REPO, 'B');
    // Order: changes, ignored, A, B. Drag B onto changes.
    await store.reorderGroup(REPO, b, CHANGES_GROUP_ID);
    assert.deepStrictEqual(
      store.groupsFor(REPO).map(g => g.id),
      [b, CHANGES_GROUP_ID, 'ignored', a]
    );
  });

  it('assigns files to groups and clears on Changes or undefined', async () => {
    await store.assign(REPO, ['/repo/.env'], 'ignored');
    assert.strictEqual(store.groupOf(REPO, '/repo/.env'), 'ignored');

    await store.assign(REPO, ['/repo/.env'], CHANGES_GROUP_ID);
    assert.strictEqual(store.groupOf(REPO, '/repo/.env'), undefined);

    await store.assign(REPO, ['/repo/.env'], 'ignored');
    await store.assign(REPO, ['/repo/.env'], undefined);
    assert.strictEqual(store.groupOf(REPO, '/repo/.env'), undefined);
  });

  it('persists assignments across store instances', async () => {
    await store.assign(REPO, ['/repo/.env', '/repo/.DS_Store'], 'ignored');
    const reloaded = new GroupStore(memento as never);
    assert.strictEqual(reloaded.groupOf(REPO, '/repo/.env'), 'ignored');
    assert.strictEqual(reloaded.groupOf(REPO, '/repo/.DS_Store'), 'ignored');
  });

  it('fires onDidChange for every mutation', async () => {
    let fired = 0;
    store.onDidChange(() => fired++);
    const id = await store.createGroup(REPO, 'A');
    await store.renameGroup(REPO, id, 'B');
    await store.assign(REPO, ['/repo/x'], id);
    await store.moveGroup(REPO, id, -1);
    await store.deleteGroup(REPO, id);
    assert.strictEqual(fired, 5);
  });

  describe('migration from the pre-per-repo format', () => {
    it('seeds each repository with the legacy groups and its own assignments', async () => {
      const legacy = new MemoryMemento();
      await legacy.update('changeGroups.groups', [
        { id: CHANGES_GROUP_ID, name: 'Changes' },
        { id: 'ignored', name: 'Ignored' },
        { id: 'g-legacy', name: 'WIP' }
      ]);
      await legacy.update('changeGroups.assignments', {
        '/repo/.env': 'ignored',
        '/other/.env': 'g-legacy'
      });

      const migrated = new GroupStore(legacy as never);
      assert.deepStrictEqual(
        migrated.groupsFor('/repo').map(g => g.name),
        ['Changes', 'Ignored', 'WIP']
      );
      // Each repo only inherits assignments under its own root.
      assert.strictEqual(migrated.groupOf('/repo', '/repo/.env'), 'ignored');
      assert.strictEqual(migrated.groupOf('/repo', '/other/.env'), undefined);
      assert.strictEqual(migrated.groupOf('/other', '/other/.env'), 'g-legacy');
    });
  });
});
