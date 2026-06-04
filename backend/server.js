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
      
      const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
      if (sessionRes.rows.length === 0) return;
      const session = sessionRes.rows[0];

      // Left Button Reset to Home State
      if (event.type === 'left_button_pressed') {
        await pool.query(
          "UPDATE active_sessions SET current_state_name='home', current_dial_value=0, current_app_id=NULL, current_scene_node='start' WHERE yoto_player_id=$1", 
          [deviceId]
        );
        pushDisplayCommand(client, deviceId, "yoto:home");
        return;
      }

      // Right Dial Turn Options Navigation
      if (event.type === 'right_dial_turned') {
        const turnValue = Math.abs(event.value || 0);

        if (session.current_state_name === 'home') {
          const downloads = (await pool.query('SELECT da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [deviceId])).rows;
          // Options matrix: 0 = App Store, 1 to N = Apps, N+1 = System Settings Menu
          const totalOptions = downloads.length + 2; 
          const index = turnValue % totalOptions;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          
          if (index === 0) pushDisplayCommand(client, deviceId, "yoto:download");
          else if (index === totalOptions - 1) pushDisplayCommand(client, deviceId, "yoto:settings");
          else pushDisplayCommand(client, deviceId, downloads[index - 1].icon_identifier);
        } 
        else if (session.current_state_name === 'store') {
          const storeCatalog = (await pool.query('SELECT id, icon_identifier FROM developer_apps ORDER BY id')).rows;
          if (storeCatalog.length === 0) return;
          const index = turnValue % storeCatalog.length;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          pushDisplayCommand(client, deviceId, storeCatalog[index].icon_identifier);
        } 
        else if (session.current_state_name === 'settings') {
          // Toggle between 0 (Normal Voice Speed) and 1 (Fast Voice Speed)
          const index = turnValue % 2;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [index, deviceId]);
          pushDisplayCommand(client, deviceId, index === 0 ? "yoto:face_happy" : "yoto:clock");
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

      // Right Button Click Selection Matrix Execution
      if (event.type === 'right_button_pressed') {
        const idx = session.current_dial_value || 0;

        if (session.current_state_name === 'home') {
          const downloads = (await pool.query('SELECT app_id FROM installed_apps WHERE yoto_player_id = $1 ORDER BY id', [deviceId])).rows;
          const totalOptions = downloads.length + 2;

          if (idx === 0) {
            // Enter App Store Mode
            await pool.query("UPDATE active_sessions SET current_state_name='store', current_dial_value=0 WHERE yoto_player_id=$1", [deviceId]);
            pushDisplayCommand(client, deviceId, "yoto:download");
          } else if (idx === totalOptions - 1) {
            // Enter System Settings Configuration
            await pool.query("UPDATE active_sessions SET current_state_name='settings', current_dial_value=0 WHERE yoto_player_id=$1", [deviceId]);
            pushDisplayCommand(client, deviceId, "yoto:settings");
          } else {
            // Launch Custom App Compilation Module
            const appTarget = downloads[idx - 1].app_id;
            await pool.query("UPDATE active_sessions SET current_state_name='playing', current_app_id=$1, current_dial_value=0, current_scene_node='start' WHERE yoto_player_id=$2", [appTarget, deviceId]);
            const da = (await pool.query('SELECT icon_identifier FROM developer_apps WHERE id=$1', [appTarget])).rows[0];
            pushDisplayCommand(client, deviceId, da.icon_identifier);
          }
        } 
        else if (session.current_state_name === 'store') {
          const storeCatalog = (await pool.query('SELECT id FROM developer_apps ORDER BY id')).rows;
          if (storeCatalog.length === 0) return;
          await pool.query('INSERT INTO installed_apps (yoto_player_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deviceId, storeCatalog[idx].id]);
          pushDisplayCommand(client, deviceId, "yoto:tick");
        } 
        else if (session.current_state_name === 'settings') {
          const speedSetting = idx === 0 ? 'medium' : 'fast';
          await pool.query("UPDATE active_sessions SET voice_speed=$1, current_state_name='home', current_dial_value=0 WHERE yoto_player_id=$2", [speedSetting, deviceId]);
          pushDisplayCommand(client, deviceId, "yoto:tick");
        }
        else if (session.current_state_name === 'playing') {
          const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
          const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
          
          if (node && node.type === 'decision') {
            const targetNodeName = node.branches[idx];
            const nextNode = app.executable_data.executable[targetNodeName];

            // PERSISTENT SAVE DATA INTERACTION LAYER
            if (nextNode && nextNode.save_trigger) {
              await pool.query(
                `INSERT INTO app_save_data (yoto_player_id, app_id, save_state) 
                 VALUES ($1, $2, $3) ON CONFLICT (yoto_player_id, app_id) 
                 DO UPDATE SET save_state = $3, updated_at = CURRENT_TIMESTAMP`,
                [deviceId, session.current_app_id, JSON.stringify(nextNode.save_trigger)]
              );
            }

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
 * AUTH-URL GENERATION ENDPOINT
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

    const yotoAuthUrl = `https://login.yotoplay.com/authorize?` + new URLSearchParams({
      audience: 'https://api.yotoplay.com',
      client_id: clientId,
      redirect_uri: redirect_uri,
      response_type: 'code',
      scope: 'openid profile offline_access family:library:view user:content:manage',
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
 * SECURE TOKEN EXCHANGE CALLBACK ENDPOINT (With Production-Validated Content Payload)
 */
app.post('/api/yoto/callback', async (req, res) => {
  try {
    const { authCode, codeVerifier, redirectUri } = req.body;
    
    const clientId = process.env.YOTO_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: "Server Error: Missing YOTO_CLIENT_ID on Render." });
    }
    
    // 1. Exchange authorization code for token matrix
    const tokenRes = await fetch('https://login.yotoplay.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri
      })
    });
    
    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      return res.status(400).json({ error: `Token negotiation rejected: ${tokens.error_description || 'Invalid Grant Structure'}` });
    }

    // 2. Fetch active physical user hardware IDs
    const playerResponse = await fetch('https://api.yotoplay.com/api/v1/players', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const playerData = await playerResponse.json();
    
    let targetPlayerId = playerData.players?.[0]?.id || playerData.players?.id;

    if (!targetPlayerId) {
      console.log("⚠️ Physical hardware registration trace missing. Routing workspace mapping node.");
      targetPlayerId = "MYO-TRACK-NODE"; 
    }
    
    // 3. Register and increment system boot metrics inside our PostgreSQL schema
    await pool.query(
      `INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value, boot_count) 
       VALUES ($1, 'home', 0, 1) 
       ON CONFLICT (yoto_player_id) DO UPDATE SET boot_count = active_sessions.boot_count + 1`, 
      [targetPlayerId]
    );
    
    // 4. STANDARDIZED INTERACTIVE PLAYLIST INJECTION (FIXED REGISTRATION SCHEMA)
    console.log("🚀 Provisioning Standardized Content Stream Layout via Yoto API...");
    
    const randomCardId = `os_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

    const playlistPayload = {
      cardId: randomCardId, // Explicit tracking identifier handles account visibility layout mapping
      title: "Yoto Multi-Card OS Launcher",
      metadata: {
        description: "Cloud-rendered interface mapping over-the-air instructions directly onto physical hardware controls."
      },
      content: {
        playbackType: "linear", 
        config: { 
          resumeTimeout: 0, 
          autoadvance: "none" 
        },
        chapters: [
          {
            key: "os_boot_sequence",
            title: "System Boot Matrix",
            tracks: [
              {
                title: "System Main Kernel Execution Audio",
                key: `tk_${targetPlayerId}`,
                format: "mp3",
                type: "stream", // Correct pattern unlocks permanent live-stream routing
                uid: `track_uid_${targetPlayerId}`,
                trackUrl: `https://yoto-multi-card.onrender.com/yoto/launcher/${targetPlayerId}/track.mp3`,
                duration: 1800, 
                fileSize: 1048576,
                channels: "stereo",
                overlayLabel: "SYSTEM",
                display: {
                  icon16x16: "yoto:rocket" // CUSTOM BOOT LOGO matrix assignment
                }
              }
            ]
          }
        ]
      }
    };

    const playlistCreateResponse = await fetch('https://api.yotoplay.com/content', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(playlistPayload)
    });

    const playlistData = await playlistCreateResponse.json();
    console.log("✅ Interactive Launcher successfully injected:", playlistData);

    if (targetPlayerId !== "MYO-TRACK-NODE") {
      startPlayerLiveSync(targetPlayerId, tokens.access_token);
    }
    
    res.json({ success: true, playerId: targetPlayerId, playlistCreated: true });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

