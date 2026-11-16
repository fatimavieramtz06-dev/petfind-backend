// api/moderar.js — todas las decisiones y permisos se verifican en el servidor.
const admin = require('firebase-admin');
const { createHash } = require('crypto');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const MOTIVOS = ['Información falsa', 'Spam o publicidad', 'Contenido inapropiado', 'Otro'];
const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idValido = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
const version = (d) => d.exists ? `${d.updateTime.seconds}:${d.updateTime.nanoseconds}` : 'ausente';
const fallo = (status, message) => Object.assign(new Error(message), { status });
const texto = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
const copia = (r) => ({
  nombre: texto(r.nombre, 60), tipo: texto(r.tipo, 20), especie: texto(r.especie, 20), especieOtro: texto(r.especieOtro, 60), fechaEvento: texto(r.fechaEvento, 40), estado: texto(r.estado, 20), raza: texto(r.raza, 60),
  descripcion: texto(r.descripcion, 500), ubicacion: texto(r.ubicacion, 150), foto: texto(r.foto, 800000),
  colores: Array.isArray(r.colores) ? r.colores.filter(x => typeof x === 'string').slice(0, 3) : [],
  tamano: texto(r.tamano, 20), autorId: texto(r.autorId, 128),
});
const iso = (v) => v?.toDate ? v.toDate().toISOString() : '';
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Método no permitido' });
  let uid;
  try { ({ uid } = await admin.auth().verifyIdToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), true)); }
  catch { return res.status(401).json({ error: 'Inicia sesión de nuevo para continuar.' }); }
  const esAdmin = (process.env.ADMIN_UIDS || '').split(',').map(x => x.trim()).filter(Boolean).includes(uid);
  const db = admin.firestore();
  try {
    if (req.method === 'GET') {
      if (req.query?.rol === '1') return res.json({ admin: esAdmin });
      if (!esAdmin) throw fallo(403, 'Esta cuenta no puede revisar denuncias.');
      const id = req.query?.id;
      if (id !== undefined) {
        if (!idValido(id)) throw fallo(400, 'Denuncia inválida.');
        const d = await db.collection('denuncias').doc(id).get();
        if (!d.exists) throw fallo(404, 'La denuncia ya no existe.');
        const n = d.data();
        const [r, evidencia] = await Promise.all([db.collection('reportes').doc(n.reporteId).get(), d.ref.collection('evidencia').doc('retirada').get()]);
        return res.json({ denuncia: { id: d.id, motivo: n.motivo, detalle: n.detalle, estado: n.estado, creado: iso(n.creado), accion: n.accion || '', nota: n.nota || '', revisado: iso(n.revisado), copia: n.copia }, reporte: r.exists ? copia(r.data()) : null, retirada: evidencia.exists ? evidencia.data() : null, version: version(r) });
      }
      const estado = req.query?.estado || 'pendiente';
      if (!['pendiente', 'resuelta'].includes(estado)) throw fallo(400, 'Estado inválido.');
      const cursor = req.query?.cursor;
      if (cursor !== undefined && !idValido(cursor)) throw fallo(400, 'Página inválida.');
      let q = db.collection('denuncias').where('estado', '==', estado).orderBy(admin.firestore.FieldPath.documentId());
      if (cursor) q = q.startAfter(cursor);
      const docs = (await q.limit(21).get()).docs;
      return res.json({ items: docs.slice(0, 20).map(d => { const n = d.data(); return { id: d.id, nombre: n.copia?.nombre || 'Sin nombre', motivo: n.motivo, creado: iso(n.creado), accion: n.accion || '' }; }), siguiente: docs.length > 20 ? docs[19].id : null });
    }
    const body = req.body || {};
    if (body.accion === 'denunciar') {
      if (!idValido(body.reporteId) || !MOTIVOS.includes(body.motivo) || typeof body.detalle !== 'string' || body.detalle.trim().length > 500 || (body.motivo === 'Otro' && body.detalle.trim().length < 10)) throw fallo(400, 'Elige un motivo válido. Para Otro, explica lo ocurrido con al menos 10 caracteres.');
      const ref = db.collection('denuncias').doc(hash([uid, body.reporteId]));
      const reporte = db.collection('reportes').doc(body.reporteId);
      const cuota = db.collection('moderacion_limites').doc(hash([uid, new Date().toISOString().slice(0, 10)]));
      const resultado = await db.runTransaction(async tx => {
        const [d, r, limite] = await Promise.all([tx.get(ref), tx.get(reporte), tx.get(cuota)]);
        if (d.exists) return { ok: true, duplicada: true };
        if (!r.exists) throw fallo(404, 'La publicación ya no existe.');
        if (r.data().autorId === uid) throw fallo(400, 'Puedes editar o eliminar tu propio reporte desde tu perfil.');
        if ((limite.data()?.cantidad || 0) >= 5) throw fallo(429, 'Alcanzaste el límite diario de cinco denuncias. Intenta más tarde.');
        tx.create(ref, { reporteId: body.reporteId, denuncianteUid: uid, motivo: body.motivo, detalle: body.detalle.trim(), estado: 'pendiente', creado: admin.firestore.FieldValue.serverTimestamp(), copia: copia(r.data()) });
        tx.set(cuota, { cantidad: (limite.data()?.cantidad || 0) + 1, actualizado: admin.firestore.FieldValue.serverTimestamp() });
        return { ok: true, duplicada: false };
      });
      return res.json(resultado);
    }
    if (body.accion !== 'resolver') throw fallo(400, 'Acción inválida.');
    if (!esAdmin) throw fallo(403, 'Esta cuenta no puede resolver denuncias.');
    if (!idValido(body.denunciaId) || !['descartar', 'retirar'].includes(body.decision) || typeof body.nota !== 'string' || body.nota.trim().length < 10 || body.nota.trim().length > 500 || typeof body.version !== 'string' || body.version.length > 100) throw fallo(400, 'Explica la decisión con entre 10 y 500 caracteres.');
    const ref = db.collection('denuncias').doc(body.denunciaId);
    const resultado = await db.runTransaction(async tx => {
      const d = await tx.get(ref);
      if (!d.exists) throw fallo(404, 'La denuncia ya no existe.');
      const n = d.data();
      if (n.estado === 'resuelta') return { ok: true, yaResuelta: true };
      const refReporte = db.collection('reportes').doc(n.reporteId), r = await tx.get(refReporte);
      if (body.version !== version(r)) throw fallo(409, 'La publicación cambió desde que la abriste. Actualiza la revisión antes de decidir.');
      if (body.decision === 'retirar' && !r.exists) throw fallo(409, 'La publicación ya no existe. Actualiza y cierra la denuncia sin retirar.');
      const ahora = admin.firestore.FieldValue.serverTimestamp();
      tx.update(ref, { estado: 'resuelta', accion: body.decision, nota: body.nota.trim(), revisadoPor: uid, revisado: ahora, versionRevisada: body.version });
      if (body.decision === 'retirar') {
        // Se conserva evidencia privada en la denuncia antes de eliminar la publicación.
        tx.set(ref.collection('evidencia').doc('retirada'), copia(r.data()));
        tx.delete(refReporte);
        const autor = r.data().autorId;
        if (typeof autor === 'string' && autor) tx.set(db.collection('notificaciones').doc(`moderacion_retirada_${n.reporteId}`), { paraUid: autor, tipo: 'moderacion', motivo: `Tu publicación fue retirada tras una revisión. Motivo: ${body.nota.trim()}`, tuReporteId: n.reporteId, tuReporteNombre: r.data().nombre || '', leida: false, creado: ahora });
      }
      tx.set(db.collection('notificaciones').doc(`moderacion_revision_${d.id}`), { paraUid: n.denuncianteUid, tipo: 'moderacion', motivo: body.decision === 'retirar' ? 'Revisamos tu denuncia y retiramos la publicación.' : 'Revisamos tu denuncia y cerramos la revisión sin retirar la publicación.', tuReporteId: n.reporteId, tuReporteNombre: n.copia?.nombre || '', leida: false, creado: ahora });
      return { ok: true, yaResuelta: false };
    });
    return res.json(resultado);
  } catch (e) {
    console.error('Moderación', e.status || 500, e.message);
    return res.status(e.status || 500).json({ error: e.status ? e.message : 'No se pudo completar la operación. Intenta de nuevo.' });
  }
};