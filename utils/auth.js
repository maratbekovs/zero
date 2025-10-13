// utils/auth.js

const bcrypt = require('bcryptjs');

/**
 * Хеширует пароль с использованием bcrypt.
 * @param {string} password Пароль, который нужно хешировать.
 * @returns {Promise<string>} Хешированный пароль.
 */
async function hashPassword(password) {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

/**
 * Сравнивает предоставленный пароль с хешем.
 * @param {string} password Пароль, введенный пользователем.
 * @param {string} hash Хеш пароля из базы данных.
 * @returns {Promise<boolean>} True, если пароли совпадают.
 */
async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

module.exports = {
    hashPassword,
    comparePassword
};