import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import mqtt from 'mqtt';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors()); // Critical to allow your GitHub Pages frontend to talk to this server

// Initialize connection pool to your serverless Neon PostgreSQL Database
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for secure cloud communication with Neon
});

/**
 * 📡 HARDWARE SYNC LOOP
 * This connects your Render server directly to Yoto's AWS IoT Core.
 * It stays awake in the background to catch physical knob turns and clicks.
 */
function startPlayerLiveSync(deviceId, accessToken) {
  // Official Yoto AWS IoT secure WebSocket broker URL
  const MQTT_URL = "wss://://amazonaws.com"; 
  const clientIdentifier = `DASH_${deviceId}_${Math.floor(Math.random() * 1000)}`;

  const client = mqtt.connect(MQTT_URL, {
    keepalive: 300,
    port: 443,
    protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: accessToken, // Authenticated user token acts as the secure passcode
    clientId: clientIdentifier,
    ALPNProtocols: ["x-amzn-mqtt-ca"]
  });

  client.on('connect', () => {
    console.log(`📡 Connected live to physical Yoto Hardware: ${deviceId}`);
    // Subscribe to standard real-time input telemetry data published by the player
    client.subscribe(`/device/${deviceId}/data/events`);
  });

  client.on('message', async (topic, message) => {
    try {
      const eventData = JSON.parse(message.toString());
      console.log(`🕹️ [Hardware Event] Player: ${deviceId} ->`, eventData);

      const { type, value } = eventData; 

      // 1. If child turns the physical dial, save their current choice position to Neon DB
      if (type === 'dial_turned') {
        await pool.query(
          'UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2',
          [value, deviceId]
        );
        console.log(`🧮 Dial position updated to: ${value}`);
      }

      // 2. If child presses the button, evaluate what application state they are on
      if (type === 'button_pressed') {
        const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
        const session = sessionRes.rows[0];

        if (session && session.current_app_id) {
          const appRes = await pool.query('SELECT * FROM developer_apps WHERE id = $1', [session.current_app_id]);
          const currentApp = appRes.rows[0];
          const appLogic = currentApp.json_logic;
          const currentState = appLogic.states[session.current_state_name || 'welcome'];

          // Simple target condition processing engine
          if (currentState.on_click === 'check_guess') {
            let nextState = 'try_again';
            if (session.current_dial_value === 7) nextState = 'win'; // Target winning value configuration

            await pool.query(
              'UPDATE active_sessions SET current_state_name = $1 WHERE yoto_player_id = $2',
              [nextState, deviceId]
        );
            console.log(`🔄 State engine evaluated. Shifted screen/audio matrix destination to: ${nextState}`);
          }
        }
      }
    } catch (err) {
      console.error("Error evaluating live hardware data stream packet:", err);
    }
  });

  client.on('error', (err) => {
    console.error(`❌ MQTT Client Connection breakdown for ${deviceId}:`, err);
  });
}

/**
 * 🚀 ROUTE 1: DEVELOPER STUDIO INTAKE PORTAL
 * Targets: Post requests from your index.html app creator grid.
 * Saves custom third-party game state layout logic to Neon DB.
 */
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

/**
 * 🔊 ROUTE 2: DYNAMIC LIVE AUDIO STREAM FOR MYO CARDS
 * Targets: Audio fetch stream issued by the physical plastic Yoto Player.
 * Checks the kid's live DB session state coordinates and updates what track audio plays.
 */
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  const { playerId } = req.params;
  try {
    // 1. Fetch or automatically initialize the child's session state tracking entry
    let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [playerId]);
    
    if (sessionRes.rows.length === 0) {
      const createSession = await pool.query('INSERT INTO active_sessions (yoto_player_id) VALUES ($1) RETURNING *', [playerId]);
      sessionRes = createSession;
    }
    
    const session = sessionRes.rows[0];

    // 2. If the kid has selected/launched an app from the directory database
    if (session.current_app_id) {
      const appRes = await pool.query('SELECT * FROM developer_apps WHERE id = $1', [session.current_app_id]);
      const currentApp = appRes.rows[0];
      const logic = currentApp.json_logic;
      const currentState = logic.states[session.current_state_name || 'welcome'];

      // Dynamically forward the audio player straight to a Text-to-Speech voice builder stream
      return res.redirect(`https://yourtts.com{encodeURIComponent(currentState.audio_prompt)}`);
    }

    // 3. Fallback: If no app has been selected yet, send them to the default starting audio track
    res.redirect('https://yourstorage.com');
  } catch (err) {
    console.error(err);
    res.status(500).send("Audio engine processing failure");
  }
});

/**
 * 🔒 ROUTE 3: OAUTH 2.0 TOKEN EXCHANGE HANDSHAKE
 * Targets: Security code submission payload from callback.html interface.
 * Swaps access passport tokens with Yoto and saves the configuration state inside Neon.
 */
app.post('/api/yoto/callback', async (req, res) => {
  const { authCode } = req.body;

  try {
    // Determine target domain dynamically based on incoming caller metadata headers
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const computedRedirectUri = `${protocol}://${req.headers.host}/callback.html`;

    // 1. Request secure access keys directly from Yoto central authentication registry
    const tokenResponse = await fetch('https://yoto.dev', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: process.env.YOTO_CLIENT_ID,
        client_secret: process.env.YOTO_CLIENT_SECRET,
        redirect_uri: computedRedirectUri
      })
    });

    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokens.error_description || 'OAuth Token conversion failed.');

    // 2. Fetch the target hardware player identifier serial code assigned to this account
    const playerResponse = await fetch('https://yoto.dev', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id; // Track the first hardware player in their network

    if (!targetPlayerId) {
      return res.status(400).json({ error: "Authentication success, but no physical Yoto Player device found on your account." });
    }

    // 3. Store or establish the player instance within your Neon Database tables
    await pool.query(`
      INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value) 
      VALUES ($1, 'welcome', 0)
      ON CONFLICT (yoto_player_id) DO NOTHING;
    `, [targetPlayerId]);

    // 4. Fire up the real-time background MQTT link listener right here on Render
    startPlayerLiveSync(targetPlayerId, tokens.access_token);

    // Return verification back to your browser callback client web page 
    res.json({ 
      success: true, 
      playerId: targetPlayerId,
      message: "🔒 Cloud architecture loop synced successfully!" 
    });

  } catch (error) {
    console.error("Callback endpoint error execution block:", error);
    res.status(500).json({ error: error.message });
  }
});

// Run server listener loop
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Yoto App Engine Engine running online via port ${PORT}`));
