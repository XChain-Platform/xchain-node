/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Shared eslint flat config for the xchain-* service repos: the file-level
 * half of the code-style rules, for editors and `npm run lint`.
 *
 * VENDORED COPY. The master lives in the platform tree and is copied here
 * rather than imported, because a public clone of this repo has no platform
 * tree beside it. Core rules only, no plugins, so this file has exactly one
 * dependency. Everything above the "What this repo adds" banner at the bottom
 * is the shared preset verbatim; keep it that way so a refresh is a copy.
 *
 * The pre-push gate (check-code-structure.js) does not depend on eslint or
 * on this file; the two agree on the rules but the gate is what binds.
 */
'use strict';

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
        'no-underscore-dangle': ['error', { enforceInMethodNames: true, allowAfterThis: false, allowFunctionParams: false }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: ['src/config.js', 'src/api.js', 'src/migrate.js', 'src/index.js', 'bin/**/*.js'],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

/*
 * What this repo adds to the shared preset, and why each one is here rather
 * than a rule someone forgot to fix.
 *
 * THE PRINTS ARE THE PRODUCT. This is a command-line tool, not a daemon: the
 * four paths below print to a human who ran a command and is reading the
 * answer. Routing them through a logger would change what that person sees,
 * which is why the same four paths carry a byte-identical-output contract and
 * are itemized here rather than waved through as a count. Everything else in
 * src/ goes through the logger and keeps the shared preset's no-console.
 *
 * THE CONFIG HOME IS A DIRECTORY. The preset names a single src/config.js
 * because that is the shape of a service; here the env reads live under
 * src/config/, so the process.env restriction lifts for that directory and
 * nowhere else.
 *
 * scripts/ IS TOOLING. Operator commands print for the same reason bin/ does.
 */
const nodePrints = {
    files: [
        'src/cli.js',
        'src/precheck.js',
        'src/ui/**/*.js',
        'src/operations/**/*.js',
        'scripts/**/*.js',
    ],
    rules: {
        'no-console': 'off',
    },
};

const nodeConfigHome = {
    files: ['src/config/**/*.js'],
    rules: {
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

module.exports = [src, configAndEntry, tests, nodePrints, nodeConfigHome];
