-- *********************************************************************
--
-- Copyright © 2025-2026 Dankest, LLC
-- Based on XChain Platform by Dankest, LLC - https://dankest.llc
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
--
-- This file is part of XChain Platform. Licensed under the GNU Affero
-- General Public License v3.0 or later; see LICENSE.md.
--
-- *********************************************************************
CREATE TABLE IF NOT EXISTS {{MODULES_TABLE}} (
    module       VARCHAR(64)  NOT NULL,
    coin         VARCHAR(32)  NOT NULL DEFAULT '',
    network      VARCHAR(32)  NOT NULL DEFAULT '',
    container_id VARCHAR(128) NOT NULL,
    created_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (module, coin, network)
)
