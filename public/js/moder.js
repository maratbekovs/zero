// Инициализируем после загрузки DOM
document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '/api';
  const socket = io('/', { withCredentials: true });

  // Регистрация сервис-воркера и автоподписка на push (если уже выдано разрешение)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(()=>{});
  }
  (async function ensurePush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const publicKey = await fetchVapidPublicKey();
        const appServerKey = urlBase64ToUint8Array(publicKey);
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      }
      await fetch(`${API_BASE}/auth/save-subscription`, {
        method: 'POST', headers: { 'Content-Type':'application/json' }, credentials:'include',
        body: JSON.stringify({ subscription })
      });
    } catch {}
  })();

  async function fetchVapidPublicKey(){
    const res = await fetch(`${API_BASE}/auth/vapid-public-key`);
    if (!res.ok) throw new Error('No VAPID public key');
    const data = await res.json();
    return data.publicKey;
  }
  function urlBase64ToUint8Array(base64String) {
    if (!base64String) return new Uint8Array();
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  // ------ DOM refs ------
  const meUsernameEl = byId('me-username');
  const meRoleEl = byId('me-role');
  const profileUsername = byId('profile-username');
  const profileRole = byId('profile-role');

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
  const editMsg = byId('edit-user-message');
  const editUsername = byId('edit-user-username');
  const editFullname = byId('edit-user-fullname');
  const editPhone = byId('edit-user-phone');
  const editRole = byId('edit-user-role');

  // Reports
  const btnMakeReport = byId('btn-make-report');
  const btnPrint = byId('btn-print');
  const startDate = byId('start_date');
  const endDate = byId('end_date');
  const reportSummary = byId('report-summary');
  const reportTableBody = qs('#report-table tbody');
  const reportMessage = byId('report-message');

  // Profile
  const btnLogout = byId('btn-logout');
  const btnLogout2 = byId('logout-2');

  // ------ State ------
  let me = { userId: null, username: null, role: null };
  let allTickets = [];
  let activeTicket = null;
  let usersCache = [];
  let editingUserId = null;

  // ------ Helpers ------
  function byId(id) { return document.getElementById(id); }
  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function isMobile() { return window.matchMedia('(max-width: 768px)').matches; }
  function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function formatDateSafe(d){
    if (!d) return '—';
    const dt = new Date(d);
    return isNaN(dt.getTime()) ? '—' : dt.toLocaleString();
  }
  const statusMapRU = {
    'New':'Новая',
    'In Progress':'В работе',
    'On Hold':'На согласовании',
    'Successful':'Успешно',
    'Rejected':'Отклонено'
  };
  function statusToRu(s){ return statusMapRU[s] || (s || '—'); }
  function closeAttachMenu(){
    if (m.attachMenu) {
      m.attachMenu.classList.remove('open');
      m.attachMenu.setAttribute('aria-hidden','true');
    }
  }
  function showEditModal(){
    if (!editModal) return;
    editModal.style.display = 'flex';
    editModal.setAttribute('aria-hidden','false');
    setTimeout(()=> editFullname?.focus(), 0);
    document.addEventListener('keydown', escCloseHandler);
  }
  function hideEditModal(){
    if (!editModal) return;
    editModal.style.display = 'none';
    editModal.setAttribute('aria-hidden','true');
    editMsg.textContent = '';
    editingUserId = null;
    document.removeEventListener('keydown', escCloseHandler);
  }
  function escCloseHandler(e){
    if (e.key === 'Escape') hideEditModal();
  }
  function setBtnBusy(btn, busy){
    if (!btn) return;
    btn.disabled = !!busy;
    if (btn.id === 'edit-user-save') btn.textContent = busy ? 'Сохранение...' : 'Сохранить';
  }

  // ------ Auth ------
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
    }catch(e){
      location.href = '/';
    }
  }

  // ------ Sections ------
  function activateSection(sec){
    navLinks.forEach(x=> x.classList.toggle('active', x.dataset.section===sec));
    qsa('.section').forEach(s=> s.classList.toggle('active', s.id === `sec-${sec}`));
    mobileTabs.forEach(t=> t.classList.toggle('active', t.dataset.section===sec));
    if (sec==='tickets') reloadTickets();
    if (sec==='users') loadUsers();
  }
  navLinks.forEach(a => on(a, 'click', e => { e.preventDefault(); activateSection(a.dataset.section); closeAttachMenu(); }));
  mobileTabs.forEach(t => on(t, 'click', e => { e.preventDefault(); activateSection(t.dataset.section); closeAttachMenu(); }));

  // ------ Logout ------
  async function doLogout(){
    try { await fetch(`${API_BASE}/auth/logout`, { method:'POST', credentials:'include' }); }
    finally { location.href = '/'; }
  }
  on(btnLogout, 'click', doLogout);
  on(btnLogout2, 'click', doLogout);

  // ------ Tickets list ------
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
          </div>
        </td>
      `;
      ticketsTableBody.appendChild(tr);
    }

    ticketsTableBody.querySelectorAll('[data-open]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const id = Number(btn.getAttribute('data-id'));
        const t = allTickets.find(x=>x.id===id);
        if (t) openChat(t);
      });
    });
  }

  // ------ Chat ------
  function openChat(ticket){
    // перейти из прошлой комнаты
    if (activeTicket && activeTicket.id && activeTicket.id !== ticket.id) {
      socket.emit('leaveTicket', activeTicket.id);
    }
    activeTicket = ticket;
    if (isMobile()) openMobileChat(ticket);
    else openDesktopChat(ticket);
  }

  function openDesktopChat(t){
    if (!d.ticketId) return;
    d.ticketId.textContent = t.id;
    d.subject && (d.subject.textContent = t.subject || '');
    d.userId && (d.userId.textContent = t.user_id || '-');
    d.status && (d.status.textContent = statusToRu(t.status));

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

  async function loadMessagesTo(ticketId, container, isMobileChat){
    if (!container) return;
    container.innerHTML = '';
    try{
      const res = await fetch(`${API_BASE}/tickets/${ticketId}/messages`, { credentials:'include' });
      const list = res.ok ? await res.json() : [];
      for(const msg of list){
        appendMessageTo(msg, container, isMobileChat);
      }
      container.scrollTop = container.scrollHeight;
    }catch(e){ console.warn(e); }
  }

  function appendMessageTo(mg, container, isMobileChat){
    const isMe = mg.senderRole === 'moderator' || mg.senderRole === 'admin';
    const el = document.createElement('div');
    el.className = `${isMobileChat ? 'mmsg':'msg'} ${isMe ? 'me':'other'}`;

    let attach = '';
    if (mg.attachmentUrl){
      const url = mg.attachmentUrl;
      const img = /\.(png|jpe?g|gif|webp|heic|heif)$/i.test(url);
      const vid = /\.(mp4|webm|ogg|mov)$/i.test(url);
      if (img) attach = `<div class="attach"><img src="${url}" alt="attach"></div>`;
      else if (vid) attach = `<div class="attach"><video src="${url}" controls></video></div>`;
      else attach = `<div class="attach"><a href="${url}" target="_blank" rel="noopener">📎 Вложение</a></div>`;
    }

    el.innerHTML = `
      ${mg.messageText ? `<div>${escapeHtml(mg.messageText)}</div>`:''}
      ${attach}
      <div class="meta">${escapeHtml(mg.senderUsername || mg.senderRole || '')} • ${formatDateSafe(mg.createdAt)}</div>
    `;
    container.appendChild(el);
  }

  // Обновление статуса
  on(d.updateStatusBtn, 'click', async ()=>{
    if (!activeTicket) return;
    const newStatus = d.statusSelect?.value || 'In Progress';
    await updateStatusCommon(newStatus, false);
  });
  on(m.updateStatusBtn, 'click', async ()=>{
    if (!activeTicket) return;
    const newStatus = m.statusSelect?.value || 'In Progress';
    await updateStatusCommon(newStatus, true);
  });

  async function updateStatusCommon(newStatus, isMobileUI){
    try{
      const res = await fetch(`${API_BASE}/tickets/update-status`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ ticketId: activeTicket.id, newStatus })
      });
      const data = res.ok ? await res.json() : { message: await res.text() };
      if (!res.ok) throw new Error(data.message || `Ошибка (${res.status})`);

      if (isMobileUI){
        m.status && (m.status.textContent = statusToRu(data.newStatus || newStatus));
        if (data.timeSpent && m.timeSpent){
          m.timeSpent.style.display = '';
          m.timeSpent.textContent = `Время в работе: ${data.timeSpent}`;
        }
        const closed = ['Successful','Rejected'].includes(data.newStatus || newStatus);
        m.closedBanner && (m.closedBanner.style.display = closed ? '' : 'none');
        m.actions && (m.actions.style.display = closed ? 'none' : 'flex');
      }else{
        d.status && (d.status.textContent = statusToRu(data.newStatus || newStatus));
        if (data.timeSpent && d.timeSpent){
          d.timeSpent.style.display = '';
          d.timeSpent.textContent = `Время в работе: ${data.timeSpent}`;
        }
        const closed = ['Successful','Rejected'].includes(data.newStatus || newStatus);
        d.closedBanner && (d.closedBanner.style.display = closed ? '' : 'none');
        d.actions && (d.actions.style.display = closed ? 'none' : 'flex');
      }

      await reloadTickets();
      const found = allTickets.find(x=>x.id===activeTicket.id);
      if (found) activeTicket = found;
    }catch(e){
      alert(e.message || 'Ошибка обновления статуса');
    }
  }

  // Desktop send
  on(d.btnPick, 'click', ()=>{ if (d.actions?.style.display==='none') return; if (!d.file) return; d.file.accept='image/*,video/*'; d.file.removeAttribute('capture'); d.file.click(); });
  on(d.btnPhoto, 'click', ()=>{ if (d.actions?.style.display==='none') return; if (!d.file) return; d.file.accept='image/*'; d.file.setAttribute('capture','environment'); d.file.click(); });
  on(d.btnVideo, 'click', ()=>{ if (d.actions?.style.display==='none') return; if (!d.file) return; d.file.accept='video/*'; d.file.setAttribute('capture','environment'); d.file.click(); });
  on(d.btnClearPreview, 'click', ()=>{ if (!d.file || !d.preview || !d.previewThumb) return; d.file.value=''; d.previewThumb.innerHTML=''; d.preview.classList.remove('show'); });
  on(d.file, 'change', ()=> handlePreview(d.file, d.preview, d.previewThumb));
  on(d.btnSend, 'click', ()=> sendMessage(false));
  on(d.input, 'keydown', (e)=>{ if (d.actions?.style.display==='none') return; if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(false); }});

  // Mobile send + меню вложений
  on(m.attachToggle, 'click', (e)=>{
    e.stopPropagation();
    if (!m.attachMenu) return;
    const opened = m.attachMenu.classList.toggle('open');
    m.attachMenu.setAttribute('aria-hidden', opened ? 'false':'true');
  });
  document.addEventListener('click', (e)=>{
    if (!isMobile()) return;
    if (!m.attachMenu) return;
    const clickedInsideMenu = m.attachMenu.contains(e.target);
    const clickedToggle = m.attachToggle && m.attachToggle.contains(e.target);
    if (!clickedInsideMenu && !clickedToggle) closeAttachMenu();
  });

  on(m.btnPick, 'click', ()=>{ if (m.actions?.style.display==='none') return; if (!m.file) return; closeAttachMenu(); m.file.accept='image/*,video/*'; m.file.removeAttribute('capture'); m.file.click(); });
  on(m.btnPhoto, 'click', ()=>{ if (m.actions?.style.display==='none') return; if (!m.file) return; closeAttachMenu(); m.file.accept='image/*'; m.file.setAttribute('capture','environment'); m.file.click(); });
  on(m.btnVideo, 'click', ()=>{ if (m.actions?.style.display==='none') return; if (!m.file) return; closeAttachMenu(); m.file.accept='video/*'; m.file.setAttribute('capture','environment'); m.file.click(); });
  on(m.btnClearPreview, 'click', ()=>{ if (!m.file || !m.preview || !m.previewThumb) return; m.file.value=''; m.previewThumb.innerHTML=''; m.preview.classList.remove('show'); });
  on(m.file, 'change', ()=> handlePreview(m.file, m.preview, m.previewThumb));
  on(m.btnSend, 'click', ()=> { closeAttachMenu(); sendMessage(true); });
  on(m.input, 'keydown', (e)=>{ if (m.actions?.style.display==='none') return; if (e.key==='Enter' && !e.shiftKey){ e.preventDefault(); closeAttachMenu(); sendMessage(true); }});

  function handlePreview(fileInput, wrap, thumb){
    const f = fileInput?.files?.[0];
    if (!wrap || !thumb) return;
    thumb.innerHTML = '';
    if (!f){ wrap.classList.remove('show'); return; }
    const isImg = (f.type||'').startsWith('image/');
    const isVid = (f.type||'').startsWith('video/');
    if (isImg){
      const img = new Image(); img.src = URL.createObjectURL(f); img.onload = ()=> URL.revokeObjectURL(img.src);
      img.style.maxHeight = '100px'; img.style.borderRadius='6px'; thumb.appendChild(img);
    }else if (isVid){
      const v = document.createElement('video'); v.src = URL.createObjectURL(f); v.controls = true; v.style.maxHeight='100px'; v.style.borderRadius='6px';
      v.onloadeddata = ()=> URL.revokeObjectURL(v.src); thumb.appendChild(v);
    }else{
      thumb.textContent = f.name;
    }
    wrap.classList.add('show');
    fileInput.accept='image/*,video/*'; fileInput.setAttribute('capture','environment');
  }

  async function sendMessage(isMobileUI){
    if (!activeTicket) return;
    const ui = isMobileUI ? m : d;
    if (ui.actions?.style.display==='none') return;

    const text = ui.input?.value.trim();
    const file = ui.file?.files?.[0] || null;
    if (!text && !file) return;

    try{
      if (file){
        // вложения — через HTTP; сервер эмитит receiveMessage
        const fd = new FormData();
        fd.set('ticketId', String(activeTicket.id));
        if (text) fd.set('messageText', text);
        fd.set('attachment', file);
        const res = await fetch(`${API_BASE}/tickets/messages/send`, { method:'POST', body: fd, credentials:'include' });
        const ok = res.ok;
        const data = ok ? await res.json() : { message: await res.text() };
        if (!ok) throw new Error(data.message || `Ошибка (${res.status})`);
      }else{
        // текст — мгновенно через сокеты
        socket.emit('sendMessage', { ticketId: activeTicket.id, messageText: text });
      }

      ui.input && (ui.input.value = '');
      ui.file && (ui.file.value = '');
      ui.previewThumb && (ui.previewThumb.innerHTML = '');
      ui.preview && ui.preview.classList.remove('show');

    }catch(e){ alert(e.message || 'Ошибка отправки сообщения'); }
  }

  // Сокеты
  socket.on('receiveMessage', (payload)=>{
    if (!activeTicket || Number(payload?.ticketId) !== Number(activeTicket.id)) return;
    if (m.modal && m.modal.style.display === 'block'){
      appendMessageTo(payload, m.box, true);
      m.box && (m.box.scrollTop = m.box.scrollHeight);
    } else {
      appendMessageTo(payload, d.box, false);
      d.box && (d.box.scrollTop = d.box.scrollHeight);
    }
  });

  socket.on('ticketStatusUpdate', ({ ticketId, newStatus, timeSpent }) => {
    // обновим таблицу и статус в чате
    reloadTickets();
    if (activeTicket && Number(activeTicket.id) === Number(ticketId)) {
      d.status && (d.status.textContent = statusToRu(newStatus));
      m.status && (m.status.textContent = statusToRu(newStatus));
      const closed = ['Successful','Rejected'].includes(newStatus);
      d.closedBanner && (d.closedBanner.style.display = closed ? '' : 'none');
      d.actions && (d.actions.style.display = closed ? 'none' : 'flex');
      m.closedBanner && (m.closedBanner.style.display = closed ? '' : 'none');
      m.actions && (m.actions.style.display = closed ? 'none' : 'flex');
      if (timeSpent && d.timeSpent) { d.timeSpent.style.display=''; d.timeSpent.textContent=`Время в работе: ${timeSpent}`; }
      if (timeSpent && m.timeSpent) { m.timeSpent.style.display=''; m.timeSpent.textContent=`Время в работе: ${timeSpent}`; }
      activeTicket.status = newStatus;
    }
  });

  // ------ Users ------
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

  on(btnCreateUser, 'click', async ()=>{
    if (!createUserMsg) return;
    createUserMsg.textContent = '';
    try{
      const payload = {
        username: byId('new-username')?.value.trim(),
        password: byId('new-password')?.value,
        role: byId('new-role')?.value,
        full_name: byId('new-fullname')?.value?.trim() || null,
        phone_number: byId('new-phone')?.value?.trim() || null
      };
      const res = await fetch(`${API_BASE}/admin/create-user`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify(payload)
      });
      const data = res.ok ? await res.json() : { message: await res.text() };
      if (!res.ok) throw new Error(data.message || `Ошибка (${res.status})`);
      createUserMsg.textContent = data.message || 'Создано';
      await loadUsers();
    }catch(e){
      createUserMsg.textContent = e.message || 'Ошибка создания';
    }
  });

  // Edit user
  function openEditUser(userId){
    const u = usersCache.find(x => Number(x.id) === Number(userId));
    if (!u) { alert('Пользователь не найден'); return; }
    editingUserId = u.id;
    editTitle && (editTitle.textContent = `Редактирование пользователя #${u.id}`);
    editUsername && (editUsername.value = u.username || '');
    editFullname && (editFullname.value = u.full_name || '');
    editPhone && (editPhone.value = u.phone_number || '');
    editRole && (editRole.value = u.role || '');
    editMsg && (editMsg.textContent = '');
    showEditModal();
  }
  async function saveEditUser(){
    if (!editingUserId) return;
    const fullName = (editFullname?.value || '').trim();
    const phoneNumber = (editPhone?.value || '').trim();
    try{
      setBtnBusy(editSave, true);
      editMsg.style.color = '#718096';
      editMsg.textContent = 'Сохраняем...';
      const res = await fetch(`${API_BASE}/tickets/update-user-info`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        credentials:'include',
        body: JSON.stringify({ userId: editingUserId, fullName, phoneNumber })
      });
      const data = res.ok ? await res.json() : { message: await res.text() };
      if (!res.ok) throw new Error(data.message || `Ошибка (${res.status})`);

      editMsg.style.color = '#2a9d8f';
      editMsg.textContent = data.message || 'Данные обновлены';
      await loadUsers();
      const idx = usersCache.findIndex(x => x.id === editingUserId);
      if (idx >= 0) {
        usersCache[idx].full_name = fullName;
        usersCache[idx].phone_number = phoneNumber;
      }
      setTimeout(hideEditModal, 600);
    }catch(e){
      editMsg.style.color = '#e63946';
      editMsg.textContent = e.message || 'Ошибка сохранения';
    }finally{
      setBtnBusy(editSave, false);
    }
  }
  on(editClose, 'click', hideEditModal);
  on(editCancel, 'click', hideEditModal);
  on(editSave, 'click', saveEditUser);
  on(editModal, 'click', (e)=>{ if (e.target === editModal) hideEditModal(); });

  // Reports
  on(btnMakeReport, 'click', async ()=>{
    if (!reportTableBody || !reportSummary || !reportMessage) return;

    reportTableBody.innerHTML = '';
    reportSummary.innerHTML = '<div class="muted">Готовим отчёт...</div>';
    reportMessage.textContent = '';
    btnPrint && (btnPrint.disabled = true);

    const qsParams = new URLSearchParams({ startDate: startDate?.value, endDate: endDate?.value }).toString();
    try{
      const res = await fetch(`${API_BASE}/admin/report?${qsParams}`, { credentials:'include' });
      const data = res.ok ? await res.json() : [];

      const total = data.length;
      const successful = data.filter(x=>x.status==='Successful').length;
      const rejected = data.filter(x=>x.status==='Rejected').length;
      reportSummary.innerHTML = `
        <div class="chips">
          <span class="chip">Всего закрыто: ${total}</span>
          <span class="chip">Успешно: ${successful}</span>
          <span class="chip">Отклонено: ${rejected}</span>
        </div>
      `;
      for(const r of data){
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td data-label="ID">${r.ticket_id}</td>
          <td data-label="Тема">${escapeHtml(r.subject || '')}</td>
          <td data-label="Статус">${escapeHtml(statusToRu(r.status || ''))}</td>
          <td data-label="Пользователь">${escapeHtml(r.client_username || '')}</td>
          <td data-label="Модератор" class="col-moderator">${escapeHtml(r.moderator_username || '')}</td>
          <td data-label="Создан">${formatDateSafe(r.created_at)}</td>
          <td data-label="Закрыт" class="col-closed">${formatDateSafe(r.closed_at)}</td>
        `;
        reportTableBody.appendChild(tr);
      }
      reportMessage.textContent = total ? '' : 'За период нет закрытых тикетов';
      btnPrint && (btnPrint.disabled = !total);
    }catch(e){
      reportSummary.innerHTML = '';
      reportMessage.textContent = 'Ошибка формирования отчёта';
    }
  });

  // ------ Init ------
  (async function init(){
    await ensureModerator();
    await reloadTickets();
  })();
});