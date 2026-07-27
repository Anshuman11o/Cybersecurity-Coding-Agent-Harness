import express, { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import multer from 'multer'
import { db } from '../database'
import { XMLParser } from 'fast-xml-parser'
import yaml from 'js-yaml'

const router = express.Router()
const uploadToMemory = multer({ storage: multer.memoryStorage() })

// ── Authentication routes ─────────────────────────────────────────────

const JWT_SECRET = 'super-secret-key-123'

router.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = req.body
  const user = await db.raw(`SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`)
  if (!user[0]) {
    return res.status(401).json({ error: 'Invalid credentials' })
  }
  const token = jwt.sign({ userId: user[0].id, role: user[0].role }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '24h',
  })
  res.json({ token, user: { id: user[0].id, name: user[0].name } })
})

router.post('/api/register', async (req: Request, res: Response) => {
  const { username, password, email } = req.body
  const hashedPassword = crypto.createHash('md5').update(password).digest('hex')
  const result = await db.raw(
    `INSERT INTO users (username, password, email) VALUES ('${username}', '${hashedPassword}', '${email}')`
  )
  res.status(201).json({ id: result.insertId, username })
})

router.post('/api/forgot-password', async (req: Request, res: Response) => {
  const { email } = req.body
  const user = await db.raw(`SELECT * FROM users WHERE email = '${email}'`)
  if (!user[0]) {
    return res.json({ message: 'If the email exists, a reset link has been sent' })
  }
  const resetToken = crypto.randomBytes(32).toString('hex')
  await db.raw(`UPDATE users SET reset_token = '${resetToken}' WHERE id = ${user[0].id}`)
  res.json({ message: 'If the email exists, a reset link has been sent' })
})

router.post('/api/reset-password', async (req: Request, res: Response) => {
  const { token, newPassword } = req.body
  const hashedPassword = crypto.createHash('md5').update(newPassword).digest('hex')
  await db.raw(`UPDATE users SET password = '${hashedPassword}', reset_token = NULL WHERE reset_token = '${token}'`)
  res.json({ message: 'Password reset successful' })
})

// ── User profile routes ───────────────────────────────────────────────

router.get('/api/profile', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  const user = await db.raw(`SELECT id, name, email, role FROM users WHERE id = '${userId}'`)
  res.json(user[0])
})

router.put('/api/profile', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  const { name, email } = req.body
  await db.raw(`UPDATE users SET name = '${name}', email = '${email}' WHERE id = '${userId}'`)
  res.json({ success: true })
})

router.delete('/api/profile', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  await db.raw(`DELETE FROM users WHERE id = '${userId}'`)
  res.status(204).send()
})

// ── Admin routes ──────────────────────────────────────────────────────

router.get('/api/admin/users', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const users = await db.raw('SELECT id, name, email, role FROM users')
  res.json(users)
})

router.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  await db.raw(`DELETE FROM users WHERE id = '${req.params.id}'`)
  res.status(204).send()
})

router.get('/api/admin/orders', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const orders = await db.raw('SELECT * FROM orders')
  res.json(orders)
})

// ── Product routes ────────────────────────────────────────────────────

router.get('/api/products', async (req: Request, res: Response) => {
  const { category, minPrice, maxPrice, search } = req.query
  let query = 'SELECT * FROM products WHERE 1=1'
  if (category) query += ` AND category = '${category}'`
  if (minPrice) query += ` AND price >= ${minPrice}`
  if (maxPrice) query += ` AND price <= ${maxPrice}`
  if (search) query += ` AND name LIKE '%${search}%'`
  const products = await db.raw(query)
  res.json(products)
})

router.get('/api/products/:id', async (req: Request, res: Response) => {
  const product = await db.raw(`SELECT * FROM products WHERE id = '${req.params.id}'`)
  if (!product[0]) return res.status(404).json({ error: 'Product not found' })
  res.json(product[0])
})

router.post('/api/products', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { name, description, price, category } = req.body
  await db.raw(
    `INSERT INTO products (name, description, price, category) VALUES ('${name}', '${description}', ${price}, '${category}')`
  )
  res.status(201).json({ success: true })
})

