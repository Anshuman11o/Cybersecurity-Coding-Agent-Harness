import { Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'

export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
})

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  res.on('finish', () => {
    const duration = Date.now() - start
    console.log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`)
  })
  next()
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  console.error(err.stack)
  res.status(500).json({ error: 'Internal server error', message: err.message })
}
