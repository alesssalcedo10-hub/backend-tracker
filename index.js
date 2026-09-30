const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Pagina publica para compartir la ubicacion de Aless.
app.get(['/','/monitor','/monitor/'], (_req,res) => {
  res.set('Cache-Control','no-store');
  res.sendFile(require('path').join(__dirname,'monitor.html'));
});
app.get('/config', (_req,res) => {
  const token = process.env.MAPBOX_PUBLIC_TOKEN || '';
  res.json({mapboxToken: token.startsWith('pk.') ? token : ''});
});

// Se conecta a la BD mediante la variable de entorno DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Requerido para Supabase
});


// Una zona por dispositivo. Los eventos quedan guardados aunque se cierre la app.
let schemaPromise;
function prepararGeocercas() {
  if (!schemaPromise) schemaPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS geocercas (
      dispositivo_id TEXT PRIMARY KEY, nombre TEXT NOT NULL,
      latitud DOUBLE PRECISION NOT NULL, longitud DOUBLE PRECISION NOT NULL,
      radio DOUBLE PRECISION NOT NULL CHECK (radio BETWEEN 50 AND 2000),
      estado TEXT NOT NULL DEFAULT 'pendiente', candidato TEXT,
      confirmaciones INTEGER NOT NULL DEFAULT 0, ultima_muestra TIMESTAMPTZ,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS eventos_geocerca (
      id BIGSERIAL PRIMARY KEY, dispositivo_id TEXT NOT NULL, nombre TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida')),
      fecha_hora TIMESTAMPTZ NOT NULL, latitud DOUBLE PRECISION NOT NULL,
      longitud DOUBLE PRECISION NOT NULL, radio DOUBLE PRECISION NOT NULL,
      centro_latitud DOUBLE PRECISION NOT NULL, centro_longitud DOUBLE PRECISION NOT NULL
    );
    CREATE INDEX IF NOT EXISTS eventos_geocerca_dispositivo_fecha
      ON eventos_geocerca(dispositivo_id, fecha_hora DESC);
  `).catch(error => { schemaPromise = null; throw error; });
  return schemaPromise;
}
function distanciaMetros(lat1,lng1,lat2,lng2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2-lat1)*rad/2)**2 + Math.cos(lat1*rad)*Math.cos(lat2*rad)*Math.sin((lng2-lng1)*rad/2)**2;
  return 6371000*2*Math.atan2(Math.sqrt(Math.min(1,a)),Math.sqrt(Math.max(0,1-a)));
}
function clasificarZona(distancia,radio,precision) {
  if(typeof precision !== 'number' || !Number.isFinite(precision) || precision < 0 || precision > 100) return null;
  const margen=Math.max(10,precision);
  if(distancia+margen < radio) return 'dentro';
  if(distancia-margen > radio) return 'fuera';
  return null; // Cerca del borde no cambiamos el estado.
}
function validarZona(p) {
  return p && typeof p.nombre==='string' && p.nombre.trim().length>0 && p.nombre.trim().length<=40 &&
    typeof p.latitud==='number' && Number.isFinite(p.latitud) && Math.abs(p.latitud)<=90 &&
    typeof p.longitud==='number' && Number.isFinite(p.longitud) && Math.abs(p.longitud)<=180 &&
    typeof p.radio==='number' && Number.isFinite(p.radio) && p.radio>=50 && p.radio<=2000;
}
app.get('/api/geocerca/:dispositivo',async(req,res)=>{
  try {
    await prepararGeocercas();
    const zona=await pool.query('SELECT nombre,latitud,longitud,radio,estado,actualizado_en FROM geocercas WHERE dispositivo_id=$1',[req.params.dispositivo]);
    const eventos=await pool.query('SELECT id,nombre,tipo,fecha_hora FROM eventos_geocerca WHERE dispositivo_id=$1 ORDER BY fecha_hora DESC,id DESC LIMIT 20',[req.params.dispositivo]);
    res.set('Cache-Control','no-store').json({zona:zona.rows[0]||null,eventos:eventos.rows});
  } catch(error) { console.error('Consultar geocerca:',error.code||error.name);res.status(503).json({error:'Geocercas temporalmente no disponibles'}); }
});
app.put('/api/geocerca/:dispositivo',async(req,res)=>{
  const p=req.body, dispositivo=req.params.dispositivo;
  if(!validarZona(p)||!/^[A-Za-z0-9_-]{1,80}$/.test(dispositivo))return res.status(400).json({error:'Nombre, coordenadas o radio inválidos'});
  try {
    await prepararGeocercas();
    const r=await pool.query(`INSERT INTO geocercas(dispositivo_id,nombre,latitud,longitud,radio)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(dispositivo_id) DO UPDATE SET
      nombre=EXCLUDED.nombre,latitud=EXCLUDED.latitud,longitud=EXCLUDED.longitud,radio=EXCLUDED.radio,
      estado='pendiente',candidato=NULL,confirmaciones=0,ultima_muestra=NULL,actualizado_en=NOW()
      RETURNING nombre,latitud,longitud,radio,estado,actualizado_en`,[dispositivo,p.nombre.trim(),p.latitud,p.longitud,p.radio]);
    res.json(r.rows[0]);
  } catch(error) { console.error('Guardar geocerca:',error.code||error.name);res.status(503).json({error:'No se pudo guardar la geocerca'}); }
});
async function evaluarGeocerca(p) {
  const fecha=new Date(p.fecha_hora), ahora=Date.now();
  if(!Number.isFinite(fecha.getTime()) || ahora-fecha.getTime()>120000 || fecha.getTime()>ahora+30000) return;
  await prepararGeocercas();
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    const r=await db.query('SELECT * FROM geocercas WHERE dispositivo_id=$1 FOR UPDATE',[p.dispositivo_id]);
    const zona=r.rows[0];
    if(!zona) { await db.query('COMMIT'); return; }
    const anterior=zona.ultima_muestra ? new Date(zona.ultima_muestra).getTime() : null;
    if(anterior!==null && fecha.getTime()-anterior<5000) { await db.query('COMMIT'); return; }
    const distancia=distanciaMetros(zona.latitud,zona.longitud,p.latitud,p.longitud);
    const candidato=clasificarZona(distancia,zona.radio,p.precision);
    const seguido=anterior!==null && fecha.getTime()-anterior<=120000;
    const cantidad=candidato ? (seguido && candidato===zona.candidato ? zona.confirmaciones+1 : 1) : 0;
    let estado=zona.estado;
    if(candidato && cantidad>=2 && candidato!==estado) {
      if(estado!=='pendiente') await db.query(`INSERT INTO eventos_geocerca
        (dispositivo_id,nombre,tipo,fecha_hora,latitud,longitud,radio,centro_latitud,centro_longitud)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[p.dispositivo_id,zona.nombre,candidato==='dentro'?'entrada':'salida',fecha,p.latitud,p.longitud,zona.radio,zona.latitud,zona.longitud]);
      estado=candidato;
    }
    await db.query('UPDATE geocercas SET estado=$2,candidato=$3,confirmaciones=$4,ultima_muestra=$5 WHERE dispositivo_id=$1',[p.dispositivo_id,estado,candidato,Math.min(cantidad,2),fecha]);
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK');throw error; }
  finally { db.release(); }
}


