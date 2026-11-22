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
 ********************************************************************/

module.exports = {
    retroactive_replay: (coin, network) =>
        "a retroactive boot replay is applying blocks under the current consensus rules. It needs no operator action"
        + " and clears when the replay reaches its target; a restart does not shorten it."
        + " `xchain-node logs xchain-indexer " + coin + " " + network + "` shows its progress.",
    decoder_block_time_unavailable: (coin, network) =>
        "the decoder has no usable block time for the next block, so the indexer defers it and retries each pass."
        + " This is a decoder-side gap, and restarting the indexer does not supply the row; check the xchain-decoder line"
        + " in `ps` and `xchain-node logs xchain-decoder " + coin + " " + network + "`, then look for the decoder block"
        + " time unavailable warning in `xchain-node logs xchain-indexer " + coin + " " + network + "`."
}
