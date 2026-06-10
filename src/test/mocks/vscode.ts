/**
 * Minimal in-memory stand-in for the `vscode` module so the extension's
 * library code can be unit-tested in plain Node. Only the APIs actually
 * used by groupStore.ts and treeProvider.ts are implemented.
 */

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => unknown>();

  readonly event = (listener: (e: T) => unknown) => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  fire(e: T): void {
    for (const listener of [...this.listeners]) {
      listener(e);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }

  constructor(private readonly callOnDispose: () => unknown) {}

  dispose(): void {
    this.callOnDispose();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  resourceUri?: unknown;
  iconPath?: unknown;
  command?: unknown;

  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
  ) {}
}

export class ThemeIcon {
  constructor(public readonly id: string) {}
}

export class DataTransferItem {
  constructor(public readonly value: unknown) {}
}

export class DataTransfer {
  private readonly items = new Map<string, DataTransferItem>();

  get(mime: string): DataTransferItem | undefined {
    return this.items.get(mime);
  }

  set(mime: string, item: DataTransferItem): void {
    this.items.set(mime, item);
  }
}
