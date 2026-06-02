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
app.use(express.static(path.join(__dirname, 'public')));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function pushDisplayCommand(mqttClient, deviceId, icon) {
  mqttClient.publish(`/device/${deviceId}/cmd/display`, JSON.stringify({
    command: "show_icon", icon: icon, duration: 5000
  }));
}

// Complete Core State Machine & Event Loop
function bindHardwareKernel(deviceId, token) {
  const broker = process.env.YOTO_MQTT_URL || "wss://amazonaws.com";
  const client = mqtt.connect(broker, {
    keepalive: 300, port: 443, protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: token, clientId: `KERN_${deviceId}_${Math.floor(Math.random()*1000)}`,
    ALPNProtocols: ["x-amzn-mqtt-ca"]
  });

  client.on('connect', () => client.subscribe(`/device/${deviceId}/data/events`));

  client.on('message', async (topic, payload) => {
    try {
      const event = JSON.parse(payload.toString());
      let session = (await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId])).rows[0];
      
      if (!session) {
        await pool.query('INSERT INTO active_sessions (yoto_player_id) VALUES ($1)', [deviceId]);
        return;
      }

      // CONSTRAINT 1: Left button pressed is ALWAYS hard-wired to return Home
      if (event.type === 'left_button_pressed') {
        await pool.query("UPDATE active_sessions SET current_state_name='home', current_dial_value=0, current_app_id=NULL, current_scene_node='start' WHERE yoto_player_id=$1", [deviceId]);
        pushDisplayCommand(client, deviceId, "yoto:home");
        return;
      }

      // CONSTRAINT 2: Turn Right Dial to change internal index selections
      if (event.type === 'right_dial_turned') {
        const turnValue = Math.abs(event.value || 0);

        if (session.current_state_name === 'home') {
          const downloads = (await pool.query('SELECT da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [deviceId])).rows;
          const index = turnValue % (downloads.length + 1); // 0 is App Store catalog
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

      // CONSTRAINT 3: Right Button clicks trigger executions / downloads
      if (event.type === 'right_button_pressed') {
        const idx = session.current_dial_value || 0;

        if (session.current_state_name === 'home') {
          if (idx === 0) {
            await pool.query("UPDATE active_sessions SET current_state_name='store', current_dial_value=0 WHERE yoto_player_id=$1", [deviceId]);
            pushDisplayCommand(client, deviceId, "yoto:download");
          } else {
            const downloads = (await pool.query('SELECT app_id FROM installed_apps WHERE yoto_player_id = $1 ORDER BY id', [deviceId])).rows;
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
        else if (session.current_state_name === 'playing') {
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
    } catch (err) { console.error(err); }
  });
}

// OS Runtime Interactivity Audio Stream Channel
app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  try {
    const session = (await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [req.params.playerId])).rows[0];
    if (!session) return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=Booting`);
    
    let text = "";
    const idx = session.current_dial_value || 0;

    if (session.current_state_name === 'home') {
      if (idx === 0) {
        text = "App Store. Press right button to open.";
      } else {
        const apps = (await pool.query('SELECT da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [req.params.playerId])).rows;
        text = `Launch ${apps[idx - 1].app_name}`;
      }
    } 
    else if (session.current_state_name === 'store') {
      const store = (await pool.query('SELECT app_name FROM developer_apps ORDER BY id')).rows;
      text = store.length === 0 ? "Store Empty" : `Install ${store[idx].app_name}`;
    } 
    else if (session.current_state_name === 'playing') {
      const app = (await pool.query('SELECT executable_data FROM developer_apps WHERE id = $1', [session.current_app_id])).rows[0];
      const node = app.executable_data.executable[session.current_scene_node || app.executable_data.entry];
      text = node ? node.audio_prompt : "Running App";
    }

    return res.redirect(`https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`);
  } catch { res.status(500).send("Audio engine fault."); }
});

// OAuth Callback & PKCE Integration Router Hook
app.post('/api/yoto/callback', async (req, res) => {
  try {
    const { authCode, codeVerifier, redirectUri } = req.body;
    const tokenRes = await fetch('https://yoto.dev/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: process.env.YOTO_CLIENT_ID || '',
        code: authCode, code_verifier: codeVerifier, redirect_uri: redirectUri
      })
    });
    const tokens = await tokenRes.json();
    const pRes = await fetch('https://yoto.dev/api/v1/players', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
    const pData = await pRes.json();
    const targetId = pData.players?.[0]?.id;

    if (!targetId) return res.status(400).json({ error: "No hardware found" });
    await pool.query("INSERT INTO active_sessions (yoto_player_id) VALUES ($1) ON CONFLICT DO NOTHING", [targetId]);
    bindHardwareKernel(targetId, tokens.access_token);
    res.json({ success: true, playerId: targetId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/apps/compile', async (req, res) => {
  try {
    const { appName, iconIdentifier, yexeData } = req.body;
    await pool.query('INSERT INTO developer_apps (app_name, icon_identifier, executable_data) VALUES ($1, $2, $3)', [appName, iconIdentifier, JSON.stringify(yexeData)]);
    res.status(201).json({ message: "Successfully published .yexe file" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(process.env.PORT || 3000);
