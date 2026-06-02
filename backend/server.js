import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

// Initialize connection pool to Neon DB using the secret environment variable
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ROUTE 1: The Dev Portal submission link for your website
app.post('/api/apps/upload', async (req, res) => {
  try {
    const { appName, iconIdentifier, jsonLogic } = req.body;
    
    const query = `
      INSERT INTO developer_apps (app_name, icon_identifier, json_logic) 
      VALUES ($1, $2, $3) 
      RETURNING *;
    `;
    
    const result = await pool.query(query, [appName, iconIdentifier, JSON.stringify(jsonLogic)]);
    res.status(201).json({ message: "🚀 Upload successful!", app: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROUTE 2: Dynamic Live Audio Engine mapped to a physical card
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  const { playerId } = req.params;
  try {
    // Look up or initialize the child's session
    let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [playerId]);
    
    if (sessionRes.rows.length === 0) {
      const createSession = await pool.query('INSERT INTO active_sessions (yoto_player_id) VALUES ($1) RETURNING *', [playerId]);
      sessionRes = createSession;
    }
    
    const session = sessionRes.rows[0];

    if (session.current_app_id) {
      const appRes = await pool.query('SELECT * FROM developer_apps WHERE id = $1', [session.current_app_id]);
      const currentApp = appRes.rows[0];
      const logic = currentApp.json_logic;
      const currentState = logic.states[session.current_state_name || 'welcome'];

      // Dynamically send words to a Text-to-Speech API
      return res.redirect(`https://yourtts.com{encodeURIComponent(currentState.audio_prompt)}`);
    }

    res.redirect('https://yourstorage.com');
  } catch (err) {
    res.status(500).send("Audio engine processing failure");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Yoto App Engine running on port ${PORT}`));
