// routes/ticketRoutes.js
//
// Полная версия с правками:
// - Мультивложения для создания тикетов и сообщений (attachments[]; поддержка старого поля attachment с дедупликацией).
// - Идемпотентность на приёме сообщений (in-memory кэш + clientMessageId).
// - Дедупликация файлов, если пришли одновременно attachments и attachment (исключает дубль в одном сообщении).
// - Проверки доступа при отправке сообщений (в тикет может писать владелец тикета или модератор/админ).
// - Уведомления (web-push) и события Socket.IO сохранены.
// - Колонки/данные, не относящиеся к интерфейсу (ID в UI), оставлены на API уровне как было.
//
// Примечание: для масштабируемой идемпотентности рекомендуется миграция БД с уникальным ключом (client_msg_id).

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const webPush = require('web-push');

const { pool } = require('../db');
const { isAuthenticated, isModeratorOrAdmin, isAdmin } = require('./authRoutes');

// Настройка Web Push (если заданы ключи)
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// --------------------------- ИДЕМПОТЕНТНОСТЬ ---------------------------
// Временный in-memory кэш идемпотентности на 15с (для подавления повторных POST)
const idempCache = new Map();
function idempSeen(key, ttlMs = 15000) {
  const now = Date.now();
  // ленивая очистка просроченных ключей
  for (const [k, exp] of idempCache) {
    if (exp <= now) idempCache.delete(k);
  }
  if (!key) return false;
  if (idempCache.has(key)) return true;
  idempCache.set(key, now + ttlMs);
  return false;
}

// --------------------------- PUSH UTILS ---------------------------
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
    // 410 Gone — подписка устарела/удалена, чистим её
    if (e && e.statusCode === 410) {
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
      try {
        await webPush.sendNotification(subscription, JSON.stringify(payload));
      } catch (e) {
        if (e && e.statusCode === 410) {
          await pool.query('UPDATE users SET push_subscription = NULL WHERE id = ?', [m.id]);
        }
      }
    }
  } catch {}
}

