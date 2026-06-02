import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import mqtt from 'mqtt';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// App Store Upload Route
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

// Yoto Player Audio Stream Route
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  const { playerId } = req.params;
  try {
    let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [playerId]);
    if (sessionRes.rows.length === 0) {
      sessionRes = await pool.query('INSERT INTO active_sessions (yoto_player_id) VALUES ($1) RETURNING *', [playerId]);
    }
    const session = sessionRes.rows[0];

    if (session.current_app_id) {
      const appRes = await pool.query('SELECT * FROM developer_apps WHERE id = $1', [session.current_app_id]);
      const currentApp = appRes.rows[0];
      const logic = currentApp.json_logic;
      const currentState = logic.states[session.current_state_name || 'welcome'];
      return res.redirect(`https://yourtts.com{encodeURIComponent(currentState.audio_prompt)}`);
    }
    res.redirect('https://yourstorage.com');
  } catch (err) {
    res.status(500).send("Audio engine processing failure");
  }
});

// OAuth Callback Route
app.post('/api/yoto/callback', async (req, res) => {
  const { authCode } = req.body;
  try {
    const tokenResponse = await fetch('https://yoto.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: process.env.YOTO_CLIENT_ID,
        client_secret: process.env.YOTO_CLIENT_SECRET,
        redirect_uri: `https://${req.headers.host}/callback.html`
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokens.error_description || 'Token trade failed');

    const playerResponse = await fetch('https://yoto.dev', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id;

    if (!targetPlayerId) return res.status(400).json({ error: "No player found." });

    await pool.query(`
      INSERT INTO active_sessions (yoto_player_id) VALUES ($1)
      ON CONFLICT (yoto_player_id) DO NOTHING;
    `, [targetPlayerId]);

    res.json({ success: true, playerId: targetPlayerId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Engine running on port ${PORT}`));
