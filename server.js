const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();

// Twilio sends data as URL-encoded form
app.use(bodyParser.urlencoded({ extended: false }));

// Health check route (for browser + Render)
app.get("/", (req, res) => {
    res.send("Guka is running");
});

// WhatsApp webhook (main entry point)
app.post("/webhook", async (req, res) => {
    const incomingMessage = req.body.Body;
    const userNumber = req.body.From;

    console.log("User:", userNumber);
    console.log("Message:", incomingMessage);

    // For now we return a simple response (no AI yet)
    const reply = `Guka received: ${incomingMessage}`;

    // Twilio requires this XML format
    res.set("Content-Type", "text/xml");

    res.send(`
        <Response>
            <Message>${reply}</Message>
        </Response>
    `);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Guka server running on port ${PORT}`);
});