// --------------------------- MULTER ---------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// Дедупликация файлов (если один и тот же файл попал и в attachments, и в attachment)
function dedupeFiles(mix) {
  const seen = new Set();
  const out = [];
  for (const f of mix) {
    const key = `${f.filename}:${f.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// --------------------------- ROUTES: TICKETS ---------------------------

// POST /api/tickets/create — создать тикет (пользователь)
// Принимает: subject, description, файлы в attachments[] (поддерживается и fallback attachment)
router.post(
  '/create',
  isAuthenticated,
  upload.fields([
    { name: 'attachments', maxCount: 10 },
    { name: 'attachment',  maxCount: 1  }, // поддерживаем старое поле, но далее дедуплируем
  ]),
  async (req, res) => {
    const userId = req.session.userId;
    const { subject, description } = req.body || {};
    if (!subject || String(subject).trim() === '') {
      return res.status(400).json({ message: 'Укажите тему тикета.' });
    }

    // Объединяем и дедуплируем файлы
    const incoming = [
      ...(req.files?.attachments || []),
      ...(req.files?.attachment  || []),
    ];
    const files = dedupeFiles(incoming);

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      // 1) Создаём тикет
      const [ins] = await connection.query(
        'INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, ?)',
        [userId, subject.trim(), 'New']
      );
      const ticketId = ins.insertId;

      // 2) Первое сообщение (если есть текст/файлы)
      const hasText = description && String(description).trim();
      const hasFiles = files.length > 0;

      if (hasText || hasFiles) {
        const [msgIns] = await connection.query(
          'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
          [ticketId, userId, hasText ? description.trim() : '', null]
        );
        const messageId = msgIns.insertId;

        if (hasFiles) {
          for (const f of files) {
            const url = `/uploads/attachments/${f.filename}`;
            await connection.query(
              'INSERT INTO message_attachments (message_id, url, mime_type, size) VALUES (?, ?, ?, ?)',
              [messageId, url, f.mimetype || null, f.size || null]
            );
          }
        }
      }

      await connection.commit();

      // Сигнал модераторам (socket + push)
      try {
        const io = req.app.get('io');
        if (io) io.to('moderators').emit('ticketsReload');
      } catch {}
      try {
        await sendPushToAllModerators({
          title: `[ZERO] Новый тикет`,
          body: `Создан тикет: ${String(subject).substring(0, 60)}`,
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
  }
);

// GET /api/tickets/my — список тикетов текущего пользователя
router.get('/my', isAuthenticated, async (req, res) => {
  const userId = req.session.userId;

  try {
    const [tickets] = await pool.query(
      `SELECT 
         t.*,
         t.created_at AS updated_at,
         u_mod.username   AS moderator_username,
         u_mod.full_name  AS moderator_full_name,
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

// GET /api/tickets/all — все тикеты (для модераторов/админов)
router.get('/all', isModeratorOrAdmin, async (_req, res) => {
  try {
    const [tickets] = await pool.query(`
      SELECT
        t.id,
        t.user_id,
        t.subject,
        t.status,
        t.created_at,
        u_user.username    AS user_username,
        u_user.full_name   AS user_full_name,
        u_user.phone_number AS user_phone,
        u_user.avatar_url  AS user_avatar_url,
        u_mod.username     AS moderator_username,
        u_mod.full_name    AS moderator_full_name,
        u_mod.avatar_url   AS moderator_avatar_url
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

// --------------------------- ROUTES: MESSAGES ---------------------------

// GET /api/tickets/:ticketId/messages — сообщения по тикету
router.get('/:ticketId/messages', isAuthenticated, async (req, res) => {
  const { ticketId } = req.params;
  const userId = req.session.userId;
  const userRole = req.session.userRole;

  try {
    // Проверка доступа к тикету
    const [tickets] = await pool.query(
      'SELECT user_id, moderator_id FROM tickets WHERE id = ?',
      [ticketId]
    );
    if (!tickets.length) return res.status(404).json({ message: 'Тикет не найден.' });

    const ticket = tickets[0];
    const isOwner = ticket.user_id === userId;
    const isStaff = userRole === 'moderator' || userRole === 'admin';
    if (!isOwner && !isStaff) {
      return res.status(403).json({ message: 'Доступ запрещён.' });
    }

    // Сообщения
    const [messages] = await pool.query(`
      SELECT
        m.id,
        m.message_text AS messageText,
        m.created_at   AS createdAt,
        m.sender_id    AS senderId,
        u.username     AS senderUsername,
        u.role         AS senderRole,
        u.avatar_url   AS senderAvatarUrl
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.ticket_id = ?
      ORDER BY m.created_at ASC
    `, [ticketId]);

    // Вложения к сообщениям
    const ids = messages.map(m => m.id);
    const attachmentsByMsg = {};
    if (ids.length) {
      const [atts] = await pool.query(
        'SELECT message_id, url, mime_type, size FROM message_attachments WHERE message_id IN (?) ORDER BY id ASC',
        [ids]
      );
      for (const a of atts) {
        (attachmentsByMsg[a.message_id] ||= []).push({
          url: a.url, mime_type: a.mime_type, size: a.size
        });
      }
    }

    const formatted = messages.map(msg => ({
      ...msg,
      createdAt: msg.createdAt ? new Date(msg.createdAt).toISOString() : new Date().toISOString(),
      attachmentUrl: null, // для обратной совместимости
      attachments: attachmentsByMsg[msg.id] || []
    }));

    res.json(formatted);
  } catch (error) {
    console.error('Ошибка получения сообщений тикета:', error);
    res.status(500).json({ message: 'Ошибка сервера при загрузке сообщений.' });
  }
});

// POST /api/tickets/messages/send — отправка сообщения в чат тикета
// Принимает: ticketId, messageText (опц), attachments[] (мульти), clientMessageId (для идемпотентности)
router.post(
  '/messages/send',
  isAuthenticated,
  upload.fields([
    { name: 'attachments', maxCount: 10 },
    { name: 'attachment',  maxCount: 1  }, // поддерживаем старых клиентов
  ]),
  async (req, res) => {
    const { ticketId } = req.body;
    let { messageText, clientMessageId } = req.body;
    messageText = (messageText || '').trim();
    clientMessageId = (clientMessageId || '').trim();

    // Объединяем и дедуплируем файлы
    const incoming = [
      ...(req.files?.attachments || []),
      ...(req.files?.attachment  || []),
    ];
    const files = dedupeFiles(incoming);

    if (!ticketId) {
      return res.status(400).json({ success: false, message: 'Не указан ticketId.' });
    }
    if (!messageText && files.length === 0) {
      return res.status(400).json({ success: false, message: 'Пустое сообщение.' });
    }

    // Проверка доступа к тикету (владелец или модератор/админ)
    try {
      const [tickets] = await pool.query('SELECT user_id, status, moderator_id FROM tickets WHERE id = ?', [ticketId]);
      if (!tickets.length) return res.status(404).json({ success: false, message: 'Тикет не найден.' });

      const senderId  = req.session.userId;
      const senderRole = req.session.userRole;
      const isOwner = tickets[0].user_id === senderId;
      const isStaff = senderRole === 'moderator' || senderRole === 'admin';
      if (!isOwner && !isStaff) {
        return res.status(403).json({ success: false, message: 'Доступ запрещён.' });
      }
    } catch (authErr) {
      console.error('Auth check error (messages/send):', authErr);
      return res.status(500).json({ success: false, message: 'Ошибка проверки доступа.' });
    }

    // Идемпотентность (кратковременная)
    const senderId = req.session.userId;
    const firstFile = files[0] || null;
    const fallbackKey = `${senderId}|${ticketId}|${messageText}|${firstFile ? (firstFile.originalname||firstFile.filename||'') : ''}|${firstFile ? (firstFile.size||0) : 0}`;
    const idempKey = clientMessageId || fallbackKey;
    if (idempSeen(idempKey)) {
      return res.json({ success: true, message: 'Повтор подавлен (идемпотентность).' });
    }

    const senderRole = req.session.userRole;

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();

      // Сохраняем сообщение
      const [msgIns] = await connection.query(
        'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
        [ticketId, senderId, messageText || '', null]
      );
      const messageId = msgIns.insertId;

      // Сохраняем вложения (если есть)
      const attachments = [];
      for (const f of files) {
        const url = `/uploads/attachments/${f.filename}`;
        await connection.query(
          'INSERT INTO message_attachments (message_id, url, mime_type, size) VALUES (?, ?, ?, ?)',
          [messageId, url, f.mimetype || null, f.size || null]
        );
        attachments.push({ url, mime_type: f.mimetype || null, size: f.size || null });
      }

      // Возможный автоперевод статуса тикета (когда пишет модератор)
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

      // Socket-события
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
            attachmentUrl: null, // старое поле
            createdAt: new Date().toISOString(),
            ticketId: Number(ticketId),
          };
          io.to(roomName).emit('receiveMessage', newMessage);

          if (newStatus) {
            io.emit('ticketStatusUpdate', { ticketId: Number(ticketId), newStatus });
            io.to('moderators').emit('ticketsReload');
          }
        }
      } catch (emitErr) {
        console.warn('Socket emit error (messages/send):', emitErr && emitErr.message);
      }

      // Push-уведомления
      try {
        const recipientId = (senderRole === 'user')
          ? (ticketRows[0].moderator_id || null)
          : ticketRows[0].user_id;

        if (recipientId) {
          const bodyText = (senderRole === 'moderator' || senderRole === 'admin')
            ? `Модератор ответил в тикет.`
            : `Новое сообщение от клиента${messageText ? `: "${String(messageText).substring(0,30)}..."` : ''}`;
          await sendPushToUserId(recipientId, {
            title: `[ZERO] Новое сообщение`,
            body: bodyText,
            url: (senderRole === 'moderator' || senderRole === 'admin') ? `/user.html` : `/moder.html`
          });
        } else if (senderRole === 'user') {
          // Нет назначенного модератора — оповестим всех модераторов
          await sendPushToAllModerators({
            title: `[ZERO] Новая активность`,
            body: `Новое сообщение/вложение в тикете`,
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
          createdAt: new Date().toISOString(),
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

// --------------------------- ROUTES: STATUS/ASSIGN ---------------------------

// POST /api/tickets/update-status — смена статуса (модератор/админ)
router.post('/update-status', isModeratorOrAdmin, async (req, res) => {
  const { ticketId, newStatus } = req.body;
  const actorId   = req.session.userId;
  const actorRole = req.session.userRole;

  const validStatusesAll   = ['New', 'In Progress', 'On Hold', 'Successful', 'Rejected'];
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

    const oldStatus   = currentTicket[0].status;
    let moderator_id  = currentTicket[0].moderator_id;
    const ticketOwnerId = currentTicket[0].user_id;

    // Если модератор переводит из New и модератор ещё не назначен — назначаем текущего модератора
    if (actorRole === 'moderator' && oldStatus === 'New' && !moderator_id) {
      moderator_id = actorId;
    }

    // Построим UPDATE
    let updateSQL = 'UPDATE tickets SET status = ?, moderator_id = ?';
    const params  = [newStatus, moderator_id, ticketId];

    let timeSpent = null;
    if (newStatus === 'Successful' || newStatus === 'Rejected') {
      updateSQL += ', closed_at = NOW()';
      const startTime = new Date(currentTicket[0].created_at);
      const endTime   = new Date();
      const diffMs    = Math.max(0, endTime - startTime);
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

    // Socket
    try {
      const io = req.app.get('io');
      if (io) {
        io.emit('ticketStatusUpdate', { ticketId: Number(ticketId), newStatus, timeSpent: timeSpent || null });
        io.to('moderators').emit('ticketsReload');
      }
    } catch {}

    // Push пользователю
    try {
      await sendPushToUserId(ticketOwnerId, {
        title: `[ZERO] Обновление статуса`,
        body: `Статус вашего тикета изменён на "${newStatus}"`,
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

// POST /api/tickets/assign — назначить ответственного (админ)
router.post('/assign', isAdmin, async (req, res) => {
  const { ticketId, moderatorId } = req.body || {};
  const tid = Number(ticketId);
  const mid = Number(moderatorId);
  if (!tid || !mid) {
    return res.status(400).json({ message: 'Нужно указать ticketId и moderatorId.' });
  }

  try {
    // Валидация модератора
    const [mods] = await pool.query(
      "SELECT id FROM users WHERE id = ? AND role = 'moderator'",
      [mid]
    );
    if (!mods.length) return res.status(400).json({ message: 'Пользователь не найден или не модератор.' });

    // Валидация тикета
    const [tics] = await pool.query('SELECT id FROM tickets WHERE id = ?', [tid]);
    if (!tics.length) return res.status(404).json({ message: 'Тикет не найден.' });

    // Назначение
    await pool.query('UPDATE tickets SET moderator_id = ? WHERE id = ?', [mid, tid]);
    await pool.query(
      'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
      [tid, req.session.userId, 'assign', 'assign']
    );

    // Обновление модераторского списка
    try {
      const io = req.app.get('io');
      if (io) io.to('moderators').emit('ticketsReload');
    } catch {}

    res.json({ message: 'Ответственный назначен.' });
  } catch (e) {
    console.error('Ошибка назначения модератора:', e);
    res.status(500).json({ message: 'Ошибка сервера при назначении модератора.' });
  }
});

module.exports = router;