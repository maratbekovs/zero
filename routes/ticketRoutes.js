// routes/ticketRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webPush = require('web-push');

const { pool } = require('../db');
const { isAuthenticated, isModeratorOrAdmin } = require('./authRoutes');

// Настройка VAPID для отправки push (если есть ключи)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Помощники отправки push
async function sendPushToUserId(userId, payload) {
  try {
    const [rows] = await pool.query('SELECT push_subscription FROM users WHERE id = ?', [userId]);
    if (!rows.length || !rows[0].push_subscription) return;
    let subscription = rows[0].push_subscription;
    if (typeof subscription === 'string') {
      try { subscription = JSON.parse(subscription); } catch { subscription = null; }
    }
    if (!subscription) return;
    await webPush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410) {
      await pool.query('UPDATE users SET push_subscription = NULL WHERE id = ?', [userId]);
    }
  }
}
async function sendPushToAllModerators(payload) {
  try {
    const [mods] = await pool.query(
      "SELECT id, push_subscription FROM users WHERE role IN ('moderator','admin') AND push_subscription IS NOT NULL"
    );
    for (const m of mods) {
      let subscription = m.push_subscription;
      if (typeof subscription === 'string') {
        try { subscription = JSON.parse(subscription); } catch { subscription = null; }
      }
      if (!subscription) continue;
      try { await webPush.sendNotification(subscription, JSON.stringify(payload)); }
      catch (e) {
        if (e.statusCode === 410) await pool.query('UPDATE users SET push_subscription = NULL WHERE id = ?', [m.id]);
      }
    }
  } catch {}
}

// --- Конфигурация Multer (хранение файлов вложений) ---
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename: (_req, file, cb) => cb(null, 'file-' + Date.now() + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (_req, file, cb) => {
    const ALLOWED_EXT = new Set([
      '.jpeg', '.jpg', '.png', '.gif', '.webp',
      '.pdf', '.doc', '.docx',
      '.mp4', '.webm', '.ogg', '.mov',
      '.heic', '.heif'
    ]);
    const ALLOWED_MIME_PREFIX = ['image/', 'video/'];
    const ALLOWED_MIME_EXACT = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/heic',
      'image/heif'
    ]);
    const ext = (path.extname(file.originalname || '') || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    const byExt = ALLOWED_EXT.has(ext);
    const byMime = ALLOWED_MIME_EXACT.has(mime) || ALLOWED_MIME_PREFIX.some(p => mime.startsWith(p));
    if (byExt && byMime) return cb(null, true);
    cb(new Error('Неподдерживаемый тип файла.'));
  }
});

