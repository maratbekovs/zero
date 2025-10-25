// routes/authRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, comparePassword } = require('../utils/auth');

const multer = require('multer');
const path = require('path');
const fs = require('fs');

/**
 * Проверяет, авторизован ли пользователь.
 */
function isAuthenticated(req, res, next) {
  if (req.session?.userId) return next();
  return res.status(401).json({ message: 'Требуется авторизация.' });
}

/**
 * Проверяет, является ли пользователь модератором или администратором.
 */
function isModeratorOrAdmin(req, res, next) {
  if (req.session?.userId && (req.session.userRole === 'moderator' || req.session.userRole === 'admin')) {
    return next();
  }
  return res.status(403).json({ message: 'Доступ запрещен. Требуется роль модератора/администратора.' });
}

/**
 * Проверяет, является ли пользователь администратором.
 */
function isAdmin(req, res, next) {
  if (req.session?.userId && req.session.userRole === 'admin') return next();
  return res.status(403).json({ message: 'Доступ запрещен. Требуется роль администратора.' });
}

// ---------------------------------------------------
// POST /api/auth/register-admin — регистрация первого администратора
// ---------------------------------------------------
router.post('/register-admin', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Требуется имя пользователя и пароль.' });

  try {
    const [adminCheck] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['admin']);
    if (adminCheck[0].count > 0) {
      return res.status(403).json({ message: 'Администратор уже зарегистрирован. Используйте логин.' });
    }

    const password_hash = await hashPassword(password);
    await pool.query(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
      [username, password_hash, 'admin']
    );

    res.status(201).json({ message: '✅ Первый администратор успешно зарегистрирован.' });
  } catch (error) {
    console.error('Ошибка регистрации администратора:', error);
    res.status(500).json({ message: 'Ошибка сервера при регистрации.' });
  }
});

// ---------------------------------------------------
// POST /api/auth/login — логин
// ---------------------------------------------------
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return res.status(400).json({ message: 'Введите имя пользователя и пароль.' });

  try {
    const [users] = await pool.query(
      'SELECT id, password_hash, role, full_name, phone_number, avatar_url FROM users WHERE username = ?',
      [username]
    );
    if (users.length === 0) return res.status(401).json({ message: 'Неверное имя пользователя или пароль.' });

    const user = users[0];
    const hash = user.password_hash || '';
    let isMatch = false;
    try {
      isMatch = hash ? await comparePassword(password, hash) : false;
    } catch (cmpErr) {
      console.error('Ошибка сравнения пароля (bcrypt):', cmpErr);
      isMatch = false;
    }
    if (!isMatch) return res.status(401).json({ message: 'Неверное имя пользователя или пароль.' });

    // Сессия
    req.session.userId = user.id;
    req.session.userRole = user.role;
    req.session.username = username;

    res.json({
      message: 'Успешный вход.',
      role: user.role,
      userId: user.id,
      username,
      full_name: user.full_name,
      phone_number: user.phone_number,
      avatar_url: user.avatar_url || null
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ message: 'Ошибка сервера при входе.' });
  }
});

// ---------------------------------------------------
// POST /api/auth/logout — выход
// ---------------------------------------------------
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ message: 'Не удалось завершить сессию.' });
    res.clearCookie('connect.sid');
    res.json({ message: 'Выход выполнен успешно.' });
  });
});

// ---------------------------------------------------
// GET /api/auth/status — статус + профиль (с avatar_url)
// ---------------------------------------------------
router.get('/status', async (req, res) => {
  if (!req.session?.userId) return res.json({ isLoggedIn: false });

  try {
    const [users] = await pool.query(
      'SELECT username, role, full_name, phone_number, avatar_url FROM users WHERE id = ?',
      [req.session.userId]
    );

    if (users.length > 0) {
      const user = users[0];
      res.json({
        isLoggedIn: true,
        role: user.role,
        userId: req.session.userId,
        username: user.username,
        full_name: user.full_name,
        phone_number: user.phone_number,
        avatar_url: user.avatar_url || null
      });
    } else {
      res.json({ isLoggedIn: true, role: req.session.userRole, userId: req.session.userId, username: req.session.username });
    }
  } catch (error) {
    console.error('Ошибка /auth/status:', error);
    res.status(500).json({ message: 'Ошибка сервера.' });
  }
});

// ---------------------------------------------------
// GET /api/auth/admin-exists — есть ли уже админ
// ---------------------------------------------------
router.get('/admin-exists', async (_req, res) => {
  try {
    const [adminCheck] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['admin']);
    const exists = adminCheck[0].count > 0;
    res.json({ adminExists: exists });
  } catch (error) {
    console.error('Ошибка проверки существования администратора:', error);
    res.status(500).json({ adminExists: true, message: 'Ошибка сервера.' });
  }
});

