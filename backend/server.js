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

function startPlayerLiveSync(deviceId, accessToken) {
  const MQTT_URL = "wss://://amazonaws.com";
  const clientIdentifier = `OS_${deviceId}_${Math.floor(Math.random() * 1000)}`;

  const client = mqtt.connect(MQTT_URL, {
    keepalive: 300, port: 443, protocol: "wss",
    username: `${deviceId}?x-amz-customauthorizer-name=PublicJWTAuthorizer`,
    password: accessToken, clientId: clientIdentifier, ALPNProtocols: ["x-amzn-mqtt-ca"]
  });

  client.on('connect', () => {
    console.log(`0x1F4E1 App Store Engine locked onto player: ${deviceId}`);
    client.subscribe(`/device/${deviceId}/data/events`);
  });

  client.on('message', async (topic, message) => {
    try {
      const event = JSON.parse(message.toString());
      
      const sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [deviceId]);
      if (sessionRes.rows.length === 0) return;
      const session = sessionRes.rows[0];
      let currentMenu = session.current_state_name || 'home'; 
      let currentIdx = session.current_dial_value || 0;

      if (event.type === 'left_button_pressed') {
        await pool.query(
          "UPDATE active_sessions SET current_state_name = 'home', current_dial_value = 0, current_app_id = NULL WHERE yoto_player_id = $1",
          [deviceId]
        );
        sendPixelIcon(client, deviceId, "yoto:home");
        return;
      }

      if (event.type === 'right_dial_turned') {
        const rawValue = event.value; 

        if (currentMenu === 'home') {
          const choice = Math.abs(rawValue) % 2;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [choice, deviceId]);
          sendPixelIcon(client, deviceId, choice === 0 ? "yoto:basket" : "yoto:play");
        } 
        else if (currentMenu === 'store') {
          const apps = await pool.query('SELECT id, icon_identifier FROM developer_apps ORDER BY id');
          if (apps.rows.length === 0) return;
          const targetIdx = Math.abs(rawValue) % apps.rows.length;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [targetIdx, deviceId]);
          sendPixelIcon(client, deviceId, apps.rows[targetIdx].icon_identifier);
        } 
        else if (currentMenu === 'launcher') {
          const apps = await pool.query('SELECT da.id, da.icon_identifier FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [deviceId]);
          if (apps.rows.length === 0) { sendPixelIcon(client, deviceId, "yoto:cross"); return; }
          const targetIdx = Math.abs(rawValue) % apps.rows.length;
          await pool.query('UPDATE active_sessions SET current_dial_value = $1 WHERE yoto_player_id = $2', [targetIdx, deviceId]);
          sendPixelIcon(client, deviceId, apps.rows[targetIdx].icon_identifier);
        }
      }

      if (event.type === 'right_button_pressed') {
        if (currentMenu === 'home') {
          const destinationMenu = (currentIdx === 0) ? 'store' : 'launcher';
          await pool.query('UPDATE active_sessions SET current_state_name = $1, current_dial_value = 0 WHERE yoto_player_id = $2', [destinationMenu, deviceId]);
          sendPixelIcon(client, deviceId, destinationMenu === 'store' ? "yoto:download" : "yoto:rocket");
        } 
        else if (currentMenu === 'store') {
          const apps = await pool.query('SELECT id, app_name FROM developer_apps ORDER BY id');
          if (apps.rows.length === 0) return;
          const selectedApp = apps.rows[currentIdx];
          await pool.query('INSERT INTO installed_apps (yoto_player_id, app_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [deviceId, selectedApp.id]);
          sendPixelIcon(client, deviceId, "yoto:tick");
        } 
        else if (currentMenu === 'launcher') {
          const apps = await pool.query('SELECT da.id, da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [deviceId]);
          if (apps.rows.length === 0) return;
          const selectedApp = apps.rows[currentIdx];
          await pool.query("UPDATE active_sessions SET current_state_name = 'playing', current_app_id = $1, current_dial_value = 0 WHERE yoto_player_id = $2", [selectedApp.id, deviceId]);
          sendPixelIcon(client, deviceId, "yoto:star");
        }
      }
    } catch (err) {
      console.error(err);
    }
  });
}

function sendPixelIcon(mqttClient, deviceId, iconName) {
  mqttClient.publish(`/device/${deviceId}/cmd/display`, JSON.stringify({ command: "show_icon", icon: iconName, duration: 3000 }));
}

