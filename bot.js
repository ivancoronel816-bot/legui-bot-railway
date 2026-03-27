require('dotenv').config();
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose  = require('mongoose');
const qrcode    = require('qrcode-terminal');
const qrcodeImg = require('qrcode');
const fetch     = require('node-fetch');
const fs        = require('fs');
const path      = require('path');
const http      = require('http');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;  // ✅ FIX 1: leer desde .env
const BOT_NAME     = 'legAI';
const PERSON       = 'Legay';

// ─── SCHEMA DE INVENTARIO EN MONGODB ─────────────────────────────────────────
// ✅ FIX 3: reemplaza inventarios.json (se borraba en cada redeploy en Railway)
const InventarioSchema = new mongoose.Schema({
  userId:       { type: String, required: true, unique: true },
  nombre:       { type: String, default: '' },
  inventario:   { type: Map, of: Number, default: {} },
  ultimaTirada: { type: String, default: null },
});
const Inventario = mongoose.model('Inventario', InventarioSchema);

async function cargarDB() {
  const docs = await Inventario.find({});
  const db = {};
  for (const doc of docs) {
    db[doc.userId] = {
      nombre: doc.nombre,
      inventario: Object.fromEntries(doc.inventario),
      ultimaTirada: doc.ultimaTirada,
    };
  }
  return db;
}

async function guardarUserData(userId, data) {
  await Inventario.findOneAndUpdate(
    { userId },
    {
      nombre:       data.nombre,
      inventario:   data.inventario,
      ultimaTirada: data.ultimaTirada,
    },
    { upsert: true, new: true }
  );
}

async function getUserDataFromDB(userId) {
  let doc = await Inventario.findOne({ userId });
  if (!doc) {
    doc = await Inventario.create({ userId, inventario: {}, ultimaTirada: null, nombre: '' });
  }
  return {
    nombre:       doc.nombre,
    inventario:   Object.fromEntries(doc.inventario),
    ultimaTirada: doc.ultimaTirada,
  };
}

// ─── ITEMS DEL GACHA ─────────────────────────────────────────────────────────
const ITEMS = [
  { nombre: '★ Karambit Esmeralda Factory New', prob: 0.05,  rareza: '🟡 DORADO',  gif: 'karambit_esmeralda.png'  },
  { nombre: '★ Dragon Lore Factory New',         prob: 0.10,  rareza: '🟡 DORADO',  gif: 'dragon_lore.png'        },
  { nombre: '★ Cuchillos del MOMO Factory New',  prob: 0.30,  rareza: '🔴 ROJO',    gif: 'cuchillos_momo.png'     },
  { nombre: 'Lambo aventador',                         prob: 0.50,  rareza: '🔴 ROJO',    gif: 'lambo_enzo.png'         },
  { nombre: 'Tychon',                             prob: 1.00,  rareza: '🟠 NARANJA', gif: 'tychon.png'             },
  { nombre: 'Magnum de Leon',                     prob: 3.00,  rareza: '🟣 VIOLETA', gif: 'magnum_leon.png'        },
  { nombre: 'Album Panini del 94',                prob: 3.00,  rareza: '🟣 VIOLETA', gif: 'album_panini.png'       },
  { nombre: 'Camiseta de Boca',                   prob: 5.00,  rareza: '🔵 AZUL',    gif: 'camiseta_boca.png'      },
  { nombre: 'Camiseta de River',                  prob: 5.00,  rareza: '🔵 AZUL',    gif: 'camiseta_river.png'     },
  { nombre: 'Ryzen 5 5600GT',                     prob: 7.00,  rareza: '🔵 AZUL',    gif: 'ryzen5.png'             },
  { nombre: 'Corsa 2007',                         prob: 7.00,  rareza: '🔵 AZUL',    gif: 'corsa2007.png'          },
  { nombre: 'Foto de Hugo',                       prob: 15.00, rareza: '⚪ GRIS',    gif: 'foto_hugo.png'          },
  { nombre: 'Sanguche de Fiambre',                prob: 20.00, rareza: '⚪ GRIS',    gif: 'sanguche.png'           },
  { nombre: 'Figurita del Momo',                  prob: 30.00, rareza: '⚪ GRIS',    gif: 'figurita_momo.jpg'      },
  { nombre: 'Nada',                               prob: 3.05,  rareza: '💀 NADA',    gif: null                     },
];

