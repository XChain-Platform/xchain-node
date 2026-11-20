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
 * XChain Node - Regtest gate arm inventory
 *
 * The shared list follows the ENV_READERS order in the hub and indexer gate
 * registries. regtest_gate_arm_parity.test.js enforces both registries and the
 * hub-only gate against these arrays.
 ********************************************************************/

'use strict'

const SHARED_REGTEST_GATE_ARMS = Object.freeze([
    'XC_ANCHOR_FOLD_REGTEST_ACTIVATION',
    'XC_ANCHOR_STAKE_REGTEST_ACTIVATION',
    'XC_ANCHOR_SLASH_REGTEST_ACTIVATION',
    'XC_ROLLCALL_REGTEST_ACTIVATION',
    'XC_ROLLCALL_GATES_REGTEST_ACTIVATION',
    'XC_MIRROR_ADMISSION_ACTIVATION',
    'XC_AMOUNTS_PRICE_REGTEST_ACTIVATION',
    'XC_AMOUNTS_PRICE_REGTEST_TIME',
    'XC_CONTRACTS_REGTEST_ACTIVATION',
    'XC_LISTS_MARKET_REGTEST_ACTIVATION',
    'XC_LISTS_MARKET_REGTEST_TIME',
    'XC_REMOTE_TOKEN_ADMISSION_REGTEST_ACTIVATION',
    'XC_PASS_PROGRESS_RETIREMENT_REGTEST_ACTIVATION',
    'XC_SLASH_HISTORICAL_SET_REGTEST_ACTIVATION',
    'XC_ANCHOR_REWARD_COPY_SELECTION_REGTEST_ACTIVATION',
    'XC_TOKEN_SUPPLY_REPRESENTATION_REGTEST_ACTIVATION',
    'XC_DISPENSER_FIAT_PRICING_REGTEST_ACTIVATION',
    'XC_BRIDGE_POLICY_APPLY_ORDER_REGTEST_ACTIVATION',
    'XC_VM_EMISSION_AMOUNT_FORMAT_REGTEST_ACTIVATION',
    'XC_EXECUTE_FEE_CAP_REGTEST_ACTIVATION',
    'XC_EXECUTE_NATIVE_METERED_GAS_REGTEST_ACTIVATION',
    'XC_VOTE_V3_TICK_EXISTENCE_REGTEST_ACTIVATION',
    'XC_MATCH_ORIGIN_OPEN_REGTEST_ACTIVATION',
    'XC_MATCH_EQUAL_PRICE_OLDEST_FIRST_REGTEST_ACTIVATION',
    'XC_REASSEMBLE_CHUNK_PARENT_STATUS_REGTEST_ACTIVATION',
    'XC_UNSTAKE_DELEGATED_ROW_JOURNAL_REGTEST_ACTIVATION',
    'XC_ANCHOR_CHECKPOINT_SEQ_BIND_REGTEST_ACTIVATION',
    'XC_DIVIDEND_EMPTY_ALLOW_LIST_DENIES_REGTEST_ACTIVATION',
    'XC_AIRDROP_ZERO_LEGS_OMITTED_REGTEST_ACTIVATION',
    'XC_TICK_NORMALIZE_REGTEST_ACTIVATION'
])

const HUB_ONLY_REGTEST_GATE_ARMS = Object.freeze([
    'XC_OFFER_LIST_REGTEST_ACTIVATION'
])

module.exports = { SHARED_REGTEST_GATE_ARMS, HUB_ONLY_REGTEST_GATE_ARMS }
