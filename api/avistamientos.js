// Guardar como api/avistamientos.js en petfind-backend.
const admin = require('firebase-admin');
const { createHash } = require('crypto');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idValido = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const fallo = (status, message) => Object.assign(new Error(message), { status });
const activo = (r) => r.tipo === 'Perdida' && r.estado !== 'Reunida' && r.estado !== 'Vencida';
const fotoValida = (x) => typeof x === 'string' && (x === '' || (x.length <= 700023 && /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/.test(x)));
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido.' });
  let uid;
  try { ({ uid } = await admin.auth().verifyIdToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), true)); }
  catch { return res.status(401).json({ error: 'Inicia sesión de nuevo para continuar.' }); }
  const db = admin.firestore();
  try {
    if (req.method === 'GET') {
      const { reporteId, cursor } = req.query || {};
      if (!idValido(reporteId) || (cursor !== undefined && !idValido(cursor))) throw fallo(400, 'Consulta inválida.');
      // Verificar la propiedad y leer en una transacción evita filtrar ubicaciones si cambia el autor.
      const resultado = await db.runTransaction(async (tx) => {
        const r = await tx.get(db.collection('reportes').doc(reporteId));
        if (!r.exists) throw fallo(404, 'La publicación ya no existe.');
        if (r.data().autorId !== uid) throw fallo(403, 'Solo el autor del reporte puede consultar estos avistamientos.');
        let q = db.collection('avistamientos').where('reporteId', '==', reporteId).orderBy(admin.firestore.FieldPath.documentId());
        if (cursor) q = q.startAfter(cursor);
        // Cuatro fotos por respuesta mantienen el cuerpo por debajo del límite de la función.
        const docs = (await tx.get(q.limit(5))).docs;
        return { items: docs.slice(0, 4).map(d => { const a = d.data(); return { id: d.id, comentario: a.comentario, referencia: a.referencia, latitud: a.latitud, longitud: a.longitud, fechaEvento: a.fechaEvento, foto: a.foto, creado: a.creado?.toDate?.().toISOString() || '' }; }), siguiente: docs.length > 4 ? docs[3].id : null };
      });
      return res.json(resultado);
    }
    const b = req.body || {};
    if (!idValido(b.reporteId) || typeof b.solicitudId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(b.solicitudId)) throw fallo(400, 'Solicitud inválida.');
    if (typeof b.comentario !== 'string' || b.comentario.trim().length < 10 || b.comentario.trim().length > 500) throw fallo(400, 'Describe lo que viste con entre 10 y 500 caracteres.');
    if (typeof b.referencia !== 'string' || b.referencia.trim().length > 150) throw fallo(400, 'La referencia debe tener hasta 150 caracteres.');
    if (!Number.isFinite(b.latitud) || b.latitud < -90 || b.latitud > 90 || !Number.isFinite(b.longitud) || b.longitud < -180 || b.longitud > 180) throw fallo(400, 'Confirma una ubicación válida en el mapa.');
    if (!fotoValida(b.foto)) throw fallo(400, 'La foto debe ser JPEG o PNG y ocupar menos de 700000 caracteres de imagen. Elige otra foto o envía sin foto.');
    const fecha = typeof b.fechaEvento === 'string' ? Date.parse(b.fechaEvento) : NaN;
    if (!Number.isFinite(fecha) || fecha > Date.now() + 300000 || fecha < Date.now() - 30 * 86400000) throw fallo(400, 'La fecha debe estar dentro de los últimos 30 días y no ser futura.');
    const ref = db.collection('avistamientos').doc(hash([uid, b.reporteId, b.solicitudId]));
    const cuota = db.collection('avistamientos_limites').doc(hash([uid, new Date().toISOString().slice(0, 10)]));
    const resultado = await db.runTransaction(async (tx) => {
      const [existe, r, limite] = await Promise.all([tx.get(ref), tx.get(db.collection('reportes').doc(b.reporteId)), tx.get(cuota)]);
      if (existe.exists) return { ok: true, duplicado: true };
      if (!r.exists) throw fallo(404, 'La publicación ya no existe.');
      const reporte = r.data();
      if (!activo(reporte)) throw fallo(409, 'Solo se pueden enviar avistamientos para mascotas perdidas con reporte activo.');
      if (reporte.autorId === uid) throw fallo(400, 'Este es tu reporte. Aquí puedes consultar los avistamientos que recibas.');
      if (typeof reporte.autorId !== 'string' || !reporte.autorId) throw fallo(409, 'Este reporte no tiene un destinatario válido.');
      const perdida = Date.parse(reporte.fechaEvento);
      if (Number.isFinite(perdida) && fecha < perdida) throw fallo(400, 'El avistamiento es anterior a la fecha de pérdida del reporte. Revisa cuándo ocurrió.');
      if ((limite.data()?.cantidad || 0) >= 5) throw fallo(429, 'Alcanzaste el límite diario de cinco avistamientos. Intenta más tarde.');
      const ahora = admin.firestore.FieldValue.serverTimestamp();
      tx.create(ref, { reporteId: b.reporteId, autorUid: uid, comentario: b.comentario.trim(), referencia: b.referencia.trim(), latitud: b.latitud, longitud: b.longitud, fechaEvento: new Date(fecha).toISOString(), foto: b.foto, creado: ahora });
      tx.set(cuota, { cantidad: (limite.data()?.cantidad || 0) + 1, actualizado: ahora });
      tx.create(db.collection('notificaciones').doc(`avistamiento_${ref.id}`), { paraUid: reporte.autorId, tipo: 'avistamiento', tuReporteId: b.reporteId, tuReporteNombre: String(reporte.nombre || '').slice(0, 60), motivo: 'Alguien informó que vio una mascota parecida. Abre tu reporte para consultar el lugar, la fecha y la foto, si la adjuntó. Es información por verificar.', leida: false, creado: ahora });
      return { ok: true, duplicado: false };
    });
    return res.json(resultado);
  } catch (e) {
    console.error('Avistamientos', e.status || 500, e.status ? e.message : e.code || 'error');
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo completar la operación. Intenta de nuevo.' });
  }
};