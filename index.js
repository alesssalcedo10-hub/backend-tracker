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

// Guardar ubicación desde el celular
app.post('/api/ubicacion', async (req, res) => {
  const { dispositivo_id, latitud, longitud, fecha_hora } = req.body;

  if (!dispositivo_id || !latitud || !longitud) {
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
    res.status(201).json({ status: 'OK' });
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
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