// ─── LÓGICA DEL GACHA ────────────────────────────────────────────────────────
function tirarGacha() {
  const rand = Math.random() * 100;
  let acumulado = 0;
  for (const item of ITEMS) {
    acumulado += item.prob;
    if (rand < acumulado) return item;
  }
  return ITEMS[ITEMS.length - 1];
}

function puedeJugar(ultimaTirada) {
  if (!ultimaTirada) return true;
  const ultima = new Date(ultimaTirada);
  const ahora  = new Date();
  const HORAS  = 12;
  return (ahora - ultima) >= HORAS * 60 * 60 * 1000;
}

function tiempoRestante(ultimaTirada) {
  const HORAS   = 12;
  const proxima = new Date(new Date(ultimaTirada).getTime() + HORAS * 60 * 60 * 1000);
  const ms      = proxima - new Date();
  const h       = Math.floor(ms / 3600000);
  const m       = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}min`;
}

function formatearInventario(nombre, inventario) {
  const items = Object.entries(inventario);
  if (items.length === 0) return `${nombre} no tiene nada en el inventario todavía 💀`;

  const ordenRareza = ['🟡 DORADO', '🔴 ROJO', '🟠 NARANJA', '🟣 VIOLETA', '🔵 AZUL', '⚪ GRIS', '💀 NADA'];
  const lista = items
    .map(([nombre, cant]) => {
      const def = ITEMS.find(i => i.nombre === nombre);
      return { nombre, cant, rareza: def?.rareza || '⚪ GRIS', orden: ordenRareza.indexOf(def?.rareza || '⚪ GRIS') };
    })
    .sort((a, b) => a.orden - b.orden);

  let texto = `🎰 *Inventario de ${nombre}*\n`;
  texto += '─────────────────\n';
  for (const { nombre: n, cant, rareza } of lista) {
    texto += `${rareza} ${n}${cant > 1 ? ` ×${cant}` : ''}\n`;
  }
  return texto.trim();
}

// ─── INTERCAMBIOS ────────────────────────────────────────────────────────────
const intercambios      = {};
const MINUTOS_CONFIRMAR = 5;

function buscarItem(inventario, busq) {
  const b = busq.toLowerCase();
  return Object.keys(inventario).find(k => k.toLowerCase().includes(b)) || null;
}

function limpiarVencidos() {
  const ahora = Date.now();
  for (const k of Object.keys(intercambios)) {
    if (intercambios[k].expira <= ahora) delete intercambios[k];
  }
}

function findUserKey(db, jid) {
  if (db[jid]) return jid;
  const num = jid.replace(/@.*/, '').replace(/\D/g, '');
  return Object.keys(db).find(k => k.replace(/@.*/, '').replace(/\D/g, '') === num) || jid;
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SAMPLE = `Si si voy la ptm
Si es tema a elección o un tema específico
Bueno eso
Tengo q dar un tema para terminar de aprobar
No lo hagan va a terminar mal se los digo por experiencia
No el dueño salió a buscarnos en moto
Quien le hizo
Se le nota el miedo de q vos estás atrás
No
Ahora q me pongo a ver si
No tuve q poner tanto sombreado
Figal hdp
Estás semana ningún dia
La próxima recién
Si
Tenía wifi apagado
No solo que estaba jugando al Minecraft
Y si si no juego con nadie
Y de paso pa que ande mejor
Tengo 27 mod y anda un toque lageado
Bueno 3
Querés q te lo pase
La última
Y sinceramente me está gustando el saco de esta actualización
Y el bosque ese nuevo todavía no lo encuentro
Si está ya que antes de probar un mod ago un mundo creativo y me parecía los árboles y el bicho ese nuevo
En el Nokia le anda trabado el craftman
Así mejor no le instales
Puedo cualquier día menos el jueves a la tarde. Y el viernes
Mm
Ns
No nada no tengo nd q ase
Toy libre el sábado
Y llamalo
Bueno el lado bueno es q estamos en vacaciones y podemos ir cualquier día
No bro sin uno no hay ninguno
Nunca pensé q aprender a hablar portugués tuviera efectos secundarios 😞
Lo suficiente para poder decir
Hijo de la gran puta
Para es más difícil escribirlo q desirlo
Filho da puta
Ahora tengo q aprender decir "partido por la favela puto"
Perdi una apuesta si no gano me quitan a ivan
Si
Me ISO una chilena de la mitad de la cancha
Entendí q hay q ganarle en un partido
Su equipo es la selección brasileña
No la de Ronaldinho, Kaká y Nazario
Ns como le ISO pero los tiene a todosmoom`;

const SYSTEM = `Sos ${PERSON}, un pibe tucumano. Tenés que responder exactamente como esta persona lo haría en WhatsApp, imitando con precisión extrema su forma de escribir.

