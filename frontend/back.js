document.querySelectorAll('[data-back-button]').forEach(button => {
  button.addEventListener('click', () => {
    let previousPageIsLocal = false;

    try {
      previousPageIsLocal = Boolean(document.referrer)
        && new URL(document.referrer).origin === window.location.origin;
    } catch {
      previousPageIsLocal = false;
    }

    if (previousPageIsLocal && window.history.length > 1) {
      window.history.back();
      return;
    }

    window.location.assign(button.dataset.backFallback || 'admin.html');
  });
});
