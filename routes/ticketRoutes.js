// routes/ticketRoutes.js
//
// Полная версия с:
// - мгновенным оповещением модераторов о новых/изменённых тикетах (Socket.IO, событие "ticketsReload")
// - ограничением смены статусов: moderator => только "In Progress"/"On Hold"; admin => любые
// - назначением ответственного модератора (только admin) — POST /api/tickets/assign
// - отправкой сообщений с мультивложениями (attachments[]) и обратной совместимостью с одиночным attachment
// - историей статусов и push-уведомлениями

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webPush = require('web-push');

const { pool } = require('../db');
const { isAuthenticated, isModeratorOrAdmin, isAdmin } = require('./authRoutes');

// Настройка VAPID для отправки push (если есть ключи)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Помощники push
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

// --- Multer (хранение вложений сообщений) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    cb(null, `att-${Date.now()}${ext || ''}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB на файл
});

// ---------------------------------------------------
// POST /api/tickets/create — создать тикет (пользователь)
// (оставлен прием одиночного файла через 'attachment' как было)
// ---------------------------------------------------
router.post('/create', isAuthenticated, upload.single('attachment'), async (req, res) => {
  const userId = req.session.userId;
  const { subject, description } = req.body || {};
  if (!subject || String(subject).trim() === '') {
    return res.status(400).json({ message: 'Укажите тему тикета.' });
  }

  const attachmentUrl = req.file ? `/uploads/attachments/${req.file.filename}` : null;

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [ins] = await connection.query(
      'INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, ?)',
      [userId, subject.trim(), 'New']
    );
    const ticketId = ins.insertId;

    if ((description && String(description).trim()) || attachmentUrl) {
      const [msgIns] = await connection.query(
        'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
        [ticketId, userId, description?.trim() || '', null] // attachment_url не используем для множества
      );
      const messageId = msgIns.insertId;

      if (attachmentUrl) {
        await connection.query(
          'INSERT INTO message_attachments (message_id, url, mime_type, size) VALUES (?, ?, ?, ?)',
          [messageId, attachmentUrl, req.file.mimetype || null, req.file.size || null]
        );
      }
    }

    await connection.commit();

    const io = req.app.get('io');
    if (io) io.to('moderators').emit('ticketsReload');

    try {
      await sendPushToAllModerators({
        title: `[ZERO] Новый тикет`,
        body: `Создан тикет #${ticketId}: ${subject.substring(0, 60)}`,
        url: `/moder.html`
      });
    } catch {}

    res.status(201).json({ ticketId, message: 'Тикет создан.' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка создания тикета:', error);
    res.status(500).json({ message: 'Ошибка сервера при создании тикета.' });
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
      `SELECT 
         t.*,
         t.created_at AS updated_at,
         u_mod.username AS moderator_username,
         u_mod.full_name AS moderator_full_name,
         u_mod.avatar_url AS moderator_avatar_url
       FROM tickets t
       LEFT JOIN users u_mod ON t.moderator_id = u_mod.id
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
// GET /api/tickets/all — список всех тикетов (модераторы/админы)
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
        u_user.avatar_url AS user_avatar_url,
        u_mod.username AS moderator_username,
        u_mod.full_name AS moderator_full_name,
        u_mod.avatar_url AS moderator_avatar_url
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
// GET /api/tickets/:ticketId/messages — сообщения тикета (c attachments[])
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
    if (!isAuthorized) return res.status(403).json({ message: 'Доступ запрещён.' });

    const [messages] = await pool.query(`
      SELECT
        m.id,
        m.message_text AS messageText,
        m.created_at AS createdAt,
        m.sender_id AS senderId,
        u.username AS senderUsername,
        u.role AS senderRole,
        u.avatar_url AS senderAvatarUrl
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.ticket_id = ?
      ORDER BY m.created_at ASC
    `, [ticketId]);

    const ids = messages.map(m => m.id);
    let attachmentsByMsg = {};
    if (ids.length) {
      const [atts] = await pool.query(
        'SELECT message_id, url, mime_type, size FROM message_attachments WHERE message_id IN (?) ORDER BY id ASC',
        [ids]
      );
      for (const a of atts) {
        attachmentsByMsg[a.message_id] = attachmentsByMsg[a.message_id] || [];
        attachmentsByMsg[a.message_id].push({ url: a.url, mime_type: a.mime_type, size: a.size });
      }
    }

    const formatted = messages.map(msg => ({
      ...msg,
      createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
      attachmentUrl: null, // для обратной совместимости (раньше был один файл)
      attachments: attachmentsByMsg[msg.id] || []
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Ошибка получения сообщений тикета:', error);
    res.status(500).json({ message: 'Ошибка сервера при загрузке сообщений.' });
  }
});

// ---------------------------------------------------
// POST /api/tickets/messages/send — отправить сообщение (текст + несколько файлов)
// Принимаем И attachments[] (много), И fallback attachment (один)
// ---------------------------------------------------
router.post(
  '/messages/send',
  isAuthenticated,
  upload.fields([
    { name: 'attachments', maxCount: 10 },
    { name: 'attachment',  maxCount: 1  } // для обратной совместимости со старым фронтом
  ]),
  async (req, res) => {
    const { ticketId } = req.body;
    let { messageText } = req.body;
    messageText = (messageText || '').trim();

    const files = [
      ...(req.files?.attachments || []),
      ...(req.files?.attachment  || [])
    ];

    if (!ticketId) return res.status(400).json({ success: false, message: 'Не указан ticketId.' });
    if (!messageText && files.length === 0) {
      return res.status(400).json({ success: false, message: 'Пустое сообщение.' });
    }

    const senderId = req.session.userId;
    const senderRole = req.session.userRole;

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      // 1) Сообщение
      const [msgIns] = await connection.query(
        'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
        [ticketId, senderId, messageText || '', null]
      );
      const messageId = msgIns.insertId;

      // 2) Сохраняем все прикреплённые файлы
      const attachments = [];
      for (const f of files) {
        const url = `/uploads/attachments/${f.filename}`;
        await connection.query(
          'INSERT INTO message_attachments (message_id, url, mime_type, size) VALUES (?, ?, ?, ?)',
          [messageId, url, f.mimetype || null, f.size || null]
        );
        attachments.push({ url, mime_type: f.mimetype || null, size: f.size || null });
      }

      // 3) Автоперевод статуса при ответе модератора/админа
      const [ticketRows] = await connection.query(
        'SELECT status, moderator_id, user_id FROM tickets WHERE id = ?',
        [ticketId]
      );
      if (!ticketRows.length) {
        await connection.rollback();
        return res.status(404).json({ success: false, message: 'Тикет не найден.' });
      }
      const currentStatus = ticketRows[0].status;
      let moderatorId = ticketRows[0].moderator_id;
      const ticketOwnerId = ticketRows[0].user_id;

      let newStatus = null;
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

      // Socket: сообщение в комнату тикета
      try {
        const io = req.app.get('io');
        if (io) {
          const roomName = `ticket-${ticketId}`;
          const newMessage = {
            senderId,
            senderUsername: req.session.username,
            senderRole,
            messageText,
            attachments,
            attachmentUrl: null, // для совместимости
            createdAt: new Date().toISOString(),
            ticketId: Number(ticketId)
          };
          io.to(roomName).emit('receiveMessage', newMessage);

          if (newStatus) {
            io.emit('ticketStatusUpdate', { ticketId: Number(ticketId), newStatus });
            io.to('moderators').emit('ticketsReload');
          }
        }
      } catch (emitErr) {
        console.warn('Socket emit error (messages/send):', emitErr.message);
      }

      // Push: адресно/модераторам
      try {
        const recipientId = senderRole === 'user' ? (ticketRows[0].moderator_id || null) : ticketRows[0].user_id;
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
          ticketId: Number(ticketId),
          messageText,
          attachments,
          senderId,
          createdAt: new Date().toISOString()
        }
      });
    } catch (error) {
      if (connection) await connection.rollback();
      console.error('Ошибка отправки сообщения из чата:', error);
      res.status(500).json({ success: false, message: 'Ошибка сервера при сохранении сообщения.' });
    } finally {
      if (connection) connection.release();
    }
  }
);

// ---------------------------------------------------
// POST /api/tickets/update-status — смена статуса (с ограничениями ролей)
// ---------------------------------------------------
router.post('/update-status', isModeratorOrAdmin, async (req, res) => {
  const { ticketId, newStatus } = req.body;
  const actorId = req.session.userId;
  const actorRole = req.session.userRole;

  const validStatusesAll = ['New', 'In Progress', 'On Hold', 'Successful', 'Rejected'];
  const allowedForModerator = ['In Progress', 'On Hold'];

  if (!ticketId || !newStatus || !validStatusesAll.includes(newStatus)) {
    return res.status(400).json({ message: 'Неверные данные или статус.' });
  }
  if (actorRole === 'moderator' && !allowedForModerator.includes(newStatus)) {
    return res.status(403).json({ message: 'Только администратор может завершать или отклонять тикеты.' });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [currentTicket] = await pool.query(
      'SELECT status, moderator_id, user_id, created_at FROM tickets WHERE id = ?',
      [ticketId]
    );
    if (!currentTicket.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Тикет не найден.' });
    }

    const oldStatus = currentTicket[0].status;
    let moderator_id = currentTicket[0].moderator_id;
    const ticketOwnerId = currentTicket[0].user_id;

    if (actorRole === 'moderator' && oldStatus === 'New' && !moderator_id) {
      moderator_id = actorId;
    }

    let updateSQL = 'UPDATE tickets SET status = ?, moderator_id = ?';
    const params = [newStatus, moderator_id, ticketId];

    let timeSpent = null;
    if (newStatus === 'Successful' || newStatus === 'Rejected') {
      updateSQL += ', closed_at = NOW()';
      const startTime = new Date(currentTicket[0].created_at);
      const endTime = new Date();
      const diffMs = Math.max(0, endTime - startTime);
      const diffHours = Math.round(diffMs / (1000 * 60 * 60));
      timeSpent = diffHours;
    } else if (newStatus === 'In Progress') {
      updateSQL += ', closed_at = NULL';
    }

    updateSQL += ' WHERE id = ?';
    await connection.query(updateSQL, params);

    await connection.query(
      'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [ticketId, actorId, oldStatus, newStatus]
    );

    await connection.commit();

    const io = req.app.get('io');
    if (io) {
      io.emit('ticketStatusUpdate', { ticketId: Number(ticketId), newStatus, timeSpent: timeSpent || null });
      io.to('moderators').emit('ticketsReload');
    }

    try {
      await sendPushToUserId(ticketOwnerId, {
        title: `[ZERO] Обновление статуса`,
        body: `Статус вашего тикета #${ticketId} изменён на "${newStatus}"`,
        url: `/user.html`
      });
    } catch {}

    res.json({ message: 'Статус обновлён.', timeSpent });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка смены статуса:', error);
    res.status(500).json({ message: 'Ошибка сервера при смене статуса.' });
  } finally {
    if (connection) connection.release();
  }
});

