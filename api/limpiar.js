// Limpieza programada: conserva las políticas de 30 y 90 días.
const admin = require('firebase-admin');
const { randomUUID, timingSafeEqual } = require('node:crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const DIAS_REUNIDA = 30;
const DIAS_ACTIVO = 90;
const DIA_MS = 24 * 60 * 60 * 1000;
const PAGINA = 40;
const MAX_REVISADOS_POR_TAREA = 400;
const estaActivo = (r) => r.estado === undefined || r.estado === 'Activo';
const milisegundos = (f) => f && typeof f.toMillis === 'function' ? f.toMillis() : null;

function autorizado(cabecera, secreto) {
  if (typeof secreto !== 'string' || !secreto || typeof cabecera !== 'string') return false;
  const recibido = Buffer.from(cabecera);
  const esperado = Buffer.from(`Bearer ${secreto}`);
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

module.exports = async (req, res) => {
  if (!autorizado(req.headers.authorization, process.env.CRON_SECRET)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const ahora = Date.now();
  const limiteTotal = ahora + 42000;
  const propietario = randomUUID();
  const db = admin.firestore();
  // Colección privada: las reglas publicadas deniegan su acceso desde la app.
  const control = db.collection('mantenimiento').doc('limpieza');
  const totales = { borrados: 0, vencidos: 0, avisosBorrados: 0, conflictos: 0 };
  let cursores = {};

  const liberar = async () => db.runTransaction(async (tx) => {
    const actual = await tx.get(control);
    if (actual.data()?.propietario === propietario) {
      tx.set(control, { propietario: admin.firestore.FieldValue.delete(), venceEn: 0 }, { merge: true });
    }
  });

  const guardarAvance = async () => db.runTransaction(async (tx) => {
    const actual = await tx.get(control);
    if (actual.data()?.propietario !== propietario || !(actual.data()?.venceEn > Date.now())) {
      throw new Error('La limpieza perdió su reserva');
    }
    tx.set(control, { cursores, ultimaEjecucion: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });

  try {
    const adquirido = await db.runTransaction(async (tx) => {
      const actual = await tx.get(control);
      const datos = actual.data() || {};
      if (datos.venceEn > Date.now()) return false;
      cursores = datos.cursores || {};
      tx.set(control, { propietario, venceEn: Date.now() + 120000 }, { merge: true });
      return true;
    });
    if (!adquirido) return res.status(409).json({ error: 'La limpieza ya está en ejecución.' });

    const campoId = admin.firestore.FieldPath.documentId();
    const corte30 = ahora - DIAS_REUNIDA * DIA_MS;
    const corte90 = ahora - DIAS_ACTIVO * DIA_MS;
    const timestamp30 = admin.firestore.Timestamp.fromMillis(corte30);
    const timestamp90 = admin.firestore.Timestamp.fromMillis(corte90);

    const tareas = [
      {
        clave: 'reunidas', contador: 'borrados',
        consulta: () => db.collection('reportes').where('estado', '==', 'Reunida').orderBy(campoId),
        porFecha: false,
        aplicar: async (d) => {
          const r = d.data();
          const fecha = milisegundos(r.fechaResolucion);
          if (r.estado !== 'Reunida' || fecha === null || !(fecha < corte30)) return false;
          await d.ref.delete({ lastUpdateTime: d.updateTime });
          return true;
        },
      },
      {
        clave: 'activos', contador: 'vencidos',
        consulta: () => db.collection('reportes').where('creado', '<', timestamp90).orderBy('creado').orderBy(campoId),
        porFecha: true,
        aplicar: async (d) => {
          const r = d.data();
          if (!estaActivo(r)) return false;
          await d.ref.update({ estado: 'Vencida' }, { lastUpdateTime: d.updateTime });
          return true;
        },
      },
      {
        clave: 'avisos', contador: 'avisosBorrados',
        consulta: () => db.collection('notificaciones').where('creado', '<', timestamp30).orderBy('creado').orderBy(campoId),
        porFecha: true,
        aplicar: async (d) => {
          await d.ref.delete({ lastUpdateTime: d.updateTime });
          return true;
        },
      },
    ];

    const revisados = {};
    const pendientes = {};
    for (const tarea of tareas) {
      // Reservar tiempo para las otras tareas. Al agotarlo, se continúa en la próxima ejecución.
      const limiteTarea = Math.min(limiteTotal, Date.now() + 12000);
      let revisadosTarea = 0;
      let terminado = false;
      while (revisadosTarea < MAX_REVISADOS_POR_TAREA && Date.now() < limiteTarea) {
        let consulta = tarea.consulta();
        const cursor = cursores[tarea.clave];
        if (cursor && typeof cursor.id === 'string') {
          consulta = tarea.porFecha
            ? consulta.startAfter(cursor.creado, cursor.id)
            : consulta.startAfter(cursor.id);
        }
        // Solo descargar metadatos: no hacen falta las fotos para limpiar.
        const pagina = await consulta.select('estado', 'fechaResolucion', 'creado')
          .limit(Math.min(PAGINA, MAX_REVISADOS_POR_TAREA - revisadosTarea)).get();
        if (pagina.empty) {
          cursores[tarea.clave] = null;
          await guardarAvance();
          terminado = true;
          break;
        }
        let consumidos = 0;
        for (const d of pagina.docs) {
          if (Date.now() >= limiteTarea) break;
          try {
            if (await tarea.aplicar(d)) totales[tarea.contador]++;
          } catch (e) {
            // No tocar una versión que cambió o desapareció después de leerla.
            if (e.code === 5 || e.code === 9) totales.conflictos++;
            else throw e;
          }
          cursores[tarea.clave] = tarea.porFecha
            ? { id: d.id, creado: d.data().creado }
            : { id: d.id };
          revisadosTarea++;
          consumidos++;
        }
        if (consumidos === pagina.size && pagina.size < PAGINA) {
          cursores[tarea.clave] = null;
          terminado = true;
        }
        await guardarAvance();
        if (terminado || consumidos < pagina.size) break;
      }
      revisados[tarea.clave] = revisadosTarea;
      pendientes[tarea.clave] = !terminado;
    }

    await liberar();
    console.log('Limpieza completada:', { ...totales, revisados, pendientes });
    return res.json({ ...totales, revisados, pendientes, parcial: Object.values(pendientes).some(Boolean) });
  } catch (e) {
    try { await liberar(); } catch { console.error('No se pudo liberar la reserva; caducará automáticamente.'); }
    console.error('Falló la limpieza:', e?.code || e?.name || 'desconocido');
    return res.status(500).json({ error: 'Falló la limpieza. Algunas operaciones pueden haberse completado.', ...totales });
  }
};