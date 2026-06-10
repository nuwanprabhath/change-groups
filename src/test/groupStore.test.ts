import * as assert from 'assert';
import { CHANGES_GROUP_ID, GroupStore } from '../groupStore';
import { MemoryMemento } from './helpers';

describe('GroupStore', () => {
  let memento: MemoryMemento;
  let store: GroupStore;

  beforeEach(() => {
    memento = new MemoryMemento();
    store = new GroupStore(memento as never);
  });

  it('seeds the default Changes and Ignored groups', () => {
    assert.deepStrictEqual(
      store.groups.map(g => ({ id: g.id, name: g.name })),
      [
        { id: CHANGES_GROUP_ID, name: 'Changes' },
        { id: 'ignored', name: 'Ignored' }
      ]
    );
  });

  it('creates groups at the end of the order and persists them', async () => {
    const id = await store.createGroup('WIP');
    assert.strictEqual(store.groups[2].id, id);
    assert.strictEqual(store.groups[2].name, 'WIP');

    const reloaded = new GroupStore(memento as never);
    assert.strictEqual(reloaded.groups[2].name, 'WIP');
  });

  it('renames custom groups but never the built-in Changes group', async () => {
    await store.renameGroup('ignored', 'Local only');
    assert.strictEqual(store.getGroup('ignored')?.name, 'Local only');

    await store.renameGroup(CHANGES_GROUP_ID, 'Hacked');
    assert.strictEqual(store.getGroup(CHANGES_GROUP_ID)?.name, 'Changes');
  });

  it('deletes a group and releases its file assignments', async () => {
    const id = await store.createGroup('Temp');
    await store.assign(['/repo/a.txt'], id);
    assert.strictEqual(store.groupOf('/repo/a.txt'), id);

    await store.deleteGroup(id);
    assert.strictEqual(store.getGroup(id), undefined);
    assert.strictEqual(store.groupOf('/repo/a.txt'), undefined);
  });

  it('refuses to delete the built-in Changes group', async () => {
    await store.deleteGroup(CHANGES_GROUP_ID);
    assert.ok(store.getGroup(CHANGES_GROUP_ID));
  });

  it('moves groups up and down with clamping at the edges', async () => {
    await store.moveGroup('ignored', -1);
    assert.deepStrictEqual(store.groups.map(g => g.id), ['ignored', CHANGES_GROUP_ID]);

    // Already at the top: no change.
    await store.moveGroup('ignored', -1);
    assert.deepStrictEqual(store.groups.map(g => g.id), ['ignored', CHANGES_GROUP_ID]);

    await store.moveGroup('ignored', 1);
    assert.deepStrictEqual(store.groups.map(g => g.id), [CHANGES_GROUP_ID, 'ignored']);

    // Already at the bottom: no change.
    await store.moveGroup('ignored', 1);
    assert.deepStrictEqual(store.groups.map(g => g.id), [CHANGES_GROUP_ID, 'ignored']);
  });

  it('reorders a dragged group to the target position', async () => {
    const a = await store.createGroup('A');
    const b = await store.createGroup('B');
    // Order: changes, ignored, A, B. Drag B onto changes.
    await store.reorderGroup(b, CHANGES_GROUP_ID);
    assert.deepStrictEqual(store.groups.map(g => g.id), [b, CHANGES_GROUP_ID, 'ignored', a]);
  });

  it('assigns files to groups and clears on Changes or undefined', async () => {
    await store.assign(['/repo/.env'], 'ignored');
    assert.strictEqual(store.groupOf('/repo/.env'), 'ignored');

    await store.assign(['/repo/.env'], CHANGES_GROUP_ID);
    assert.strictEqual(store.groupOf('/repo/.env'), undefined);

    await store.assign(['/repo/.env'], 'ignored');
    await store.assign(['/repo/.env'], undefined);
    assert.strictEqual(store.groupOf('/repo/.env'), undefined);
  });

  it('treats assignments to deleted groups as unassigned', async () => {
    const id = await store.createGroup('Temp');
    await store.assign(['/repo/a.txt'], id);
    // Simulate a stale assignment surviving a group deletion in another window.
    const reloadedMemento = new MemoryMemento();
    await reloadedMemento.update('changeGroups.groups', [
      { id: CHANGES_GROUP_ID, name: 'Changes' }
    ]);
    await reloadedMemento.update('changeGroups.assignments', { '/repo/a.txt': id });
    const reloaded = new GroupStore(reloadedMemento as never);
    assert.strictEqual(reloaded.groupOf('/repo/a.txt'), undefined);
  });

  it('persists assignments across store instances', async () => {
    await store.assign(['/repo/.env', '/repo/.DS_Store'], 'ignored');
    const reloaded = new GroupStore(memento as never);
    assert.strictEqual(reloaded.groupOf('/repo/.env'), 'ignored');
    assert.strictEqual(reloaded.groupOf('/repo/.DS_Store'), 'ignored');
  });

  it('fires onDidChange for every mutation', async () => {
    let fired = 0;
    store.onDidChange(() => fired++);
    const id = await store.createGroup('A');
    await store.renameGroup(id, 'B');
    await store.assign(['/repo/x'], id);
    await store.moveGroup(id, -1);
    await store.deleteGroup(id);
    assert.strictEqual(fired, 5);
  });
});
