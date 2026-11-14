// Cierra de forma atómica los dos reportes de un aviso de coincidencia autorizado.
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const estaActivo = (r) => r.estado === undefined || r.estado === 'Activo';
const idValido = (valor) => typeof valor === 'string'
  && valor.length > 0 && Buffer.byteLength(valor, 'utf8') <= 1500
  && !valor.includes('/') && valor !== '.' && valor !== '..'
  && !/^__.*__$/.test(valor);

class ErrorSolicitud extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const cabecera = req.headers.authorization;
  const portador = typeof cabecera === 'string' ? /^Bearer\s+(\S+)$/i.exec(cabecera.trim()) : null;
  if (!portador) return res.status(401).json({ error: 'Inicia sesión para confirmar el reencuentro.' });

  let uid;
  try {
    ({ uid } = await admin.auth().verifyIdToken(portador[1]));
    if (!uid) throw new Error('Token sin usuario');
  } catch {
    return res.status(401).json({ error: 'Tu sesión no es válida. Inicia sesión de nuevo.' });
  }

  const { notificacionId } = req.body || {};
  if (!idValido(notificacionId)) {
    return res.status(400).json({ error: 'El identificador del aviso no es válido.' });
  }

  try {
    const db = admin.firestore();
    const refAviso = db.collection('notificaciones').doc(notificacionId);
    const resultado = await db.runTransaction(async (transaccion) => {
      // Todas las comprobaciones se repiten si Firestore reintenta la transacción.
      const aviso = await transaccion.get(refAviso);
      if (!aviso.exists) throw new ErrorSolicitud(404, 'El aviso ya no existe.');
      const n = aviso.data();
      if (n.paraUid !== uid) throw new ErrorSolicitud(403, 'No puedes confirmar un aviso de otra cuenta.');
      // Compatibilidad con avisos antiguos sin tipo; no se aceptan otros tipos explícitos.
      if (n.tipo !== undefined && n.tipo !== 'coincidencia') {
        throw new ErrorSolicitud(400, 'Este aviso no es una coincidencia que se pueda confirmar.');
      }
      if (!idValido(n.tuReporteId) || !idValido(n.reporteNuevoId) || n.tuReporteId === n.reporteNuevoId) {
        throw new ErrorSolicitud(400, 'El aviso no contiene dos reportes distintos y válidos.');
      }

      const refMio = db.collection('reportes').doc(n.tuReporteId);
      const refOtro = db.collection('reportes').doc(n.reporteNuevoId);
      const docMio = await transaccion.get(refMio);
      const docOtro = await transaccion.get(refOtro);
      if (!docMio.exists || !docOtro.exists) {
        throw new ErrorSolicitud(404, 'Uno de los reportes ya no existe. Actualiza tus avisos.');
      }
      const mio = docMio.data();
      const otro = docOtro.data();
      if (mio.autorId !== uid) throw new ErrorSolicitud(403, 'El reporte asociado no pertenece a tu cuenta.');
      if (typeof otro.autorId !== 'string' || !otro.autorId) {
        throw new ErrorSolicitud(409, 'El otro reporte no tiene un autor válido.');
      }
      if (!['Perdida', 'Encontrada'].includes(mio.tipo)
          || !['Perdida', 'Encontrada'].includes(otro.tipo) || mio.tipo === otro.tipo) {
        throw new ErrorSolicitud(409, 'El reencuentro requiere un reporte de pérdida y otro de hallazgo.');
      }
      if (!['Perro', 'Gato', 'Otro'].includes(mio.especie) || mio.especie !== otro.especie) {
        throw new ErrorSolicitud(409, 'Los reportes ya no corresponden a la misma especie.');
      }

      // Una repetición nunca vuelve a cerrar ni cambia la fecha del reencuentro.
      if (mio.estado === 'Reunida' && otro.estado === 'Reunida') {
        transaccion.update(refAviso, { leida: true });
        return { ok: true, cerrados: 0, yaResueltos: true };
      }
      // Evita que un aviso antiguo cierre un reporte activo usando otro ya vencido o resuelto.
      if (!estaActivo(mio) || !estaActivo(otro)) {
        throw new ErrorSolicitud(409, 'Este aviso ya no se puede confirmar: uno de los reportes está resuelto o vencido. Actualiza tus avisos.');
      }

      const ahora = admin.firestore.FieldValue.serverTimestamp();
      transaccion.update(refMio, { estado: 'Reunida', fechaResolucion: ahora });
      transaccion.update(refOtro, { estado: 'Reunida', fechaResolucion: ahora });
      if (otro.autorId !== uid) {
        transaccion.set(db.collection('notificaciones').doc(`cierre_${docOtro.id}`), {
          paraUid: otro.autorId,
          tipo: 'cierre',
          tuReporteId: docOtro.id,
          tuReporteNombre: typeof otro.nombre === 'string' ? otro.nombre : '',
          reporteNuevoId: docMio.id,
          reporteNuevoNombre: typeof mio.nombre === 'string' ? mio.nombre : '',
          reporteNuevoTipo: mio.tipo,
          similitud: 0,
          motivo: otro.tipo === 'Encontrada'
            ? 'El dueño confirmó que ya recuperó a su mascota. Tu reporte se cerró automáticamente. ¡Gracias por ayudar!'
            : 'Quien la encontró confirmó que ya la entregó. Tu reporte se cerró automáticamente. ¡Qué bueno que se resolvió!',
          leida: false,
          creado: ahora,
        });
      }
      transaccion.update(refAviso, {
        leida: true, confirmadaReencuentro: true, confirmadoPor: uid, fechaConfirmacion: ahora,
      });
      return { ok: true, cerrados: 2, yaResueltos: false };
    });
    return res.json(resultado);
  } catch (e) {
    if (e instanceof ErrorSolicitud) return res.status(e.status).json({ error: e.message });
    console.error('Error al confirmar reencuentro:', e?.code || e?.name || 'desconocido');
    return res.status(500).json({ error: 'No se pudo confirmar el reencuentro. Intenta de nuevo.' });
  }
};