const express = require('express');
const cors = require('cors');
// If you are tracking sessions in a database, keep your pg/pool imports here
// const { Pool } = require('pg'); 

const app = express();
const PORT = process.env.PORT || 10000;

// 1. GLOBAL MIDDLEWARE CONFIGURATION
app.use(cors({ origin: '*' })); // Allows GitHub Pages domain requests to pass CORS gates
app.use(express.json());

// Replace this with your verified Yoto App Developer Dashboard credentials
const YOTO_CLIENT_ID = "BA8IaVyfDSHBPMEM4eXCep9VVHjHwLAy";
// NOTE: Public Clients do not use a client_secret. If your app is configured 
// as a Confidential Client, uncomment the line below and add your secret string.
// const YOTO_CLIENT_SECRET = "YOUR_CONFENTIAL_CLIENT_SECRET"; 

// --- OAUTH GATEWAY ROUTES ---

/**
 * STEP 1: DYNAMIC AUTHORIZATION URL BUILDER
 * Generates the clean Auth0 link based entirely on what your frontend requests.
 */
app.get('/api/yoto/auth-url', (req, res) => {
    try {
        const { redirect_uri, challenge } = req.query;

        // Catch missing parameters before calling out to Yoto
        if (!redirect_uri || !challenge) {
            console.error("❌ Auth URL Error: Missing required query string values.");
            return res.status(400).json({ 
                error: "Missing parameters. Required variables: redirect_uri, challenge" 
            });
        }

        console.log(`📡 Compiling handshake url targets: ${redirect_uri}`);

        // Construct Auth0 destination matching scope parameters
        const authUrl = `https://login.yotoplay.com/authorize?` +
            `audience=${encodeURIComponent('https://api.yotoplay.com')}&` +
            `client_id=${encodeURIComponent(YOTO_CLIENT_ID)}&` +
            `redirect_uri=${encodeURIComponent(redirect_uri)}&` +
            `response_type=code&` +
            `scope=${encodeURIComponent('openid profile offline_access user:content:manage family:devices:control')}&` +
            `state=lkf8n83n5g&` + // Trackable state sequence validation string
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
 * Receives incoming tracking codes from callback.html and trades them for user tokens.
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

        // Construct the standard application x-www-form-urlencoded format payload
        const requestBody = new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: YOTO_CLIENT_ID,
            code: authCode,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri
        });

        // If confidential type config rule applies, attach payload validation
        // if (YOTO_CLIENT_SECRET) requestBody.append('client_secret', YOTO_CLIENT_SECRET);

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
        
        // TODO: Save tokenData.access_token and tokenData.refresh_token to your session store/database here

        // Send a clean response back to your callback.html file
        res.json({ success: true, message: "Handshake verified." });

    } catch (err) {
        console.error("🔥 System Crash in /api/yoto/callback:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- COMPILER WORKSPACE ROUTE ---

/**
 * APP PACKAGE COMPILER ENDPOINT
 */
app.post('/api/apps/compile', async (req, res) => {
    try {
        const { appName, iconIdentifier, yexeData } = req.body;
        
        console.log(`🚀 Compiling app bundle package manifest: [${appName}]`);
        
        // Process, save, or broadcast payload streams here
        
        res.json({ success: true, appName: appName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start the server instance execution lifecycle loop
app.listen(PORT, () => {
    console.log(`🛰️ Yoto Runtime Core Engine operational on listener port: ${PORT}`);
});
