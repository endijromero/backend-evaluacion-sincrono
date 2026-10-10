const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'sistema_pagos_idempotente',
  user: 'postgres',
  password: '123456789'
});

// Endpoint para crear una tarjeta (Demuestra Idempotencia)
app.post('/cards', async (req, res) => {
  const idempotencyKey = req.headers['x-idempotency-key'];
  
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'Se requiere la cabecera x-idempotency-key' });
  }

  try {
    // Iniciar transacción
    await pool.query('BEGIN');

    // Comprobar si la clave ya existe
    const keyCheck = await pool.query('SELECT * FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
    
    if (keyCheck.rows.length > 0) {
      await pool.query('ROLLBACK');
      const cached = keyCheck.rows[0];
      return res.status(cached.status_code).json(cached.response_body);
    }

    // Simular un fallo aleatorio (ej. 503 Service Unavailable) para forzar reintentos en el cliente
    // Esto es para demostrar el Backoff Exponencial y Jitter en el frontend
    if (Math.random() < 0.3) {
      await pool.query('ROLLBACK');
      return res.status(503).json({ error: 'Servicio no disponible temporalmente' });
    }

    const { card_number } = req.body;
    if (!card_number) {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error: 'card_number es requerido' });
    }

    // Crear la tarjeta (Operación Atómica dentro de la transacción)
    const cardResult = await pool.query(
      'INSERT INTO cards (card_number) VALUES ($1) RETURNING *',
      [card_number]
    );

    const newCard = cardResult.rows[0];
    const responseBody = { message: 'Tarjeta creada exitosamente', card: newCard };

    // Guardar la respuesta con la clave de idempotencia
    await pool.query(
      'INSERT INTO idempotency_keys (key, status_code, response_body) VALUES ($1, $2, $3)',
      [idempotencyKey, 201, responseBody]
    );

    await pool.query('COMMIT');
    res.status(201).json(responseBody);

  } catch (error) {
    await pool.query('ROLLBACK');
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Endpoint para actualizar el balance (Demuestra Bloqueo Optimista / ETags)
app.put('/cards/:id/balance', async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  const ifMatch = req.headers['if-match']; // Usamos versionado simple como ETag

  if (!ifMatch) {
    return res.status(400).json({ error: 'Se requiere la cabecera If-Match' });
  }

  try {
    // Obtener la tarjeta actual
    const cardResult = await pool.query('SELECT * FROM cards WHERE id = $1', [id]);
    
    if (cardResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tarjeta no encontrada' });
    }

    const card = cardResult.rows[0];

    // Verificar ETag (version)
    if (card.version.toString() !== ifMatch) {
      return res.status(412).json({ error: 'Precondition Failed: El recurso ha sido modificado por otro cliente.' });
    }

    // Actualizar el balance y la versión (Bloqueo Optimista)
    const updateResult = await pool.query(
      'UPDATE cards SET balance = balance + $1, version = version + 1 WHERE id = $2 AND version = $3 RETURNING *',
      [amount, id, ifMatch]
    );

    if (updateResult.rows.length === 0) {
      // Esto ocurriría si otro proceso actualizó la fila justo después de nuestro SELECT
      return res.status(412).json({ error: 'Precondition Failed: Conflicto de actualización concurrente.' });
    }

    const updatedCard = updateResult.rows[0];
    
    // Devolvemos el nuevo ETag
    res.setHeader('ETag', updatedCard.version.toString());
    res.status(200).json({ message: 'Balance actualizado', card: updatedCard });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Obtener detalles de la tarjeta (Demuestra método seguro e idempotente GET)
app.get('/cards/:id', async (req, res) => {
    try {
        const cardResult = await pool.query('SELECT * FROM cards WHERE id = $1', [req.params.id]);
        if (cardResult.rows.length === 0) {
            return res.status(404).json({ error: 'Tarjeta no encontrada' });
        }
        const card = cardResult.rows[0];
        res.setHeader('ETag', card.version.toString());
        res.json(card);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error interno' });
    }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Backend escuchando en http://localhost:${PORT}`);
});
