// routes/authRoutes.js

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, comparePassword } = require('../utils/auth');

// --- Middleware для проверки авторизации и ролей ---
/**
 * Проверяет, авторизован ли пользователь.
 */
function isAuthenticated(req, res, next) {
    if (req.session.userId) {
        next();
    } else {
        res.status(401).json({ message: 'Требуется авторизация.' });
    }
}

/**
 * Проверяет, является ли пользователь модератором или администратором.
 */
function isModeratorOrAdmin(req, res, next) {
    if (req.session.userId && (req.session.userRole === 'moderator' || req.session.userRole === 'admin')) {
        next();
    } else {
        res.status(403).json({ message: 'Доступ запрещен. Требуется роль модератора/администратора.' });
    }
}

/**
 * Проверяет, является ли пользователь администратором.
 */
function isAdmin(req, res, next) {
    if (req.session.userId && req.session.userRole === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Доступ запрещен. Требуется роль администратора.' });
    }
}
// ---------------------------------------------------


// POST /api/auth/register-admin
router.post('/register-admin', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Требуется имя пользователя и пароль.' });
    }

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


// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ message: 'Введите имя пользователя и пароль.' });
    }

    try {
        // Выбираем все нужные поля
        const [users] = await pool.query('SELECT id, password_hash, role, full_name, phone_number FROM users WHERE username = ?', [username]);

        if (users.length === 0) {
            return res.status(401).json({ message: 'Неверное имя пользователя или пароль.' });
        }

        const user = users[0];
        const isMatch = await comparePassword(password, user.password_hash);

        if (!isMatch) {
            return res.status(401).json({ message: 'Неверное имя пользователя или пароль.' });
        }

        // Устанавливаем данные в сессию
        req.session.userId = user.id;
        req.session.userRole = user.role;
        req.session.username = username;

        // Отправляем успешный ответ (включая данные профиля)
        res.json({ 
            message: 'Успешный вход.', 
            role: user.role, 
            userId: user.id,
            username: username,
            full_name: user.full_name,
            phone_number: user.phone_number
        });

    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ message: 'Ошибка сервера при входе.' });
    }
});


// POST /api/auth/logout
router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Не удалось завершить сессию.' });
        }
        res.clearCookie('connect.sid'); 
        res.json({ message: 'Выход выполнен успешно.' });
    });
});


// GET /api/auth/status (Исправлен для получения полных данных)
router.get('/status', async (req, res) => {
    if (!req.session.userId) {
        return res.json({ isLoggedIn: false });
    }

    try {
        // Запрашиваем актуальные данные из БД при проверке статуса
        const [users] = await pool.query(
            'SELECT username, role, full_name, phone_number FROM users WHERE id = ?', 
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
                phone_number: user.phone_number
            });
        } else {
            // Пользователь не найден в БД, сбрасываем сессию
            req.session.destroy();
            res.json({ isLoggedIn: false });
        }
    } catch (error) {
        console.error('Ошибка получения статуса:', error);
        res.status(500).json({ isLoggedIn: false, message: 'Ошибка сервера.' });
    }
});


// GET /api/auth/admin-exists
router.get('/admin-exists', async (req, res) => {
    try {
        const [adminCheck] = await pool.query('SELECT COUNT(*) AS count FROM users WHERE role = ?', ['admin']);
        const exists = adminCheck[0].count > 0;

        res.json({ adminExists: exists });
    } catch (error) {
        console.error('Ошибка проверки существования администратора:', error);
        res.status(500).json({ adminExists: true, message: 'Ошибка сервера.' });
    }
});


// POST /api/auth/save-subscription
router.post('/save-subscription', isAuthenticated, async (req, res) => {
    const { subscription } = req.body;
    const userId = req.session.userId;

    if (!subscription) {
        return res.status(400).json({ message: 'Требуется объект подписки.' });
    }

    try {
        await pool.query(
            'UPDATE users SET push_subscription = ? WHERE id = ?',
            [JSON.stringify(subscription), userId]
        );
        res.json({ message: 'Подписка успешно сохранена.' });
    } catch (error) {
        console.error('Ошибка сохранения подписки:', error);
        res.status(500).json({ message: 'Ошибка сервера при сохранении подписки.' });
    }
});


// POST /api/user/update-profile
// Обновление ФИО и телефона пользователем (напрямую, без модератора)
router.post('/user/update-profile', isAuthenticated, async (req, res) => {
    const { fullName, phoneNumber } = req.body;
    const userId = req.session.userId;

    try {
        await pool.query(
            'UPDATE users SET full_name = ?, phone_number = ? WHERE id = ?',
            [fullName || null, phoneNumber || null, userId] // null, если пустая строка
        );
        
        res.json({ message: 'Данные успешно обновлены.' });
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        res.status(500).json({ message: 'Ошибка сервера при обновлении данных.' });
    }
});


module.exports = {
    router,
    isAuthenticated,
    isModeratorOrAdmin,
    isAdmin
};