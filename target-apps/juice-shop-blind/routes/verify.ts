/*
 * Copyright (c) 2014-2026 Bjoern Kimminich & the OWASP Juice Shop contributors.
 * SPDX-License-Identifier: MIT
 */

import { type Request, type Response, type NextFunction } from 'express'

import { challenges } from '../data/datacache'
import * as challengeUtils from '../lib/challengeUtils'
import * as utils from '../lib/utils'

export const emptyUserRegistration = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const forgedFeedbackChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const captchaBypassChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  req.app.locals.captchaBypassReqTimes[req.app.locals.captchaReqId - 1] = new Date().getTime()
  req.app.locals.captchaReqId++
  next()
}

export const registerAdminChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const passwordRepeatChallenge = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const accessControlChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  const { url } = req
  const uiBypassed = req.header('sec-fetch-dest') === 'document' || !req.header('referer')
  next()
}

export const errorHandlingChallenge = () => (err: unknown, req: Request, { statusCode }: Response, next: NextFunction) => {
  next(err)
}

export const jwtChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
}

export const serverSideChallenges = () => (req: Request, res: Response, next: NextFunction) => {
  next()
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
