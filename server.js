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

// ===============================
// WHATSAPP WEBHOOK (CORE LOGIC)
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "unknown";
        const message = req.body.Body || "";

        console.log("User:", user);
        console.log("Message:", message);

        let reply = "";

        // ===========================
        // 1. CREATE GOAL
        // ===========================
        if (message.toLowerCase().startsWith("goal:")) {
            const goalText = message.replace("goal:", "").trim();

            await supabase.from("goals").insert([
                {
                    user_id: user,
                    goal: goalText
                }
            ]);

            reply = `Goal saved: ${goalText}`;
        }

        // ===========================
        // 2. VIEW GOALS
        // ===========================
        else if (message.toLowerCase().includes("my goals")) {
            const { data } = await supabase
                .from("goals")
                .select("*")
                .eq("user_id", user)
                .eq("status", "active");

            const list = (data || [])
                .map(g => `- ${g.goal}`)
                .join("\n");

            reply = list ? `Your goals:\n${list}` : "You have no goals yet.";
        }

        // ===========================
        // 3. AI CHAT + MEMORY
        // ===========================
        else {
            // Save message to DB
            await supabase.from("messages").insert([
                {
                    user_id: user,
                    role: "user",
                    content: message
                }
            ]);

            // Get memory
            const { data } = await supabase
                .from("messages")
                .select("*")
                .eq("user_id", user)
                .order("created_at", { ascending: true })
                .limit(20);

            const memory = (data || []).map(m => ({
                role: m.role,
                content: m.content
            }));

            // AI response
            const completion = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are Guka, a strict but supportive productivity coach. You help users stay disciplined, achieve goals, and avoid procrastination. Keep responses short and actionable."
                    },
                    ...memory,
                    { role: "user", content: message }
                ]
            });

            reply = completion.choices[0].message.content;

            // Save AI response
            await supabase.from("messages").insert([
                {
                    user_id: user,
                    role: "assistant",
                    content: reply
                }
            ]);
        }

        // ===========================
        // TWILIO RESPONSE
        // ===========================
        res.set("Content-Type", "text/xml");
        res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
        `);

    } catch (error) {
        console.error("Webhook Error:", error);

        res.set("Content-Type", "text/xml");
        res.send(`
<Response>
    <Message>Guka error. Try again.</Message>
</Response>
        `);
    }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});