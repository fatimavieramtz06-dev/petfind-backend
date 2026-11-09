// Cierra los dos reportes involucrados cuando una persona confirma, desde un aviso de coincidencia,
// que la mascota ya regresó a casa (o que ya la entregó). Después avisa a la otra persona.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const estaActivo = (r) => r.estado !== 'Reunida' && r.estado !== 'Vencida';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    // 1. Sesión iniciada
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { uid } = await admin.auth().verifyIdToken(token);

    const { notificacionId } = req.body || {};
    if (!notificacionId || typeof notificacionId !== 'string') {
      return res.status(400).json({ error: 'Falta el aviso' });
    }

    const db = admin.firestore();
    const refAviso = db.collection('notificaciones').doc(notificacionId);
    const aviso = await refAviso.get();
    if (!aviso.exists) return res.status(404).json({ error: 'El aviso ya no existe' });
    const n = aviso.data();

    // 2. El aviso debe ser tuyo y ser una coincidencia (no un aviso de cierre)
    if (n.paraUid !== uid) return res.status(403).json({ error: 'No autorizado' });
    if (n.tipo === 'cierre') return res.status(400).json({ error: 'Este aviso no se puede confirmar' });

    // 3. Tu reporte debe ser tuyo; el otro es el que originó el aviso
    const refMio = db.collection('reportes').doc(n.tuReporteId);
    const refOtro = db.collection('reportes').doc(n.reporteNuevoId);
    const [docMio, docOtro] = await Promise.all([refMio.get(), refOtro.get()]);
    if (!docMio.exists) return res.status(404).json({ error: 'Tu reporte ya no existe' });
    const mio = { id: docMio.id, ...docMio.data() };
    if (mio.autorId !== uid) return res.status(403).json({ error: 'No autorizado' });

    const ahora = admin.firestore.FieldValue.serverTimestamp();
    const lote = db.batch();
    let cerrados = 0;

    if (estaActivo(mio)) {
      lote.update(refMio, { estado: 'Reunida', fechaResolucion: ahora });
      cerrados++;
    }

    if (docOtro.exists) {
      const otro = { id: docOtro.id, ...docOtro.data() };
      if (estaActivo(otro)) {
        lote.update(refOtro, { estado: 'Reunida', fechaResolucion: ahora });
        cerrados++;
        // Aviso para la otra persona (si es otro usuario)
        if (otro.autorId && otro.autorId !== uid) {
          lote.set(db.collection('notificaciones').doc(`cierre_${otro.id}`), {
            paraUid: otro.autorId,
            tipo: 'cierre',
            tuReporteId: otro.id,
            tuReporteNombre: otro.nombre || '',
            reporteNuevoId: mio.id,
            reporteNuevoNombre: mio.nombre || '',
            reporteNuevoTipo: mio.tipo,
            similitud: 0,
            motivo:
              otro.tipo === 'Encontrada'
                ? 'El dueño confirmó que ya recuperó a su mascota. Tu reporte se cerró automáticamente. ¡Gracias por ayudar!'
                : 'Quien la encontró confirmó que ya la entregó. Tu reporte se cerró automáticamente. ¡Qué bueno que se resolvió!',
            leida: false,
            creado: ahora,
          });
        }
      }
    }

    lote.update(refAviso, { leida: true });
    await lote.commit();

    return res.json({ ok: true, cerrados });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'No se pudo cerrar el reporte' });
  }
};