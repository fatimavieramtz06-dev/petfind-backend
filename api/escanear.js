const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const MODELO = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const URL_GEMINI = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;
const MAX_CANDIDATOS = 8;

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

// Quita el prefijo "data:image/...;base64," si viene incluido y adivina el tipo de imagen
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

  try {
    // 1. Solo usuarios con sesión iniciada pueden usar el escáner
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    await admin.auth().verifyIdToken(token);

    const { imagen } = req.body || {};
    if (!imagen) return res.status(400).json({ error: 'Falta la imagen' });
    const escaneada = prepararImagen(imagen);

    // 2. Reportes activos más recientes (perdidos y encontrados)
    const snap = await admin
      .firestore()
      .collection('reportes')
      .orderBy('creado', 'desc')
      .limit(40)
      .get();

    const candidatos = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((r) => r.estado !== 'Reunida' && r.estado !== 'Vencida' && typeof r.foto === 'string' && r.foto.includes('base64,'))
      .slice(0, MAX_CANDIDATOS);

    console.log('Reportes comparados:', candidatos.length);
    if (candidatos.length === 0) return res.json({ coincidencias: [], comparados: 0 });

    // 3. Mensaje para la IA: los reportes se numeran (1, 2, 3...) para evitar errores con los id
    const partes = [
      { text: 'FOTO ESCANEADA (mascota vista en la calle o foto de referencia):' },
      { inline_data: { mime_type: escaneada.mime, data: escaneada.b64 } },
    ];
    candidatos.forEach((c, i) => {
      const foto = prepararImagen(c.foto);
      const especie = c.especie === 'Otro' && c.especieOtro ? c.especieOtro : c.especie;
      partes.push({
        text:
          `REPORTE ${i + 1} (${c.tipo === 'Perdida' ? 'mascota perdida' : 'mascota encontrada'}) | ` +
          `${especie}, ${c.raza}. Descripción: ${c.descripcion || 'sin descripción'}`,
      });
      partes.push({ inline_data: { mime_type: foto.mime, data: foto.b64 } });
    });
    partes.push({
      text:
        'Decide cuáles reportes muestran probablemente el MISMO animal que la foto escaneada. ' +
        'Fíjate en especie, raza, color, manchas, tamaño y rasgos distintivos. ' +
        'Si la foto escaneada es idéntica o casi idéntica a la de un reporte, la similitud debe estar entre 95 y 100. ' +
        'Si la especie no coincide, descarta el reporte. ' +
        'Responde SOLO con JSON con este formato: ' +
        '{"coincidencias":[{"numero":1,"similitud":0-100,"motivo":"una frase corta en español"}]}. ' +
        'Incluye solo similitud >= 40, ordenadas de mayor a menor. Si ninguna se parece, devuelve {"coincidencias":[]}.',
    });

    // 4. Consultar a Gemini
    const respuesta = await consultarGemini(JSON.stringify({
      contents: [{ role: 'user', parts: partes }],
      generationConfig: { responseMimeType: 'application/json' },
    }));

    if (respuesta.status === 429) {
      return res.status(429).json({ error: 'Límite gratuito alcanzado, intenta en un minuto' });
    }
    if (ESTADOS_TEMPORALES.has(respuesta.status)) {
      return res.status(503).json({ error: MENSAJE_OCUPADO });
    }
    if (!respuesta.ok) {
      console.error('Gemini error', respuesta.status);
      return res.status(502).json({ error: 'Error del servicio de IA' });
    }

    const data = JSON.parse(respuesta.texto);
    const texto = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    console.log('Respuesta de Gemini:', texto.slice(0, 600));

    const json = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1));

    // 5. Convertir los números a id reales de reporte
    const coincidencias = (json.coincidencias || [])
      .map((c) => {
        const rep = candidatos[Number(c.numero) - 1];
        return rep ? { id: rep.id, similitud: Number(c.similitud) || 0, motivo: c.motivo || '' } : null;
      })
      .filter(Boolean);

    return res.json({ coincidencias, comparados: candidatos.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'No se pudo analizar la foto' });
  }
};