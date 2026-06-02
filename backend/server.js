import express from 'express';
import cors from 'cors';
import pg from 'pg';
import dotenv from 'dotenv';
import mqtt from 'mqtt';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// Serve the frontend operating center static files
app.use(express.static(path.join(__dirname, 'public')));

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Hardware driver utility to transmit visualization signals via MQTT
function sendPixelIcon(mqttClient, deviceId, iconName) {
  mqttClient.publish(
    `/device/${deviceId}/cmd/display`, 
    JSON.stringify({ command: "show_icon", icon: iconName, duration: 5000 })
  );
}

// Background Hardware State Machine Engine
function startOSKernel(deviceId, accessToken) {
  const MQTT_URL = process.env.YOTO_MQTT_URL || "wss://amazonaws.com";
  const clientIdentifier = `YOTO_OS_${deviceId}_${Math.floor(Math.random() * 1000)}`;

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
    console.log(`[OS KERNEL] Boot sequence complete. Monitoring Player ID: ${deviceId}`);
    client.subscribe(`/device/${deviceId}/data/events`);
  });

  client.on('message', async (topic, message) => {
    try {
      const event = JSON.parse(message.toString());
      
      let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
      if (sessionRes.rows.length === 0) {
        await pool.query('INSERT INTO active_sessions (yoto_player_id) VALUES ($1)', [deviceId]);
        return;
      }
      
      const session = sessionRes.rows[0];
      let currentMenu = session.current_state_name || 'home'; 
      let currentIdx = session.current_dial_value || 0;

      // SPECIFICATION 1: Left Button hardware trigger forces Home fallback reset
      if (event.type === 'left_button_pressed') {
        await pool.query(
          "UPDATE active_sessions SET current_state_name = 'home', current_dial_value = 0, current_app_id = NULL, current_scene_node = 'start' WHERE yoto_player_id = $1",
          [deviceId]
        );
        sendPixelIcon(client, deviceId, "yoto:home");
        return;
      }

      // SPECIFICATION 2: Turning the Right Dial scrolls options inside active software contexts
      if (event.type === 'right_dial_turned') {
        const rawValue = Math.abs(event.value || 0); 

        if (currentMenu === 'home') {
          const installedRes = await pool.query(
            'SELECT da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id',
            [deviceId]
          );
          const totalOptions = installedRes.rows.length + 1; // Index 0 is always App Store
          const targetIdx = rawValue % totalOptions;
          
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [targetIdx, deviceId]);
          
          if (targetIdx === 0) {
            sendPixelIcon(client, deviceId, "yoto:download");
          } else {
            sendPixelIcon(client, deviceId, installedRes.rows[targetIdx - 1].icon_identifier);
          }
        } 
        else if (currentMenu === 'store') {
          const apps = await pool.query('SELECT id, icon_identifier FROM developer_apps ORDER BY id');
          if (apps.rows.length === 0) return;
          const targetIdx = rawValue % apps.rows.length;
          
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [targetIdx, deviceId]);
          sendPixelIcon(client, deviceId, apps.rows[targetIdx].icon_identifier);
        }
        else if (currentMenu === 'playing' && session.current_app_id) {
          const appRes = await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id]);
          const yexe = appRes.rows[0].executable_data;
          const currentScene = yexe.executable[session.current_scene_node || yexe.entry];
          
          if (currentScene && currentScene.type === 'decision') {
            const branchIdx = rawValue % currentScene.branches.length;
            await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [branchIdx, deviceId]);
          }
        }
      }

      // SPECIFICATION 3: Right Button triggers Action Selection/Execution environments
      if (event.type === 'right_button_pressed') {
        if (currentMenu === 'home') {
          if (currentIdx === 0) {
            await pool.query('UPDATE active_sessions SET current_state_name = \'store\', current_dial_value = 0 WHERE yoto_player_id = $1', [deviceId]);
            sendPixelIcon(client, deviceId, "yoto:download");
          } else {
            const installedRes = await pool.query(
              'SELECT da.id, da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id',
              [deviceId]
            );
            const selectedApp = installedRes.rows[currentIdx - 1];
            
            await pool.query(
              "UPDATE active_sessions SET current_state_name = 'playing', current_app_id = $1, current_dial_value = 0, current_scene_node = 'start' WHERE yoto_player_id = $2", 
              [selectedApp.id, deviceId]
            );
            sendPixelIcon(client, deviceId, selectedApp.icon_identifier);
          }
        } 
        else if (currentMenu === 'store') {
          const apps = await pool.query('SELECT id FROM developer_apps ORDER BY id');
          if (apps.rows.length === 0) return;
          const selectedApp = apps.rows[currentIdx];
          
          await pool.query('INSERT INTO installed_apps (yoto_player_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deviceId, selectedApp.id]);
          sendPixelIcon(client, deviceId, "yoto:tick"); 
        }
        else if (currentMenu === 'playing' && session.current_app_id) {
          const appRes = await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id]);
          const yexe = appRes.rows[0].executable_data;
          const currentScene = yexe.executable[session.current_scene_node || yexe.entry];
          
          if (currentScene && currentScene.type === 'decision') {
            const nextNode = currentScene.branches[currentIdx];
            const targetScene = yexe.executable[nextNode];
            
            await pool.query(
              'UPDATE active_sessions SET current_scene_node = $1, current_dial_value = 0 WHERE yoto_player_id = $2', 
              [nextNode, deviceId]
            );
            sendPixelIcon(client, deviceId, targetScene.display || "yoto:play");
          }
        }
      }
    } catch (err) {
      console.error("[KERNEL ERROR]", err);
    }
  });
}

