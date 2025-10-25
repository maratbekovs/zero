// public/js/avatars.js
// Лёгкая логика загрузки аватара на странице user.html

(function(){
  const API_BASE = '/api';

  function setImg(el, url){
    if (!el) return;
    el.src = url || '/icons/user-placeholder.png';
  }

  async function onUpload(){
    const input = document.getElementById('avatar-input');
    const msg = document.getElementById('avatar-upload-msg');
    const img = document.getElementById('profile-avatar');
    if (!input || !input.files || !input.files[0]) {
      if (msg) msg.textContent = 'Выберите файл.';
      return;
    }
    const fd = new FormData();
    fd.append('avatar', input.files[0]);
    try{
      const res = await fetch(`${API_BASE}/auth/upload-avatar`, { method:'POST', body: fd, credentials: 'include' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Ошибка загрузки');
      setImg(img, data.avatar_url);
      if (msg) msg.textContent = 'Аватар обновлен.';
    }catch(e){
      if (msg) msg.textContent = e.message || 'Ошибка загрузки.';
    }
  }

  document.addEventListener('DOMContentLoaded', ()=>{
    const btn = document.getElementById('avatar-upload-btn');
    btn && btn.addEventListener('click', onUpload);
  });
})();