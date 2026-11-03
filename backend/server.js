require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const YOTO_API_BASE = 'https://api.yotoplay.com';
const CLIENT_ID = process.env.YOTO_CLIENT_ID;
const CLIENT_SECRET = process.env.YOTO_CLIENT_SECRET;
const REDIRECT_URI = process.env.YOTO_REDIRECT_URI;

// 1. OAuth Redirect Handler
app.get('/api/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const tokenResponse = await axios.post(`${YOTO_API_BASE}/oauth/token`, {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    });
    // Send token to frontend (in production, set as secure HTTP-only cookie)
    res.json(tokenResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to exchange OAuth token', details: error.response?.data });
  }
});

// 2. Fetch User Devices
app.get('/api/devices', async (req, res) => {
  const authHeader = req.headers.authorization;
  try {
    const response = await axios.get(`${YOTO_API_BASE}/v1/family/devices`, {
      headers: { Authorization: authHeader },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch devices' });
  }
});

// 3. Fetch User Library (Cards & MYO Content)
app.get('/api/library', async (req, res) => {
  const authHeader = req.headers.authorization;
  try {
    const response = await axios.get(`${YOTO_API_BASE}/v1/user/cards`, {
      headers: { Authorization: authHeader },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// 4. Launch URI/Card to Specific Yoto Device
app.post('/api/launch', async (req, res) => {
  const authHeader = req.headers.authorization;
  const { deviceId, cardUri } = req.body;

  try {
    const response = await axios.post(
      `${YOTO_API_BASE}/v1/family/devices/${deviceId}/play`,
      { uri: cardUri }, // e.g. "yoto://card/<cardId>"
      { headers: { Authorization: authHeader } }
    );
    res.json({ success: true, result: response.data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to dispatch launch command to player' });
  }
});

app.listen(3000, () => console.log('Yoto Launcher Backend running on port 3000'));
