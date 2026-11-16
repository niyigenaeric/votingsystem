window.formatRwandaDateTime = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value || '');
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kigali',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(date);
  return formatted + ' CAT';
};
