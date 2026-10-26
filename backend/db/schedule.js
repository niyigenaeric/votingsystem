const DEADLINE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const KIGALI_UTC_OFFSET_MINUTES = 120;

function parseKigaliDateTime(value) {
    if (typeof value !== 'string') return null;
    const match = DEADLINE_RE.exec(value);
    if (!match) return null;
    const [, year, month, day, hour, minute] = match;
    const localTime = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
    if (localTime.getUTCFullYear() !== Number(year) || localTime.getUTCMonth() !== Number(month) - 1
        || localTime.getUTCDate() !== Number(day) || localTime.getUTCHours() !== Number(hour)
        || localTime.getUTCMinutes() !== Number(minute)) return null;
    const utcTime = new Date(localTime.getTime() - KIGALI_UTC_OFFSET_MINUTES * 60 * 1000).toISOString();
    return `${utcTime.slice(0, 10)} ${utcTime.slice(11, 19)}`;
}

module.exports = { parseKigaliDateTime };
