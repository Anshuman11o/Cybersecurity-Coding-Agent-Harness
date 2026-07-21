/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import config from 'config'
import { challenges, products, setRetrieveBlueprintChallengeFile } from '../../data/datacache'
import type { Product, Challenge } from '@juice-shop/data/types'
import type { Product as ProductConfig } from '../../lib/config.schema'
import * as security from '../../lib/insecurity'
import { type UserModel } from '@juice-shop/models/user'
import * as verify from '../../routes/verify'
import { isWindows } from '../../lib/utils'

void describe('verify', () => {
  let req: any
  let res: any
  let next: any
  let save: any
  let err: any

  beforeEach(() => {
    req = { body: {}, headers: {}, header: mock.fn(() => undefined) }
    res = { json: mock.fn() }
    next = mock.fn()
    save = () => ({
      then () { }
    })
  })

  void describe('"forgedFeedbackChallenge"', () => {
    beforeEach(() => {
      security.authenticatedUsers.put('token12345', {
        data: {
          id: 42,
          email: 'test@juice-sh.op'
        } as unknown as UserModel
      })
      challenges.forgedFeedbackChallenge = { solved: false, save } as unknown as Challenge
    })




  })

  void describe('accessControlChallenges', () => {






  })

  void describe('"errorHandlingChallenge"', () => {
    beforeEach(() => {
      challenges.errorHandlingChallenge = { solved: false, save } as unknown as Challenge
    })


    void describe('is solved when an error occurs on a response with error', () => {
      const httpStatus = [402, 403, 404, 500]
      httpStatus.forEach(statusCode => {
      })
    })


    void describe('is not solved when no error occurs on a response with error', () => {
      const httpStatus = [401, 402, 404, 500]
      httpStatus.forEach(statusCode => {
      })
    })

    void it('should pass occurred error on to next route', () => {
      res.statusCode = 500
      err = new Error()

      verify.errorHandlingChallenge()(err, req, res, next)

      assert.equal(next.mock.calls.length, 1)
      assert.equal(next.mock.calls[0].arguments[0], err)
    })
  })

  void describe('databaseRelatedChallenges', () => {
    void describe('"changeProductChallenge"', () => {
      beforeEach(() => {
        challenges.changeProductChallenge = { solved: false, save } as unknown as Challenge
        products.osaft = { reload () { return { then (cb: any) { cb() } } } } as unknown as Product
      })



    })
  })

  void describe('jwtChallenges', () => {
    beforeEach(() => {
      challenges.jwtUnsignedChallenge = { solved: false, save } as unknown as Challenge
      challenges.jwtForgedChallenge = { solved: false, save, disabledEnv: 'Windows' } as unknown as Challenge
    })






  })

  void describe('diceCoefficient', () => {
    void it('should return 1 for identical strings', () => {
      assert.equal(verify.diceCoefficient('abc', 'abc'), 1)
    })

    void it('should return 1 for identical strings even if they are short', () => {
      assert.equal(verify.diceCoefficient('a', 'a'), 1)
    })

    void it('should return 0 for different strings if at least one is less than 2 characters', () => {
      assert.equal(verify.diceCoefficient('a', 'b'), 0)
      assert.equal(verify.diceCoefficient('a', 'abc'), 0)
    })

    void it('should return 0 for completely different strings', () => {
      assert.equal(verify.diceCoefficient('abc', 'def'), 0)
    })

    void it('should return correct coefficient for partially overlapping strings', () => {
      // 'night' bigrams: ni, ig, gh, ht
      // 'nacht' bigrams: na, ac, ch, ht
      // intersection: ht (1)
      // score: 2 * 1 / (5 + 5 - 2) = 0.25
      assert.equal(verify.diceCoefficient('night', 'nacht'), 0.25)
    })
  })

  void describe('checkSystemPromptSimilarity', () => {
    void it('should return true if similarity is above threshold', () => {
      const s1 = 'This is a test'
      const s2 = 'This is a test'
      assert.ok(verify.checkSystemPromptSimilarity(s1, s2))
    })

    void it('should return false if similarity is below threshold', () => {
      const s1 = 'This is a test'
      const s2 = 'Something completely different'
      assert.ok(!verify.checkSystemPromptSimilarity(s1, s2, 0.9))
    })
  })
})
