import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import mqtt from 'mqtt';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(cors());

// Configure connection pool to your Render/Neon PostgreSQL database
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * HELPER: Send commands to the 16x16 LED Matrix of a physical Yoto unit via MQTT
 */
function pushDisplayCommand(mqttClient, deviceId, icon) {
  mqttClient.publish(`/device/${deviceId}/cmd/display`, JSON.stringify({
    command: "show_icon", 
    icon: icon, 
    duration: 5000
  }));
}

/**
 * CORE RUNTIME KERNEL: Establishes a secure WebSocket MQTT tunnel directly with Yoto's 
 * live enterprise AWS IoT core infrastructure to stream inputs/outputs in real-time.
 */
function startPlayerLiveSync(deviceId, accessToken) {
  const MQTT_URL = process.env.YOTO_MQTT_URL || "wss://a2979201shg79z-ats.iot.eu-west-1.amazonaws.com";
  const clientIdentifier = `KERN_${deviceId}_${Math.floor(Math.random() * 1000)}`;

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
    console.log(`📡 Custom OS Kernel attached to physical player: ${deviceId}`);
    client.subscribe(`/device/${deviceId}/data/events`);
  });

  client.on('message', async (topic, message) => {
    try {
      const event = JSON.parse(message.toString());
      
      // Fetch current session running on this physical device
      const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
      if (sessionRes.rows.length === 0) return;
      const session = sessionRes.rows[0];

      // CONSTRAINT 1: Left Button Always Returns the OS to the Main Home Selection Matrix State
      if (event.type === 'left_button_pressed') {
        await pool.query(
          "UPDATE active_sessions SET current_state_name='home', current_dial_value=0, current_app_id=NULL, current_scene_node='start' WHERE yoto_player_id=$1", 
          [deviceId]
        );
        pushDisplayCommand(client, deviceId, "yoto:home");
        return;
      }

      // CONSTRAINT 2: Turn Right Dial to shift options (Left Dial modifications are ignored)
      if (event.type === 'right_dial_turned') {
        const turnValue = Math.abs(event.value || 0);

        if (session.current_state_name === 'home') {
          const downloads = (await pool.query('SELECT da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [deviceId])).rows;
          const index = turnValue % (downloads.length + 1); // 0 index is the App Store
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          pushDisplayCommand(client, deviceId, index === 0 ? "yoto:download" : downloads[index - 1].icon_identifier);
        } 
        else if (session.current_state_name === 'store') {
          const storeCatalog = (await pool.query('SELECT id, icon_identifier FROM developer_apps ORDER BY id')).rows;
          if (storeCatalog.length === 0) return;
          const index = turnValue % storeCatalog.length;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          pushDisplayCommand(client, deviceId, storeCatalog[index].icon_identifier);
        } 
        else if (session.current_state_name === 'playing') {
          const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
          const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
          if (node && node.type === 'decision') {
            const index = turnValue % node.branches.length;
            await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          }
        }
      }

      // CONSTRAINT 3: Right Button click executes transitions, selections, and downloads
      if (event.type === 'right_button_pressed') {
        const idx = session.current_dial_value || 0;

        if (session.current_state_name === 'home') {
          if (idx === 0) {
            // Enter App Store catalog mode
            await pool.query("UPDATE active_sessions SET current_state_name='store', current_dial_value=0 WHERE yoto_player_id=$1", [deviceId]);
            pushDisplayCommand(client, deviceId, "yoto:download");
          } else {
            // Launch downloaded application
            const downloads = (await pool.query('SELECT app_id FROM installed_apps WHERE yoto_player_id = $1 ORDER BY id', [deviceId])).rows;
            const appTarget = downloads[idx - 1].app_id;
            await pool.query("UPDATE active_sessions SET current_state_name='playing', current_app_id=$1, current_dial_value=0, current_scene_node='start' WHERE yoto_player_id=$2", [appTarget, deviceId]);
            const da = (await pool.query('SELECT icon_identifier FROM developer_apps WHERE id=$1', [appTarget])).rows[0];
            pushDisplayCommand(client, deviceId, da.icon_identifier);
          }
        } 
        else if (session.current_state_name === 'store') {
          // Download app to local player profile storage simulation
          const storeCatalog = (await pool.query('SELECT id FROM developer_apps ORDER BY id')).rows;
          if (storeCatalog.length === 0) return;
          await pool.query('INSERT INTO installed_apps (yoto_player_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deviceId, storeCatalog[idx].id]);
          pushDisplayCommand(client, deviceId, "yoto:tick");
        } 
        else if (session.current_state_name === 'playing') {
          // Advance the .yexe state tree selection forward based on chosen index branch target
          const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
          const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
          if (node && node.type === 'decision') {
            const targetNodeName = node.branches[idx];
            const nextNode = app.executable_data.executable[targetNodeName];
            await pool.query("UPDATE active_sessions SET current_scene_node=$1, current_dial_value=0 WHERE yoto_player_id=$2", [targetNodeName, deviceId]);
            pushDisplayCommand(client, deviceId, nextNode.display || "yoto:play");
          }
        }
      }
    } catch (err) { 
      console.error("MQTT event routing processing loop crash:", err); 
    }
  });
}

/* ==========================================================================
   API ENDPOINTS
   ========================================================================== */

/**
 * FIXED AUTH-URL ENDPOINT (Clears 400 Bad Request Blocks)
 */
app.get('/api/yoto/auth-url', (req, res) => {
  try {
    const { redirect_uri, challenge } = req.query;
    if (!redirect_uri || !challenge) {
      return res.status(400).json({ error: "Missing redirect_uri or challenge query params" });
    }

    const clientId = process.env.YOTO_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: "Server Error: YOTO_CLIENT_ID missing on Render configuration." });
    }

    const securityState = Math.random().toString(36).substring(2, 15);

    // FIXED: Formatted strictly according to Yoto Identity standards
    const yotoAuthUrl = `https://login.yotoplay.com/authorize?` + new URLSearchParams({
      audience: 'https://api.yotoplay.com',
      client_id: clientId,
      redirect_uri: redirect_uri,
      response_type: 'code',
      scope: 'openid profile offline_access family:library:view',
      state: securityState,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString();

    res.json({ url: yotoAuthUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * FIXED OAUTH CALLBACK ENDPOINT
 */
app.post('/api/yoto/callback', async (req, res) => {
  try {
    const { authCode, codeVerifier, redirectUri } = req.body;
    
    // FIXED: Exchanging tokens via the official Auth0 Identity Provider pipeline
    const tokenRes = await fetch('https://login.yotoplay.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: process.env.YOTO_CLIENT_ID || '',
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      })
    });
    
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.status(400).json({ error: "Token negotiation rejected by Yoto server." });

    // Fetch the player ID profile linked with this authorization token
    const playerResponse = await fetch('https://api.yotoplay.com/api/v1/players', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id || playerData.players?.id;

    if (!targetPlayerId) return res.status(400).json({ error: "No physical player hardware bound to this account profile." });
    
    await pool.query(
      "INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value) VALUES ($1, 'home', 0) ON CONFLICT (yoto_player_id) DO NOTHING", 
      [targetPlayerId]
    );
    
    // Boot up the persistent streaming listener for the player's buttons/dials
    startPlayerLiveSync(targetPlayerId, tokens.access_token);
    
    res.json({ success: true, playerId: targetPlayerId });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

/**
 * .YEXE SOFTWARE APPLICATION CATALOG COMPILER UPLOADER
 */
app.post('/api/apps/compile', async (req, res) => {
  try {
    const { appName, iconIdentifier, yexeData } = req.body;
    
    if (!yexeData || yexeData.format !== 'yexe-v1') {
      return res.status(400).json({ error: "Validation Failure: Executable missing valid format identity 'yexe-v1'." });
    }

    // Insert app payload matrix structure into database registry catalog block
    await pool.query(
      'INSERT INTO developer_apps (app_name, icon_identifier, executable_data) VALUES ($1, $2, $3)', 
      [appName, iconIdentifier, JSON.stringify(yexeData)]
    );
    
    res.status(201).json({ message: "Successfully published app package to distribution streams!" });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

/**
 * INTERACTIVE TEXT-TO-SPEECH STREAM GENERATOR
 */
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  try {
    const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [req.params.playerId]);
    if (sessionRes.rows.length === 0) {
      return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=Booting%20OS`);
    }
    
    const session = sessionRes.rows[0];
    let spokenOutputText = "";
    const idx = session.current_dial_value || 0;

    if (session.current_state_name === 'home') {
      if (idx === 0) {
        spokenOutputText = "App Store catalog dashboard menu. Press the right button to enter.";
      } else {
        const apps = (await pool.query('SELECT da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [req.params.playerId])).rows;
        spokenOutputText = `Launch custom application bundle, ${apps[idx - 1].app_name}. Click right button to execute software boot loop.`;
      }
    } 
    else if (session.current_state_name === 'store') {
      const store = (await pool.query('SELECT app_name FROM developer_apps ORDER BY id')).rows;
      spokenOutputText = store.length === 0 ? "Store compilation empty." : `Install app asset package, ${store[idx].app_name} onto player library launcher. Click right button to confirm download.`;
    } 
    else if (session.current_state_name === 'playing') {
      const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
      const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
      spokenOutputText = node ? node.audio_prompt : "Executing background application thread.";
    }

    return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(spokenOutputText)}`);
  } catch (err) { 
    res.status(500).send("Text-To-Speech pipeline routing failure."); 
  }
});

// Fire up the Server Engine
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Yoto Custom OS Engine running on port ${PORT}`);
});
