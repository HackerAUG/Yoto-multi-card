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

/**
 * 📡 MQTT DIRECT SYSTEM LINK LOOP
 */
function startPlayerLiveSync(deviceId, accessToken) {
  const MQTT_URL = "wss://://amazonaws.com"; 
  const clientIdentifier = `DASH_${deviceId}_${Math.floor(Math.random() * 1000)}`;

  const client = mqtt.connect(MQTT_URL, {
    keepalive: 300,
    port: 443,
    protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: accessToken,
    clientId: clientIdentifier,
    ALPNProtocols: ["x-amzn-mqtt-ca"]
  });

  client.on('connect', () => {
    console.log(`📡 Linked live to hardware device: ${deviceId}`);
    client.subscribe(`/device/${deviceId}/data/events`);
  });

  client.on('message', async (topic, message) => {
    try {
      const eventData = JSON.parse(message.toString());
      const { type, value } = eventData;

      if (type === 'card_inserted') {
        sendPixelIconToPlayer(client, deviceId, "pixel_rocket");
      }

      if (type === 'dial_turned') {
        await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [value, deviceId]);
      }

      if (type === 'button_pressed') {
        const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
        const session = sessionRes.rows[0];

        if (session && session.current_app_id) {
          const appRes = await pool.query('SELECT * FROM developer_apps WHERE id = $1', [session.current_app_id]);
          const appLogic = appRes.rows[0].json_logic;
          const currentState = appLogic.states[session.current_state_name || 'welcome'];

          if (currentState.on_click === 'check_guess') {
            let nextState = (session.current_dial_value === 7) ? 'win' : 'try_again';
            await pool.query('UPDATE active_sessions SET current_state_name = $1 WHERE yoto_player_id = $2', [nextState, deviceId]);
          }
        }
      }
    } catch (err) {
      console.error("Live packet tracking error:", err);
    }
  });
}

function sendPixelIconToPlayer(mqttClient, deviceId, iconName) {
  mqttClient.publish(`/device/${deviceId}/cmd/display`, JSON.stringify({
    command: "show_icon", icon: iconName, duration: 5000
  }));
}

// ROUTE 1: Dev Studio App Intake
app.post('/api/apps/upload', async (req, res) => {
  try {
    const { appName, iconIdentifier, jsonLogic } = req.body;
    const result = await pool.query(
      `INSERT INTO developer_apps (app_name, icon_identifier, json_logic) VALUES ($1, $2, $3) RETURNING *;`,
      [appName, iconIdentifier, JSON.stringify(jsonLogic)]
    );
    res.status(201).json({ message: "🚀 Upload successful!", app: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROUTE 2: Dynamic Live Audio Engine
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
      const logic = appRes.rows[0].json_logic;
      const currentState = logic.states[session.current_state_name || 'welcome'];
      return res.redirect(`https://yourtts.com{encodeURIComponent(currentState.audio_prompt)}`);
    }
    res.redirect('https://yourstorage.com');
  } catch (err) {
    res.status(500).send("Audio engine failure");
  }
});

// ROUTE 3: OAuth Handshake (Uses code_verifier and requires zero client secrets)
app.post('/api/yoto/callback', async (req, res) => {
  const { authCode, codeVerifier } = req.body;
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const computedRedirectUri = `${protocol}://${req.headers.host}/callback.html`;

    const tokenResponse = await fetch('https://yoto.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.YOTO_CLIENT_ID,
        code: authCode,
        code_verifier: codeVerifier, // Key payload parameter replacing client_secret
        redirect_uri: computedRedirectUri
      })
    });

    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokens.error_description || 'OAuth swap failed.');

    const playerResponse = await fetch('https://yoto.dev', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id; // Safely get first parent device

    if (!targetPlayerId) return res.status(400).json({ error: "No player found on account." });

    await pool.query(`
      INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value) 
      VALUES ($1, 'welcome', 0) ON CONFLICT (yoto_player_id) DO NOTHING;
    `, [targetPlayerId]);

    startPlayerLiveSync(targetPlayerId, tokens.access_token);
    res.json({ success: true, playerId: targetPlayerId });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Engine listening on port ${PORT}`));
