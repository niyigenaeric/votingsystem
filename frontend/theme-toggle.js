(() => {
  const storageKey = 'voting-system-theme';
  let storedTheme = null;
  try {
    storedTheme = localStorage.getItem(storageKey);
  } catch (error) {
    console.warn('Theme preference could not be loaded:', error.message);
  }
  const initialTheme = storedTheme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = initialTheme;

  function updateToggle(button, theme) {
    const darkMode = theme === 'dark';
    button.textContent = darkMode ? '☀ Light mode' : '◐ Dark mode';
    button.setAttribute('aria-label', darkMode ? 'Switch to light mode' : 'Switch to dark mode');
    button.setAttribute('aria-pressed', String(darkMode));
    button.title = darkMode ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function addToggle() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    updateToggle(button, initialTheme);
    button.addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme;
      try {
        localStorage.setItem(storageKey, theme);
      } catch (error) {
        console.warn('Theme preference could not be saved:', error.message);
      }
      updateToggle(button, theme);
    });
    document.body.appendChild(button);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addToggle, { once: true });
  } else {
    addToggle();
  }
})();
