document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = '/api';

  // UI
  const searchInput = byId('search');
  const filterStatus = byId('filter-status');
  const btnReload = byId('btn-reload');
  const tbody = byId('archive-table-body');

  let allTickets = [];

  // Helpers
  function byId(id){ return document.getElementById(id); }
  function escapeHtml(s=''){ return s.replace(/[&<>"'`=\/]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','`':'&#x60;','=':'&#x3D;'}[c])); }
  function toRu(status=''){
    switch(status){
      case 'New': return 'Новые';
      case 'In Progress': return 'В работе';
      case 'On Hold': return 'На согласовании';
      case 'Successful': return 'Успешно';
      case 'Rejected': return 'Отклонено';
      default: return status || '—';
    }
  }
  function badge(status=''){ return `<span class="status-badge status-${(status||'').replace(' ', '-')}">${toRu(status)}</span>`; }
  function fmtDate(s){
    if (!s) return '-';
    const d = new Date(s);
    if (isNaN(d)) return '-';
    return d.toLocaleString();
  }

  async function ensureModerator(){
    try{
      const res = await fetch(`${API_BASE}/auth/status`, { credentials:'include' });
      if (!res.ok) throw new Error('auth');
      const data = await res.json();
      if (!data.isLoggedIn || !['moderator','admin'].includes(data.role)) throw new Error('role');
    }catch{
      location.href = '/';
    }
  }

  async function load(){
    try{
      const res = await fetch(`${API_BASE}/tickets/all`, { credentials:'include' });
      allTickets = res.ok ? await res.json() : [];
      render();
    }catch(e){
      console.warn(e);
      allTickets = [];
      render();
    }
  }

  function render(){
    const q = (searchInput?.value || '').trim().toLowerCase();
    const fs = filterStatus?.value || '';

    const completed = allTickets.filter(t => ['Successful','Rejected'].includes(t.status));
    const filtered = completed.filter(t => {
      const matchesQ = !q || `${t.subject} ${t.user_username} ${t.user_full_name}`.toLowerCase().includes(q);
      const matchesS = !fs || t.status === fs;
      return matchesQ && matchesS;
    });

    const sorted = filtered.slice().sort((a,b)=>{
      const ca = new Date(a.closed_at || a.created_at || a.createdAt).getTime();
      const cb = new Date(b.closed_at || b.created_at || b.createdAt).getTime();
      return cb - ca; // последние закрытые/созданные — сверху
    });

    tbody.innerHTML = '';
    for (const t of sorted){
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="ID">${t.id}</td>
        <td data-label="Пользователь" class="col-user">
          <div><strong>${escapeHtml(t.user_username || '')}</strong></div>
          <div class="muted">${escapeHtml(t.user_full_name || '')}</div>
        </td>
        <td data-label="Тема">${escapeHtml(t.subject || '')}</td>
        <td data-label="Статус">${badge(t.status)}</td>
        <td data-label="Создан" class="col-created">${fmtDate(t.created_at || t.createdAt)}</td>
        <td data-label="Закрыт" class="col-closed">${fmtDate(t.closed_at)}</td>
        <td data-label="Действия">
          <a class="btn btn-outline btn-small" href="/moder.html#tickets" title="Открыть в модераторе" aria-label="Открыть в модераторе">Открыть</a>
        </td>
      `;
      tbody.appendChild(tr);
    }
    if (!sorted.length){
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="7" class="muted" style="text-align:center;">Нет завершённых заявок</td>`;
      tbody.appendChild(tr);
    }
  }

  // Events
  btnReload?.addEventListener('click', load);
  searchInput?.addEventListener('input', render);
  filterStatus?.addEventListener('change', render);

  // Bootstrap
  (async function init(){
    await ensureModerator();
    await load();
  })();
});