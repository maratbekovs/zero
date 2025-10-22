// public/js/login.js — форма входа + полноценный переключатель темы (dark по умолчанию)
document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '/api';

  // Elements
  const formLogin = byId('form-login');
  const loginUsername = byId('login-username');
  const loginPassword = byId('login-password');
  const toggleLoginPass = byId('toggle-login-pass');
  const btnLogin = byId('btn-login');
  const btnLoginText = byId('btn-login-text');
  const btnLoginSpinner = byId('btn-login-spinner');
  const loginMsg = byId('login-msg');
  const globalMsg = byId('global-msg');
  const capsHint = byId('caps-hint');
  const themeToggle = byId('theme-toggle');

  // Helpers
  function byId(id){ return document.getElementById(id); }
  function show(el){ el && el.classList.remove('hidden'); }
  function hide(el){ el && el.classList.add('hidden'); }
  function setBusy(btn, spinner, textEl, busy, textDefault){
    if (!btn) return;
    btn.disabled = !!busy;
    if (busy){ show(spinner); if (textEl) textEl.textContent = 'Подождите...'; }
    else { hide(spinner); if (textEl) textEl.textContent = textDefault; }
  }
  function setError(el, msg){
    if (!el) return;
    el.textContent = msg || '';
    if (msg) {
      show(el);
      const card = el.closest('.auth');
      if (card){ card.classList.remove('shake'); requestAnimationFrame(()=> card.classList.add('shake')); }
    } else hide(el);
  }
  function routeByRole(role){
    if (role === 'moderator' || role === 'admin') { location.href = '/moder.html'; return; }
    location.href = '/user.html';
  }

  // ===== Тема: dark/light, по умолчанию — dark =====
  const THEME_KEY = 'zero_theme';
  function getTheme(){
    const t = localStorage.getItem(THEME_KEY);
    return (t === 'light' || t === 'dark') ? t : 'dark';
  }
  function setTheme(theme){
    const html = document.documentElement;
    html.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    // Иконка и подсказка
    const isDark = theme === 'dark';
    if (themeToggle){
      themeToggle.textContent = isDark ? '☀️' : '🌙'; // показываем цель переключения
      themeToggle.title = isDark ? 'Включить светлую тему' : 'Включить тёмную тему';
      themeToggle.setAttribute('aria-label', themeToggle.title);
    }
  }
  function toggleTheme(){
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
  }
  // Инициализация иконки по текущей теме
  setTheme(getTheme());
  themeToggle?.addEventListener('click', toggleTheme);

  // Если уже авторизован — редирект
  (async function checkAuth(){
    try{
      const res = await fetch(`${API_BASE}/auth/status`, { credentials:'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.isLoggedIn) routeByRole(data.role);
    }catch{}
  })();

  // Показ/скрытие пароля
  toggleLoginPass?.addEventListener('click', ()=> togglePass(loginPassword, toggleLoginPass));
  function togglePass(input, btn){
    if (!input) return;
    const isPw = input.type === 'password';
    input.type = isPw ? 'text' : 'password';
    if (btn) btn.textContent = isPw ? '🙈' : '👁️';
    input.focus({ preventScroll:true });
  }

  // CapsLock детектор
  loginPassword?.addEventListener('keyup', (e)=> {
    const caps = e.getModifierState && e.getModifierState('CapsLock');
    if (caps) show(capsHint); else hide(capsHint);
  });

  // Логин: Enter на username -> к паролю
  loginUsername?.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter'){
      e.preventDefault();
      loginPassword?.focus();
    }
  });

  // Сабмит логина
  formLogin?.addEventListener('submit', async (e)=>{
    e.preventDefault();
    setError(loginMsg, '');

    const username = (loginUsername?.value || '').trim();
    const password = loginPassword?.value || '';

    if (!username){
      setError(loginMsg, 'Введите логин.');
      loginUsername?.focus();
      return;
    }
    if (!password){
      setError(loginMsg, 'Введите пароль.');
      loginPassword?.focus();
      return;
    }

    try{
      setBusy(btnLogin, btnLoginSpinner, btnLoginText, true, 'Войти');

      const res = await fetch(`${API_BASE}/auth/login`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ username, password })
      });

      const isJson = (res.headers.get('content-type')||'').includes('application/json');
      const data = isJson ? await res.json() : { message: await res.text() };

      if (!res.ok){
        const msg = data.message || (res.status === 401 ? 'Неверный логин или пароль.' : `Ошибка входа (${res.status})`);
        setError(loginMsg, msg);
        return;
      }

      routeByRole(data.role);
    }catch{
      setError(loginMsg, 'Не удалось подключиться к серверу.');
    }finally{
      setBusy(btnLogin, btnLoginSpinner, btnLoginText, false, 'Войти');
    }
  });
});