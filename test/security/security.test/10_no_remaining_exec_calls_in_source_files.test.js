'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const path       = require('path')

describe('Security', function () {
    // Verify no remaining exec() calls in source
    describe('No remaining exec() calls in source files', function () {
        const fs = require('fs')
        const srcDir = path.join(__dirname, '../../../src')

        function getAllJsFiles(dir) {
            const files = []
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) files.push(...getAllJsFiles(full))
                else if (entry.name.endsWith('.js')) files.push(full)
            }
            return files
        }

        const jsFiles = getAllJsFiles(srcDir)

        for (const file of jsFiles) {
            const relPath = path.relative(srcDir, file)
            it(`${relPath} does not use child_process.exec()`, function () {
                const source = fs.readFileSync(file, 'utf8')
                // Flags a bare exec( (imported child_process.exec), skipping comment
                // and require('child_process') lines and excluding execFile/execFileAsync.
                const lines = source.split('\n')
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim()
                    if (line.startsWith('//') || line.startsWith('*')) continue
                    if (line.includes("require('child_process')")) continue
                    // Check for a BARE exec( (the imported child_process.exec), but not a
                    // method call like RegExp.prototype.exec (`re.exec(...)`) or execFile(.
                    // Requiring the char before `exec` to be start-of-line or a non-dot,
                    // non-word char excludes `x.exec(` method calls (the false positive that
                    // flagged a regex `.exec`), while still catching a bare imported exec(.
                    if (/(^|[^.\w])exec\s*\(/.test(line) && !/\bexecFile/.test(line)) {
                        // Allow promisify references and variable names
                        if (/promisify/.test(line)) continue
                        if (/execAsync/.test(line)) continue
                        expect.fail(`${relPath}:${i + 1} contains exec() call: ${line}`)
                    }
                    // Also catch an aliased child_process.exec( (e.g. cp.exec / childProcess.exec)
                    if (/\b(child_?[pP]rocess|cp)\s*\.\s*exec\s*\(/.test(line)) {
                        expect.fail(`${relPath}:${i + 1} contains child_process.exec() call: ${line}`)
                    }
                    // Check for execSync
                    if (/\bexecSync\s*\(/.test(line)) {
                        expect.fail(`${relPath}:${i + 1} contains execSync() call: ${line}`)
                    }
                }
            })
        }
    })
})
