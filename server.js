const OpenAI = require("openai");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});
const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const app = express();

// Middleware (IMPORTANT for Twilio)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Root route (Render health check)
app.get("/", (req, res) => {
    res.status(200).send("Guka is running");
});

// WhatsApp webhook
app.post("/webhook", async (req, res) => {
    try {
        const incomingMessage = req.body.Body || "No message";
        const userNumber = req.body.From || "Unknown user";

        console.log("User:", userNumber);
        console.log("Message:", incomingMessage);

        // Basic reply (MVP)
        const reply = `Guka received: ${incomingMessage}`;

        // Twilio requires XML response
        res.set("Content-Type", "text/xml");
        res.status(200).send(`
<Response>
    <Message>${reply}</Message>
</Response>
        `);

    } catch (error) {
        console.error("Webhook error:", error);

        res.set("Content-Type", "text/xml");
        res.status(200).send(`
<Response>
    <Message>Something went wrong</Message>
</Response>
        `);
    }
});

// Handle unknown routes (prevents crashes)
app.use((req, res) => {
    res.status(404).send("Route not found");
});

// Global error handler (VERY IMPORTANT)
app.use((err, req, res, next) => {
    console.error("Server error:", err);
    res.status(500).send("Internal Server Error");
});

// Start server (Render-compatible)
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka server running on port ${PORT}`);
});