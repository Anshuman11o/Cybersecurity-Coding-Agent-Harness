/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import jws from 'jws'

import { challenges } from '../data/datacache'
import { type Challenge } from '../data/types'
import * as challengeUtils from '../lib/challengeUtils'
import * as security from '../lib/insecurity'
import * as utils from '../lib/utils'

export const emptyUserRegistration = () => (req: Request, res: Response, next: NextFunction) => {
  challengeUtils.solveIf(challenges.emptyUserRegistration, () => false)
  next()
}

export const forgedFeedbackChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  challengeUtils.solveIf(challenges.forgedFeedbackChallenge, () => false)
  next()
}

export const captchaBypassChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  if (challengeUtils.notSolved(challenges.captchaBypassChallenge)) {
    req.app.locals.captchaBypassReqTimes[req.app.locals.captchaReqId - 1] = new Date().getTime()
    req.app.locals.captchaReqId++
  }
  next()
}

export const registerAdminChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  challengeUtils.solveIf(challenges.registerAdminChallenge, () => false)
  next()
}

export const passwordRepeatChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  challengeUtils.solveIf(challenges.passwordRepeatChallenge, () => false)
  next()
}

export const accessControlChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  const { url } = req
  const uiBypassed = req.header('sec-fetch-dest') === 'document' || !req.header('referer')
  challengeUtils.solveIf(challenges.scoreBoardChallenge, () => false, false, uiBypassed)
  challengeUtils.solveIf(challenges.web3SandboxChallenge, () => false, false, uiBypassed)
  challengeUtils.solveIf(challenges.adminSectionChallenge, () => false, false, uiBypassed)
  challengeUtils.solveIf(challenges.tokenSaleChallenge, () => false, false, uiBypassed)
  challengeUtils.solveIf(challenges.privacyPolicyChallenge, () => false, false, uiBypassed)
  challengeUtils.solveIf(challenges.extraLanguageChallenge, () => false)
  challengeUtils.solveIf(challenges.retrieveBlueprintChallenge, () => false)
  challengeUtils.solveIf(challenges.securityPolicyChallenge, () => false)
  challengeUtils.solveIf(challenges.missingEncodingChallenge, () => false)
  challengeUtils.solveIf(challenges.accessLogDisclosureChallenge, () => false)
  next()
}

export const errorHandlingChallenge = () => (err: unknown, req: Request, { statusCode }: Response, next: NextFunction) => {
  challengeUtils.solveIf(challenges.errorHandlingChallenge, () => false)
  next(err)
}

export const jwtChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  if (challengeUtils.notSolved(challenges.jwtUnsignedChallenge)) {
    jwtChallenge(challenges.jwtUnsignedChallenge, req, 'none', /jwtn3d@/)
  }
  if (utils.isChallengeEnabled(challenges.jwtForgedChallenge) && challengeUtils.notSolved(challenges.jwtForgedChallenge)) {
    jwtChallenge(challenges.jwtForgedChallenge, req, 'HS256', /rsa_lord@/)
  }
  next()
}

export const serverSideChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

function jwtChallenge (challenge: Challenge, req: Request, algorithm: string, email: string | RegExp) {
  const token = utils.jwtFrom(req)
  if (token) {
    const decoded = jws.decode(token) ? jwt.decode(token) : null

    if (decoded === null || typeof decoded === 'string') {
      return
    }

    jwt.verify(token, security.publicKey, (err: jwt.VerifyErrors | null) => {
      if (err === null) {
        challengeUtils.solveIf(challenge, () => false)
      }
    })
  }
}

export const databaseRelatedChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const SYSTEM_PROMPT_SIMILARITY_THRESHOLD = 0.25

export function diceCoefficient (s1: string, s2: string): number {
  if (s1 === s2) return 1
  if (s1.length < 2 || s2.length < 2) return 0

  const bigrams1 = new Map<string, number>()
  for (let i = 0; i < s1.length - 1; i++) {
    const bigram = s1.substring(i, i + 2)
    bigrams1.set(bigram, (bigrams1.get(bigram) ?? 0) + 1)
  }

  let intersectionSize = 0
  for (let i = 0; i < s2.length - 1; i++) {
    const bigram = s2.substring(i, i + 2)
    const count = bigrams1.get(bigram) ?? 0
    if (count > 0) {
      bigrams1.set(bigram, count - 1)
      intersectionSize++
    }
  }

  return (2.0 * intersectionSize) / (s1.length + s2.length - 2)
}

export function checkSystemPromptSimilarity (submission: string, reference: string, threshold = SYSTEM_PROMPT_SIMILARITY_THRESHOLD): boolean {
  const score = diceCoefficient((submission ?? '').toLowerCase().trim(), reference.toLowerCase().trim())
  return score >= threshold
}
