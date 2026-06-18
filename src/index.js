#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Node - Entry point
 *
 ********************************************************************/

// Node version guard. Must run BEFORE any require() that transitively pulls
// in `mariadb` (cli → precheck → state → MariaDbStore). `mariadb` is ESM-only,
// and require()-ing an ES module only works on Node 22+. On Node 18/20 the
// load chain dies with a cryptic ERR_REQUIRE_ESM stack trace; fail fast here
// with an actionable message instead. Keep this dependency-free.
const MIN_NODE_MAJOR = 22
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10)
if (nodeMajor < MIN_NODE_MAJOR) {
    console.error(
        `xchain-node requires Node.js ${MIN_NODE_MAJOR} or newer (current: v${process.versions.node}).\n` +
        `The 'mariadb' driver is ESM-only and cannot be loaded on older Node.\n` +
        `Install Node ${MIN_NODE_MAJOR} LTS (e.g. \`nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}\`) and re-run.`
    )
    process.exit(1)
}

require('dotenv').config()

const { parseCommand } = require('./cli')

parseCommand()
