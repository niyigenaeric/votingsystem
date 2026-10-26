const CAMPUSES = ['Huye', 'Gikondo', 'Nyarugenge', 'Remera', 'Busogo', 'Nyagatare', 'Rukara', 'Rwamagana'];
const canonical = v => CAMPUSES.find(c => c.toLowerCase() === String(v || '').trim().toLowerCase()) || null;

module.exports = { CAMPUSES, canonical };