/**
 * Minimal typings for the built-in `vscode.git` extension API (version 1).
 * Mirrors the relevant parts of
 * https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
import * as vscode from 'vscode';

export const enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,

  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,

  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED
}

export interface Change {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly mergeChanges: Change[];
  readonly untrackedChanges: Change[];
  readonly onDidChange: vscode.Event<void>;
}

export interface RepositoryUIState {
  /** Whether the repository is selected in the Source Control "Repositories" section. */
  readonly selected: boolean;
  readonly onDidChange: vscode.Event<void>;
}

export interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: RepositoryState;
  readonly ui: RepositoryUIState;
  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
}

export interface API {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly onDidCloseRepository: vscode.Event<Repository>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}
