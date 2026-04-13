const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const app = express();

// Twilio sends data as URL-encoded form
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check route (Render + browser test)
app.get("/", (req, res) => {
    res.status(200).send("Guka is running");
});

// WhatsApp webhook (MAIN LOGIC)
app.post("/webhook", async (req, res) => {
    try {
        const incomingMessage = req.body.Body || "";
        const userNumber = req.body.From || "unknown";

        console.log("User:", userNumber);
        console.log("Message:", incomingMessage);

        // AI response (OpenAI)
        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are Guka, a strict but supportive productivity coach. You help users stay focused, disciplined, and productive. Keep responses short and actionable."
                },
                {
                    role: "user",
                    content: incomingMessage
                }
            ]
        });

        const reply = completion.choices[0].message.content;

        // Twilio requires XML response
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
    <Message>Guka is having trouble thinking right now. Try again.</Message>
</Response>
        `);
    }
});

// Handle unknown routes
app.use((req, res) => {
    res.status(404).send("Not found");
});

// Start server (Render compatible)
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka server running on port ${PORT}`);
});