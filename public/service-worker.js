// public/service-worker.js

// Имя для кэша PWA (для будущих улучшений оффлайн-работы)
const CACHE_NAME = 'zero-helpdesk-cache-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/user.html',
  '/moder.html'
  // ... добавьте сюда CSS, JS и иконки
];

// Устанавливаем Service Worker и кэшируем основные ресурсы
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Активируем Service Worker
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName); // Удаляем старые кэши
          }
        })
      );
    })
  );
});

// Обработчик события Push-уведомлений
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push Received.');

  const data = event.data.json();

  const title = data.title || 'Новое уведомление ZERO';
  const options = {
    body: data.body || 'Вам пришло новое сообщение или изменился статус тикета.',
    icon: '/icons/icon-72x72.png', // Используем иконку PWA
    badge: '/icons/icon-72x72.png',
    data: {
      url: data.url || '/' // URL, который откроется при клике
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Обработчик события клика по уведомлению
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification click received.');
  event.notification.close();

  const targetUrl = event.notification.data.url;

  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        // Если вкладка уже открыта, переключаемся на нее и фокусируемся
        if (client.url === targetUrl && 'focus' in client) {
          return client.focus();
        }
      }
      // Если вкладка не найдена или закрыта, открываем новую
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});