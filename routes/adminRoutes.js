// routes/adminRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, comparePassword } = require('../utils/auth');
const { isAdmin, isModeratorOrAdmin } = require('./authRoutes'); 


// POST /api/admin/create-user
// ... (Код без изменений) ...
router.post('/create-user', isAdmin, async (req, res) => {
    const { username, password, role = 'user' } = req.body; 

    if (!username || !password) {
        return res.status(400).json({ message: 'Требуется имя пользователя и пароль.' });
    }

    if (!['user', 'moderator'].includes(role)) {
        return res.status(400).json({ message: 'Недопустимая роль. Разрешено: user, moderator.' });
    }

    try {
        const [adminCheck] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE username = ?', [username]);
        if (adminCheck[0].count > 0) {
            return res.status(409).json({ message: 'Пользователь с таким именем уже существует.' });
        }
        
        const password_hash = await hashPassword(password);
        const result = await pool.query(
            'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
            [username, password_hash, role]
        );

        res.status(201).json({ 
            message: `✅ Пользователь/Модератор '${username}' успешно создан.`,
            userId: result[0].insertId,
            role: role
        });

    } catch (error) {
        console.error('Ошибка создания пользователя:', error);
        res.status(500).json({ message: 'Ошибка сервера при регистрации.' });
    }
});


// GET /api/admin/users
// ... (Код без изменений) ...
router.get('/users', isAdmin, async (req, res) => {
    try {
        const [users] = await pool.query(
            'SELECT id, username, role, full_name, phone_number, created_at FROM users WHERE role != "admin" ORDER BY id DESC'
        );
        
        res.json(users);

    } catch (error) {
        console.error('Ошибка получения списка пользователей:', error);
        res.status(500).json({ message: 'Ошибка сервера при получении списка.' });
    }
});


// !!! НОВЫЙ РОУТ: GET /api/admin/report
// Генерация отчета о закрытых тикетах
router.get('/report', isModeratorOrAdmin, async (req, res) => {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Требуются даты начала (startDate) и окончания (endDate).' });
    }
    
    // Добавляем один день к конечной дате, чтобы включить весь последний день
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
                u_user.username AS client_username,
                u_user.full_name AS client_full_name,
                u_mod.username AS moderator_username
            FROM tickets t
            JOIN users u_user ON t.user_id = u_user.id
            LEFT JOIN users u_mod ON t.moderator_id = u_mod.id
            WHERE t.status IN ('Successful', 'Rejected')
              AND t.closed_at >= ? 
              AND t.closed_at < ?
            ORDER BY t.closed_at DESC
        `, [startDate, endDateTime]);
        
        // Для каждого тикета получаем историю изменения статусов (для полной картины)
        const reportsWithHistory = await Promise.all(reports.map(async (report) => {
            const [history] = await pool.query(`
                SELECT new_status, change_time, u.username AS changer_username
                FROM status_history sh
                JOIN users u ON sh.user_id = u.id
                WHERE sh.ticket_id = ?
                ORDER BY sh.change_time ASC
            `, [report.ticket_id]);
            
            return {
                ...report,
                history: history
            };
        }));
        
        res.json(reportsWithHistory);

    } catch (error) {
        console.error('Ошибка формирования отчета:', error);
        res.status(500).json({ message: 'Ошибка сервера при формировании отчета.' });
    }
});


module.exports = router;