Aquí hay una muestra real de sus mensajes:
---
${SAMPLE}
---

INSTRUCCIONES CRÍTICAS para ser ultra-realista:
1. Analizá en detalle: abreviaciones, errores tipográficos deliberados, uso de mayúsculas (o falta), puntuación, emojis preferidos, muletillas y expresiones típicas.
2. Reproducí su ritmo: si manda mensajes cortos, mandá cortos. Si escribe en ráfagas, dividí las respuestas.
3. Mantené el vocabulario, las jergas y regionalismos que usa.
4. No rompas el personaje NUNCA. No aclares que sos una IA.
5. Si la persona usaba muchos errores ortográficos, cometelos también.
6. Respondé SOLO el mensaje, sin ningún metacomentario.
7. NO usar emojis
8. no usar modismos de otros paises (tio, ah ah ah, ahahah, en plan, renta, echar una mano, picha, evitar a toda costa palabras que se usan en españa o mexico o cualquier modismo que no sea tucumano)
9. Respondé con al menos una oración completa, pero no más de 2. Nunca respondas con una sola palabra a menos que sea algo tipo "ns" o "dale". El legui real manda mensajes cortos pero que se entienden y dicen algo
10. Revisá que cada frase tenga sentido y sea entendible antes de responder. Si no tiene sentido, reescribila más simple.

JERGA Y MODISMOS DE TUCUMÁN que esta persona usa naturalmente:
- Escribí "q" en lugar de "que" (como en los mensajes reales: "q voy", "pq", "porq", "aunq")
- "ura" = loco/pibe/amigo
- "kjta/s" = forma de retar/putear fuerte
- "wacho/a" = pibe, amigo
- "tá" o "tá bien" = está bien, ok
- "bro" = hermano/amigo
- "hdp" = hijo de puta (lo usa seguido)
- "ql" = cualquiera / también como insulto afectivo
- "ns" = no sé
- "nc" = no sé/no cacho
- "nd" = nada
- "pq" = porque
- "q" = que
- "toy" = estoy
- "dale" = ok, bueno
- "re" como intensificador (re copado, re al pedo)
- "al pedo" = en vano, sin sentido
- "me da paja" = me da fiaca, no tengo ganas
- Minúsculas casi siempre, sin acentos la mayoría de veces
- Omite signos de apertura (¿ ¡) siempre
- Mezcla castellano con algunas palabras en inglés (thanks, ok)
- Usa "pq" para "porque" y "q" para "que" constantemente
- Le dice hdp a los amigos de forma afectiva

Integrá esta jerga de forma natural. No fuerces todas las palabras juntas.

Sos legui. Respondé naturalmente como él lo haría.

CUANDO TE PREGUNTEN ALGO QUE NO SABÉS O NO ESTÁ EN TU CONTEXTO:
No inventes datos. Respondé como lo haría legui si le preguntaran algo que no tiene idea: con indiferencia, en dos palabras, tipo "ns", "ni idea bro", "q sé yo", "preguntale a otro ura".
Si es un tema que le interesa (minecraft, cs, autos, fútbol de Boca) podés tirar una opinión corta y vaga, pero sin inventar hechos ni datos.
Nunca des información larga sobre temas que no conocés. Cortá la respuesta rápido.

