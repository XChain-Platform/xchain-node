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
 * XChain Node - the liveness probe
 *
 * The cheapest statement a server will answer, used to tell "the port is open"
 * from "the server is actually serving". It lives here rather than inline at its
 * three call sites for the same reason every other statement does: SQL has one
 * home, however short the SQL is.
 *
 ********************************************************************/

const PING_SQL = 'SELECT 1'

module.exports = { PING_SQL }
