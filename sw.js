self.addEventListener('push', (event) => {
  let payload = {
    title: 'Destiny Lore Masters',
    body: 'Un amico è online.',
    url: './'
  };

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'dlm.ico',
      badge: 'dlm.ico',
      data: { url: payload.url || './' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(clients.openWindow(url));
});