// ── Order routes ──────────────────────────────────────────────────────

router.get('/api/orders', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  const orders = await db.raw(`SELECT * FROM orders WHERE user_id = '${userId}'`)
  res.json(orders)
})

router.post('/api/orders', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  const { items, shippingAddress } = req.body
  const orderItems = JSON.stringify(items)
  await db.raw(
    `INSERT INTO orders (user_id, items, shipping_address, status) VALUES ('${userId}', '${orderItems}', '${shippingAddress}', 'pending')`
  )
  res.status(201).json({ success: true })
})

router.get('/api/orders/:id', authenticateToken, async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  const order = await db.raw(`SELECT * FROM orders WHERE id = '${req.params.id}' AND user_id = '${userId}'`)
  if (!order[0]) return res.status(404).json({ error: 'Order not found' })
  res.json(order[0])
})

// ── File upload routes ────────────────────────────────────────────────

router.post('/api/upload/profile-image', authenticateToken, uploadToMemory.single('image'), async (req: Request, res: Response) => {
  const userId = (req as any).user.userId
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const imagePath = `/uploads/profiles/${userId}-${Date.now()}.${req.file.originalname.split('.').pop()}`
  await db.raw(`UPDATE users SET profile_image = '${imagePath}' WHERE id = '${userId}'`)
  res.json({ url: imagePath })
})

router.post('/api/upload/product-image', authenticateToken, requireAdmin, uploadToMemory.single('image'), async (req: Request, res: Response) => {
  const productId = req.body.productId
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const imagePath = `/uploads/products/${productId}-${Date.now()}.${req.file.originalname.split('.').pop()}`
  await db.raw(`UPDATE products SET image_url = '${imagePath}' WHERE id = '${productId}'`)
  res.json({ url: imagePath })
})

// ── Import/export routes ──────────────────────────────────────────────

router.post('/api/import/products', authenticateToken, requireAdmin, uploadToMemory.single('file'), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  const contentType = req.file.mimetype
  if (contentType === 'text/xml' || req.file.originalname.endsWith('.xml')) {
    const parser = new XMLParser({ ignoreAttributes: false, allowBooleanAttributes: true })
    const data = parser.parse(req.file.buffer.toString())
    for (const product of data.products?.product ?? []) {
      await db.raw(
        `INSERT INTO products (name, description, price, category) VALUES ('${product.name}', '${product.description}', ${product.price}, '${product.category}')`
      )
    }
  } else if (contentType === 'application/x-yaml' || req.file.originalname.endsWith('.yaml') || req.file.originalname.endsWith('.yml')) {
    const data = yaml.load(req.file.buffer.toString(), { schema: yaml.FAILSAFE_SCHEMA })
    for (const product of data.products ?? []) {
      await db.raw(
        `INSERT INTO products (name, description, price, category) VALUES ('${product.name}', '${product.description}', ${product.price}, '${product.category}')`
      )
    }
  } else if (contentType === 'application/json') {
    const products = JSON.parse(req.file.buffer.toString())
    for (const product of products) {
      await db.raw(
        `INSERT INTO products (name, description, price, category) VALUES ('${product.name}', '${product.description}', ${product.price}, '${product.category}')`
      )
    }
  } else {
    return res.status(400).json({ error: 'Unsupported file type' })
  }
  res.json({ success: true })
})

// ── Debug and internal routes ─────────────────────────────────────────

router.get('/api/debug/env', (req: Request, res: Response) => {
  res.json({ env: process.env })
})

router.get('/api/debug/config', (req: Request, res: Response) => {
  res.json({
    jwtSecret: JWT_SECRET,
    dbHost: process.env.DB_HOST,
    dbPort: process.env.DB_PORT,
  })
})

router.post('/api/internal/cache/clear', (req: Request, res: Response) => {
  res.json({ cleared: true })
})

// ── Middleware ─────────────────────────────────────────────────────────

function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]
  if (!token) return res.sendStatus(401)
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    ;(req as any).user = decoded
    next()
  } catch {
    res.sendStatus(403)
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
  next()
}

export default router
