const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// OpenAI
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get("/", (req, res) => {
    res.send("Guka is running");
});

// WhatsApp webhook
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "unknown";
        const message = req.body.Body || "";

        console.log("User:", user);
        console.log("Message:", message);

        // 1. Save user message to Supabase
        await supabase.from("messages").insert([
            {
                user_id: user,
                role: "user",
                content: message
            }
        ]);

        // 2. Get last 20 messages for memory
        const { data, error } = await supabase
            .from("messages")
            .select("*")
            .eq("user_id", user)
            .order("created_at", { ascending: true })
            .limit(20);

        if (error) {
            console.error("Supabase error:", error);
        }

        const recentMemory = (data || []).map(m => ({
            role: m.role,
            content: m.content
        }));

        // 3. Call OpenAI
        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are Guka, a strict but supportive productivity coach. You remember user goals and follow up on them. Keep responses short, direct, and actionable."
                },
                ...recentMemory
            ]
        });

        const reply = completion.choices[0].message.content;

        // 4. Save AI response
        await supabase.from("messages").insert([
            {
                user_id: user,
                role: "assistant",
                content: reply
            }
        ]);

        // 5. Respond to WhatsApp (Twilio XML)
        res.set("Content-Type", "text/xml");
        res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
        `);

    } catch (error) {
        console.error("Webhook error:", error);

        res.set("Content-Type", "text/xml");
        res.send(`
<Response>
    <Message>Guka error. Try again.</Message>
</Response>
        `);
    }
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});