// ---------------------------------------------------
// POST /api/tickets/new — создание тикета (с первым сообщением)
// ---------------------------------------------------
router.post('/new', isAuthenticated, upload.single('attachment'), async (req, res) => {
  const userId = req.session.userId;
  const { subject, description } = req.body;

  const messageText = description;
  const attachmentUrl = req.file ? `/uploads/${req.file.filename}` : null;

  if (!subject || !messageText) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ message: 'Требуется тема и текст обращения.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Тикет
    const [ticketResult] = await connection.query(
      'INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, ?)',
      [userId, subject, 'New']
    );
    const ticketId = ticketResult.insertId;

    // 2. Первое сообщение
    await connection.query(
      'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
      [ticketId, userId, messageText, attachmentUrl]
    );

    // 3. История статусов
    await connection.query(
      'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [ticketId, userId, null, 'New']
    );

    await connection.commit();

    res.status(201).json({
      message: '✅ Запрос успешно создан.',
      ticketId,
      status: 'New'
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка создания тикета:', error);
    res.status(500).json({ message: 'Ошибка сервера при создании запроса.' });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------
// GET /api/tickets/my — список тикетов текущего пользователя
// ---------------------------------------------------
router.get('/my', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;

  try {
    const [tickets] = await pool.query(
      `SELECT t.*, t.created_at AS updated_at, u.username AS moderator_username
       FROM tickets t
       LEFT JOIN users u ON t.moderator_id = u.id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC`,
      [userId]
    );
    res.json(tickets);
  } catch (error) {
    console.error('Ошибка получения тикетов:', error);
    res.status(500).json({ message: 'Ошибка сервера при загрузке тикетов.' });
  }
});

// ---------------------------------------------------
// GET /api/tickets/all — список всех тикетов (модераторы)
// ---------------------------------------------------
router.get('/all', isModeratorOrAdmin, async (_req, res) => {
  try {
    const [tickets] = await pool.query(`
      SELECT
        t.id,
        t.user_id,
        t.subject,
        t.status,
        t.created_at,
        u_user.username AS user_username,
        u_user.full_name AS user_full_name,
        u_user.phone_number AS user_phone,
        u_mod.username AS moderator_username
      FROM tickets t
      JOIN users u_user ON t.user_id = u_user.id
      LEFT JOIN users u_mod ON t.moderator_id = u_mod.id
      ORDER BY t.status = 'New' DESC, t.created_at ASC
    `);

    res.json(tickets);
  } catch (error) {
    console.error('Ошибка получения всех тикетов:', error);
    res.status(500).json({ message: 'Ошибка сервера при загрузке всех тикетов.' });
  }
});

// ---------------------------------------------------
// GET /api/tickets/:ticketId/messages — сообщения тикета
// ---------------------------------------------------
router.get('/:ticketId/messages', isAuthenticated, async (req, res) => {
  const { ticketId } = req.params;
  const userId = req.session.userId;
  const userRole = req.session.userRole;

  try {
    const [tickets] = await pool.query(
      'SELECT user_id, moderator_id FROM tickets WHERE id = ?',
      [ticketId]
    );
    if (tickets.length === 0) return res.status(404).json({ message: 'Тикет не найден.' });

    const ticket = tickets[0];
    const isAuthorized = ticket.user_id === userId || userRole === 'moderator' || userRole === 'admin';
    if (!isAuthorized) return res.status(403).json({ message: 'Доступ запрещен.' });

    const [messages] = await pool.query(`
      SELECT
        m.id,
        m.message_text AS messageText,
        m.created_at AS createdAt,
        m.sender_id AS senderId,
        m.attachment_url AS attachmentUrl,
        u.username AS senderUsername,
        u.role AS senderRole
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.ticket_id = ?
      ORDER BY m.created_at ASC
    `, [ticketId]);

    const formattedMessages = messages.map(msg => ({
      ...msg,
      createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString()
    }));

    res.json(formattedMessages);
  } catch (error) {
    console.error('Ошибка получения сообщений:', error);
    res.status(500).json({ message: 'Ошибка сервера при загрузке сообщений.' });
  }
});

// ---------------------------------------------------
// POST /api/tickets/messages/send — сообщение (вложение/текст через HTTP)
// Сервер эмитит receiveMessage и рассылает push
// ---------------------------------------------------
router.post('/messages/send', isAuthenticated, upload.single('attachment'), async (req, res) => {
  const senderId = req.session.userId;
  const senderRole = req.session.userRole;
  const { ticketId, messageText } = req.body;
  const attachmentUrl = req.file ? `/uploads/${req.file.filename}` : null;

  if (!ticketId || (!messageText && !attachmentUrl)) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'Требуется ID тикета и текст или вложение.' });
  }

  let connection;
  let newStatus = null;
  let recipientId = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // 1. Сообщение
    const [messageResult] = await connection.query(
      'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
      [ticketId, senderId, messageText || '', attachmentUrl]
    );
    const messageId = messageResult.insertId;

    // 2. Тикет/статус
    const [ticket] = await connection.query('SELECT status, moderator_id, user_id FROM tickets WHERE id = ?', [ticketId]);
    const currentStatus = ticket[0].status;
    let moderatorId = ticket[0].moderator_id;
    const ticketOwnerId = ticket[0].user_id;

    recipientId = senderRole === 'user' ? (moderatorId || null) : ticketOwnerId;

    if (senderRole === 'moderator' || senderRole === 'admin') {
      if (['New', 'Successful', 'Rejected'].includes(currentStatus)) {
        newStatus = 'In Progress';
        if (!moderatorId) moderatorId = senderId;

        await connection.query(
          'UPDATE tickets SET status = ?, moderator_id = ?, closed_at = NULL WHERE id = ?',
          [newStatus, moderatorId, ticketId]
        );

        await connection.query(
          'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
          [ticketId, senderId, currentStatus, newStatus]
        );
      }
    }

    await connection.commit();

    // 3. Эмиссия в сокеты: чтобы вложение появилось мгновенно
    try {
      const io = req.app.get('io');
      if (io) {
        const roomName = `ticket-${ticketId}`;
        const [[senderRow]] = await pool.query('SELECT username, role FROM users WHERE id = ?', [senderId]);
        const newMessage = {
          id: messageId,
          ticketId: parseInt(ticketId),
          senderId,
          senderUsername: senderRow?.username || null,
          senderRole: senderRow?.role || null,
          messageText: messageText || '',
          attachmentUrl,
          createdAt: new Date().toISOString()
        };
        io.to(roomName).emit('receiveMessage', newMessage);
        if (newStatus) {
          io.emit('ticketStatusUpdate', { ticketId: parseInt(ticketId), newStatus });
        }
      }
    } catch (emitErr) {
      console.warn('Socket emit error (messages/send):', emitErr.message);
    }

    // 4. Push: получателю, либо всем модераторам (если не назначен)
    try {
      if (recipientId) {
        const isModerator = senderRole === 'moderator' || senderRole === 'admin';
        const bodyText = isModerator
          ? `Модератор ответил в тикет #${ticketId}.`
          : `Новое сообщение от клиента${messageText ? `: "${(messageText||'').substring(0,30)}..."` : ''}`;
        await sendPushToUserId(recipientId, {
          title: `[ZERO] Новое сообщение`,
          body: bodyText,
          url: isModerator ? `/user.html` : `/moder.html`
        });
      } else if (senderRole === 'user') {
        await sendPushToAllModerators({
          title: `[ZERO] Новая активность`,
          body: `Новое сообщение/вложение в тикете #${ticketId}`,
          url: `/moder.html`
        });
      }
    } catch {}

    res.json({
      success: true,
      message: 'Сообщение принято и сохранено.',
      socketData: {
        ticketId: parseInt(ticketId),
        messageText,
        attachmentUrl,
        senderId,
        createdAt: new Date().toISOString(),
        newStatus,
        recipientId
      }
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка отправки сообщения из чата:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении сообщения.' });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------
// POST /api/tickets/update-status — ручная смена статуса
// ---------------------------------------------------
router.post('/update-status', isModeratorOrAdmin, async (req, res) => {
  const { ticketId, newStatus } = req.body;
  const moderatorId = req.session.userId;
  const validStatuses = ['New', 'In Progress', 'On Hold', 'Successful', 'Rejected'];

  if (!ticketId || !newStatus || !validStatuses.includes(newStatus)) {
    return res.status(400).json({ message: 'Неверные данные или статус.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [currentTicket] = await pool.query(
      'SELECT status, moderator_id, user_id, created_at FROM tickets WHERE id = ?',
      [ticketId]
    );
    if (!currentTicket.length) return res.status(404).json({ message: 'Тикет не найден.' });

    const oldStatus = currentTicket[0].status;
    let moderator_id = currentTicket[0].moderator_id;
    if (oldStatus === 'New' && !moderator_id) moderator_id = moderatorId;

    let updateSQL = 'UPDATE tickets SET status = ?, moderator_id = ?';
    const params = [newStatus, moderator_id, ticketId];

    let timeSpent = null;
    if (newStatus === 'Successful' || newStatus === 'Rejected') {
      updateSQL += ', closed_at = NOW()';
      const startTime = new Date(currentTicket[0].created_at);
      const endTime = new Date();
      const diffMs = endTime - startTime;
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      timeSpent = `${days}д ${hours}ч ${minutes}м`;
    } else if (oldStatus === 'Successful' || oldStatus === 'Rejected') {
      updateSQL += ', closed_at = NULL';
    }

    updateSQL += ' WHERE id = ?';

    await connection.query(updateSQL, params);
    await connection.query(
      'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [ticketId, moderatorId, oldStatus, newStatus]
    );

    await connection.commit();

    // Эмитим всем фронтам
    try {
      const io = req.app.get('io');
      if (io) io.emit('ticketStatusUpdate', { ticketId: parseInt(ticketId), newStatus, timeSpent });
    } catch {}

    res.json({
      message: `Статус тикета #${ticketId} обновлен на "${newStatus}".`,
      newStatus,
      moderatorId: moderator_id,
      timeSpent
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка обновления статуса тикета:', error);
    res.status(500).json({ message: 'Ошибка сервера при обновлении статуса.' });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------
// POST /api/tickets/update-user-info — изменить ФИО/Телефон пользователя (модераторы)
// ---------------------------------------------------
router.post('/update-user-info', isModeratorOrAdmin, async (req, res) => {
  const { userId, fullName, phoneNumber } = req.body;
  if (!userId) return res.status(400).json({ message: 'Требуется ID пользователя.' });

  try {
    await pool.query(
      'UPDATE users SET full_name = ?, phone_number = ? WHERE id = ?',
      [fullName || null, phoneNumber || null, userId]
    );
    res.json({ message: `Данные пользователя ID ${userId} успешно обновлены.` });
  } catch (error) {
    console.error('Ошибка обновления данных пользователя:', error);
    res.status(500).json({ message: 'Ошибка сервера при обновлении данных пользователя.' });
  }
});

module.exports = router;