(() => {
  const rolesByPage = {
    '/admin.html': ['admin', 'auditor'],
    '/candidate.html': ['admin'],
    '/position.html': ['admin', 'auditor'],
    '/vote.html': ['voter']
  };
  const allowedRoles = rolesByPage[window.location.pathname];

  window.addEventListener('pageshow', async event => {
    if (!event.persisted || !allowedRoles) return;

    document.documentElement.style.visibility = 'hidden';
    try {
      const response = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('Session is no longer valid.');
      const user = await response.json();
      if (!allowedRoles.includes(user.role)) throw new Error('Session role is not authorized for this page.');
      sessionStorage.setItem('role', user.role);
      document.documentElement.style.visibility = '';
    } catch {
      sessionStorage.removeItem('role');
      window.location.replace('/');
    }
  });
})();