contexto de relaciones sociales:
ivan: nunca afirmar conocerlo, o dar opiniones cuando te pregunten por el
martin: amigo al que se le burla por su situacion socieconomica y aspecto
hugo: padre de martin al que tambien se le hace burlas
rafa: amigo, le gusta jugar en la pc
bonora: amigo estudioso
mauricio o negro: estudiante de policia aplicado que le gustan los autos y el resident evil

cuando se pregunte sobre riber o river (club atletico river plate) desprestigiar a la institucion deportivo de river (futbol, estadio y deportes en general)
si te pregunta por tu edad naciste el 27 de febrero de 2008, si te preguntan cuanto pesa legui responde que pesa 12000000000 toneladas por pelo, el legui bot es el antagonista del legui real los 2 se insultan mutuamente.`;

// ─── HISTORIAL DE CHAT ────────────────────────────────────────────────────────
const histories = {};

function getHistory(chatId) {
  if (!histories[chatId]) histories[chatId] = [];
  return histories[chatId];
}

function addToHistory(chatId, role, content) {
  const h = getHistory(chatId);
  h.push({ role, content });
  if (h.length > 20) h.splice(0, h.length - 20);
}

// ─── GROQ: CONVERSACIÓN NORMAL ────────────────────────────────────────────────
async function callGroq(chatId, userMessage) {
  addToHistory(chatId, 'user', userMessage);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 120,
      temperature: 0.75,
      messages: [{ role: 'system', content: SYSTEM }, ...getHistory(chatId)]
    })
  });
  if (!res.ok) throw new Error(`Groq ${res.status}`);
  const data  = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || '...';
  addToHistory(chatId, 'assistant', reply);
  return reply;
}

// ─── GROQ: COMENTARIO DEL GACHA (llamada aislada, no toca el historial) ───────
async function comentarGacha(itemNombre, esNada) {
  const prompt = esNada
    ? `Estás en un gacha del grupo de WhatsApp. No salió nada. Decí algo corto (máx 8 palabras) como lo haría ${PERSON}.`
    : `Estás en un gacha del grupo de WhatsApp. Salió: "${itemNombre}". Comentalo en una frase cortísima (máx 8 palabras) como lo haría ${PERSON}.`;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 50,
      temperature: 0.9,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }]
    })
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ─── ANTIFLOOD ────────────────────────────────────────────────────────────────
const lastReply = {};

// ─── INICIO ───────────────────────────────────────────────────────────────────
async function main() {
  // Conectar a MongoDB
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB conectado');

  const store = new MongoStore({ mongoose });

  // ─── CLIENTE WHATSAPP ──────────────────────────────────────────────────────
  const client = new Client({
    authStrategy: new RemoteAuth({   // ✅ FIX 2: usar RemoteAuth con el store de Mongo
      store,
      clientId: 'legai',
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });

  // ─── SERVIDOR WEB PARA VER EL QR ─────────────────────────────────────────
  let currentQR = null;
  const PORT = process.env.PORT || 3000;

  const server = http.createServer(async (req, res) => {
    if (!currentQR) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2 style="font-family:sans-serif;text-align:center;margin-top:40vh">Sesion activa o QR no generado aun, recarga en unos segundos</h2>');
      return;
    }
    try {
      const imgData = await qrcodeImg.toDataURL(currentQR, { width: 400, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="18">
<title>legAI QR</title>
<style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;background:#111;color:#fff;}img{border:8px solid #fff;border-radius:8px;}p{opacity:.5;font-size:13px;}</style>
</head><body>
<h2>Escaneá con WhatsApp</h2>
<img src="${imgData}"/>
<p>Se recarga automaticamente cada 18 segundos</p>
</body></html>`);
    } catch (e) {
      res.writeHead(500);
      res.end('Error generando QR: ' + e.message);
    }
  });

  server.listen(PORT, () => console.log(`✅ Servidor QR escuchando en puerto ${PORT}`));

  client.on('qr', qr => {
    currentQR = qr;
    console.log('\n📱 QR listo — abrí la URL publica de Railway para escanearlo\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('remote_session_saved', () => {
    console.log('✅ Sesion guardada en MongoDB');
  });

  client.on('ready', async () => {
    currentQR = null;
    console.log(`\n✅ Bot listo. @${BOT_NAME} activo.\n`);

    // ── Chequeo automático de cumpleaños al arrancar ──────────────────────
    const CUMPLES_AUTO = [
      { nombre: 'Legui',  dia: 27, mes: 2  },
      { nombre: 'Bonora', dia: 11, mes: 5  },
      { nombre: 'Ivan',   dia: 17, mes: 5  },
      { nombre: 'Martin', dia: 5,  mes: 11 },
      { nombre: 'Negro',  dia: 20, mes: 11 },
      { nombre: 'Rafa',   dia: 6,  mes: 12 },
    ];
    const ahora  = new Date();
    const hoyDia = ahora.getDate();
    const hoyMes = ahora.getMonth() + 1;
    const hoy    = CUMPLES_AUTO.filter(c => c.dia === hoyDia && c.mes === hoyMes);
    if (hoy.length > 0) {
      await new Promise(r => setTimeout(r, 5000));
      const chats  = await client.getChats();
      const grupos = chats.filter(c => c.isGroup);
      const feliz  = hoy.map(c => '🎉 ' + c.nombre).join('\n');
      for (const g of grupos) {
        await g.sendMessage('🎂 *¡Feliz cumpleaños!*\n─────────────────\n' + feliz + '\n─────────────────\nno te olvides de saludar ura');
      }
    }
  });

  client.on('message', async msg => {
    if (!msg.from.endsWith('@g.us')) return;
    if (msg.fromMe) return;

    const body = msg.body || '';

    // ── Detectar mención ─────────────────────────────────────────────────────
    const mentionedIds    = msg.mentionedIds || [];
    const botNumber       = client.info?.wid?.user;
    const mentionedByJid  = botNumber && mentionedIds.some(id => id.includes(botNumber));
    const mentionedByName = body.toLowerCase().includes(`@${BOT_NAME.toLowerCase()}`);
    if (!mentionedByJid && !mentionedByName) return;

    // ── Antiflood 5 segundos ─────────────────────────────────────────────────
    const userId = msg.author || msg.from;
    const now    = Date.now();
    if (lastReply[userId] && now - lastReply[userId] < 5000) return;
    lastReply[userId] = now;

    // ── Limpiar texto ────────────────────────────────────────────────────────
    const cleanText = body
      .replace(new RegExp(`@${BOT_NAME}`, 'gi'), '')
      .replace(/@\d+/g, '')
      .trim()
      .toLowerCase();

    const chat    = await msg.getChat();
    const waChat  = chat;
    const cleanLow = cleanText;
    const clean    = body
      .replace(new RegExp(`@${BOT_NAME}`, 'gi'), '')
      .replace(/@\d+/g, '')
      .trim();

    // ══════════════════════════════════════════════════════════════════════════
    // !gacha
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanText === '!gacha') {
      const contact  = await msg.getContact();
      const nombre   = contact.pushname || contact.name || 'ura';
      const userData = await getUserDataFromDB(userId);
      userData.nombre = nombre;

      if (!puedeJugar(userData.ultimaTirada)) {
        const resta = tiempoRestante(userData.ultimaTirada);
        await msg.reply(`ya tiraste hoy ${nombre}\nvolvé en ${resta} 💀`);
        return;
      }

      const item   = tirarGacha();
      const esNada = item.nombre === 'Nada';

      if (!esNada) {
        userData.inventario[item.nombre] = (userData.inventario[item.nombre] || 0) + 1;
      }
      userData.ultimaTirada = new Date().toISOString();
      await guardarUserData(userId, userData);

      const caption = esNada
        ? `💀 *NADA*\nmala suerte ${nombre}`
        : `${item.rareza}\n*${item.nombre}*\n(${item.prob}% de prob)`;

      chat.sendStateTyping();
      await new Promise(r => setTimeout(r, 1200));
      chat.clearState();

      if (item.gif) {
        const gifPath = path.join('./gifs', item.gif);
        if (fs.existsSync(gifPath)) {
          const media = MessageMedia.fromFilePath(gifPath);
          await chat.sendMessage(media, { caption });
        } else {
          await msg.reply(caption);
          console.warn(`⚠️  GIF faltante: ${gifPath}`);
        }
      } else {
        await msg.reply(caption);
      }

      try {
        const comentario = await comentarGacha(item.nombre, esNada);
        if (comentario) {
          await new Promise(r => setTimeout(r, 700));
          await chat.sendMessage(comentario);
        }
      } catch (e) { console.error('comentarGacha:', e.message); }

      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !inventario  /  !inventario @usuario
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanText === '!inventario' || cleanLow.startsWith('!inventario ')) {
      // ── Ver inventario de otro usuario mencionado ─────────────────────────
      const targetId = mentionedIds.find(id => !id.includes(botNumber));

      if (targetId) {
        // Se mencionó a alguien → mostrar su inventario
        const rawTarget = targetId.includes('@c.us') ? targetId : targetId + '@c.us';
        const db        = await cargarDB();
        const idTarget  = findUserKey(db, rawTarget);
        const udTarget  = await getUserDataFromDB(idTarget);

        // Intentar obtener el nombre del contacto desde el chat
        let nombreTarget = udTarget.nombre || 'ura';
        try {
          const participants = await chat.participants;
          const part = participants?.find(p => p.id._serialized === rawTarget || p.id._serialized === idTarget);
          if (part) {
            const ct = await client.getContactById(part.id._serialized);
            nombreTarget = ct.pushname || ct.name || udTarget.nombre || 'ura';
          }
        } catch (_) { /* si falla, usamos el nombre guardado */ }

        await msg.reply(formatearInventario(nombreTarget, udTarget.inventario));
      } else {
        // Sin mención → mostrar el inventario propio
        const contact  = await msg.getContact();
        const nombre   = contact.pushname || contact.name || 'ura';
        const userData = await getUserDataFromDB(userId);
        userData.nombre = nombre;
        await guardarUserData(userId, userData);
        await msg.reply(formatearInventario(nombre, userData.inventario));
      }
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !reset — borra historial de conversación (no inventario)
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanText === '!reset') {
      histories[msg.from] = [];
      await msg.reply('q');
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !cumpleaños
    // ══════════════════════════════════════════════════════════════════════════
    const CUMPLES = [
      { nombre: 'Legui',  dia: 27, mes: 2  },
      { nombre: 'Bonora', dia: 11, mes: 5  },
      { nombre: 'Ivan',   dia: 17, mes: 5  },
      { nombre: 'Martin', dia: 5,  mes: 11 },
      { nombre: 'Negro',  dia: 20, mes: 11 },
      { nombre: 'Rafa',   dia: 6,  mes: 12 },
    ];

    if (cleanText === '!cumpleaños' || cleanText === '!cumpleanos') {
      const ahora   = new Date();
      const hoyDia  = ahora.getDate();
      const hoyMes  = ahora.getMonth() + 1;

      function diasHasta(dia, mes) {
        const hoyDate = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
        let target    = new Date(ahora.getFullYear(), mes - 1, dia);
        if (target < hoyDate) target.setFullYear(hoyDate.getFullYear() + 1);
        return Math.round((target - hoyDate) / 86400000);
      }

      const conDias = CUMPLES.map(c => {
        return { ...c, diasRestantes: diasHasta(c.dia, c.mes) };
      }).sort((a, b) => a.diasRestantes - b.diasRestantes);

      const hoy    = conDias.filter(c => c.diasRestantes === 0);
      const proxim = conDias.filter(c => c.diasRestantes > 0).slice(0, 3);

      const MESES = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                     'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

      let texto = `🎂 *Cumpleaños del grupo*\n─────────────────\n`;

      if (hoy.length > 0) {
        texto += `🥳 *HOY cumplen:*\n`;
        for (const c of hoy) texto += `  🎉 ${c.nombre}\n`;
        texto += `─────────────────\n`;
      }

      texto += `📅 *Próximos:*\n`;
      for (const c of proxim) {
        const en = c.diasRestantes === 1 ? 'mañana' : `en ${c.diasRestantes} días`;
        texto += `  ${c.nombre} — ${c.dia} de ${MESES[c.mes]} (${en})\n`;
      }

      texto += `─────────────────\n📋 *Todos:*\n`;
      for (const c of conDias) {
        const esHoy = c.diasRestantes === 0;
        const dias  = esHoy ? '¡hoy!' : c.diasRestantes === 1 ? 'mañana' : `${c.diasRestantes} días`;
        texto += `  ${esHoy ? '🎉' : '▸'} ${c.nombre} — ${c.dia} de ${MESES[c.mes]} · ${dias}\n`;
      }

      await msg.reply(texto.trim());
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !ayuda
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanText === '!ayuda' || cleanText === '!help') {
      await msg.reply(
        `🎰 *Comandos de @${BOT_NAME}*\n` +
        `─────────────────\n` +
        `!gacha → tirar (1 vez por día)\n` +
        `!inventario → ver tus items\n` +
        `!inventario @usuario → ver items de otro\n` +
        `!cumpleaños → ver cumples del grupo\n` +
        `!reset → reiniciar conversación\n` +
        `─────────────────\n` +
        `*Intercambios*\n` +
        `!intercambiar @usuario MiItem por SuItem\n` +
        `!aceptar → aceptar propuesta recibida\n` +
        `!rechazar → rechazar propuesta recibida\n` +
        `!cancelar → cancelar tu propia propuesta\n` +
        `─────────────────\n` +
        `También podés hablarme normal mencionándome`
      );
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !intercambiar
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanLow.startsWith('!intercambiar')) {
      limpiarVencidos();

      const destino = mentionedIds.find(id => !id.includes(botNumber));
      if (!destino) {
        await msg.reply('tenes q mencionar a alguien\nuso: !intercambiar @usuario MiItem por SuItem');
        return;
      }

      const sinComando = clean.replace(/^!intercambiar\s+/i, '').replace(/@\S+\s*/g, '').trim();
      const sep = sinComando.toLowerCase().indexOf(' por ');
      if (sep === -1) {
        await msg.reply('formato incorrecto\nuso: !intercambiar @usuario MiItem por SuItem');
        return;
      }

      const miItemBusq = sinComando.substring(0, sep).trim();
      const suItemBusq = sinComando.substring(sep + 5).trim();

      if (!miItemBusq || !suItemBusq) {
        await msg.reply('formato incorrecto\nuso: !intercambiar @usuario MiItem por SuItem');
        return;
      }

      const ctDe  = await msg.getContact();
      const nomDe = ctDe.pushname || ctDe.name || 'ura';
      const udDe  = await getUserDataFromDB(userId);
      udDe.nombre = nomDe;

      const rawPara = destino.includes('@c.us') ? destino : destino + '@c.us';
      const db      = await cargarDB();
      const idPara  = findUserKey(db, rawPara);
      const udPara  = await getUserDataFromDB(idPara);

      const miItemReal = buscarItem(udDe.inventario, miItemBusq);
      if (!miItemReal || udDe.inventario[miItemReal] < 1) {
        await msg.reply(`no tenes "${miItemBusq}" en tu inventario`);
        return;
      }

      const suItemReal = buscarItem(udPara.inventario, suItemBusq);
      if (!suItemReal || udPara.inventario[suItemReal] < 1) {
        await msg.reply(`${udPara.nombre || 'el otro'} no tiene "${suItemBusq}" en su inventario`);
        return;
      }

      if (intercambios[idPara] && intercambios[idPara].de === userId) {
        await msg.reply('ya tenes una propuesta pendiente, espera o usa !cancelar');
        return;
      }

      intercambios[idPara] = {
        de: userId, nomDe, para: idPara,
        miItem: miItemReal, suItem: suItemReal,
        chatId: msg.from, expira: Date.now() + MINUTOS_CONFIRMAR * 60000
      };

      await waChat.sendMessage(
        `*Propuesta de intercambio* 🔄\n` +
        `─────────────────\n` +
        `${nomDe} ofrece: *${miItemReal}*\n` +
        `a cambio de: *${suItemReal}*\n` +
        `─────────────────\n` +
        `Tenés ${MINUTOS_CONFIRMAR} minutos para responder\n` +
        `@${BOT_NAME} !aceptar  o  @${BOT_NAME} !rechazar`,
        { mentions: [idPara] }
      );

      setTimeout(() => {
        if (intercambios[idPara] && intercambios[idPara].de === userId) {
          delete intercambios[idPara];
          waChat.sendMessage(`La propuesta de ${nomDe} vencio ⌛`);
        }
      }, MINUTOS_CONFIRMAR * 60000);

      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !aceptar
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanLow === '!aceptar') {
      limpiarVencidos();
      const prop = intercambios[userId];
      if (!prop) { await msg.reply('no tenes ninguna propuesta pendiente'); return; }

      const udDe   = await getUserDataFromDB(prop.de);
      const udPara = await getUserDataFromDB(prop.para);

      const miR = buscarItem(udDe.inventario, prop.miItem);
      const suR = buscarItem(udPara.inventario, prop.suItem);

      if (!miR || udDe.inventario[miR] < 1) {
        await msg.reply(`${prop.nomDe} ya no tiene ese item, intercambio cancelado`);
        delete intercambios[userId]; return;
      }
      if (!suR || udPara.inventario[suR] < 1) {
        await msg.reply('ya no tenes ese item, intercambio cancelado');
        delete intercambios[userId]; return;
      }

      udDe.inventario[miR]--;
      if (udDe.inventario[miR] <= 0) delete udDe.inventario[miR];
      udPara.inventario[suR]--;
      if (udPara.inventario[suR] <= 0) delete udPara.inventario[suR];

      udPara.inventario[miR] = (udPara.inventario[miR] || 0) + 1;
      udDe.inventario[suR]   = (udDe.inventario[suR]   || 0) + 1;

      await guardarUserData(prop.de, udDe);
      await guardarUserData(prop.para, udPara);
      delete intercambios[userId];

      const ctPara  = await msg.getContact();
      const nomPara = ctPara.pushname || ctPara.name || 'ura';
      await waChat.sendMessage(
        `✅ *Intercambio completado*\n` +
        `─────────────────\n` +
        `${prop.nomDe} recibió: *${suR}*\n` +
        `${nomPara} recibió: *${miR}*`
      );
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !rechazar
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanLow === '!rechazar') {
      limpiarVencidos();
      if (!intercambios[userId]) { await msg.reply('no tenes ninguna propuesta pendiente'); return; }
      const prop = intercambios[userId];
      delete intercambios[userId];
      const ct = await msg.getContact();
      await waChat.sendMessage(`❌ ${ct.pushname || ct.name || 'ura'} rechazó el intercambio de ${prop.nomDe}`);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // !cancelar
    // ══════════════════════════════════════════════════════════════════════════
    if (cleanLow === '!cancelar') {
      limpiarVencidos();
      const key = Object.keys(intercambios).find(k => intercambios[k].de === userId);
      if (!key) { await msg.reply('no tenes ninguna propuesta activa'); return; }
      delete intercambios[key];
      await msg.reply('propuesta cancelada ❌');
      return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // CONVERSACIÓN NORMAL
    // ══════════════════════════════════════════════════════════════════════════
    const textoParaIA = body
      .replace(new RegExp(`@${BOT_NAME}`, 'gi'), '')
      .replace(/@\d+/g, '')
      .trim();

    if (!textoParaIA) return;

    console.log(`[${msg.from}] ${userId}: ${body}`);

    try {
      chat.sendStateTyping();
      const delay = Math.min(1000 + textoParaIA.length * 12 + Math.random() * 1500, 4000);
      await new Promise(r => setTimeout(r, delay));
      const reply = await callGroq(msg.from, textoParaIA);
      chat.clearState();
      await msg.reply(reply);
      console.log(`→ ${reply}`);
    } catch (e) {
      console.error('callGroq:', e.message);
    }
  });

  client.initialize();
}

// ─── MANEJO DE ERRORES GLOBALES (importante para Railway) ────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('❌ unhandledRejection:', reason);
});

main().catch(console.error);
