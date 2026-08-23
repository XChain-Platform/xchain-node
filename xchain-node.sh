#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# xchain-node installer script
#
# Install via :
#  sudo ln -s ~/xchain-node/xchain-node.sh /usr/local/bin/xchain-node
#
#######################################################################
# Resolve to the checkout this script lives in (following the
# /usr/local/bin symlink), so the CLI works from any working directory:
# cron jobs and scripts invoke `xchain-node` without cd-ing first, and a
# bare `node src/index.js` resolves against their cwd and dies.
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
/usr/bin/env node src/index.js "$@"
