// db.js
//
// Добавлена таблица message_attachments + безопасный ALTER на случай уже существующей БД.

const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true 
});

async function initializeDB() {
    console.log("Попытка подключения к MySQL...");
    try {
        await pool.getConnection();
        console.log("✅ Успешное подключение к MySQL.");

        const createTablesSQL = `
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NULL,
                phone_number VARCHAR(20) NULL,
                avatar_url VARCHAR(255) NULL,
                role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS tickets (
                id INT AUTO_INCREMENT PRIMARY KEY,
                user_id INT NOT NULL,
                moderator_id INT NULL,
                subject VARCHAR(255) NOT NULL,
                status ENUM('New', 'In Progress', 'On Hold', 'Successful', 'Rejected') NOT NULL DEFAULT 'New',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                closed_at TIMESTAMP NULL,
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (moderator_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                sender_id INT NOT NULL,
                message_text TEXT NOT NULL,
                attachment_url VARCHAR(255) NULL, -- оставлено для совместимости (не используется для множества)
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id),
                FOREIGN KEY (sender_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS status_history (
                id INT AUTO_INCREMENT PRIMARY KEY,
                ticket_id INT NOT NULL,
                user_id INT NOT NULL,
                old_status VARCHAR(50),
                new_status VARCHAR(50) NOT NULL,
                change_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id),
                FOREIGN KEY (user_id) REFERENCES users(id)
            );

            -- Таблица для мультивложений сообщений
            CREATE TABLE IF NOT EXISTS message_attachments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                message_id INT NOT NULL,
                url VARCHAR(255) NOT NULL,
                mime_type VARCHAR(100) NULL,
                size INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            );

            -- Дублированное создание users (как у вас в исходнике) — дополнено avatar_url и push_subscription
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NULL,
                phone_number VARCHAR(20) NULL,
                avatar_url VARCHAR(255) NULL,
                role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                push_subscription JSON NULL
            );
        `;

        await pool.query(createTablesSQL);

        // Безопасные ALTER'ы на случай старых БД
        try {
          await pool.query("ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL AFTER phone_number");
        } catch (e) {
          if (e && e.code !== 'ER_DUP_FIELDNAME' && !String(e.message||'').includes('Duplicate')) {
            console.warn('ALTER users ADD avatar_url failed:', e.message);
          }
        }

        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS message_attachments (
                id INT AUTO_INCREMENT PRIMARY KEY,
                message_id INT NOT NULL,
                url VARCHAR(255) NOT NULL,
                mime_type VARCHAR(100) NULL,
                size INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
            )
          `);
        } catch (e) {
          console.warn('CREATE message_attachments failed:', e.message);
        }

        console.log("✅ Таблицы успешно созданы или уже существуют.");
    } catch (error) {
        console.error("❌ Ошибка при работе с базой данных:", error.message);
    }
}

module.exports = {
    pool,
    initializeDB
};