// ---------------------------------------------------
// POST /api/tickets/assign — назначить модератора (только admin)
// ---------------------------------------------------
router.post('/assign', isAdmin, async (req, res) => {
  const { ticketId, moderatorId } = req.body || {};
  const tid = Number(ticketId);
  const mid = Number(moderatorId);
  if (!tid || !mid) {
    return res.status(400).json({ message: 'Нужно указать ticketId и moderatorId.' });
  }

  try {
    const [mods] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role = 'moderator'",
      [mid]
    );
    if (!mods.length) return res.status(400).json({ message: 'Пользователь не найден или не модератор.' });

    const [tics] = await pool.query('SELECT id FROM tickets WHERE id = ?', [tid]);
    if (!tics.length) return res.status(404).json({ message: 'Тикет не найден.' });

    await pool.query('UPDATE tickets SET moderator_id = ? WHERE id = ?', [mid, tid]);

    await pool.query(
      'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [tid, req.session.userId, 'assign', 'assign']
    );

    const io = req.app.get('io');
    if (io) io.to('moderators').emit('ticketsReload');

    res.json({ message: 'Ответственный назначен.' });
  } catch (e) {
    console.error('Ошибка назначения модератора:', e);
    res.status(500).json({ message: 'Ошибка сервера при назначении модератора.' });
  }
});

module.exports = router;