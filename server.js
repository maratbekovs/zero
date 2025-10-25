// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const webPush = require('web-push');
const path = require('path');
require('dotenv').config();

const { pool, initializeDB } = require('./db');
const { router: authRouter } = require('./routes/authRoutes');
const adminRouter = require('./routes/adminRoutes');
const ticketRouter = require('./routes/ticketRoutes');

const app = express();
const server = http.createServer(app);

// -----------------------------------------------------
// 1. Инициализация Базы Данных
// -----------------------------------------------------
initializeDB();

// -----------------------------------------------------
// 0. Настройка Web-Push
// -----------------------------------------------------
const VAPID_KEYS = {
  publicKey: process.env.VAPID_PUBLIC_KEY,
  privateKey: process.env.VAPID_PRIVATE_KEY
};

if (VAPID_KEYS.publicKey && VAPID_KEYS.privateKey) {
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    VAPID_KEYS.publicKey,
    VAPID_KEYS.privateKey
  );
} else {
  console.error('❌ VAPID ключи не найдены в .env. Push-уведомления не будут работать.');
}

/**
 * Отправляет Push-уведомление конкретному пользователю по его ID.
 * Автоматически парсит JSON в subscription при необходимости.
 */
async function sendPushNotification(userId, payload) {
  if (!VAPID_KEYS.publicKey) return;

  try {
    const [users] = await pool.query(
      'SELECT push_subscription FROM users WHERE id = ?',
      [userId]
    );
    if (!users.length || !users[0].push_subscription) {
      console.log(`Нет подписки для пользователя ID ${userId}.`);
      return;
    }

    let subscription = users[0].push_subscription;
    if (typeof subscription === 'string') {
      try { subscription = JSON.parse(subscription); } catch { subscription = null; }
    }
    if (!subscription) return;

    await webPush.sendNotification(subscription, JSON.stringify(payload));
    console.log(`✅ Push-уведомление отправлено пользователю ID ${userId}.`);
  } catch (error) {
    console.error(`❌ Ошибка отправки Push-уведомления ID ${userId}:`, error.message);
    if (error.statusCode === 410) {
      console.log(`Удаление устаревшей подписки для ID ${userId}.`);
      await pool.query('UPDATE users SET push_subscription = NULL WHERE id = ?', [userId]);
    }
  }
}

/**
 * Массовая отправка всем модераторам/админам (если модератор ещё не назначен).
 */
async function sendPushNotificationToModerators(payload) {
  if (!VAPID_KEYS.publicKey) return;
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
        if (e.statusCode === 410) {
          await pool.query('UPDATE users SET push_subscription = NULL WHERE id = ?', [m.id]);
        }
      }
    }
  } catch (e) {
    console.error('Ошибка массовой отправки модераторам:', e.message);
  }
}

// -----------------------------------------------------
// 2. Настройка Middleware
// -----------------------------------------------------

const API_PORT = process.env.PORT || 3000;
const clientPort = process.env.CLIENT_PORT || 8080;

// Базовый список локальных origin
const defaultAllowedOrigins = [
  `http://localhost:${API_PORT}`,
  `http://localhost:${clientPort}`,
  'http://127.0.0.1:5500',
  'http://localhost:5500'
];

// Разрешаем добавлять свои origin через .env (через запятую)
const envAllowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Регулярки для типичных локальных подсетей (разрешаем весь локальный сегмент)
const localNetRegexes = [
  /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}:\d+$/
];

const allowedOrigins = [...defaultAllowedOrigins, ...envAllowed];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allow = allowedOrigins.includes(origin) || localNetRegexes.some(rx => rx.test(origin));
    if (allow) return callback(null, true);
    console.warn(`CORS Reject: Origin ${origin} not allowed.`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true
}));

// Парсинг тела запроса
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));

// Настройка Сессий
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'connect.sid',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
});
app.use(sessionMiddleware);

// -----------------------------------------------------
// 3. Роутинг API
// -----------------------------------------------------
// Статика
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Роуты
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/tickets', ticketRouter);

// -----------------------------------------------------
// 4. Настройка Socket.IO
// -----------------------------------------------------
const io = new Server(server, {
  cors: {
    origin: [
      ...allowedOrigins,
      ...localNetRegexes
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});
io.engine.use(sessionMiddleware);

// Сделаем io доступным в REST-роутах
app.set('io', io);

// -----------------------------------------------------
// 5. Запуск Сервера
// -----------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер Express/Socket.IO запущен на порту ${PORT}`);
  console.log(`Базовый адрес: http://localhost:${PORT}`);
});

