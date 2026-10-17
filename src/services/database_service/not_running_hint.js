'use strict'

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pick the recovery hint for a MariaDB container that exists but is not running, by its Docker state.
// Every hint is read-only or a plain resume: none removes, recreates or auto-starts the container.
function notRunningHint(dbState, name) {
    // `docker start` acts only on a stopped (exited) or never-started (created) container.
    if (dbState === 'exited' || dbState === 'created') return "run: docker start " + name
    // A crash-loop under --restart unless-stopped: start does nothing, and the cause is in the logs.
    if (dbState === 'restarting') return "it is crash-looping; find the cause with: docker logs " + name
    // Docker refuses to start a paused container; it must be unpaused.
    if (dbState === 'paused') return "run: docker unpause " + name
    // Any other state (dead, removing) needs a look before anything is started or removed.
    return "inspect it with: docker inspect " + name + " and docker logs " + name
}

module.exports = { notRunningHint }
