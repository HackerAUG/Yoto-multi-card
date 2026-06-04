import express from 'express';
import cors from 'cors';
// If you use fetch in Node 18+, it's built-in globally! No extra import needed.
// If you use pg later, it would be: import pkg from 'pg'; const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 10000;

// 1. GLOBAL MIDDLEWARE CONFIGURATION
app.use(cors({ origin: '*' })); 
app.use(express.json());

// Replace this with your verified Yoto App Developer Dashboard credentials
const YOTO_CLIENT_ID = "BA8IaVyfDSHBPMEM4eXCep9VVHjHwLAy";

// --- OAUTH GATEWAY ROUTES ---

/**
 * STEP 1: DYNAMIC AUTHORIZATION URL BUILDER
 */
app.get('/api/yoto/auth-url', (req, res) => {
    try {
        const { redirect_uri, challenge } = req.query;

        if (!redirect_uri || !challenge) {
            console.error("❌ Auth URL Error: Missing required query string values.");
            return res.status(400).json({ 
                error: "Missing parameters. Required variables: redirect_uri, challenge" 
            });
        }

        console.log(`📡 Compiling handshake url targets: ${redirect_uri}`);

        const authUrl = `https://login.yotoplay.com/authorize?` +
            `audience=${encodeURIComponent('https://api.yotoplay.com')}&` +
            `client_id=${encodeURIComponent(YOTO_CLIENT_ID)}&` +
            `redirect_uri=${encodeURIComponent(redirect_uri)}&` +
            `response_type=code&` +
            `scope=${encodeURIComponent('openid profile offline_access family:library:veiw family:library:manage user:content:manage family:devices:control')}&` +
            `state=lkf8n83n5g&` + 
            `code_challenge=${encodeURIComponent(challenge)}&` +
            `code_challenge_method=S256`;

        res.json({ url: authUrl });

    } catch (err) {
        console.error("🔥 System Crash in /api/yoto/auth-url:", err.message);
        res.status(500).json({ error: err.message });
    }
});

/**
 * STEP 2: SECURE CODE EXCHANGE HANDSHAKE
 */
app.post('/api/yoto/callback', async (req, res) => {
    try {
        const { authCode, codeVerifier, redirectUri } = req.body;

        if (!authCode || !codeVerifier || !redirectUri) {
            return res.status(400).json({ 
                error: "Payload validation failed. Required: authCode, codeVerifier, redirectUri" 
            });
        }

        console.log("🔄 Trading authorization code for structural token keys...");

        const requestBody = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: YOTO_CLIENT_ID,
            code: authCode,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
        });

        const yotoResponse = await fetch('https://login.yotoplay.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: requestBody.toString()
        });

        const tokenData = await yotoResponse.json();

        if (!yotoResponse.ok) {
            console.error("❌ Yoto Cloud Token Exchange Rejected:", tokenData);
            return res.status(yotoResponse.status).json({ 
                error: tokenData.error_description || "Token negotiation failed." 
            });
        }

        console.log("✅ OAuth tokens acquired successfully!");
        res.json({ success: true, message: "Handshake verified." });

    } catch (err) {
        console.error("🔥 System Crash in /api/yoto/callback:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- COMPILER WORKSPACE ROUTE ---

app.post('/api/apps/compile', async (req, res) => {
    try {
        const { appName, iconIdentifier, yexeData } = req.body;
        console.log(`🚀 Compiling app bundle package manifest: [${appName}]`);
        res.json({ success: true, appName: appName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🛰️ Yoto Runtime Core Engine operational on listener port: ${PORT}`);
});
