const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const cron = require("node-cron");
const axios = require("axios");

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

// Twilio credentials
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get("/", (req, res) => {
    res.send("Guka is running");
});

// ===============================
// WHATSAPP WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "";
        const message = req.body.Body || "";

        let reply = "";

        // Save user if new
        await supabase.from("users").upsert({
            user_id: user,
            last_checkin: new Date()
        });

        // Goal handling
        if (message.toLowerCase().startsWith("goal:")) {
            const goalText = message.replace("goal:", "").trim();

            await supabase.from("goals").insert([
                { user_id: user, goal: goalText }
            ]);

            reply = `Goal saved: ${goalText}`;
        }

        else if (message.toLowerCase().includes("my goals")) {
            const { data } = await supabase
                .from("goals")
                .select("*")
                .eq("user_id", user)
                .eq("status", "active");

            const list = (data || []).map(g => `- ${g.goal}`).join("\n");

            reply = list ? `Your goals:\n${list}` : "No goals yet.";
        }

        // AI fallback
        else {
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

            const completion = await client.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are Guka, a strict productivity coach. Keep responses short."
                    },
                    ...memory,
                    { role: "user", content: message }
                ]
            });

            reply = completion.choices[0].message.content;

            await supabase.from("messages").insert([
                { user_id: user, role: "assistant", content: reply }
            ]);
        }

        res.set("Content-Type", "text/xml");
        res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
        `);

    } catch (error) {
        console.error(error);

        res.send(`
<Response>
    <Message>Error</Message>
</Response>
        `);
    }
});

// ===============================
// DAILY CHECK-IN SYSTEM
// ===============================
cron.schedule("0 9 * * *", async () => {
    console.log("Running daily check-ins...");

    const { data: users } = await supabase.from("users").select("*");

    if (!users) return;

    for (const user of users) {
        const message = "Daily Check-in: What are you focusing on today? Reply with your goals.";

        try {
            await axios.post(
                `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
                new URLSearchParams({
                    To: user.user_id,
                    From: TWILIO_NUMBER,
                    Body: message
                }),
                {
                    auth: {
                        username: TWILIO_ACCOUNT_SID,
                        password: TWILIO_AUTH_TOKEN
                    }
                }
            );

        } catch (err) {
            console.error("Check-in failed for:", user.user_id);
        }
    }
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});