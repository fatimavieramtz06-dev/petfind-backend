// Limpieza automática de reportes. Vercel la ejecuta una vez al día (ver vercel.json).
// - Reportes "Reunida" con más de DIAS_REUNIDA días: se borran por completo.
// - Reportes activos con más de DIAS_ACTIVO días: se marcan "Vencida" (salen de la lista y del escáner).
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const DIAS_REUNIDA = 30;
const DIAS_ACTIVO = 90;
const DIA_MS = 24 * 60 * 60 * 1000;

module.exports = async (req, res) => {
  // Solo la tarea programada de Vercel (o quien tenga el secreto) puede ejecutarla
  const secreto = process.env.CRON_SECRET;
  if (!secreto || req.headers.authorization !== `Bearer ${secreto}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    const db = admin.firestore();
    const ahora = Date.now();
    let borrados = 0;
    let vencidos = 0;

    // 1. Reunidas con más de 30 días: borrar
    const reunidas = await db.collection('reportes').where('estado', '==', 'Reunida').get();
    const limiteReunida = ahora - DIAS_REUNIDA * DIA_MS;
    let lote = db.batch();
    let enLote = 0;
    for (const d of reunidas.docs) {
      const f = d.data().fechaResolucion;
      const ms = f && f.toMillis ? f.toMillis() : null;
      if (ms !== null && ms < limiteReunida) {
        lote.delete(d.ref);
        borrados++;
        if (++enLote === 400) { await lote.commit(); lote = db.batch(); enLote = 0; }
      }
    }
    if (enLote) await lote.commit();

    // 2. Activas con más de 90 días: marcar como vencidas
    const limiteActivo = admin.firestore.Timestamp.fromMillis(ahora - DIAS_ACTIVO * DIA_MS);
    const viejas = await db.collection('reportes').where('creado', '<', limiteActivo).limit(300).get();
    lote = db.batch();
    enLote = 0;
    for (const d of viejas.docs) {
      const e = d.data().estado;
      if (e !== 'Reunida' && e !== 'Vencida') {
        lote.update(d.ref, { estado: 'Vencida' });
        vencidos++;
        enLote++;
      }
    }
    if (enLote) await lote.commit();

    // 3. Avisos con más de 30 días: borrar (ya cumplieron su función)
    const limiteAviso = admin.firestore.Timestamp.fromMillis(ahora - 30 * DIA_MS);
    const avisosViejos = await db.collection('notificaciones').where('creado', '<', limiteAviso).limit(400).get();
    let avisosBorrados = 0;
    if (!avisosViejos.empty) {
      lote = db.batch();
      avisosViejos.docs.forEach((d) => {
        lote.delete(d.ref);
        avisosBorrados++;
      });
      await lote.commit();
    }

    console.log(`Limpieza: ${borrados} borrados, ${vencidos} vencidos, ${avisosBorrados} avisos borrados`);
    return res.json({ borrados, vencidos, avisosBorrados });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Falló la limpieza' });
  }
};