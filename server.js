// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const cors = require('cors');
const webPush = require('web-push');
require('dotenv').config();

const { pool, initializeDB } = require('./db');
// Импортируем роуты аутентификации
const { router: authRouter } = require('./routes/authRoutes');
// Импортируем роуты администрирования
const adminRouter = require('./routes/adminRoutes'); 
// Импортируем роуты тикетов
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
        process.env.VAPID_SUBJECT,
        VAPID_KEYS.publicKey,
        VAPID_KEYS.privateKey
    );
} else {
    console.error("❌ VAPID ключи не найдены в .env. Push-уведомления не будут работать.");
}

/**
 * Отправляет Push-уведомление конкретному пользователю.
 */
async function sendPushNotification(userId, payload) {
    if (!VAPID_KEYS.publicKey) return; 

    try {
        const [users] = await pool.query(
            'SELECT push_subscription FROM users WHERE id = ?', 
            [userId]
        );

        if (users.length === 0 || !users[0].push_subscription) {
            console.log(`Нет подписки для пользователя ID ${userId}.`);
            return;
        }

        const subscription = users[0].push_subscription;
        
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
        // Разрешаем запросы без заголовка Origin (например, curl/сервер-сервер)
        if (!origin) return callback(null, true);

        // Белый список + локальные подсети
        const allow = allowedOrigins.includes(origin) || localNetRegexes.some(rx => rx.test(origin));
        if (allow) return callback(null, true);

        console.warn(`CORS Reject: Origin ${origin} not allowed.`);
        callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true 
}));

// Парсинг тела запроса
app.use(express.json());
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
// Обслуживание статических файлов из папки 'public'
app.use(express.static('public'));

// Обслуживание загруженных файлов из папки 'uploads'
app.use('/uploads', express.static('uploads')); 

// Подключение роутов аутентификации
app.use('/api/auth', authRouter);

// Подключение роутов администратора
app.use('/api/admin', adminRouter);

// Подключение роутов тикетов
app.use('/api/tickets', ticketRouter);


// -----------------------------------------------------
// 4. Настройка Socket.IO
// -----------------------------------------------------
// Для Socket.IO можно указать массив строк и RegExp — разрешим локальные подсети
const io = new Server(server, {
    cors: {
        origin: [
            ...allowedOrigins,
            ...localNetRegexes
        ],
        methods: ["GET", "POST"],
        credentials: true
    }
});

// Добавляем middleware сессий в Socket.IO
io.engine.use(sessionMiddleware);


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

// Вспомогательная функция для добавления сообщения в БД И обновления статуса/назначения
async function saveMessageToDB(ticketId, senderId, senderRole, messageText, attachmentUrl = null) {
    let connection;
    let newStatus = null;
    let recipientId = null;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Добавляем сообщение (включая путь к файлу)
        await connection.query(
            'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
            [ticketId, senderId, messageText, attachmentUrl]
        );

        const [ticket] = await connection.query('SELECT status, moderator_id, user_id FROM tickets WHERE id = ?', [ticketId]);
        const currentStatus = ticket[0].status;
        let moderatorId = ticket[0].moderator_id;
        const ticketOwnerId = ticket[0].user_id;
        
        recipientId = senderRole === 'user' ? (moderatorId || null) : ticketOwnerId;


        if (senderRole === 'moderator' || senderRole === 'admin') {
            
            if (currentStatus === 'New' || currentStatus === 'Successful' || currentStatus === 'Rejected') {
                newStatus = 'In Progress';
                
                if (!moderatorId) {
                    moderatorId = senderId;
                }

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
            newStatus: newStatus,
            recipientId: recipientId
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

    console.log(`Клиент подключен (ID: ${userId}, Роль: ${role}). Socket ID: ${socket.id}`);
    
    // --- 1. Подключение к Комнате Тикета ---
    socket.on('joinTicket', (ticketId) => {
        const roomName = `ticket-${ticketId}`; 
        socket.join(roomName);
        console.log(`Пользователь ${userId} присоединился к комнате ${roomName}`);
    });
    
    // --- 2. Обработка Нового Сообщения (Socket.IO) ---
    socket.on('sendMessage', async ({ ticketId, messageText }) => {
        const roomName = `ticket-${ticketId}`;
        
        if (!messageText || messageText.trim() === '') return;

        const senderUsername = socket.request.session.username;
        const senderRole = role;

        const { isStatusUpdated, newStatus, recipientId } = await saveMessageToDB(ticketId, userId, senderRole, messageText, null);
        
        const newMessage = {
            senderId: userId,
            senderUsername: senderUsername,
            senderRole: senderRole,
            messageText: messageText,
            createdAt: new Date().toISOString(),
            ticketId: ticketId
        };
        
        io.to(roomName).emit('receiveMessage', newMessage);
        
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
        }

        if (isStatusUpdated) {
            io.emit('ticketStatusUpdate', { ticketId: ticketId, newStatus: newStatus });
        }
    });

    // --- 3. Обработка Вручную Измененного Статуса ---
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
    
    // --- 4. Выход из Комнаты Тикета ---
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
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: 'Внутренняя ошибка сервера' });
});