/**
 * EXPLICIT ENDPOINT: Read direct playlist backup structures
 */
app.get('/api/yoto/playlist/:playerId', async (req, res) => {
  try {
    res.json({
      playlist_name: "Yoto Multi-Card Custom OS Engine",
      description: "Cloud-rendered execution layer for dynamic application modules.",
      banner_icon: "yoto:home",
      tracks: [
        {
          title: "System Main Kernel Execution Audio Track",
          url: `https://yoto-multi-card.onrender.com/yoto/launcher/${req.params.playerId}/track.mp3`,
          type: "audio/mp3"
        }
      ]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    await pool.query(
      'INSERT INTO developer_apps (app_name, icon_identifier, executable_data) VALUES ($1, $2, $3)', 
      [appName, iconIdentifier, JSON.stringify(yexeData)]
    );
    
    res.status(201).json({ message: "Successfully published app package!" });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

/**
 * INTERACTIVE TEXT-TO-SPEECH STREAM GENERATOR (With Save States & Settings Configuration Processing)
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

    // Pull system variables to dynamically control narrative performance properties
    const userVoicePreference = session.voice_speed === 'fast' ? '&ttsspeed=1.4' : '';

    if (session.current_state_name === 'home') {
      const apps = (await pool.query('SELECT da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [req.params.playerId])).rows;
      const totalOptions = apps.length + 2;

      if (idx === 0) {
        spokenOutputText = `System kernel online. Verification boot index count is ${session.boot_count || 1}. App Store menu. Press right button to check items.`;
      } else if (idx === totalOptions - 1) {
        spokenOutputText = "System environment settings board control panel. Press right button to configure adjustments.";
      } else {
        const currentAppName = apps[idx - 1]?.app_name;
        
        // READ PERSISTENT APP SAVE DATA
        const savedGame = await pool.query('SELECT save_state FROM app_save_data WHERE yoto_player_id = $1 AND app_id = (SELECT id FROM developer_apps WHERE app_name = $2)', [req.params.playerId, currentAppName]);
        let saveContextStatus = "";
        if (savedGame.rows.length > 0) {
           saveContextStatus = " Previous progress save checkpoint record verified.";
        }

        spokenOutputText = `Launch software bundle module, ${currentAppName}.${saveContextStatus} Press right button to run main execution threads.`;
      }
    } 
    else if (session.current_state_name === 'store') {
      const store = (await pool.query('SELECT app_name FROM developer_apps ORDER BY id')).rows;
      spokenOutputText = store.length === 0 ? "Store catalog footprint is currently unpopulated." : `Download app package compilation, ${store[idx].app_name}. Press right button to initialize extraction installation.`;
    } 
    else if (session.current_state_name === 'settings') {
      spokenOutputText = idx === 0 ? "Configure structural sound narration speech tempo velocity to normal baseline values." : "Accelerate structural sound narration speech output speed parameters.";
    }
    else if (session.current_state_name === 'playing') {
      const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
      const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
      spokenOutputText = node ? node.audio_prompt : "Running multi-threaded background background system tasks.";
    }

    return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(spokenOutputText)}${userVoicePreference}`);
  } catch (err) { 
    res.status(500).send("Text-To-Speech pipeline routing failure."); 
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Yoto Custom OS Engine running on port ${PORT}`);
});
