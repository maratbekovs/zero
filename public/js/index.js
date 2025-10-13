// Базовый URL API относительный к текущему origin, чтобы не зависеть от порта/домена
const API_BASE = '/api/auth';

const statusDisplay = document.getElementById('status-display');
const loadingMessage = document.getElementById('loading-message');
const adminSetupArea = document.getElementById('admin-setup-area');
const adminSetupForm = document.getElementById('admin-setup-form');
const loginArea = document.getElementById('login-area');
const loginForm = document.getElementById('login-form');
const loggedInArea = document.getElementById('logged-in-area');
const userDisplay = document.getElementById('user-display');
const roleDisplay = document.getElementById('role-display');
const logoutButton = document.getElementById('logout-button');

// Универсальный помощник для безопасного чтения ответа
async function readResponseSafe(res) {
    const text = await res.text();
    try {
        return { ok: res.ok, status: res.status, body: JSON.parse(text) };
    } catch {
        return { ok: res.ok, status: res.status, body: text };
    }
}

// --- Вспомогательные функции UI ---
function showMessage(type, text) {
    statusDisplay.textContent = text;
    statusDisplay.className = `message ${type}`;
    statusDisplay.classList.remove('hidden');
}

function hideAllAreas() {
    loadingMessage.classList.add('hidden');
    adminSetupArea.classList.add('hidden');
    loginArea.classList.add('hidden');
    loggedInArea.classList.add('hidden');
    statusDisplay.classList.add('hidden');
}

// --- Обработчики форм ---

// 1. Создание Администратора
adminSetupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = adminSetupForm.elements['admin_username'].value;
    const password = adminSetupForm.elements['admin_password'].value;

    try {
        const res = await fetch(`${API_BASE}/register-admin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const { ok, status, body } = await readResponseSafe(res);
        if (ok) {
            const msg = (body && body.message) || 'Успешно. Пожалуйста, войдите.';
            showMessage('success', msg + ' Пожалуйста, войдите.');
            hideAllAreas();
            loginArea.classList.remove('hidden');
        } else {
            const err = (body && body.message) || (typeof body === 'string' ? body : '') || `Ошибка (${status})`;
            showMessage('error', err);
        }
    } catch (error) {
        console.error('Fetch error:', error);
        showMessage('error', 'Ошибка подключения к серверу.');
    }
});

// 2. Вход в систему
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = loginForm.elements['login_username'].value;
    const password = loginForm.elements['login_password'].value;

    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        const { ok, status, body } = await readResponseSafe(res);
        if (ok) {
            const msg = (body && body.message) || 'Вход выполнен';
            showMessage('success', msg);
            checkAuthStatus(true);
        } else {
            const err = (body && body.message) || (typeof body === 'string' ? body : '') || `Ошибка (${status})`;
            showMessage('error', err);
        }
    } catch (error) {
        console.error('Fetch error:', error);
        showMessage('error', 'Ошибка подключения к серверу.');
    }
});

// 3. Выход из системы
logoutButton.addEventListener('click', async () => {
    try {
        const res = await fetch(`${API_BASE}/logout`, { method: 'POST' });
        const { ok, status, body } = await readResponseSafe(res);
        if (ok) {
            const msg = (body && body.message) || 'Вы вышли из системы';
            showMessage('success', msg);
            setTimeout(checkAuthStatus, 1500);
        } else {
            const err = (body && body.message) || (typeof body === 'string' ? body : '') || `Ошибка (${status})`;
            showMessage('error', err);
        }
    } catch (error) {
        console.error('Fetch error:', error);
        showMessage('error', 'Ошибка подключения к серверу.');
    }
});

// --- Основная логика проверки статуса ---
async function checkAuthStatus(immediateRedirect = false) {
    loadingMessage.classList.remove('hidden'); 
    hideAllAreas();

    try {
        const res = await fetch(`${API_BASE}/status`);
        const { ok, status, body } = await readResponseSafe(res);
        if (!ok) {
            const err = (body && body.message) || (typeof body === 'string' ? body : '') || `Ошибка (${status})`;
            throw new Error(err);
        }

        const authData = body || {};
        if (authData.isLoggedIn) {
            userDisplay.textContent = authData.username || '';
            roleDisplay.textContent = (authData.role || '').toUpperCase();
            loggedInArea.classList.remove('hidden');

            if (immediateRedirect) {
                performRedirect(authData.role);
            } else {
                setTimeout(() => performRedirect(authData.role), 1500);
            }
        } else {
            await showAppropriateForm();
        }
    } catch (error) {
        console.error('Ошибка проверки статуса:', error);
        hideAllAreas();
        showMessage('error', 'Не удалось связаться с сервером. Проверьте, запущен ли он.');
    }
}

async function showAppropriateForm() {
    try {
        const res = await fetch(`${API_BASE}/admin-exists`);
        const { ok, status, body } = await readResponseSafe(res);
        if (!ok) {
            const err = (body && body.message) || (typeof body === 'string' ? body : '') || `Ошибка (${status})`;
            throw new Error(err);
        }

        const adminCheckData = body || {};
        hideAllAreas();
        
        if (adminCheckData.adminExists) {
            loginArea.classList.remove('hidden');
        } else {
            adminSetupArea.classList.remove('hidden');
        }
    } catch (error) {
        hideAllAreas();
        showMessage('error', 'Критическая ошибка: Не удалось проверить статус администратора.');
    }
}

function performRedirect(role) {
     if (role === 'admin' || role === 'moderator') {
         window.location.href = '/moder.html'; 
     } else {
         window.location.href = '/user.html'; 
     }
}

// Запускаем проверку при загрузке страницы
window.onload = checkAuthStatus;