// ---------------------------------------------------
// GET /api/auth/vapid-public-key — публичный ключ VAPID
// ---------------------------------------------------
router.get('/vapid-public-key', (_req, res) => {
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  if (!pub) return res.status(500).json({ message: 'VAPID public key is not configured' });
  res.json({ publicKey: pub });
});

// ---------------------------------------------------
// POST /api/auth/save-subscription — сохранить push-подписку
// ---------------------------------------------------
router.post('/save-subscription', isAuthenticated, async (req, res) => {
  const { subscription } = req.body;
  const userId = req.session.userId;

  if (!subscription) return res.status(400).json({ message: 'Отсутствует подписка.' });

  try {
    await pool.query('UPDATE users SET push_subscription = ? WHERE id = ?', [JSON.stringify(subscription), userId]);
    res.json({ message: 'Подписка сохранена.' });
  } catch (error) {
    console.error('Ошибка сохранения подписки:', error);
    res.status(500).json({ message: 'Ошибка сервера при сохранении подписки.' });
  }
});

// ---------------------------------------------------
// POST /api/auth/update-profile — обновить ФИО/телефон
// ---------------------------------------------------
router.post('/update-profile', isAuthenticated, async (req, res) => {
  const { fullName, phoneNumber } = req.body;
  const userId = req.session.userId;

  try {
    await pool.query(
      'UPDATE users SET full_name = ?, phone_number = ? WHERE id = ?',
      [fullName || null, phoneNumber || null, userId]
    );
    res.json({ message: 'Данные успешно обновлены.' });
  } catch (error) {
    console.error('Ошибка обновления профиля:', error);
    res.status(500).json({ message: 'Ошибка сервера при обновлении данных.' });
  }
});

// ======================== АВАТАР =========================

// Хранилище для аватаров
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.png') || '.png';
    cb(null, `u${req.session.userId}-${Date.now()}${ext}`);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
}).single('avatar');

// POST /api/auth/upload-avatar — загрузка аватара текущего пользователя
router.post('/upload-avatar', isAuthenticated, (req, res) => {
  uploadAvatar(req, res, async (err) => {
    if (err || !req.file) {
      return res.status(400).json({ message: 'Ошибка загрузки аватара.' });
    }
    const relUrl = `/uploads/avatars/${req.file.filename}`;
    try {
      await pool.query('UPDATE users SET avatar_url = ? WHERE id = ?', [relUrl, req.session.userId]);
      return res.json({ message: 'Аватар обновлен.', avatar_url: relUrl });
    } catch (e) {
      return res.status(500).json({ message: 'Ошибка сохранения аватара.' });
    }
  });
});

// ---------------------------------------------------
// GET /api/auth/ticket-summary/:ticketId — сводка для хедера чата
// Пользователь видит только модератора (без телефона), модератор — пользователя с телефоном.
// ---------------------------------------------------
router.get('/ticket-summary/:ticketId', isAuthenticated, async (req, res) => {
  const ticketId = req.params.ticketId;
  const myRole = req.session.userRole;
  try {
    const [tickets] = await pool.query(
      'SELECT user_id, moderator_id FROM tickets WHERE id = ?',
      [ticketId]
    );
    if (!tickets.length) return res.status(404).json({ message: 'Тикет не найден.' });

    const t = tickets[0];
    if (myRole === 'user') {
      if (!t.moderator_id) return res.json({ moderator: null });
      const [mods] = await pool.query(
        'SELECT username, full_name, avatar_url FROM users WHERE id = ?',
        [t.moderator_id]
      );
      const m = mods[0] || {};
      return res.json({
        moderator: {
          username: m.username || null,
          full_name: m.full_name || null,
          avatar_url: m.avatar_url || null
        }
      });
    } else {
      // moderator/admin
      const [users] = await pool.query(
        'SELECT username, full_name, phone_number, avatar_url FROM users WHERE id = ?',
        [t.user_id]
      );
      const u = users[0] || {};
      return res.json({
        user: {
          username: u.username || null,
          full_name: u.full_name || null,
          phone_number: u.phone_number || null,
          avatar_url: u.avatar_url || null
        }
      });
    }
  } catch (e) {
    console.error('ticket-summary error:', e);
    res.status(500).json({ message: 'Ошибка сервера.' });
  }
});

module.exports = {
  router,
  isAuthenticated,
  isModeratorOrAdmin,
  isAdmin
};