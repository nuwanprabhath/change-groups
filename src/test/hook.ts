/**
 * Mocha --require hook: redirects require('vscode') to the in-memory mock
 * so code under test can load outside the VS Code extension host.
 * Must be registered before any test file imports extension sources.
 */
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') {
    return path.join(__dirname, 'mocks', 'vscode.js');
  }
  return originalResolve.call(this, request, ...rest);
};
