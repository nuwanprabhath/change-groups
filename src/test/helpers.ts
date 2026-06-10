import { API, Change, Repository, Status } from '../git';
import { EventEmitter } from './mocks/vscode';

/** In-memory vscode.Memento. */
export class MemoryMemento {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.store.has(key) ? (this.store.get(key) as T) : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      // Mimic real Memento behavior: values round-trip through JSON.
      this.store.set(key, JSON.parse(JSON.stringify(value)));
    }
  }

  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

export function makeChange(fsPath: string, status: Status): Change {
  return {
    uri: { fsPath } as never,
    originalUri: { fsPath } as never,
    renameUri: undefined,
    status
  };
}

export interface FakeRepo extends Repository {
  state: Repository['state'] & {
    indexChanges: Change[];
    workingTreeChanges: Change[];
    mergeChanges: Change[];
    untrackedChanges: Change[];
  };
  /** Recorded calls to add/revert/clean. */
  added: string[][];
  reverted: string[][];
  cleaned: string[][];
  setSelected(selected: boolean): void;
  fireStateChange(): void;
}

export function makeRepo(root: string, options: { selected?: boolean } = {}): FakeRepo {
  const stateEmitter = new EventEmitter<void>();
  const uiEmitter = new EventEmitter<void>();
  const ui = { selected: options.selected ?? true, onDidChange: uiEmitter.event };
  const repo = {
    rootUri: { fsPath: root },
    state: {
      indexChanges: [] as Change[],
      workingTreeChanges: [] as Change[],
      mergeChanges: [] as Change[],
      untrackedChanges: [] as Change[],
      onDidChange: stateEmitter.event
    },
    ui,
    added: [] as string[][],
    reverted: [] as string[][],
    cleaned: [] as string[][],
    async add(paths: string[]) {
      repo.added.push(paths);
    },
    async revert(paths: string[]) {
      repo.reverted.push(paths);
    },
    async clean(paths: string[]) {
      repo.cleaned.push(paths);
    },
    setSelected(selected: boolean) {
      ui.selected = selected;
      uiEmitter.fire();
    },
    fireStateChange() {
      stateEmitter.fire();
    }
  };
  return repo as unknown as FakeRepo;
}

export interface FakeGit {
  api: API;
  openRepo(repo: FakeRepo): void;
  closeRepo(repo: FakeRepo): void;
}

export function makeGitApi(repos: FakeRepo[]): FakeGit {
  const openEmitter = new EventEmitter<Repository>();
  const closeEmitter = new EventEmitter<Repository>();
  const stateEmitter = new EventEmitter<'uninitialized' | 'initialized'>();
  const repositories = [...repos] as unknown as Repository[];
  const api = {
    state: 'initialized',
    git: { path: 'git' },
    onDidChangeState: stateEmitter.event,
    repositories,
    onDidOpenRepository: openEmitter.event,
    onDidCloseRepository: closeEmitter.event,
    toGitUri: (uri: { fsPath: string }, ref: string) => ({ fsPath: uri.fsPath, ref })
  } as unknown as API;
  return {
    api,
    openRepo(repo: FakeRepo) {
      repositories.push(repo as unknown as Repository);
      openEmitter.fire(repo as unknown as Repository);
    },
    closeRepo(repo: FakeRepo) {
      const index = repositories.indexOf(repo as unknown as Repository);
      if (index >= 0) {
        repositories.splice(index, 1);
      }
      closeEmitter.fire(repo as unknown as Repository);
    }
  };
}
