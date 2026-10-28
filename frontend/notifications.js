(() => {
  const center = document.querySelector('[data-notification-center]');
  if (!center) return;

  const toggle = center.querySelector('[data-notification-toggle]');
  const panel = center.querySelector('[data-notification-panel]');
  const list = center.querySelector('[data-notification-list]');
  const count = center.querySelector('[data-notification-count]');
  const refresh = center.querySelector('[data-notification-refresh]');

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function render(notifications) {
    list.replaceChildren();
    count.textContent = String(notifications.length);
    count.hidden = notifications.length === 0;
    toggle.setAttribute(
      'aria-label',
      notifications.length
        ? `Election notifications, ${notifications.length} upcoming`
        : 'Election notifications'
    );

    if (!notifications.length) {
      list.appendChild(element('p', 'notification-empty', 'No positions are scheduled to start within the next 24 hours.'));
      return;
    }

    notifications.forEach(notification => {
      const item = element('article', 'notification-item');
      const title = notification.title + (notification.campus ? ` — ${notification.campus}` : '');
      item.appendChild(element('h3', '', title));
      item.appendChild(element('p', '', `Scheduled to start in ${formatTimeUntil(notification.minutesUntil)}.`));
      item.appendChild(element('time', '', formatStartTime(notification.startsAt)));
      list.appendChild(item);
    });
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  function formatTimeUntil(minutes) {
    if (minutes < 60) return `${Math.max(minutes, 1)} minute${minutes === 1 ? '' : 's'}`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes
      ? `${hours} hour${hours === 1 ? '' : 's'} and ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`
      : `${hours} hour${hours === 1 ? '' : 's'}`;
  }

  function formatStartTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Scheduled time unavailable';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Africa/Kigali'
    }).format(date) + ' Kigali time';
  }

  async function loadNotifications() {
    list.replaceChildren(element('p', 'notification-empty', 'Loading election notifications...'));
    try {
      const response = await fetch('/api/notifications', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (response.status === 401) {
        window.location.replace('/');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Could not load election notifications.');
      render(data.notifications);
    } catch (error) {
      list.replaceChildren(element('p', 'notification-error', error.message || 'Could not load election notifications.'));
    }
  }

  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    if (isOpen) closePanel();
    else {
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      loadNotifications();
    }
  });
  refresh.addEventListener('click', loadNotifications);
  document.addEventListener('click', event => {
    if (!center.contains(event.target)) closePanel();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePanel();
  });
  loadNotifications();
  window.setInterval(loadNotifications, 5 * 60 * 1000);
})();
