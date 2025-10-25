// routes/adminRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword } = require('../utils/auth');
const { isModeratorOrAdmin } = require('./middlewares');
const { isAdmin } = require('./authRoutes');

/**
 * POST /api/admin/create-user
 * Создать пользователя/модератора. Доступно модератору/админу.
 */
router.post('/create-user', isModeratorOrAdmin, async (req, res) => {
  const { username, password, role = 'user', full_name = null, phone_number = null } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ message: 'Требуются username и password.' });
  }
  if (!['user', 'moderator'].includes(role)) {
    return res.status(400).json({ message: 'Неверная роль. Допустимо: user, moderator.' });
  }

  try {
    const [exists] = await pool.query('SELECT COUNT(*) AS cnt FROM users WHERE username = ?', [username]);
    if (exists[0]?.cnt > 0) {
      return res.status(409).json({ message: 'Пользователь с таким именем уже существует.' });
    }

    const password_hash = await hashPassword(password);
    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, role, full_name, phone_number) VALUES (?, ?, ?, ?, ?)',
      [username, password_hash, role, full_name, phone_number]
    );

    return res.status(201).json({
      message: `✅ Пользователь/Модератор '${username}' успешно создан.`,
      userId: result.insertId,
      role
    });
  } catch (error) {
    console.error('Ошибка создания пользователя:', error);
    return res.status(500).json({ message: 'Ошибка сервера при регистрации.' });
  }
});

// GET /api/admin/moderators — список модераторов (только админ)
router.get('/moderators', isAdmin, async (_req, res) => {
  try {
    const [mods] = await pool.query(
      "SELECT id, username, full_name, avatar_url FROM users WHERE role = 'moderator' ORDER BY username"
    );
    res.json(mods);
  } catch (e) {
    console.error('Ошибка получения списка модераторов:', e);
    res.status(500).json({ message: 'Ошибка сервера при получении модераторов.' });
  }
});

/**
 * GET /api/admin/users
 * Список пользователей (без админов). Доступ модератору/админу.
 */
router.get('/users', isModeratorOrAdmin, async (_req, res) => {
  try {
    const [users] = await pool.query(
      "SELECT id, username, role, full_name, phone_number, avatar_url, created_at FROM users WHERE role <> 'admin' ORDER BY id DESC"
    );
    res.json(users);
  } catch (error) {
    if (error && (error.code === 'ER_BAD_FIELD_ERROR' || String(error.message || '').includes('Unknown column'))) {
      try {
        const [usersNoCreated] = await pool.query(
          "SELECT id, username, role, full_name, phone_number, avatar_url FROM users WHERE role <> 'admin' ORDER BY id DESC"
        );
        const normalized = usersNoCreated.map(u => ({ ...u, created_at: null }));
        return res.json(normalized);
      } catch (e2) {
        console.error('Ошибка получения списка пользователей (fallback):', e2);
        return res.status(500).json({ message: 'Ошибка сервера при получении списка.' });
      }
    }
    console.error('Ошибка получения списка пользователей:', error);
    res.status(500).json({ message: 'Ошибка сервера при получении списка.' });
  }
});

/**
 * GET /api/admin/report
 * Отчет за период. Доступ модератору/админу.
 */
router.get('/report', isModeratorOrAdmin, async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ message: 'Требуются даты начала (startDate) и окончания (endDate).' });
  }

  const endDateTime = new Date(endDate);
  endDateTime.setDate(endDateTime.getDate() + 1);

  try {
    const [reports] = await pool.query(`
      SELECT 
        t.id AS ticket_id,
        t.subject,
        t.status,
        t.created_at,
        t.closed_at,
        DATEDIFF(t.closed_at, t.created_at) AS days_spent,
        u_user.username  AS client_username,
        u_user.full_name AS client_full_name,
        u_mod.username   AS moderator_username
      FROM tickets t
      JOIN users u_user ON t.user_id = u_user.id
      LEFT JOIN users u_mod ON t.moderator_id = u_mod.id
      WHERE t.created_at >= ? AND t.created_at < ?
      ORDER BY t.created_at ASC
    `, [startDate, endDateTime.toISOString().slice(0, 19).replace('T', ' ')]);

    res.json(reports);
  } catch (error) {
    console.error('Ошибка построения отчета:', error);
    res.status(500).json({ message: 'Ошибка сервера при построении отчета.' });
  }
});

module.exports = router;