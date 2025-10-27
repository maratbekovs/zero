// public/js/moder.js
// Полная версия с доработками:
// - Глобальный баннер уведомлений (localStorage dismiss, requestPermission, сохранение подписки)
// - Профиль: вид ФИО/тел/аватар + режим редактирования, аватар меняется только в режиме редактирования
// - Чат: лайтбокс, подписи к вложениям (caption), отступы между медиа (в CSS), отправка каждого файла отдельным сообщением,
//        защита от дублей (блок кнопки + сигнатуры + clientMessageId), нормализация iOS-файлов,
//        отправляем только attachments (без fallback), компактная кнопка "＋" и компактная отправка "➤" на десктопе (как на мобильной)
// - Тикеты: переключатель "Все / Мои" (в "Мои" — тикеты, где вы назначены ответственным), в общем списке скрываем Successful/Rejected
// - Исправлены бейджи статусов с пробелами (s-InProgress, s-OnHold)
// - Явно показываем “Ответственный” (аватар + имя) в списке и в шапке чата; в чате добавлен устойчивый fallback из данных тикета.

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '/api';
  const socket = io('/', { withCredentials: true });

  // ===== Helpers =====
  const byId = id => document.getElementById(id);
  const qs = (s, r=document) => r.querySelector(s);
  const qsa = (s, r=document) => Array.from(r.querySelectorAll(s));
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);
  const escapeHtml = (str='') => String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s]));
  const formatDateSafe = d => { if (!d) return '—'; const dt=new Date(d); return isNaN(dt.getTime())?'—':dt.toLocaleString(); };
  const isMobile = () => window.matchMedia && window.matchMedia('(max-width: 768px)').matches;

  // RU статусы + классы
  const statusMapRU = { 'New':'Новая','In Progress':'В работе','On Hold':'На согласовании','Successful':'Успешно','Rejected':'Отклонено' };
  const statusToRu = s => statusMapRU[s] || (s || '—');
  const statusClass = s => {
    const map = {
      'New':'s-New',
      'In Progress':'s-InProgress',
      'On Hold':'s-OnHold',
      'Successful':'s-Successful',
      'Rejected':'s-Rejected'
    };
    return map[s] || 's-New';
  };

  // ===== Push (баннер уведомлений) =====
  const NB_KEY = 'moder.notifyBanner.dismissed';
  const nb = { wrap:byId('notify-banner'), enable:byId('nb-enable'), settings:byId('nb-settings'), close:byId('nb-close') };

  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/service-worker.js').catch(()=>{}); }
  async function fetchVapidPublicKey(){ try{ const r=await fetch(`${API_BASE}/auth/vapid-public-key`,{credentials:'include'}); const js=await r.json(); return js.publicKey; }catch{return '';} }
  function urlBase64ToUint8Array(base64String){
    const padding='='.repeat((4-base64String.length%4)%4);
    const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
    const rawData=atob(base64); const out=new Uint8Array(rawData.length);
    for(let i=0;i<rawData.length;i++) out[i]=rawData.charCodeAt(i);
    return out;
  }
  async function ensureSavedSubscription(){
    try{
      if (!('serviceWorker'in navigator) || !('PushManager'in window) || !('Notification'in window)) return;
      if (Notification.permission!=='granted') return;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription){
        const publicKey = await fetchVapidPublicKey(); if (!publicKey) return;
        subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      }
      await fetch(`${API_BASE}/auth/save-subscription`,{
        method:'POST', headers:{'Content-Type':'application/json'}, credentials:'include',
        body: JSON.stringify({ subscription })
      });
    }catch{}
  }
  function updateNotifyBanner(){
    if (!nb.wrap) return;
    const dismissed = localStorage.getItem(NB_KEY) === '1';
    if (!('serviceWorker'in navigator) || !('PushManager'in window) || !('Notification'in window) || dismissed){
      nb.wrap.style.display='none'; return;
    }
    const perm = Notification.permission;
    if (perm === 'granted'){ nb.wrap.style.display='none'; ensureSavedSubscription(); }
    else {
      nb.wrap.style.display='';
      if (nb.enable) nb.enable.style.display = (perm==='default')?'':'none';
      if (nb.settings) nb.settings.style.display = (perm==='denied')?'':'none';
    }
  }
  on(nb.enable,'click', async ()=>{ try{ const p=await Notification.requestPermission(); if (p==='granted') await ensureSavedSubscription(); }catch{} updateNotifyBanner(); });
  on(nb.settings,'click', ()=> alert('Откройте настройки сайта в браузере и разрешите уведомления для этого домена.'));
  on(nb.close,'click', ()=>{ localStorage.setItem(NB_KEY,'1'); updateNotifyBanner(); });

  // ===== State =====
  let me = null;
  let allTickets = [];
  let activeTicket = null;
  let usersCache = [];
  let editingUserId = null;

  // Отправка сообщений: антидубли
  let isSendingMessage = false;
  const recentSendSigs = new Set();
  const makeSig = (ticketId, text, files) => [String(ticketId||''), String(text||'').trim(), ...files.map(f=>`${f.name||''}:${f.size||0}:${f.type||''}`)].join('|');
  const rememberSig = (s, ttl=10000) => { recentSendSigs.add(s); setTimeout(()=>recentSendSigs.delete(s), ttl); };
  const genId = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : `m-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  function normalizeFile(f){
    try{
      const hasName=!!f?.name; const type=f?.type||''; const hasExt=/\.[a-z0-9]+$/i.test(hasName?f.name:'');
      if (hasName && hasExt) return f;
      let ext='bin'; if (type.startsWith('image/')) ext=type.split('/')[1]||'jpg'; else if (type.startsWith('video/')) ext=type.split('/')[1]||'mp4';
      const base=hasName?(f.name.replace(/\.[a-z0-9]+$/i,'')):(type.startsWith('image/')?'photo':(type.startsWith('video/')?'video':'file'));
      return new File([f], `${base}.${ext}`, { type:type||'application/octet-stream', lastModified:f.lastModified||Date.now() });
    }catch{ return f; }
  }

  // ===== DOM refs =====
  // Header/Me
  const meUsernameEl = byId('me-username');
  const meRoleEl = byId('me-role');

  // Profile view/edit
  const profileUsername = byId('profile-username');
  const profileRole = byId('profile-role');
  const profileAvatar = byId('profile-avatar');
  const profileFullname = byId('profile-fullname');
  const profilePhone = byId('profile-phone');
  const profileEditToggle = byId('profile-edit-toggle');
  const profileSaveBtn = byId('profile-save');
  const profileCancelBtn = byId('profile-cancel');
  const profileEditPanel = byId('profile-edit-panel');
  const profFullname = byId('prof-fullname');
  const profPhone = byId('prof-phone');
  const profAvatarInput = byId('prof-avatar');
  const profAvatarPick = byId('prof-avatar-pick');
  const profAvatarMsg = byId('prof-avatar-msg');

  // Nav
  const navLinks = qsa('.nav a');
  const mobileTabs = qsa('.mobile-tab-bar .tab-item');

  // Tickets
  const ticketsTableBody = qs('#tickets-table tbody');
  const searchInput = byId('search');
  const filterStatus = byId('filter-status');
  const btnReload = byId('btn-reload');
  const statTotal = byId('stat-total');
  const statNew = byId('stat-new');
  const statIP = byId('stat-ip');

  // Scope toggles (Все/Мои)
  const scopeAllBtn = byId('scope-all');
  const scopeMyBtn = byId('scope-my');
  let ticketScope = 'all'; // 'all' | 'my'

  // Desktop chat
  const d = {
    panel: byId('chat-panel'),
    box: byId('chat-box'),
    ticketId: byId('chat-ticket-id'),
    subject: byId('chat-ticket-subject'),
    userId: byId('chat-user-id'),
    status: byId('current-status'),
    statusSelect: byId('status-select'),
    updateStatusBtn: byId('update-status-button'),
    timeSpent: byId('time-spent-display'),
    closedBanner: byId('chat-closed-banner'),
    actions: byId('chat-actions'),
    input: byId('chat-input'),
    file: byId('chat-attachment'),
    attachToggle: byId('d-attach-toggle'),
    attachMenu: byId('d-attach-menu'),
    menuPick: byId('dbtn-pick'),
    menuPhoto: byId('dbtn-photo'),
    menuVideo: byId('dbtn-video'),
    btnSend: byId('chat-send-button'),
    preview: byId('preview'),
    previewThumb: byId('preview-thumb'),
    btnClearPreview: byId('btn-clear-preview')
  };

  // Mobile chat
  const m = {
    modal: byId('mchat-modal'),
    close: byId('mchat-close'),
    box: byId('mchat-box'),
    ticketId: byId('mchat-ticket-id'),
    subject: byId('mchat-ticket-subject'),
    status: byId('mchat-status'),
    statusSelect: byId('mstatus-select'),
    updateStatusBtn: byId('mupdate-status-button'),
    timeSpent: byId('mtime-spent-display'),
    closedBanner: byId('mchat-closed-banner'),
    actions: byId('mchat-actions'),
    input: byId('mchat-input'),
    file: byId('mchat-attachment'),
    btnPick: byId('mbtn-pick'),
    btnPhoto: byId('mbtn-photo'),
    btnVideo: byId('mbtn-video'),
    btnSend: byId('mchat-send'),
    preview: byId('mpreview'),
    previewThumb: byId('mpreview-thumb'),
    btnClearPreview: byId('mbtn-clear-preview'),
    attachToggle: byId('mattach-toggle'),
    attachMenu: byId('mattach-menu')
  };

  // Users
  const usersTableBody = qs('#users-table tbody');
  const btnReloadUsers = byId('btn-reload-users');
  const btnCreateUser = byId('btn-create-user');
  const createUserMsg = byId('create-user-msg');

  // Edit user modal
  const editModal = byId('edit-user-modal');
  const editTitle = byId('edit-user-title');
  const editClose = byId('edit-user-close');
  const editCancel = byId('edit-user-cancel');
  const editSave = byId('edit-user-save');
  const editMsg = byId('edit-user-message');
  const editFullname = byId('edit-user-fullname');
  const editPhone = byId('edit-user-phone');
  const editRole = byId('edit-user-role');

  // Logout
  const btnLogout = byId('btn-logout');
  const btnLogout2 = byId('logout-2');

  // ===== Roles =====
  function filterStatusOptions(){
    if (!me?.role) return;
    const only=['In Progress','On Hold'];
    [d.statusSelect, m.statusSelect].forEach(sel=>{
      if (!sel) return;
      Array.from(sel.options).forEach(opt=>{
        if (me.role==='moderator' && !only.includes(opt.value)){ opt.disabled=true; opt.hidden=true; }
      });
      if (me.role==='moderator' && sel.value && !only.includes(sel.value)) sel.value='In Progress';
    });
  }
  const canSetStatus = v => me?.role==='moderator' ? ['In Progress','On Hold'].includes(v) : true;

  // ===== Auth =====
  async function ensureModerator() {
    try{
      const res = await fetch(`${API_BASE}/auth/status`, { credentials:'include' });
      if (!res.ok) throw new Error('auth');
      const data = await res.json();
      if (!data.isLoggedIn || !['moderator','admin'].includes(data.role)) throw new Error('role');
      me = {
        userId: data.userId,
        username: data.username,
        role: data.role,
        full_name: data.full_name || '',
        phone_number: data.phone_number || '',
        avatar_url: data.avatar_url || ''
      };
      // Header
      meUsernameEl && (meUsernameEl.textContent = data.username);
      meRoleEl && (meRoleEl.textContent = `роль: ${data.role}`);
      // Profile view
      profileUsername && (profileUsername.textContent = data.username || '—');
      profileRole && (profileRole.textContent = data.role || '—');
      profileFullname && (profileFullname.textContent = data.full_name || '—');
      profilePhone && (profilePhone.textContent = data.phone_number || '—');
      profileAvatar && (profileAvatar.src = data.avatar_url || '/icons/user-placeholder.png');

      filterStatusOptions();
    }catch{ location.href = '/'; }
  }

  // ===== Sections =====
  function closeAttachMenus(){
    if (m.attachMenu){ m.attachMenu.classList.remove('open'); m.attachMenu.setAttribute('aria-hidden','true'); }
    if (d.attachMenu){ d.attachMenu.classList.remove('open'); d.attachMenu.setAttribute('aria-hidden','true'); }
  }
  function activateSection(sec){
    navLinks.forEach(x=> x.classList.toggle('active', x.dataset.section===sec));
    qsa('.section').forEach(s=> s.classList.toggle('active', s.id === `sec-${sec}`));
    mobileTabs.forEach(t=> t.classList.toggle('active', t.dataset.section===sec));
    if (sec==='tickets') reloadTickets();
    if (sec==='users') loadUsers();
    if (sec==='profile') updateNotifyBanner();
  }
  navLinks.forEach(a => on(a, 'click', e => { e.preventDefault(); activateSection(a.dataset.section); closeAttachMenus(); }));
  mobileTabs.forEach(t => on(t, 'click', e => { e.preventDefault(); activateSection(t.dataset.section); closeAttachMenus(); }));

  // ===== Logout =====
  async function doLogout(){ try { await fetch(`${API_BASE}/auth/logout`, { method:'POST', credentials:'include' }); } finally { location.href = '/'; } }
  on(btnLogout, 'click', doLogout);
  on(btnLogout2, 'click', doLogout);

  // ===== Scope toggles (Все/Мои) =====
  function setScope(scope){
    ticketScope = scope;
    scopeAllBtn && scopeAllBtn.classList.toggle('active', scope==='all');
    scopeMyBtn && scopeMyBtn.classList.toggle('active', scope==='my');
    renderTickets();
  }
  on(scopeAllBtn, 'click', ()=> setScope('all'));
  on(scopeMyBtn, 'click', ()=> setScope('my'));

  // ===== Tickets =====
  on(btnReload, 'click', reloadTickets);
  on(searchInput, 'input', renderTickets);
  on(filterStatus, 'change', renderTickets);

  async function reloadTickets(){
    try{
      const res = await fetch(`${API_BASE}/tickets/all`, { credentials:'include' });
      allTickets = res.ok ? await res.json() : [];
      renderTickets();
    }catch(e){ console.warn(e); }
  }

  function isMineTicket(t){
    // покрываем разные схемы ответа бэка
    const uid = Number(me?.userId);
    const ulogin = String(me?.username || '');
    const idCandidates = [t.moderator_id, t.assigned_moderator_id, t.assignee_id, t.moderatorId, t.assigned_to_id].map(x=>Number(x));
    const loginCandidates = [t.moderator_username, t.moderator, t.assigned_to_username, t.assigned_to_login, t.assignee_username].map(x=>x && String(x));
    if (idCandidates.some(v => !isNaN(v) && v === uid)) return true;
    if (loginCandidates.some(v => v && v === ulogin)) return true;
    return false;
  }
  const getResponsibleName = t => (t.moderator_full_name || t.moderator_username || t.assigned_to_full_name || t.assigned_to_username || '').trim();
  const getResponsibleAvatar = t => (t.moderator_avatar_url || t.assigned_to_avatar_url || '');

  function renderTickets(){
    if (!ticketsTableBody) return;

    const q = (searchInput?.value || '').toLowerCase().trim();
    const fs = filterStatus?.value || '';

    // 1) База по области (Все/Мои)
    let base = allTickets.filter(t => ticketScope === 'my' ? isMineTicket(t) : true);

    // 2) По умолчанию скрываем завершённые (если фильтр статуса не выбран)
    if (!fs) {
      base = base.filter(t => !['Successful','Rejected'].includes(t.status));
    }

    // 3) Фильтр по статусу (если выбран)
    if (fs) {
      // Закрытые показываем только в архиве — не отображаем их в общем списке
      if (['Successful','Rejected'].includes(fs)) {
        base = [];
      } else {
        base = base.filter(t => t.status === fs);
      }
    }

    // 4) Поиск
    const filtered = base.filter(t => {
      const hay = `${t.subject||''} ${t.user_username||''} ${t.user_full_name||''} ${getResponsibleName(t)}`.toLowerCase();
      return !q || hay.includes(q);
    });

    // counters (по видимому списку)
    statTotal && (statTotal.textContent = String(filtered.length));
    statNew && (statNew.textContent = String(filtered.filter(t=>t.status==='New').length));
    statIP && (statIP.textContent = String(filtered.filter(t=>t.status==='In Progress').length));

    // render rows (Ответственный в линии с аватаром)
    ticketsTableBody.innerHTML = '';
    for(const t of filtered){
      const respName = getResponsibleName(t);
      const respAvatar = getResponsibleAvatar(t);
      const respHtml = respName
        ? `<div class="muted" title="Кто работает над обращением" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
             <span>Ответственный:</span>
             ${respAvatar ? `<img src="${respAvatar}" alt="" style="width:18px;height:18px;border-radius:50%;object-fit:cover;vertical-align:middle;">` : ''}
             <strong>${escapeHtml(respName)}</strong>
           </div>`
        : `<div class="muted" title="Кто работает над обращением" style="display:flex;align-items:center;gap:6px;">Ответственный: <strong>Не назначен</strong></div>`;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="ID">${t.id}</td>
        <td data-label="Пользователь" class="col-user">
          <div><strong>${escapeHtml(t.user_username || '')}</strong></div>
          <div class="muted">${escapeHtml(t.user_full_name || '')}</div>
          <div class="muted">${escapeHtml(t.user_phone || '')}</div>
          ${respHtml}
        </td>
        <td data-label="Тема">${escapeHtml(t.subject || '')}</td>
        <td data-label="Статус"><span class="status ${statusClass(t.status)}">${statusToRu(t.status)}</span></td>
        <td data-label="Создан" class="muted col-created">${formatDateSafe(t.created_at)}</td>
        <td data-label="Действия">
          <div class="row">
            <button class="btn small" data-open data-id="${t.id}">Открыть чат</button>
            ${me?.role === 'admin' ? `<button class="btn small" data-assign data-id="${t.id}">Назначить</button>` : ''}
          </div>
        </td>
      `;
      ticketsTableBody.appendChild(tr);
    }

    // Handlers
    ticketsTableBody.querySelectorAll('[data-open]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = Number(btn.getAttribute('data-id'));
        const t = allTickets.find(x=>x.id===id);
        if (t) openChat(t);
      });
    });
    ticketsTableBody.querySelectorAll('[data-assign]').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const ticketId = Number(btn.getAttribute('data-id'));
        if (me?.role !== 'admin') return;
        try{
          const res = await fetch('/api/admin/moderators', { credentials:'include' });
          const mods = res.ok ? await res.json() : [];
          if (!mods.length) { alert('Нет доступных модераторов.'); return; }
          const listing = mods.map(m => `${m.id}: ${m.full_name || m.username}`).join('\n');
          const idStr = prompt(`Введите ID модератора для назначения:\n${listing}`);
          const moderatorId = Number(idStr);
          if (!moderatorId) return;
          const r2 = await fetch('/api/tickets/assign', {
            method:'POST',
            headers:{ 'Content-Type':'application/json' },
            credentials:'include',
            body: JSON.stringify({ ticketId, moderatorId })
          });
          const data = await r2.json();
          if (!r2.ok) throw new Error(data.message || 'Ошибка назначения');
          alert('Ответственный назначен.');
          await reloadTickets();
        }catch(e){
          alert(e.message || 'Ошибка назначения');
        }
      });
    });
  }

  // ===== Chat open / header enrich =====
  async function decorateDesktopHeaderWithUserInfo(ticketId, fallbackTicket){
    try{
      const res = await fetch(`/api/auth/ticket-summary/${ticketId}`, { credentials:'include' });
      const ct = res.headers.get('content-type') || '';
      const data = res.ok && ct.includes('application/json') ? await res.json() : null;

      const head = d.panel ? d.panel.querySelector('.chat-head') : null;
      const left = head ? head.querySelector(':scope > div') : null;
      if (!left) return;

      // Контейнер информации (клиент + ответственный)
      let info = left.querySelector('#chat-user-info');
      if (!info) {
        info = document.createElement('div');
        info.id = 'chat-user-info';
        info.style.display = 'flex';
        info.style.flexDirection = 'column';
        info.style.gap = '6px';
        info.style.marginTop = '6px';
        left.appendChild(info);
      }

      // Строка клиента
      let lineUser = info.querySelector('.line-user');
      if (!lineUser){
        lineUser = document.createElement('div');
        lineUser.className = 'line-user';
        lineUser.style.display = 'flex';
        lineUser.style.alignItems = 'center';
        lineUser.style.gap = '8px';
        lineUser.innerHTML = `
          <img id="chat-user-avatar" class="avatar" alt="Пользователь" src="/icons/user-placeholder.png" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">
          <span><strong id="chat-user-fullname">—</strong> · Тел.: <span id="chat-user-phone">—</span></span>
        `;
        info.appendChild(lineUser);
      }

      // Строка ответственного
      let lineResp = info.querySelector('.line-resp');
      if (!lineResp){
        lineResp = document.createElement('div');
        lineResp.className = 'line-resp';
        lineResp.style.display = 'flex';
        lineResp.style.alignItems = 'center';
        lineResp.style.gap = '8px';
        lineResp.innerHTML = `
          <img id="chat-resp-avatar" class="avatar" alt="Ответственный" src="/icons/user-placeholder.png" style="width:24px;height:24px;border-radius:50%;object-fit:cover;">
          <span>Ответственный: <strong id="chat-resp-name">—</strong></span>
        `;
        info.appendChild(lineResp);
      }

      // Клиент
      const u = data?.user || data?.ticket?.user || null;
      const imgU = lineUser.querySelector('#chat-user-avatar');
      const fnU = lineUser.querySelector('#chat-user-fullname');
      const phU = lineUser.querySelector('#chat-user-phone');
      if (u) {
        imgU && (imgU.src = u.avatar_url || '/icons/user-placeholder.png');
        fnU && (fnU.textContent = u.full_name || u.username || '—');
        phU && (phU.textContent = u.phone_number || '—');
      } else {
        imgU && (imgU.src = '/icons/user-placeholder.png');
        fnU && (fnU.textContent = '—');
        phU && (phU.textContent = '—');
      }

      // Ответственный (несколько возможных ключей)
      let mod = data?.moderator
              || data?.assignee
              || data?.responsible
              || data?.moderatorUser
              || data?.ticket?.moderator
              || data?.ticket?.assignee
              || null;

      // Fallback: берём из списка тикетов, если API не вернул
      if (!mod && fallbackTicket){
        const name = fallbackTicket.moderator_full_name
                  || fallbackTicket.moderator_username
                  || fallbackTicket.assigned_to_full_name
                  || fallbackTicket.assigned_to_username
                  || null;
        const avatar = fallbackTicket.moderator_avatar_url
                     || fallbackTicket.assigned_to_avatar_url
                     || null;
        if (name || avatar) {
          mod = { full_name: name, username: name, avatar_url: avatar };
        }
      }

      const imgR = lineResp.querySelector('#chat-resp-avatar');
      const nmR = lineResp.querySelector('#chat-resp-name');
      if (mod) {
        imgR && (imgR.src = mod.avatar_url || '/icons/user-placeholder.png');
        nmR && (nmR.textContent = mod.full_name || mod.username || '—');
      } else {
        imgR && (imgR.src = '/icons/user-placeholder.png');
        nmR && (nmR.textContent = 'Не назначен');
      }
    } catch {}
  }

  function openChat(ticket){
    if (activeTicket?.id && activeTicket.id !== ticket.id) { socket.emit('leaveTicket', activeTicket.id); }
    activeTicket = ticket;
    if (isMobile()) openMobileChat(ticket);
    else openDesktopChat(ticket);
  }

  function openDesktopChat(t){
    d.ticketId && (d.ticketId.textContent = t.id);
    d.subject && (d.subject.textContent = t.subject || '');
    d.userId && (d.userId.textContent = t.user_id || '-');
    d.status && (d.status.textContent = statusToRu(t.status));

    decorateDesktopHeaderWithUserInfo(t.id, t);

    const isClosed = ['Successful','Rejected'].includes(t.status);
    d.closedBanner && (d.closedBanner.style.display = isClosed ? '' : 'none');
    d.actions && (d.actions.style.display = isClosed ? 'none' : 'flex');

    d.panel && d.panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

    socket.emit('joinTicket', t.id);
    loadMessagesTo(t.id, d.box, false);
  }

  function openMobileChat(t){
    if (!m.modal) return;
    m.ticketId && (m.ticketId.textContent = t.id);
    m.subject && (m.subject.textContent = t.subject || '');
    m.status && (m.status.textContent = statusToRu(t.status));
    if (m.statusSelect){
      const allowed = ['In Progress','On Hold','Successful','Rejected'];
      m.statusSelect.value = allowed.includes(t.status) ? t.status : 'In Progress';
      filterStatusOptions();
    }
    const isClosed = ['Successful','Rejected'].includes(t.status);
    m.closedBanner && (m.closedBanner.style.display = isClosed ? '' : 'none');
    m.actions && (m.actions.style.display = isClosed ? 'none' : 'flex');
    m.timeSpent && (m.timeSpent.style.display = 'none');

    closeAttachMenus();
    m.modal.style.display = 'block';
    socket.emit('joinTicket', t.id);
    loadMessagesTo(t.id, m.box, true);
  }

  on(m.close, 'click', ()=>{
    if (activeTicket?.id) socket.emit('leaveTicket', activeTicket.id);
    m.modal && (m.modal.style.display = 'none');
    m.box && (m.box.innerHTML = '');
    m.input && (m.input.value = '');
    m.file && (m.file.value = '');
    m.previewThumb && (m.previewThumb.innerHTML = '');
    m.preview && m.preview.classList.remove('show');
    closeAttachMenus();
  });

  // ===== Загрузка/рендер сообщений =====
  async function loadMessagesTo(ticketId, container, isMobileChat){
    if (!container) return;
    container.innerHTML = '';
    try{
      const res = await fetch(`${API_BASE}/tickets/${ticketId}/messages`, { credentials:'include' });
      const list = res.ok ? await res.json() : [];
      for(const msg of list){ appendMessageTo(msg, container, isMobileChat); }
      container.scrollTop = container.scrollHeight;
    }catch(e){ console.warn(e); }
  }

  function fileCaptionFromUrl(url=''){
    try{
      const p = url.split('?')[0];
      const base = p.split('/').pop() || '';
      return base || 'Вложение';
    } catch { return 'Вложение'; }
  }

  function renderAttachments(arr){
    const frag = document.createDocumentFragment();
    for (const a of (arr||[])) {
      const url = a.url;
      const mime = (a.mime_type||'').toLowerCase();
      const wrap = document.createElement('div');
      wrap.className = 'attach';
      if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(url)) {
        const im = document.createElement('img'); im.src = url; im.alt = 'attach'; wrap.appendChild(im);
      } else if (mime.startsWith('video/') || /\.(mp4|webm|ogg|mov)$/i.test(url)) {
        const vd = document.createElement('video'); vd.src = url; vd.controls = true; wrap.appendChild(vd);
      } else {
        wrap.innerHTML = `<a href="${url}" target="_blank" rel="noopener">📎 Вложение</a>`;
      }
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = fileCaptionFromUrl(url);
      wrap.appendChild(cap);

      frag.appendChild(wrap);
    }
    return frag;
  }

  function appendMessageTo(mg, container, isMobileChat){
    const self = Number(mg.senderId) === Number(me?.userId) || mg.senderRole === 'moderator' || mg.senderRole === 'admin';
    const wrap = document.createElement('div');
    wrap.className = `${isMobileChat ? 'mmsg':'msg'} ${self ? 'me':'other'}`;

    if (!self) {
      const img = document.createElement('img');
      img.className = 'avatar avatar-sm';
      img.alt = 'Фото';
      img.src = mg.senderAvatarUrl || '/icons/user-placeholder.png';
      img.style.width = '28px'; img.style.height = '28px'; img.style.borderRadius = '50%'; img.style.objectFit = 'cover';
      wrap.appendChild(img);
    }

    if (mg.messageText) {
      const text = document.createElement('div');
      text.innerHTML = escapeHtml(mg.messageText);
      wrap.appendChild(text);
    }

    if (Array.isArray(mg.attachments) && mg.attachments.length) {
      wrap.appendChild(renderAttachments(mg.attachments));
    } else if (mg.attachmentUrl) {
      wrap.appendChild(renderAttachments([{ url: mg.attachmentUrl, mime_type: '', size: null }]));
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${mg.senderUsername || mg.senderRole || ''} • ${formatDateSafe(mg.createdAt)}`;
    wrap.appendChild(meta);

    container.appendChild(wrap);
  }

  // ===== Лайтбокс =====
  const lightboxEl = byId('lightbox');
  const lightboxImg = byId('lightbox-img');
  const lightboxClose = byId('lightbox-close');
  function showLightbox(src){ if (!lightboxEl) return; lightboxImg.src = src; lightboxEl.classList.add('open'); lightboxEl.setAttribute('aria-hidden','false'); }
  function hideLightbox(){ if (!lightboxEl) return; lightboxEl.classList.remove('open'); lightboxEl.setAttribute('aria-hidden','true'); lightboxImg.src = ''; }
  on(lightboxEl, 'click', (e)=>{ if (e.target===lightboxEl || e.target===lightboxClose) hideLightbox(); });
  document.addEventListener('keydown', (e)=>{ if (e.key==='Escape' && lightboxEl && lightboxEl.classList.contains('open')) hideLightbox(); });
  function bindLightboxClicks(container){
    if (!container) return;
    container.addEventListener('click', (e)=>{
      const im = e.target && e.target.closest('.attach img');
      if (im) showLightbox(im.src);
    });
  }
  bindLightboxClicks(d.box);
  bindLightboxClicks(m.box);

  // ===== Socket realtime =====
  socket.on('ticketsReload', () => { reloadTickets(); });
  socket.on('ticketStatusUpdate', ({ ticketId, newStatus }) => {
    const t = allTickets.find(x => Number(x.id) === Number(ticketId));
    if (t) t.status = newStatus;
    renderTickets();
    if (activeTicket?.id && Number(activeTicket.id) === Number(ticketId)) {
      d.status && (d.status.textContent = statusToRu(newStatus));
      m.status && (m.status.textContent = statusToRu(newStatus));
    }
  });
  socket.on('receiveMessage', (newMessage) => {
    if (activeTicket?.id && Number(activeTicket.id) === Number(newMessage.ticketId)) {
      appendMessageTo(newMessage, isMobile() ? m.box : d.box, isMobile());
      const box = isMobile() ? m.box : d.box;
      if (box) box.scrollTop = box.scrollHeight;
    }
  });

  // ===== Update status =====
  async function doUpdateStatus(ticketId, nextStatus, isMobileUI=false){
    if (!canSetStatus(nextStatus)) { alert('Только админ может завершать или отклонять тикеты.'); return; }
    try{
      const res = await fetch(`${API_BASE}/tickets/update-status`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
        body: JSON.stringify({ ticketId, newStatus: nextStatus })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Ошибка обновления статуса');

      const isClosed = ['Successful','Rejected'].includes(nextStatus);
      if (!isMobileUI) {
        d.status && (d.status.textContent = statusToRu(nextStatus));
        d.closedBanner && (d.closedBanner.style.display = isClosed ? '' : 'none');
        d.actions && (d.actions.style.display = isClosed ? 'none' : 'flex');
      } else {
        m.status && (m.status.textContent = statusToRu(nextStatus));
        m.closedBanner && (m.closedBanner.style.display = isClosed ? '' : 'none');
        m.actions && (m.actions.style.display = isClosed ? 'none' : 'flex');
      }

      reloadTickets();
    }catch(e){ alert(e.message || 'Ошибка обновления статуса'); }
  }
  on(d.updateStatusBtn, 'click', ()=>{ if (!activeTicket?.id) return; const next=d.statusSelect?.value; doUpdateStatus(activeTicket.id, next, false); });
  on(m.updateStatusBtn, 'click', ()=>{ if (!activeTicket?.id) return; const next=m.statusSelect?.value; doUpdateStatus(activeTicket.id, next, true); });

  // ===== Send message (каждый файл — отдельное сообщение, без дублей) =====
  async function sendPerFileMessages(ticketId, text, inputFiles, isMobileUI=false){
    if (!ticketId) return;
    const files = Array.from(inputFiles || []).map(normalizeFile);
    const msgText = (text || '').trim();
    if (!msgText && files.length === 0) return;

    const sig = makeSig(ticketId, msgText, files);
    if (recentSendSigs.has(sig)) return;

    if (isSendingMessage) return;
    isSendingMessage = true;

    const btn = isMobileUI ? m.btnSend : d.btnSend;
    const prev = btn ? btn.textContent : '';
    if (btn){ btn.disabled = true; btn.textContent = '...'; }

    try{
      if (files.length > 0){
        for (let i=0; i<files.length; i++){
          const fd = new FormData();
          fd.append('ticketId', ticketId);
          if (i===0 && msgText) fd.append('messageText', msgText);
          fd.append('clientMessageId', genId());
          fd.append('attachments', files[i]); // только attachments
          const res = await fetch(`${API_BASE}/tickets/messages/send`, { method:'POST', credentials:'include', body: fd });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.message || 'Ошибка отправки');
        }
      } else {
        const fd = new FormData();
        fd.append('ticketId', ticketId);
        fd.append('messageText', msgText);
        fd.append('clientMessageId', genId());
        const res = await fetch(`${API_BASE}/tickets/messages/send`, { method:'POST', credentials:'include', body: fd });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.message || 'Ошибка отправки');
      }
      rememberSig(sig, 10000);

      // Очистка UI
      if (!isMobileUI){
        d.input && (d.input.value = '');
        d.file && (d.file.value = '');
        d.previewThumb && (d.previewThumb.innerHTML = '');
        d.preview && d.preview.classList.remove('show');
      } else {
        m.input && (m.input.value = '');
        m.file && (m.file.value = '');
        m.previewThumb && (m.previewThumb.innerHTML = '');
        m.preview && m.preview.classList.remove('show');
      }
    }catch(e){
      alert(e.message || 'Ошибка отправки сообщения');
    }finally{
      isSendingMessage = false;
      if (btn){ btn.disabled = false; btn.textContent = prev || '➤'; }
    }
  }

  on(d.btnSend, 'click', ()=> sendPerFileMessages(activeTicket?.id, d.input?.value || '', d.file?.files || [], false));
  on(m.btnSend, 'click', ()=> sendPerFileMessages(activeTicket?.id, m.input?.value || '', m.file?.files || [], true));
  on(d.input, 'keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendPerFileMessages(activeTicket?.id, d.input?.value||'', d.file?.files||[], false); }});
  on(m.input, 'keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendPerFileMessages(activeTicket?.id, m.input?.value||'', m.file?.files||[], true); }});

  // ===== Desktop attach menu (плюс-меню) =====
  on(d.attachToggle, 'click', (e)=>{ 
    e.stopPropagation();
    if (!d.attachMenu) return;
    const open = !d.attachMenu.classList.contains('open'); 
    d.attachMenu.classList.toggle('open', open); 
    d.attachMenu.setAttribute('aria-hidden', open?'false':'true'); 
  });
  on(d.menuPick, 'click', ()=>{ if (!d.file) return; d.file.accept='image/*,video/*'; d.file.multiple=true; d.file.click(); closeAttachMenus(); });
  on(d.menuPhoto, 'click', ()=>{ if (!d.file) return; d.file.accept='image/*'; d.file.multiple=true; d.file.click(); closeAttachMenus(); });
  on(d.menuVideo, 'click', ()=>{ if (!d.file) return; d.file.accept='video/*'; d.file.multiple=true; d.file.click(); closeAttachMenus(); });
  document.addEventListener('click', (e)=>{
    if (!d.attachMenu) return;
    const inside = d.attachMenu.contains(e.target);
    const onToggle = d.attachToggle && d.attachToggle.contains(e.target);
    if (!inside && !onToggle) { d.attachMenu.classList.remove('open'); d.attachMenu.setAttribute('aria-hidden','true'); }
  });

  // ===== Mobile attach menu =====
  on(m.attachToggle, 'click', ()=>{
    if (!m.attachMenu) return;
    const open = m.attachMenu.classList.contains('open');
    m.attachMenu.classList.toggle('open', !open);
    m.attachMenu.setAttribute('aria-hidden', open ? 'true' : 'false');
  });
  on(m.btnPick, 'click', ()=>{ if (!m.file) return; m.file.accept='image/*,video/*'; m.file.multiple=true; m.file.click(); closeAttachMenus(); });
  on(m.btnPhoto, 'click', ()=>{ if (!m.file) return; m.file.accept='image/*'; m.file.multiple=true; m.file.click(); closeAttachMenus(); });
  on(m.btnVideo, 'click', ()=>{ if (!m.file) return; m.file.accept='video/*'; m.file.multiple=true; m.file.click(); closeAttachMenus(); });

  // ===== Previews =====
  function renderPreviewFiles(fileList, isMobileUI=false){
    const thumb = isMobileUI ? m.previewThumb : d.previewThumb;
    const wrap = isMobileUI ? m.preview : d.preview;
    if (!thumb || !wrap) return;
    thumb.innerHTML = '';
    const files = Array.from(fileList || []);
    if (files.length === 0) { wrap.classList.remove('show'); return; }

    const frag = document.createDocumentFragment();
    files.slice(0, 6).forEach(f=>{
      const nf = normalizeFile(f);
      const url = URL.createObjectURL(nf);
      const isImg = (nf.type||'').startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(nf.name || '');
      const isVid = (nf.type||'').startsWith('video/') || /\.(mp4|webm|ogg|mov)$/i.test(nf.name || '');
      const item = document.createElement('div');
      item.style.display='inline-block';
      item.style.marginRight='8px';
      item.style.marginBottom='8px';
      if (isImg){
        item.innerHTML = `<img src="${url}" alt="preview" style="max-width:140px;max-height:110px;border-radius:8px;">`;
      } else if (isVid){
        item.innerHTML = `<video src="${url}" controls style="max-width:160px;max-height:110px;border-radius:8px;"></video>`;
      } else {
        item.textContent = nf.name || 'Файл';
      }
      frag.appendChild(item);
    });
    thumb.appendChild(frag);

    if (files.length > 6) {
      const more = document.createElement('div');
      more.className = 'muted';
      more.textContent = `+ ещё ${files.length - 6} файл(ов)`;
      thumb.appendChild(more);
    }
    wrap.classList.add('show');
  }

  on(d.file, 'change', ()=> renderPreviewFiles(d.file.files, false));
  on(m.file, 'change', ()=> renderPreviewFiles(m.file.files, true));

  on(d.btnClearPreview, 'click', ()=>{
    d.file && (d.file.value='');
    d.previewThumb && (d.previewThumb.innerHTML='');
    d.preview && d.preview.classList.remove('show');
  });
  on(m.btnClearPreview, 'click', ()=>{
    m.file && (m.file.value='');
    m.previewThumb && (m.previewThumb.innerHTML='');
    m.preview && m.preview.classList.remove('show');
  });

  // ===== Users =====
  on(btnReloadUsers, 'click', loadUsers);

  async function loadUsers(){
    if (!usersTableBody) return;
    try{
      const res = await fetch(`${API_BASE}/admin/users`, { credentials:'include' });
      if (res.status === 403){
        usersTableBody.innerHTML = `<tr><td colspan="7">Нет прав для просмотра пользователей.</td></tr>`;
        const totalEl = byId('users-total'); totalEl && (totalEl.textContent = '0');
        return;
      }
      const users = res.ok ? await res.json() : [];
      usersCache = users.slice();
      usersTableBody.innerHTML = '';
      for(const u of users){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="ID">${u.id}</td>
          <td data-label="Логин">${escapeHtml(u.username || '')}</td>
          <td data-label="ФИО">${escapeHtml(u.full_name || '')}</td>
          <td data-label="Телефон" class="col-phone">${escapeHtml(u.phone_number || '')}</td>
          <td data-label="Роль">${escapeHtml(u.role || '')}</td>
          <td data-label="Создан" class="col-created-users">${formatDateSafe(u.created_at)}</td>
          <td data-label="Действие"><button class="btn small" data-edit="${u.id}">Изм.</button></td>
        `;
        usersTableBody.appendChild(tr);
      }
      const totalEl = byId('users-total'); totalEl && (totalEl.textContent = String(users.length));
      usersTableBody.querySelectorAll('[data-edit]').forEach(btn=>{
        btn.addEventListener('click', ()=> openEditUser(Number(btn.getAttribute('data-edit'))));
      });
    }catch(e){
      console.warn(e);
      usersTableBody.innerHTML = `<tr><td colspan="7">Ошибка загрузки списка пользователей</td></tr>`;
      const totalEl = byId('users-total'); totalEl && (totalEl.textContent = '0');
    }
  }

  function showEditModal(){ if (!editModal) return; editModal.style.display='flex'; editModal.setAttribute('aria-hidden','false'); setTimeout(()=> editFullname?.focus(), 0); document.addEventListener('keydown', escCloseHandler); }
  function hideEditModal(){ if (!editModal) return; editModal.style.display='none'; editModal.setAttribute('aria-hidden','true'); editMsg && (editMsg.textContent=''); editingUserId=null; document.removeEventListener('keydown', escCloseHandler); }
  function escCloseHandler(e){ if (e.key==='Escape') hideEditModal(); }
  on(editClose, 'click', hideEditModal);
  on(editCancel, 'click', hideEditModal);

  function openEditUser(userId){
    const u = usersCache.find(x => Number(x.id) === Number(userId));
    if (!u) { alert('Пользователь не найден'); return; }
    editingUserId = u.id;
    editTitle && (editTitle.textContent = `Редактирование пользователя #${u.id}`);
    editFullname && (editFullname.value = u.full_name || '');
    editPhone && (editPhone.value = u.phone_number || '');
    editRole && (editRole.value = u.role || 'user');
    showEditModal();
  }
  on(editSave, 'click', async ()=>{
    if (!editingUserId) return;
    try{
      const payload = {
        id: editingUserId,
        full_name: editFullname?.value?.trim() || null,
        phone_number: editPhone?.value?.trim() || null,
        role: editRole?.value || null
      };
      const res = await fetch(`${API_BASE}/admin/update-user`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Ошибка сохранения');
      hideEditModal();
      await loadUsers();
    }catch(e){ editMsg && (editMsg.textContent = e.message || 'Ошибка'); }
  });

  // ===== Профиль: режим редактирования =====
  function setProfileEditMode(onMode){
    if (!profileEditPanel) return;
    profileEditPanel.style.display = onMode ? '' : 'none';
    profileSaveBtn && (profileSaveBtn.style.display = onMode ? '' : 'none');
    profileCancelBtn && (profileCancelBtn.style.display = onMode ? '' : 'none');
    profileEditToggle && (profileEditToggle.style.display = onMode ? 'none' : '');
    if (onMode){
      profFullname && (profFullname.value = me?.full_name || '');
      profPhone && (profPhone.value = me?.phone_number || '');
      profAvatarMsg && (profAvatarMsg.textContent = '');
      profAvatarInput && (profAvatarInput.value = '');
    }
  }
  on(profileEditToggle, 'click', ()=> setProfileEditMode(true));
  on(profileCancelBtn, 'click', ()=> setProfileEditMode(false));
  on(profAvatarPick, 'click', ()=>{ if (!profAvatarInput) return; profAvatarInput.accept='image/*'; profAvatarInput.click(); });

  on(profileSaveBtn, 'click', async ()=>{
    try{
      const fullName = (profFullname?.value || '').trim();
      const phone = (profPhone?.value || '').trim();

      // Сохранение профиля
      let ok=false;
      const res = await fetch(`${API_BASE}/profile/update`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
        body: JSON.stringify({ fullName, phoneNumber: phone })
      });
      ok = res.ok;
      if (!ok){
        const r2 = await fetch(`${API_BASE}/auth/update-profile`, {
          method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include',
          body: JSON.stringify({ fullName, phoneNumber: phone })
        });
        ok = r2.ok;
      }

      // Аватар (опционально)
      if (profAvatarInput?.files?.length){
        const fd = new FormData(); fd.append('avatar', profAvatarInput.files[0]);
        const up = await fetch(`${API_BASE}/auth/upload-avatar`, { method:'POST', credentials:'include', body: fd });
        profAvatarMsg && (profAvatarMsg.textContent = up.ok ? 'Аватар обновлён' : 'Не удалось обновить аватар');
        if (up.ok && profileAvatar){
          try{
            const js = await up.json();
            if (js?.avatar_url) profileAvatar.src = js.avatar_url;
          }catch{}
        }
      }

      if (!ok) throw new Error('Не удалось сохранить профиль');

      // Обновить view
      me.full_name = fullName;
      me.phone_number = phone;
      profileFullname && (profileFullname.textContent = fullName || '—');
      profilePhone && (profilePhone.textContent = phone || '—');

      alert('Профиль обновлён');
      setProfileEditMode(false);
    }catch(e){
      alert(e.message || 'Ошибка сохранения профиля');
    }
  });

  // ===== Init =====
  (async function init(){
    await ensureModerator();
    updateNotifyBanner();
    await reloadTickets();
    activateSection('tickets');
  })();

  // Уход со страницы
  window.addEventListener('beforeunload', ()=> {
    if (activeTicket?.id) socket.emit('leaveTicket', activeTicket.id);
  });
});