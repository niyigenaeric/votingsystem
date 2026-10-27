document.querySelectorAll('[data-password-field]').forEach(field => {
  const input = field.querySelector('input[type="password"], input[type="text"]');
  const toggle = field.querySelector('[data-password-toggle]');
  if (!input || !toggle) return;

  toggle.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    toggle.setAttribute('aria-pressed', String(!showing));
    input.focus();
  });
});