// -----------------------------------------------------
// 6. Обработка Соединений Socket.IO
// -----------------------------------------------------

// Сохранение сообщения в БД + авто-назначение/статус
async function saveMessageToDB(ticketId, senderId, senderRole, messageText, attachmentUrl = null) {
  let connection;
  let newStatus = null;
  let recipientId = null;

  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    // Сообщение
    await connection.query(
      'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
      [ticketId, senderId, messageText, attachmentUrl]
    );

    // Тикет
    const [ticket] = await connection.query(
      'SELECT status, moderator_id, user_id FROM tickets WHERE id = ?',
      [ticketId]
    );
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

    return {
      isStatusUpdated: newStatus !== null,
      newStatus,
      recipientId
    };
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Ошибка сохранения сообщения в БД:', error);
    return { isStatusUpdated: false, newStatus: null, recipientId: null };
  } finally {
    if (connection) connection.release();
  }
}

io.on('connection', (socket) => {
  const userId = socket.request.session.userId;
  const role = socket.request.session.userRole;

  if (!userId) {
    socket.disconnect(true);
    return;
  }
  // Вступаем модераторскими/админскими сокетами в комнату "moderators"
if (role === 'moderator' || role === 'admin') {
  socket.join('moderators');
}

  console.log(`Клиент подключен (ID: ${userId}, Роль: ${role}). Socket ID: ${socket.id}`);

  // Подключение к комнате тикета
  socket.on('joinTicket', (ticketId) => {
    const roomName = `ticket-${ticketId}`;
    socket.join(roomName);
    console.log(`Пользователь ${userId} присоединился к комнате ${roomName}`);
  });

  // Мгновенная отправка текстовых сообщений
  socket.on('sendMessage', async ({ ticketId, messageText }) => {
    const roomName = `ticket-${ticketId}`;
    if (!messageText || messageText.trim() === '') return;

    const senderUsername = socket.request.session.username;
    const senderRole = role;

    const { isStatusUpdated, newStatus, recipientId } =
      await saveMessageToDB(ticketId, userId, senderRole, messageText, null);

    const newMessage = {
      senderId: userId,
      senderUsername,
      senderRole,
      messageText,
      createdAt: new Date().toISOString(),
      ticketId
    };

    io.to(roomName).emit('receiveMessage', newMessage);

    // Push: адресно либо всем модераторам, если не назначен
    if (recipientId) {
      const isModerator = senderRole === 'moderator' || senderRole === 'admin';
      const bodyText = isModerator
        ? `Модератор ответил в тикет #${ticketId}.`
        : `Новое сообщение от клиента: "${messageText.substring(0, 30)}..."`;
      sendPushNotification(recipientId, {
        title: `[ZERO] Новое сообщение`,
        body: bodyText,
        url: isModerator ? `/user.html` : `/moder.html`
      });
    } else if (senderRole === 'user') {
      await sendPushNotificationToModerators({
        title: `[ZERO] Новая активность`,
        body: `Новое сообщение в тикете #${ticketId}`,
        url: `/moder.html`
      });
    }

    if (isStatusUpdated) {
      io.emit('ticketStatusUpdate', { ticketId, newStatus });
    }
  });

  // Вручную изменённый статус
  socket.on('statusUpdated', async (data) => {
    io.emit('ticketStatusUpdate', {
      ticketId: data.ticketId,
      newStatus: data.newStatus,
      timeSpent: data.timeSpent || null
    });

    const [ticket] = await pool.query('SELECT user_id FROM tickets WHERE id = ?', [data.ticketId]);
    if (ticket.length > 0) {
      sendPushNotification(ticket[0].user_id, {
        title: `[ZERO] Обновление статуса`,
        body: `Статус вашего тикета #${data.ticketId} изменен на "${data.newStatus}"`,
        url: `/user.html`
      });
    }
  });

  socket.on('leaveTicket', (ticketId) => {
    const roomName = `ticket-${ticketId}`;
    socket.leave(roomName);
    console.log(`Пользователь ${userId} покинул комнату ${roomName}`);
  });

  socket.on('disconnect', () => {
    console.log(`Клиент отключен. Socket ID: ${socket.id}`);
  });
});

// -----------------------------------------------------
// 7. Универсальный JSON-обработчик ошибок
// -----------------------------------------------------
app.use((err, _req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Внутренняя ошибка сервера' });
});