// Guardar ubicación desde el celular
app.post('/api/ubicacion', async (req, res) => {
  const { dispositivo_id, latitud, longitud, fecha_hora } = req.body;

  if (typeof dispositivo_id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(dispositivo_id) || typeof latitud !== 'number' || typeof longitud !== 'number' || !Number.isFinite(latitud) || !Number.isFinite(longitud) || Math.abs(latitud)>90 || Math.abs(longitud)>180 || (fecha_hora && !Number.isFinite(Date.parse(fecha_hora)))) {
    return res.status(400).json({ error: 'Faltan parámetros' });
  }

  try {
    const query = `
      INSERT INTO ubicaciones (dispositivo_id, latitud, longitud, fecha_hora, geom)
      VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($3, $2), 4326))
      RETURNING id;
    `;
    const values = [dispositivo_id, latitud, longitud, fecha_hora || new Date()];
    await pool.query(query, values);
    let geocerca_actualizada = true;
    try { await evaluarGeocerca({...req.body,fecha_hora:values[3]}); }
    catch(error) { geocerca_actualizada=false;console.error('Evaluar geocerca:',error.code||error.name); }
    res.status(201).json({ status: 'OK', geocerca_actualizada });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno en la base de datos' });
  }
});

// Obtener última ubicación para la App Web
app.get('/api/ubicacion/:dispositivo_id/ultima', async (req, res) => {
  const { dispositivo_id } = req.params;

  try {
    const query = `
      SELECT dispositivo_id, latitud, longitud, fecha_hora
      FROM ubicaciones
      WHERE dispositivo_id = $1
      ORDER BY fecha_hora DESC
      LIMIT 1;
    `;
    const result = await pool.query(query, [dispositivo_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dispositivo no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

const PORT = process.env.PORT || 3000;
if(require.main===module) app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));

module.exports={app,pool,clasificarZona,distanciaMetros,validarZona};
