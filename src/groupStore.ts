import * as path from 'path';
import * as vscode from 'vscode';

export const CHANGES_GROUP_ID = '__changes__';

const STATE_KEY = 'changeGroups.repoState';
// Keys from before groups became per-repository; migrated on first use.
const LEGACY_GROUPS_KEY = 'changeGroups.groups';
const LEGACY_ASSIGNMENTS_KEY = 'changeGroups.assignments';

export interface GroupDef {
  id: string;
  name: string;
}

interface RepoGroupState {
  groups: GroupDef[];
  assignments: Record<string, string>;
}

/**
 * Persists change groups and file→group assignments in workspace state,
 * scoped per repository root: each repo has its own groups, order and
 * assignments. Array order of `groups` is the display order. The built-in
 * "Changes" group is part of the order list so it can be reordered too,
 * but it can never be renamed or deleted. Assignments are sticky: they
 * survive commits, so a file like `.env` stays in its group next time it
 * changes.
 */
export class GroupStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly _state: Record<string, RepoGroupState>;
  private readonly legacyGroups: GroupDef[] | undefined;
  private readonly legacyAssignments: Record<string, string> | undefined;

  constructor(private readonly memento: vscode.Memento) {
    this._state = memento.get<Record<string, RepoGroupState>>(STATE_KEY) ?? {};
    this.legacyGroups = memento.get<GroupDef[]>(LEGACY_GROUPS_KEY);
    this.legacyAssignments = memento.get<Record<string, string>>(LEGACY_ASSIGNMENTS_KEY);
  }

  /** Groups of a repository in display order. Seeds defaults on first use. */
  groupsFor(repoRoot: string): readonly GroupDef[] {
    return this.repoState(repoRoot).groups;
  }

  getGroup(repoRoot: string, id: string): GroupDef | undefined {
    return this.repoState(repoRoot).groups.find(g => g.id === id);
  }

  /** Group a file belongs to, or undefined for the default Changes group. */
  groupOf(repoRoot: string, fsPath: string): string | undefined {
    const state = this.repoState(repoRoot);
    const id = state.assignments[fsPath];
    return id && id !== CHANGES_GROUP_ID && state.groups.some(g => g.id === id) ? id : undefined;
  }

  async createGroup(repoRoot: string, name: string): Promise<string> {
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.repoState(repoRoot).groups.push({ id, name });
    await this.save();
    return id;
  }

  /** Id of the group with this name (case-insensitive), creating it if needed. */
  async ensureGroup(repoRoot: string, name: string): Promise<string> {
    const existing = this.repoState(repoRoot).groups.find(
      g => g.id !== CHANGES_GROUP_ID && g.name.toLowerCase() === name.toLowerCase()
    );
    return existing ? existing.id : this.createGroup(repoRoot, name);
  }

  async renameGroup(repoRoot: string, id: string, name: string): Promise<void> {
    const group = this.getGroup(repoRoot, id);
    if (!group || id === CHANGES_GROUP_ID) {
      return;
    }
    group.name = name;
    await this.save();
  }

  async deleteGroup(repoRoot: string, id: string): Promise<void> {
    if (id === CHANGES_GROUP_ID) {
      return;
    }
    const state = this.repoState(repoRoot);
    state.groups = state.groups.filter(g => g.id !== id);
    for (const [fsPath, groupId] of Object.entries(state.assignments)) {
      if (groupId === id) {
        delete state.assignments[fsPath];
      }
    }
    await this.save();
  }

  async moveGroup(repoRoot: string, id: string, delta: -1 | 1): Promise<void> {
    const groups = this.repoState(repoRoot).groups;
    const index = groups.findIndex(g => g.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= groups.length) {
      return;
    }
    [groups[index], groups[target]] = [groups[target], groups[index]];
    await this.save();
  }

  /** Move `dragId` to the position currently held by `targetId` (drag & drop reorder). */
  async reorderGroup(repoRoot: string, dragId: string, targetId: string): Promise<void> {
    if (dragId === targetId) {
      return;
    }
    const groups = this.repoState(repoRoot).groups;
    const from = groups.findIndex(g => g.id === dragId);
    if (from < 0) {
      return;
    }
    const [dragged] = groups.splice(from, 1);
    const to = groups.findIndex(g => g.id === targetId);
    if (to < 0) {
      groups.splice(from, 0, dragged);
      return;
    }
    groups.splice(to, 0, dragged);
    await this.save();
  }

  /** Assign files to a group; `undefined` or the Changes id moves them back to Changes. */
  async assign(repoRoot: string, fsPaths: string[], groupId: string | undefined): Promise<void> {
    const assignments = this.repoState(repoRoot).assignments;
    for (const fsPath of fsPaths) {
      if (!groupId || groupId === CHANGES_GROUP_ID) {
        delete assignments[fsPath];
      } else {
        assignments[fsPath] = groupId;
      }
    }
    await this.save();
  }

  private repoState(repoRoot: string): RepoGroupState {
    let state = this._state[repoRoot];
    if (!state) {
      state = this.seed(repoRoot);
      this._state[repoRoot] = state;
      // Persist silently: seeding happens during rendering, so firing
      // onDidChange here would cause a refresh loop.
      void this.memento.update(STATE_KEY, this._state);
    }
    return state;
  }

  private seed(repoRoot: string): RepoGroupState {
    const legacyCustoms = this.legacyGroups?.filter(g => g.id !== CHANGES_GROUP_ID);
    const groups: GroupDef[] = [
      { id: CHANGES_GROUP_ID, name: 'Changes' },
      ...(legacyCustoms?.length
        ? legacyCustoms.map(g => ({ ...g }))
        : [{ id: 'ignored', name: 'Ignored' }])
    ];
    const assignments: Record<string, string> = {};
    for (const [fsPath, id] of Object.entries(this.legacyAssignments ?? {})) {
      if (fsPath.startsWith(repoRoot + path.sep) && groups.some(g => g.id === id)) {
        assignments[fsPath] = id;
      }
    }
    return { groups, assignments };
  }

  private async save(): Promise<void> {
    await this.memento.update(STATE_KEY, this._state);
    this._onDidChange.fire();
  }
}
