// Avisa a los dueños de reportes parecidos cuando alguien publica un reporte nuevo.
// Flujo: la app llama a esta función justo después de crear un reporte; aquí se compara
// la foto nueva contra los reportes del tipo contrario (perdida <-> encontrada) con Gemini
// y, si hay coincidencias, se crean documentos en la colección "notificaciones".
const admin = require('firebase-admin');
const { randomUUID } = require('node:crypto');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const MODELO = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
const MAX_CANDIDATOS = 8;
const SIMILITUD_MINIMA = 60; // por debajo de esto no se molesta a nadie

// Dos intentos de hasta 25 segundos dejan margen dentro del límite de Vercel (60 s).
const ESTADOS_TEMPORALES = new Set([500, 502, 503, 504]);
const MENSAJE_OCUPADO = 'El servicio de IA está ocupado. Intenta de nuevo en unos momentos.';

async function consultarGemini(cuerpo) {
  for (let intento = 0; intento < 2; intento++) {
    const controller = new AbortController();
    const temporizador = setTimeout(() => controller.abort(), 25000);
    let resultado;
    try {
      const respuesta = await fetch(URL_GEMINI, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: cuerpo,
        signal: controller.signal,
      });
      // El tiempo máximo también cubre la descarga de la respuesta.
      resultado = { ok: respuesta.ok, status: respuesta.status, texto: await respuesta.text() };
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof TypeError)) throw error;
      console.warn(controller.signal.aborted ? 'Gemini: tiempo de espera agotado (25 s)' : 'Gemini: fallo temporal de conexión', { intento: intento + 1 });
      if (intento === 1) return { ok: false, status: 503, texto: '' };
    } finally {
      clearTimeout(temporizador);
    }
    if (resultado) {
      if (resultado.ok || !ESTADOS_TEMPORALES.has(resultado.status)) return resultado;
      console.warn('Gemini: respuesta temporal', { status: resultado.status, intento: intento + 1 });
      if (intento === 1) return resultado;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

function prepararImagen(valor) {
  let b64 = valor;
  let mime = null;
  const m = /^data:(image\/[a-zA-Z+.-]+);base64,/.exec(valor);
  if (m) {
    mime = m[1];
    b64 = valor.slice(m[0].length);
  }
  if (!mime) {
    if (b64.startsWith('iVBOR')) mime = 'image/png';
    else if (b64.startsWith('UklGR')) mime = 'image/webp';
    else mime = 'image/jpeg';
  }
  return { mime, b64 };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  let refProceso;
  let propietario;
  let db;
  const liberar = async () => {
    if (!refProceso || !propietario) return;
    await db.runTransaction(async (tx) => {
      const actual = await tx.get(refProceso);
      if (actual.data()?.propietario === propietario && actual.data()?.estado === 'procesando') tx.delete(refProceso);
    });
  };
  try {
    // 1. Solo usuarios con sesión iniciada
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const { uid } = await admin.auth().verifyIdToken(token);

    const { reporteId } = req.body || {};
    if (!reporteId || typeof reporteId !== 'string') {
      return res.status(400).json({ error: 'Falta el reporte' });
    }

    db = admin.firestore();
    const refNuevo = db.collection('reportes').doc(reporteId);
    const docNuevo = await refNuevo.get();
    if (!docNuevo.exists) return res.status(404).json({ error: 'El reporte no existe' });
    const nuevo = { id: docNuevo.id, ...docNuevo.data() };

    // 2. Solo el autor del reporte puede disparar el análisis (evita abusos)
    if (nuevo.autorId !== uid) return res.status(403).json({ error: 'No autorizado' });
    if (nuevo.estado === 'Reunida' || nuevo.estado === 'Vencida') return res.json({ notificadas: 0, inactivo: true });
    if (typeof nuevo.foto !== 'string' || !nuevo.foto.includes('base64,')) {
      return res.json({ notificadas: 0 });
    }

    // Reserva temporal: solo un análisis simultáneo. Un proceso interrumpido vence en 2 min.
    refProceso = db.collection('procesados').doc(reporteId);
    propietario = randomUUID();
    const reserva = await db.runTransaction(async (tx) => {
      const doc = await tx.get(refProceso);
      const previo = doc.data();
      if (previo?.estado === 'completado') return 'completado';
      if (previo?.estado === 'procesando' && previo.venceEn > Date.now()) return 'ocupado';
      // Los marcadores antiguos no demostraban éxito: se permite recuperarlos.
      tx.set(refProceso, { estado: 'procesando', propietario, venceEn: Date.now() + 120000 });
      return 'reservado';
    });
    if (reserva === 'completado') return res.json({ notificadas: 0, yaProcesado: true });
    if (reserva === 'ocupado') return res.status(409).json({ error: 'El reporte ya se está analizando', enProceso: true });

    // Avisos y marca de éxito se guardan juntos, sin sobrescribir avisos existentes.
    const finalizar = async (avisos) => db.runTransaction(async (tx) => {
      const actual = await tx.get(refProceso);
      if (actual.data()?.propietario !== propietario) throw new Error('Reserva vencida');
      const existentes = [];
      for (const aviso of avisos) existentes.push(await tx.get(aviso.ref));
      let creadas = 0;
      avisos.forEach((aviso, i) => {
        if (!existentes[i].exists) { tx.set(aviso.ref, aviso.datos); creadas++; }
      });
      tx.set(refProceso, { estado: 'completado', creado: admin.firestore.FieldValue.serverTimestamp(), notificadas: creadas });
      return creadas;
    });

    // 4. Candidatos: reportes activos del tipo contrario, de otras personas
    const tipoContrario = nuevo.tipo === 'Perdida' ? 'Encontrada' : 'Perdida';
    const snap = await db.collection('reportes').orderBy('creado', 'desc').limit(60).get();
    const candidatos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter(
        (r) =>
          r.id !== nuevo.id &&
          r.tipo === tipoContrario &&
          r.autorId &&
          r.autorId !== uid &&
          r.estado !== 'Reunida' &&
          r.estado !== 'Vencida' &&
          typeof r.foto === 'string' &&
          r.foto.includes('base64,')
      )
      .slice(0, MAX_CANDIDATOS);

    console.log('Candidatos para notificar:', candidatos.length);
    if (candidatos.length === 0) { await finalizar([]); return res.json({ notificadas: 0 }); }

    // 5. Mensaje para la IA
    const foto = prepararImagen(nuevo.foto);
    const especieNuevo = nuevo.especie === 'Otro' && nuevo.especieOtro ? nuevo.especieOtro : nuevo.especie;
    const partes = [
      {
        text:
          `REPORTE NUEVO (${nuevo.tipo === 'Perdida' ? 'mascota perdida' : 'mascota encontrada'}): ` +
          `${especieNuevo}, ${nuevo.raza}. Descripción: ${nuevo.descripcion || 'sin descripción'}`,
      },
      { inline_data: { mime_type: foto.mime, data: foto.b64 } },
    ];
    candidatos.forEach((c, i) => {
      const f = prepararImagen(c.foto);
      const especie = c.especie === 'Otro' && c.especieOtro ? c.especieOtro : c.especie;
      partes.push({
        text:
          `REPORTE ${i + 1} (${c.tipo === 'Perdida' ? 'mascota perdida' : 'mascota encontrada'}) | ` +
          `${especie}, ${c.raza}. Descripción: ${c.descripcion || 'sin descripción'}`,
      });
      partes.push({ inline_data: { mime_type: f.mime, data: f.b64 } });
    });
    partes.push({
      text:
        'Decide cuáles reportes numerados muestran probablemente el MISMO animal que el REPORTE NUEVO. ' +
        'Fíjate en especie, raza, color, manchas, tamaño y rasgos distintivos. ' +
        'Si la especie no coincide, descarta el reporte. ' +
        'Responde SOLO con JSON con este formato: ' +
        '{"coincidencias":[{"numero":1,"similitud":0-100,"motivo":"una frase corta en español"}]}. ' +
        `Incluye solo similitud >= ${SIMILITUD_MINIMA}. Si ninguna se parece, devuelve {"coincidencias":[]}.`,
    });

    const respuesta = await consultarGemini(JSON.stringify({
      contents: [{ role: 'user', parts: partes }],
      generationConfig: { responseMimeType: 'application/json' },
    }));
    if (!respuesta.ok) {
      await liberar();
      console.error('Gemini notificaciones: error', respuesta.status);
      const temporal = ESTADOS_TEMPORALES.has(respuesta.status);
      return res.status(respuesta.status === 429 ? 429 : temporal ? 503 : 502).json({
        error: respuesta.status === 429 ? 'Límite de IA alcanzado. Intenta más tarde.' : temporal ? MENSAJE_OCUPADO : 'No se pudo consultar el servicio de IA',
      });
    }
    const data = JSON.parse(respuesta.texto);
    const texto = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const json = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1));

    // 6. Crear un aviso por cada coincidencia (id fijo: nunca se duplica)
    if (!Array.isArray(json.coincidencias)) throw new Error('Respuesta de IA inválida');
    const avisos = new Map();
    for (const c of json.coincidencias || []) {
      const rep = candidatos[Number(c.numero) - 1];
      const similitud = Math.round(Number(c.similitud) || 0);
      if (!rep || !Number.isFinite(similitud) || similitud < SIMILITUD_MINIMA || similitud > 100) continue;
      avisos.set(rep.id, { ref: db.collection('notificaciones').doc(`${nuevo.id}_${rep.id}`), datos: {
        paraUid: rep.autorId,
        tuReporteId: rep.id,
        tuReporteNombre: rep.nombre || '',
        reporteNuevoId: nuevo.id,
        reporteNuevoNombre: nuevo.nombre || '',
        reporteNuevoTipo: nuevo.tipo,
        similitud,
        motivo: String(c.motivo || '').slice(0, 200),
        leida: false,
        creado: admin.firestore.FieldValue.serverTimestamp(),
      }});
    }
    const notificadas = await finalizar([...avisos.values()]);
    console.log('Notificaciones completadas:', { reporteId, notificadas });

    return res.json({ notificadas });
  } catch (e) {
    try { await liberar(); } catch (limpiezaError) { console.error('No se pudo liberar la reserva; vencerá automáticamente'); }
    console.error('Fallo en notificaciones:', e.message);
    return res.status(500).json({ error: 'No se pudo analizar el reporte' });
  }
};