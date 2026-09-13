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
 * XChain Node - docker-exec'd MariaDB client helpers
 *
 * Builds `docker exec` invocations for the mariadb client family without
 * the password ever appearing in argv. A `-p<password>` argument is
 * world-readable on the host via /proc/<pid>/cmdline (and inside the
 * container via the exec'd client's cmdline), so the password is passed
 * through the MYSQL_PWD environment variable instead: a bare
 * `-e MYSQL_PWD` (no `=value`) makes docker forward the variable from
 * its own environment, which mariadb/mariadb-admin/mariadb-dump all
 * honor. The secret then lives only in process environments
 * (owner/root-readable), never in any argv.
 ********************************************************************/

function dockerMariadbArgs(containerId, mariadbArgs, { interactive = false } = {}) {
    const args = ['exec']
    if (interactive) args.push('-i')
    args.push('-e', 'MYSQL_PWD', containerId, ...mariadbArgs)
    return args
}

function mariadbEnv(password) {
    return { ...process.env, MYSQL_PWD: password }
}

module.exports = {
    dockerMariadbArgs,
    mariadbEnv
}