// OS Audio Stream Synthesis Output Engine
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  const { playerId } = req.params;
  try {
    let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [playerId]);
    if (sessionRes.rows.length === 0) {
      return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent("OS Booted")}`);
    }
    
    const session = sessionRes.rows[0];
    const currentMenu = session.current_state_name || 'home';
    const currentIdx = session.current_dial_value || 0;
    let speakText = "";

    if (currentMenu === 'home') {
      if (currentIdx === 0) {
        speakText = "App Store. Click right dial button to open.";
      } else {
        const installedRes = await pool.query(
          'SELECT da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id',
          [playerId]
        );
        speakText = `Launch ${installedRes.rows[currentIdx - 1].app_name}`;
      }
    } 
    else if (currentMenu === 'store') {
      const apps = await pool.query('SELECT app_name FROM developer_apps ORDER BY id');
      speakText = apps.rows.length === 0 ? "Store Empty" : `App Store Catalog. Click right dial to download ${apps.rows[currentIdx].app_name}`;
    } 
    else if (currentMenu === 'playing' && session.current_app_id) {
      const appRes = await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id]);
      const yexe = appRes.rows[0].executable_data;
      const scene = yexe.executable[session.current_scene_node || yexe.entry];
      speakText = scene ? scene.audio_prompt : "Application Running";
    }

    return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(speakText)}`);
  } catch (err) { 
    res.status(500).send("Audio engine failure."); 
  }
});

// OAuth Integration Core Gateway Auth Verification Pipeline
app.get('/api/yoto/auth-url', (req, res) => {
  const { redirect_uri, challenge } = req.query;
  const url = `https://yoto.com/oauth/authorize?client_id=${process.env.YOTO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=user%3Acontent%3Aview%20user%3Acontent%3Amanage%20offline_access&code_challenge=${challenge}&code_challenge_method=S256`;
  res.json({ url });
});

app.post('/api/yoto/callback', async (req, res) => {
  const { authCode, codeVerifier, redirectUri } = req.body;
  try {
    const tokenResponse = await fetch('https://yoto.dev/oauth/token', {
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
    const tokens = await tokenResponse.json();
    
    const playerResponse = await fetch('https://yoto.dev/api/v1/players', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id;

    if (!targetPlayerId) return res.status(400).json({ error: "No players discovered on hardware link." });
    
    await pool.query("INSERT INTO active_sessions (yoto_player_id) VALUES ($1) ON CONFLICT DO NOTHING", [targetPlayerId]);
    startOSKernel(targetPlayerId, tokens.access_token);
    
    res.json({ success: true, playerId: targetPlayerId });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

// .yexe Software Compiler Interface Pipeline
app.post('/api/apps/compile', async (req, res) => {
  try {
    const { appName, iconIdentifier, yexeData } = req.body;
    await pool.query(
      'INSERT INTO developer_apps (app_name, icon_identifier, executable_data) VALUES ($1, $2, $3)', 
      [appName, iconIdentifier, JSON.stringify(yexeData)]
    );
    res.status(201).json({ message: "Successfully compiled and deployed .yexe architecture container!" });
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🦊 OS Kernel System running on port ${PORT}`));
