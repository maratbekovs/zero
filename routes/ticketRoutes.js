// routes/ticketRoutes.js

const express = require('express');
const router = express.Router();
const multer = require('multer');         
const path = require('path');             
const fs = require('fs');                 
const { pool } = require('../db');
const { isAuthenticated, isModeratorOrAdmin } = require('./authRoutes'); 

// --- КОНФИГУРАЦИЯ MULTER (Хранение файлов) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); 
    },
    filename: (req, file, cb) => {
        cb(null, 'file-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // Ограничение 10MB
    fileFilter: (req, file, cb) => {
        // Разрешаем только изображения и популярные документы
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx/;
        const mimeType = allowedTypes.test(file.mimetype);
        const extName = allowedTypes.test(path.extname(file.originalname).toLowerCase());

        if (mimeType && extName) {
            return cb(null, true);
        }
        cb(new Error('Неподдерживаемый тип файла.'));
    }
});
// ----------------------------------------------


// POST /api/tickets/new
// Создание нового обращения (унифицирован для файлов и текста)
router.post('/new', isAuthenticated, upload.single('attachment'), async (req, res) => {
    const userId = req.session.userId;
    // Фронтенд отправляет subject и description
    const { subject, description } = req.body; 
    
    const messageText = description; 
    const attachmentUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!subject || !messageText) {
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Ошибка удаления файла:', err);
            });
        }
        return res.status(400).json({ message: 'Требуется тема и текст обращения.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Создаем новый тикет
        const [ticketResult] = await connection.query(
            'INSERT INTO tickets (user_id, subject, status) VALUES (?, ?, ?)',
            [userId, subject, 'New']
        );
        const ticketId = ticketResult.insertId;

        // 2. Добавляем первое сообщение в таблицу messages
        await connection.query(
            'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
            [ticketId, userId, messageText, attachmentUrl] 
        );
        
        // 3. Добавляем запись в историю статусов
        await connection.query(
            'INSERT INTO status_history (ticket_id, user_id, old_status, new_status) VALUES (?, ?, ?, ?)',
            [ticketId, userId, null, 'New']
        );

        await connection.commit();

        res.status(201).json({ 
            message: '✅ Запрос успешно создан.', 
            ticketId: ticketId,
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


// GET /api/tickets/my
router.get('/my', isAuthenticated, async (req, res) => {
    const userId = req.session.userId;
    
    try {
        const [tickets] = await pool.query(
            // Добавляем updated_at для корректного отображения в таблице
            'SELECT t.*, t.created_at AS updated_at, u.username as moderator_username FROM tickets t LEFT JOIN users u ON t.moderator_id = u.id WHERE t.user_id = ? ORDER BY t.created_at DESC', 
            [userId]
        );
        
        res.json(tickets);
    } catch (error) {
        console.error('Ошибка получения тикетов:', error);
        res.status(500).json({ message: 'Ошибка сервера при загрузке тикетов.' });
    }
});


// GET /api/tickets/all
router.get('/all', isModeratorOrAdmin, async (req, res) => {
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


// GET /api/tickets/:ticketId/messages
router.get('/:ticketId/messages', isAuthenticated, async (req, res) => {
    const { ticketId } = req.params;
    const userId = req.session.userId;
    const userRole = req.session.userRole;

    try {
        const [tickets] = await pool.query(
            'SELECT user_id, moderator_id FROM tickets WHERE id = ?',
            [ticketId]
        );

        if (tickets.length === 0) {
            return res.status(404).json({ message: 'Тикет не найден.' });
        }

        const ticket = tickets[0];
        
        const isAuthorized = ticket.user_id === userId || userRole === 'moderator' || userRole === 'admin';

        if (!isAuthorized) {
            return res.status(403).json({ message: 'Доступ запрещен. Вы не являетесь владельцем или модератором тикета.' });
        }

        // 2. Получаем все сообщения
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

        // Форматируем дату в ISO-строку
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


// !!! НОВЫЙ РОУТ: POST /api/messages/send (Для отправки сообщений из чата, поддерживающий файлы)
router.post('/messages/send', isAuthenticated, upload.single('attachment'), async (req, res) => {
    const senderId = req.session.userId;
    const senderRole = req.session.userRole;
    const { ticketId, messageText } = req.body;
    const attachmentUrl = req.file ? `/uploads/${req.file.filename}` : null;
    
    if (!ticketId || (!messageText && !attachmentUrl)) {
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('Ошибка удаления файла:', err);
            });
        }
        return res.status(400).json({ success: false, message: 'Требуется ID тикета и текст или вложение.' });
    }

    let connection;
    let newStatus = null;
    let recipientId = null;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. Добавляем сообщение
        const [messageResult] = await connection.query(
            'INSERT INTO messages (ticket_id, sender_id, message_text, attachment_url) VALUES (?, ?, ?, ?)',
            [ticketId, senderId, messageText || '', attachmentUrl]
        );
        const messageId = messageResult.insertId;

        // 2. Логика назначения и смены статуса
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
        
        // 3. Возвращаем данные для отправки через Socket.IO (на Frontend)
        const senderUsername = req.session.username;

        res.json({ 
            success: true, 
            message: 'Сообщение принято и сохранено.',
            socketData: {
                ticketId: parseInt(ticketId),
                messageText: messageText,
                attachmentUrl: attachmentUrl,
                senderId: senderId,
                senderUsername: senderUsername,
                senderRole: senderRole,
                createdAt: new Date().toISOString(),
                newStatus: newStatus,
                recipientId: recipientId
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


// POST /api/tickets/update-status
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

        const [currentTicket] = await pool.query('SELECT status, moderator_id, user_id, created_at FROM tickets WHERE id = ?', [ticketId]);

        if (currentTicket.length === 0) {
            return res.status(404).json({ message: 'Тикет не найден.' });
        }
        
        const oldStatus = currentTicket[0].status;
        let moderator_id = currentTicket[0].moderator_id;
        
        if (oldStatus === 'New' && !moderator_id) {
            moderator_id = moderatorId;
        }

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
        
        res.json({ 
            message: `Статус тикета #${ticketId} обновлен на "${newStatus}".`,
            newStatus: newStatus,
            moderatorId: moderator_id,
            timeSpent: timeSpent
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Ошибка обновления статуса тикета:', error);
        res.status(500).json({ message: 'Ошибка сервера при обновлении статуса.' });
    } finally {
        if (connection) connection.release();
    }
});


// POST /api/tickets/update-user-info
router.post('/update-user-info', isModeratorOrAdmin, async (req, res) => {
    const { userId, fullName, phoneNumber } = req.body;

    if (!userId) {
        return res.status(400).json({ message: 'Требуется ID пользователя.' });
    }

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