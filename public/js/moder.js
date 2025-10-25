// public/js/moder.js
// Полная версия с поддержкой:
// - Аватаров (в шапке чата у модератора видны ФИО/телефон/фото пользователя)
// - Ограничений по ролям при смене статуса (moderator: только "In Progress"/"On Hold"; admin: любые)
// - Принудительного назначения ответственного модератора (только admin)
// - Рилтайм-появления новых тикетов/изменений через Socket.IO (ticketsReload)
// - Мультивложений в сообщениях (attachments[])
// - Интерактивов десктоп/моб.чата: меню вложений, предпросмотр, клики по "Фото/Видео/Файл"
// - Раздела Users (список, создание, упрощённое редактирование)
//
// Важно: для мультивложений убедитесь, что в разметке input file имеют multiple:
//   - Desktop:  <input type="file" id="chat-attachment" multiple accept="image/*,video/*" style="display:none;">
//   - Mobile:   <input type="file" id="mchat-attachment" multiple accept="image/*,video/*" style="display:none;">

document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '/api';
  const socket = io('/', { withCredentials: true });

  // ===== Helpers =====
  function byId(id){ return document.getElementById(id); }
  function qs(sel, root=document){ return root.querySelector(sel); }
  function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
  function on(el, ev, fn){ if (el) el.addEventListener(ev, fn); }
  function escapeHtml(str=''){ return String(str).replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[s])); }
  function formatDateSafe(d){ if (!d) return '—'; const dt = new Date(d); return isNaN(dt.getTime()) ? '—' : dt.toLocaleString(); }
  function isMobile(){ return window.matchMedia && window.matchMedia('(max-width: 768px)').matches; }
  function setImg(el, url){ if (el) el.src = url || '/icons/user-placeholder.png'; }

  // RU статусы
  const statusMapRU = { 'New':'Новая','In Progress':'В работе','On Hold':'На согласовании','Successful':'Успешно','Rejected':'Отклонено' };
  function statusToRu(s){ return statusMapRU[s] || (s || '—'); }

  // ===== Push (тихое управление) =====
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
  }
  async function fetchVapidPublicKey(){
    try {
      const r = await fetch(`${API_BASE}/auth/vapid-public-key`, { credentials:'include' });
      const js = await r.json();
      return js.publicKey;
    } catch { return ''; }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }
  (async function ensurePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const publicKey = await fetchVapidPublicKey();
        if (!publicKey) return;
        const appServerKey = urlBase64ToUint8Array(publicKey);
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      }
      try {
        await fetch(`${API_BASE}/auth/save-subscription`, { method:'POST', headers:{ 'Content-Type':'application/json' }, credentials:'include', body: JSON.stringify({ subscription }) });
      } catch {}
    } catch {}
  })();

  // ====== State ======
  let me = null;
  let allTickets = [];
  let activeTicket = null;   // выбранный тикет
  let usersCache = [];
  let editingUserId = null;

  // ===== DOM refs =====
  // Header/Me
  const meUsernameEl = byId('me-username');
  const meRoleEl = byId('me-role');
  const profileUsername = byId('profile-username');
  const profileRole = byId('profile-role');

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
    btnPick: byId('btn-pick'),
    btnPhoto: byId('btn-photo'),
    btnVideo: byId('btn-video'),
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
  const editMsg = byId('edit-user-msg');
  const editFullname = byId('edit-user-fullname');
  const editPhone = byId('edit-user-phone');
  const editRole = byId('edit-user-role');

  // Logout buttons
  const btnLogout = byId('btn-logout');
  const btnLogout2 = byId('btn-logout-2');

  // ===== Role-based helpers =====
  function filterStatusOptions(){
    if (!me || !me.role) return;
    const only = ['In Progress','On Hold'];
    [d?.statusSelect, m?.statusSelect].forEach(sel=>{
      if (!sel) return;
      Array.from(sel.options).forEach(opt=>{
        if (me.role === 'moderator' && !only.includes(opt.value)) {
          opt.disabled = true; opt.hidden = true;
        }
      });
      if (me.role === 'moderator' && sel.value && !only.includes(sel.value)) sel.value = 'In Progress';
    });
  }
  function canSetStatus(val){ return me?.role === 'moderator' ? ['In Progress','On Hold'].includes(val) : true; }

  // ===== Auth =====
  async function ensureModerator() {
    try{
      const res = await fetch(`${API_BASE}/auth/status`, { credentials:'include' });
      if (!res.ok) throw new Error('auth');
      const data = await res.json();
      if (!data.isLoggedIn || !['moderator','admin'].includes(data.role)) throw new Error('role');
      me = { userId:data.userId, username:data.username, role:data.role };
      meUsernameEl && (meUsernameEl.textContent = data.username);
      meRoleEl && (meRoleEl.textContent = `роль: ${data.role}`);
      profileUsername && (profileUsername.textContent = data.username);
      profileRole && (profileRole.textContent = data.role);
      filterStatusOptions();
    }catch{ location.href = '/'; }
  }

  // ===== Sections =====
  function closeAttachMenu(){
    if (m.attachMenu) { m.attachMenu.classList.remove('open'); m.attachMenu.setAttribute('aria-hidden','true'); }
  }
  function activateSection(sec){
    navLinks.forEach(x=> x.classList.toggle('active', x.dataset.section===sec));
    qsa('.section').forEach(s=> s.classList.toggle('active', s.id === `sec-${sec}`));
    mobileTabs.forEach(t=> t.classList.toggle('active', t.dataset.section===sec));
    if (sec==='tickets') reloadTickets();
    if (sec==='users') loadUsers();
  }
  navLinks.forEach(a => on(a, 'click', e => { e.preventDefault(); activateSection(a.dataset.section); closeAttachMenu(); }));
  mobileTabs.forEach(t => on(t, 'click', e => { e.preventDefault(); activateSection(t.dataset.section); closeAttachMenu(); }));

  // ===== Logout =====
  async function doLogout(){ try { await fetch(`${API_BASE}/auth/logout`, { method:'POST', credentials:'include' }); } finally { location.href = '/'; } }
  on(btnLogout, 'click', doLogout);
  on(btnLogout2, 'click', doLogout);

  // ===== Tickets list =====
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

  function renderTickets(){
    if (!ticketsTableBody) return;
    const q = (searchInput?.value || '').toLowerCase().trim();
    const fs = filterStatus?.value || '';
    const filtered = allTickets.filter(t=>{
      const matchesQ = !q || `${t.subject} ${t.user_username} ${t.user_full_name}`.toLowerCase().includes(q);
      const matchesS = !fs || t.status === fs;
      return matchesQ && matchesS;
    });

    statTotal && (statTotal.textContent = String(filtered.length));
    statNew && (statNew.textContent = String(filtered.filter(t=>t.status==='New').length));
    statIP && (statIP.textContent = String(filtered.filter(t=>t.status==='In Progress').length));

    ticketsTableBody.innerHTML = '';
    for(const t of filtered){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="ID">${t.id}</td>
        <td data-label="Пользователь" class="col-user">
          <div><strong>${escapeHtml(t.user_username || '')}</strong></div>
          <div class="muted">${escapeHtml(t.user_full_name || '')}</div>
          <div class="muted">${escapeHtml(t.user_phone || '')}</div>
        </td>
        <td data-label="Тема">${escapeHtml(t.subject || '')}</td>
        <td data-label="Статус"><span class="status s-${(t.status || '').replaceAll(' ','\\ ')}">${statusToRu(t.status)}</span></td>
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

  // ===== Chat open =====
  function openChat(ticket){
    if (activeTicket && activeTicket.id && activeTicket.id !== ticket.id) {
      socket.emit('leaveTicket', activeTicket.id);
    }
    activeTicket = ticket;
    if (isMobile()) openMobileChat(ticket);
    else openDesktopChat(ticket);
  }

  async function decorateDesktopHeaderWithUserInfo(ticketId){
    try{
      const res = await fetch(`/api/auth/ticket-summary/${ticketId}`, { credentials:'include' });
      const data = res.ok ? await res.json() : null;
      const head = d.panel ? d.panel.querySelector('.chat-head') : null;
      const left = head ? head.querySelector(':scope > div') : null;
      if (!left) return;
      let info = left.querySelector('#chat-user-info');
      if (!info) {
        info = document.createElement('div');
        info.id = 'chat-user-info';
        info.style.display = 'flex'; info.style.alignItems = 'center'; info.style.gap = '8px'; info.style.marginTop = '6px';
        info.innerHTML = `
          <img id="chat-user-avatar" class="avatar" alt="Пользователь" src="/icons/user-placeholder.png" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">
          <span><strong id="chat-user-fullname">—</strong> · Тел.: <span id="chat-user-phone">—</span></span>
        `;
        left.appendChild(info);
      }
      const u = data && data.user ? data.user : null;
      const img = left.querySelector('#chat-user-avatar');
      const fn = left.querySelector('#chat-user-fullname');
      const ph = left.querySelector('#chat-user-phone');
      if (u) { if (img) img.src = u.avatar_url || '/icons/user-placeholder.png'; if (fn) fn.textContent = u.full_name || u.username || '—'; if (ph) ph.textContent = u.phone_number || '—'; }
      else   { if (img) img.src = '/icons/user-placeholder.png'; if (fn) fn.textContent = '—'; if (ph) ph.textContent = '—'; }
    } catch {}
  }

  function openDesktopChat(t){
    if (!d.ticketId) return;
    d.ticketId.textContent = t.id;
    d.subject && (d.subject.textContent = t.subject || '');
    d.userId && (d.userId.textContent = t.user_id || '-');
    d.status && (d.status.textContent = statusToRu(t.status));

    decorateDesktopHeaderWithUserInfo(t.id);

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

    m.timeSpent && (m.timeSpent.style.display = 'none', m.timeSpent.textContent = '');

    closeAttachMenu();
    m.modal.style.display = 'block';
    socket.emit('joinTicket', t.id);
    loadMessagesTo(t.id, m.box, true);
  }

  on(m.close, 'click', ()=> closeMobileChat());
  function closeMobileChat(){
    if (!m.modal) return;
    if (activeTicket?.id) socket.emit('leaveTicket', activeTicket.id);
    m.modal.style.display = 'none';
    m.box && (m.box.innerHTML = '');
    m.input && (m.input.value = '');
    m.file && (m.file.value = '');
    m.previewThumb && (m.previewThumb.innerHTML = '');
    m.preview && m.preview.classList.remove('show');
    closeAttachMenu();
  }

  // ===== Load/Render messages =====
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

    // Мультивложения либо fallback одиночного
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

      if (!isMobileUI) {
        d.status && (d.status.textContent = statusToRu(nextStatus));
        const isClosed = ['Successful','Rejected'].includes(nextStatus);
        d.closedBanner && (d.closedBanner.style.display = isClosed ? '' : 'none');
        d.actions && (d.actions.style.display = isClosed ? 'none' : 'flex');
      } else {
        m.status && (m.status.textContent = statusToRu(nextStatus));
        const isClosed = ['Successful','Rejected'].includes(nextStatus);
        m.closedBanner && (m.closedBanner.style.display = isClosed ? '' : 'none');
        m.actions && (m.actions.style.display = isClosed ? 'none' : 'flex');
      }

      reloadTickets();
    }catch(e){ alert(e.message || 'Ошибка обновления статуса'); }
  }
  on(d.updateStatusBtn, 'click', async ()=>{ if (!activeTicket?.id) return; const next = d.statusSelect?.value; await doUpdateStatus(activeTicket.id, next, false); });
  on(m.updateStatusBtn, 'click', async ()=>{ if (!activeTicket?.id) return; const next = m.statusSelect?.value; await doUpdateStatus(activeTicket.id, next, true); });

  // ===== Send message (мультивложения) =====
  async function sendMessage(ticketId, text, fileInput, isMobileUI=false){
    if (!ticketId) return;
    const hasText = text && text.trim().length > 0;
    const files = Array.from(fileInput?.files || []);
    if (!hasText && files.length === 0) return;

    try{
      const form = new FormData();
      form.append('ticketId', ticketId);
      if (hasText) form.append('messageText', text.trim());
      files.forEach(f => form.append('attachments', f));

      const res = await fetch(`${API_BASE}/tickets/messages/send`, { method:'POST', credentials:'include', body: form });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Ошибка отправки');

      const msg = {
        senderId: me?.userId,
        senderUsername: me?.username,
        senderRole: me?.role,
        messageText: text || '',
        attachments: data.socketData?.attachments || [],
        attachmentUrl: null,
        createdAt: new Date().toISOString(),
        ticketId
      };
      appendMessageTo(msg, isMobileUI ? m.box : d.box, isMobileUI);
      const box = isMobileUI ? m.box : d.box;
      if (box) box.scrollTop = box.scrollHeight;

      // Очистка интерфейса и предпросмотра
      if (!isMobileUI){
        d.input && (d.input.value = '');
        if (d.file) d.file.value = '';
        if (d.previewThumb) d.previewThumb.innerHTML = '';
        d.preview && d.preview.classList.remove('show');
      } else {
        m.input && (m.input.value = '');
        if (m.file) m.file.value = '';
        if (m.previewThumb) m.previewThumb.innerHTML = '';
        m.preview && m.preview.classList.remove('show');
      }
    }catch(e){ alert(e.message || 'Ошибка отправки'); }
  }

  on(d.btnSend, 'click', ()=> sendMessage(activeTicket?.id, d.input?.value || '', d.file, false));
  on(m.btnSend, 'click', ()=> sendMessage(activeTicket?.id, m.input?.value || '', m.file, true));
  on(d.input, 'keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(activeTicket?.id, d.input?.value||'', d.file, false); }});
  on(m.input, 'keydown', (e)=>{ if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(activeTicket?.id, m.input?.value||'', m.file, true); }});

  // ===== Attachments UI (Desktop) =====
  on(d.btnPick, 'click', ()=>{
    if (!d.file) return;
    d.file.accept = 'image/*,video/*';
    d.file.multiple = true;
    d.file.click();
  });
  on(d.btnPhoto, 'click', ()=>{
    if (!d.file) return;
    d.file.accept = 'image/*';
    d.file.multiple = true;
    d.file.click();
  });
  on(d.btnVideo, 'click', ()=>{
    if (!d.file) return;
    d.file.accept = 'video/*';
    d.file.multiple = true;
    d.file.click();
  });

  // ===== Attachments UI (Mobile) =====
  on(m.attachToggle, 'click', ()=>{
    if (!m.attachMenu) return;
    const isOpen = m.attachMenu.classList.contains('open');
    m.attachMenu.classList.toggle('open', !isOpen);
    m.attachMenu.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
  });
  on(m.btnPick, 'click', ()=>{
    if (!m.file) return;
    m.file.accept = 'image/*,video/*';
    m.file.multiple = true;
    m.file.click();
    closeAttachMenu();
  });
  on(m.btnPhoto, 'click', ()=>{
    if (!m.file) return;
    m.file.accept = 'image/*';
    m.file.multiple = true;
    m.file.click();
    closeAttachMenu();
  });
  on(m.btnVideo, 'click', ()=>{
    if (!m.file) return;
    m.file.accept = 'video/*';
    m.file.multiple = true;
    m.file.click();
    closeAttachMenu();
  });

  // ===== Preview helpers =====
  function renderPreviewFiles(fileList, isMobileUI=false){
    const thumb = isMobileUI ? m.previewThumb : d.previewThumb;
    const wrap = isMobileUI ? m.preview : d.preview;
    if (!thumb || !wrap) return;
    thumb.innerHTML = '';
    const files = Array.from(fileList || []);
    if (files.length === 0) { wrap.classList.remove('show'); return; }

    const frag = document.createDocumentFragment();
    files.slice(0, 6).forEach(f=>{
      const url = URL.createObjectURL(f);
      const img = /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(f.name);
      const vid = /\.(mp4|webm|ogg|mov)$/i.test(f.name);
      const item = document.createElement('div');
      item.style.display='inline-block';
      item.style.marginRight='8px';
      item.style.marginBottom='8px';
      if (img){
        item.innerHTML = `<img src="${url}" alt="preview" style="max-width:140px;max-height:110px;border-radius:8px;">`;
      } else if (vid){
        item.innerHTML = `<video src="${url}" controls style="max-width:160px;max-height:110px;border-radius:8px;"></video>`;
      } else {
        item.textContent = f.name;
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
    if (d.file) d.file.value='';
    if (d.previewThumb) d.previewThumb.innerHTML='';
    d.preview && d.preview.classList.remove('show');
  });
  on(m.btnClearPreview, 'click', ()=>{
    if (m.file) m.file.value='';
    if (m.previewThumb) m.previewThumb.innerHTML='';
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
    if (editFullname) editFullname.value = u.full_name || '';
    if (editPhone) editPhone.value = u.phone_number || '';
    if (editRole) editRole.value = u.role || 'user';
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
    }catch(e){ if (editMsg) editMsg.textContent = e.message || 'Ошибка'; }
  });

  // ===== Bootstrap =====
  (async function init(){
    await ensureModerator();
    await reloadTickets();
    activateSection('tickets');
  })();

  // На всякий случай: покидаем комнату при выгрузке
  window.addEventListener('beforeunload', ()=> {
    if (activeTicket?.id) socket.emit('leaveTicket', activeTicket.id);
  });
});