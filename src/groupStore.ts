import * as vscode from 'vscode';

export const CHANGES_GROUP_ID = '__changes__';

const GROUPS_KEY = 'changeGroups.groups';
const ASSIGNMENTS_KEY = 'changeGroups.assignments';

export interface GroupDef {
  id: string;
  name: string;
}

/**
 * Persists change groups and file→group assignments in workspace state.
 * Array order of `groups` is the display order. The built-in "Changes"
 * group is part of the order list so it can be reordered too, but it can
 * never be renamed or deleted. Assignments are sticky: they survive
 * commits, so a file like `.env` stays in its group next time it changes.
 */
export class GroupStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _groups: GroupDef[];
  private _assignments: Record<string, string>;

  constructor(private readonly state: vscode.Memento) {
    this._groups = state.get<GroupDef[]>(GROUPS_KEY) ?? [
      { id: CHANGES_GROUP_ID, name: 'Changes' },
      { id: 'ignored', name: 'Ignored' }
    ];
    this._assignments = state.get<Record<string, string>>(ASSIGNMENTS_KEY) ?? {};
  }

  get groups(): readonly GroupDef[] {
    return this._groups;
  }

  getGroup(id: string): GroupDef | undefined {
    return this._groups.find(g => g.id === id);
  }

  /** Group a file belongs to, or undefined for the default Changes group. */
  groupOf(fsPath: string): string | undefined {
    const id = this._assignments[fsPath];
    return id && id !== CHANGES_GROUP_ID && this.getGroup(id) ? id : undefined;
  }

  async createGroup(name: string): Promise<string> {
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this._groups.push({ id, name });
    await this.save();
    return id;
  }

  async renameGroup(id: string, name: string): Promise<void> {
    const group = this.getGroup(id);
    if (!group || id === CHANGES_GROUP_ID) {
      return;
    }
    group.name = name;
    await this.save();
  }

  async deleteGroup(id: string): Promise<void> {
    if (id === CHANGES_GROUP_ID) {
      return;
    }
    this._groups = this._groups.filter(g => g.id !== id);
    for (const [fsPath, groupId] of Object.entries(this._assignments)) {
      if (groupId === id) {
        delete this._assignments[fsPath];
      }
    }
    await this.save();
  }

  async moveGroup(id: string, delta: -1 | 1): Promise<void> {
    const index = this._groups.findIndex(g => g.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this._groups.length) {
      return;
    }
    [this._groups[index], this._groups[target]] = [this._groups[target], this._groups[index]];
    await this.save();
  }

  /** Move `dragId` to the position currently held by `targetId` (drag & drop reorder). */
  async reorderGroup(dragId: string, targetId: string): Promise<void> {
    if (dragId === targetId) {
      return;
    }
    const from = this._groups.findIndex(g => g.id === dragId);
    if (from < 0) {
      return;
    }
    const [dragged] = this._groups.splice(from, 1);
    const to = this._groups.findIndex(g => g.id === targetId);
    if (to < 0) {
      this._groups.splice(from, 0, dragged);
      return;
    }
    this._groups.splice(to, 0, dragged);
    await this.save();
  }

  /** Assign files to a group; `undefined` or the Changes id moves them back to Changes. */
  async assign(fsPaths: string[], groupId: string | undefined): Promise<void> {
    for (const fsPath of fsPaths) {
      if (!groupId || groupId === CHANGES_GROUP_ID) {
        delete this._assignments[fsPath];
      } else {
        this._assignments[fsPath] = groupId;
      }
    }
    await this.save();
  }

  private async save(): Promise<void> {
    await this.state.update(GROUPS_KEY, this._groups);
    await this.state.update(ASSIGNMENTS_KEY, this._assignments);
    this._onDidChange.fire();
  }
}
