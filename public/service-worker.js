/* Service Worker для ZERO Help Desk
   - Принимает push и показывает нотификацию
   - Обрабатывает клики по уведомлениям, открывает/фокусирует нужную вкладку
*/

self.addEventListener('install', (event) => {
  // Быстрая активация обновлённого SW
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Контроль над уже открытыми клиентами
  event.waitUntil(self.clients.claim());
});

// Безопасный парс данных push
function parsePushData(event) {
  try {
    if (!event.data) return {};
    const text = event.data.text();
    try { return JSON.parse(text); } catch { return { body: text }; }
  } catch {
    return {};
  }
}

// Показ уведомления
self.addEventListener('push', (event) => {
  const data = parsePushData(event) || {};
  const title = data.title || 'ZERO — Новое уведомление';
  const body = data.body || 'У вас есть новое сообщение.';
  const url = data.url || '/';
  const tag = data.tag || 'zero-helpdesk';
  const ticketId = data.ticketId || null;

  const options = {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [100, 50, 100],
    tag,           // чтобы похожие уведомления группировались/обновлялись
    renotify: true,
    data: { url, ticketId },
    // Доп. действия при желании (комментировано)
    // actions: [
    //   { action: 'open', title: 'Открыть' }
    // ]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Переход/фокус по клику
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || '/';

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Если вкладка с этим URL уже есть — фокусируем её
      const same = allClients.find((c) => c.url.includes(new URL(targetUrl, self.location.origin).pathname));
      if (same) {
        await same.focus();
        try { same.navigate(targetUrl); } catch {}
        return;
      }
      // Иначе открываем новую
      await self.clients.openWindow(targetUrl);
    })()
  );
});

// Необязательно, для аналитики
self.addEventListener('notificationclose', (_event) => {
  // Можно отправить метрику закрытия уведомления
});