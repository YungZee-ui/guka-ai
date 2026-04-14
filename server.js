const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Simple in-memory memory store (resets on restart)
const memory = {};

// Health check (Render)
app.get("/", (req, res) => {
    res.status(200).send("Guka is running");
});

// WhatsApp webhook
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "unknown";
        const message = req.body.Body || "";

        console.log("User:", user);
        console.log("Message:", message);

        // Create memory bucket for user
        if (!memory[user]) {
            memory[user] = [];
        }

        // Store user message
        memory[user].push({ role: "user", content: message });

        // Keep last 10 messages only
        const recentMemory = memory[user].slice(-10);

        // AI request
        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are Guka, a strict but supportive productivity coach. You help users stay focused, disciplined, and productive. Keep responses short, clear, and actionable. Remember user goals and follow up when relevant."
                },
                ...recentMemory
            ]
        });

        const reply = completion.choices[0].message.content;

        // Store AI response
        memory[user].push({ role: "assistant", content: reply });

        // Twilio response format
        res.set("Content-Type", "text/xml");
        res.status(200).send(`
<Response>
    <Message>${reply}</Message>
</Response>
        `);

    } catch (error) {
        console.error("Webhook Error:", error);

        res.set("Content-Type", "text/xml");
        res.status(200).send(`
<Response>
    <Message>Guka had an error. Try again.</Message>
</Response>
        `);
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).send("Not found");
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka server running on port ${PORT}`);
});