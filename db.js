// db.js

const mysql = require('mysql2/promise');
require('dotenv').config();

// Конфигурация подключения берется из .env
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

/**
 * Функция для проверки подключения к БД и инициализации таблиц.
 */
async function initializeDB() {
    console.log("Попытка подключения к MySQL...");
    try {
        await pool.getConnection();
        console.log("✅ Успешное подключение к MySQL.");

        // SQL для создания таблиц
        const createTablesSQL = `
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NULL,
                phone_number VARCHAR(20) NULL,
                role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user',
                -- !!! ИСПРАВЛЕНИЕ: Добавляем столбец created_at
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
                attachment_url VARCHAR(255) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES tickets(id),
                FOREIGN KEY (sender_id) REFERENCES users(id)
            );

            -- Дополнительная таблица для логов (для отчетов и истории)
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

            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(100) NULL,
                phone_number VARCHAR(20) NULL,
                role ENUM('user', 'moderator', 'admin') NOT NULL DEFAULT 'user',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                push_subscription JSON NULL  -- !!! НОВОЕ: Столбец для хранения Push-подписки
            );
        `;

        await pool.query(createTablesSQL);
        console.log("✅ Таблицы успешно созданы или уже существуют.");

    } catch (error) {
        console.error("❌ Ошибка при работе с базой данных:", error.message);
    }
}

module.exports = {
    pool,
    initializeDB
};