app.get('/yoto/launcher/:playerId/track.mp3', async (req, res) => {
  const { playerId } = req.params;
  try {
    let sessionRes = await pool.query('SELECT * FROM active_sessions WHERE yoto_player_id = $1', [playerId]);
    if (sessionRes.rows.length === 0) {
      await pool.query('INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value) VALUES ($1, \'home\', 0)', [playerId]);
      return res.redirect(`https://google.com{encodeURIComponent("Welcome to your app hub. Turn the right dial to browse options.")}`);
    }
    
    const session = sessionRes.rows[0];
    const currentMenu = session.current_state_name || 'home';
    const currentIdx = session.current_dial_value || 0;
    let speakText = "";

    if (currentMenu === 'home') {
      speakText = (currentIdx === 0) ? "App Store. Press the right dial to open." : "My Apps Launcher. Press the right dial to view your installed games.";
    } 
    else if (currentMenu === 'store') {
      const apps = await pool.query('SELECT app_name FROM developer_apps ORDER BY id');
      speakText = (apps.rows.length === 0) ? "The app store is empty." : `Store app catalog. Press dial to install, ${apps.rows[currentIdx].app_name}`;
    } 
    else if (currentMenu === 'launcher') {
      const apps = await pool.query('SELECT da.app_name FROM installed_apps ia JOIN developer_apps da ON ia.app_id = da.id WHERE ia.yoto_player_id = $1 ORDER BY ia.id', [playerId]);
      speakText = (apps.rows.length === 0) ? "You haven't installed any apps yet." : `Your library. Press dial to launch, ${apps.rows[currentIdx].app_name}`;
    } 
    else if (currentMenu === 'playing' && session.current_app_id) {
      const appRes = await pool.query('SELECT json_logic FROM developer_apps WHERE id = $1', [session.current_app_id]);
      speakText = appRes.rows[0].json_logic.states.welcome.audio_prompt;
    }

    return res.redirect(`https://google.com{encodeURIComponent(speakText)}`);
  } catch (err) { res.status(500).send("Audio engine failure."); }
});

app.get('/api/yoto/auth-url', (req, res) => {
  const { redirect_uri, challenge } = req.query;
  const url = `https://yoto.com{process.env.YOTO_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=user%3Acontent%3Aview%20user%3Acontent%3Amanage%20offline_access&code_challenge=${challenge}&code_challenge_method=S256`;
  res.json({ url });
});

app.post('/api/yoto/callback', async (req, res) => {
  const { authCode, codeVerifier } = req.body;
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const computedRedirectUri = `${protocol}://${req.headers.host}/callback.html`;
    const tokenResponse = await fetch('https://yoto.dev', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: process.env.YOTO_CLIENT_ID, code: authCode, code_verifier: codeVerifier, redirect_uri: computedRedirectUri })
    });
    const tokens = await tokenResponse.json();
    const playerResponse = await fetch('https://yoto.dev', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
    const playerData = await playerResponse.json();
    const targetPlayerId = playerData.players?.[0]?.id || playerData.players?.id;

    if (!targetPlayerId) return res.status(400).json({ error: "No player found." });
    await pool.query("INSERT INTO active_sessions (yoto_player_id, current_state_name, current_dial_value) VALUES ($1, 'home', 0) ON CONFLICT (yoto_player_id) DO NOTHING", [targetPlayerId]);
    startPlayerLiveSync(targetPlayerId, tokens.access_token);
    res.json({ success: true, playerId: targetPlayerId });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/apps/upload', async (req, res) => {
  try {
    const { appName, iconIdentifier, jsonLogic } = req.body;
    await pool.query('INSERT INTO developer_apps (app_name, icon_identifier, json_logic) VALUES ($1, $2, $3)', [appName, iconIdentifier, JSON.stringify(jsonLogic)]);
    res.status(201).json({ message: "0x1F680 Upload successful!" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/icons/save', async (req, res) => {
  try {
    const { iconName, pixelMatrix } = req.body;
    await pool.query('INSERT INTO custom_icons (icon_name, pixel_matrix) VALUES ($1, $2) ON CONFLICT (icon_name) DO UPDATE SET pixel_matrix = $2', [iconName, pixelMatrix]);
    res.status(201).json({ message: "0x1F3A8 Icon saved!" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`0x1F680 Engine listening on port ${PORT}`));
