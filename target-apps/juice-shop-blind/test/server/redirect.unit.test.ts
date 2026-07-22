/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { challenges } from '../../data/datacache'
import { performRedirect } from '../../routes/redirect'
import { type Challenge } from '@juice-shop/data/types'
import { redirectAllowlist } from '../../lib/insecurity'

void describe('redirect', () => {
  let req: any
  let res: any
  let next: any
  let save: any

  beforeEach(() => {
    req = { query: {} }
    res = { redirect: mock.fn(), status: mock.fn() }
    next = mock.fn()
    save = () => ({
      then () { }
    })
  })

  void describe('should be performed for all allowlisted URLs', () => {
    for (const url of redirectAllowlist) {
      void it(url, () => {
        req.query.to = url

        performRedirect()(req, res, next)

        assert.equal(res.redirect.mock.calls.length, 1)
        assert.equal(res.redirect.mock.calls[0].arguments[0], url)
      })
    }
  })

  void it('should raise error for URL not on allowlist', () => {
    req.query.to = 'http://kimminich.de'

    performRedirect()(req, res, next)

    assert.equal(res.redirect.mock.calls.length, 0)
    assert.equal(next.mock.calls.length, 1)
    assert.ok(next.mock.calls[0].arguments[0] instanceof Error)
  })




})
