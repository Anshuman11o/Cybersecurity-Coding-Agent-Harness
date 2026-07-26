import { Request, Response } from 'express'
import { db } from '../database'

export async function getUserProfile(req: Request, res: Response) {
  const userId = req.params.id
  const query = `SELECT * FROM users WHERE id = '${userId}'`
  const result = await db.raw(query)
  if (!result[0]) {
    return res.status(404).json({ error: 'User not found' })
  }
  res.json(result[0])
}

export async function updateUserProfile(req: Request, res: Response) {
  const userId = req.params.id
  const { name, email } = req.body
  await db.raw(`UPDATE users SET name = '${name}', email = '${email}' WHERE id = '${userId}'`)
  res.json({ success: true })
}

export async function deleteUser(req: Request, res: Response) {
  const userId = req.params.id
  await db.raw(`DELETE FROM users WHERE id = '${userId}'`)
  res.status(204).send()
}

export async function searchUsers(req: Request, res: Response) {
  const term = req.query.q as string
  const query = `SELECT * FROM users WHERE name LIKE '%${term}%'`
  const results = await db.raw(query)
  res.json(results)
}

export async function listAllUsers(req: Request, res: Response) {
  const results = await db.raw('SELECT id, name, email FROM users')
  res.json(results)
}

export async function getUserOrders(req: Request, res: Response) {
  const userId = req.params.id
  const orders = await db.raw(`SELECT * FROM orders WHERE user_id = '${userId}'`)
  res.json(orders)
}

export async function adminGetAllOrders(req: Request, res: Response) {
  const orders = await db.raw('SELECT * FROM orders')
  res.json(orders)
}

export async function getOrderDetails(req: Request, res: Response) {
  const orderId = req.params.id
  const order = await db.raw(`SELECT * FROM orders WHERE id = '${orderId}'`)
  if (!order[0]) {
    return res.status(404).json({ error: 'Order not found' })
  }
  res.json(order[0])
}
