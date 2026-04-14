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

// Twilio config
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Health check
app.get("/", (req, res) => {
    res.send("Guka is running");
});

// ===============================
// MOTIVATION ENGINE
// ===============================
function getMotivation(streak) {
    if (streak >= 7) return "Elite discipline. Don’t break the chain.";
    if (streak >= 3) return "Good momentum. Keep going.";
    return "Start small. One action today.";
}

// ===============================
// WHATSAPP WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "";
        const message = req.body.Body || "";

        let reply = "";

        // Save user activity (for inactivity tracking)
        await supabase.from("users").upsert({
            user_id: user,
            last_active: new Date().toISOString()
        });

        // GOAL CREATE
        if (message.toLowerCase().startsWith("goal:")) {
            const goalText = message.replace("goal:", "").trim();

            await supabase.from("goals").insert([
                { user_id: user, goal: goalText }
            ]);

            await supabase.from("streaks").upsert({
                user_id: user,
                goal: goalText,
                streak_count: 0,
                last_updated: new Date().toISOString().split("T")[0]
            });

            reply = `Goal set: ${goalText}`;
        }

        // DONE
        else if (message.toLowerCase().startsWith("done:")) {
            const goalText = message.replace("done:", "").trim();

            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user)
                .eq("goal", goalText)
                .single();

            if (!data) {
                reply = "Goal not found.";
            } else {
                const today = new Date().toISOString().split("T")[0];

                let streak = data.streak_count;

                if (data.last_updated !== today) {
                    streak += 1;
                }

                await supabase
                    .from("streaks")
                    .update({
                        streak_count: streak,
                        last_updated: today
                    })
                    .eq("id", data.id);

                reply = `🔥 Streak: ${streak} days\n${getMotivation(streak)}`;
            }
        }

        // VIEW GOALS
        else if (message.toLowerCase().includes("my goals")) {
            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user);

            const list = (data || [])
                .map(g => `- ${g.goal} | 🔥 ${g.streak_count}`)
                .join("\n");

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
                        content: "You are Guka, a strict discipline coach. Push users to take action and build consistency."
                    },
                    ...memory,
                    { role: "user", content: message }
                ]
            });

            reply = completion.choices[0].message.content;
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
// PROACTIVE MOTIVATION SYSTEM
// ===============================
cron.schedule("0 18 * * *", async () => {
    console.log("Running proactive motivation...");

    const { data: users } = await supabase.from("users").select("*");

    if (!users) return;

    for (const u of users) {
        const lastActive = new Date(u.last_active || 0);
        const now = new Date();

        const hoursInactive = (now - lastActive) / (1000 * 60 * 60);

        // If inactive for 6+ hours → send motivation
        if (hoursInactive >= 6) {
            const message = "Guka check-in: You’re off track. Take one action right now. Discipline is built today.";

            try {
                await axios.post(
                    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
                    new URLSearchParams({
                        To: u.user_id,
                        From: TWILIO_NUMBER,
                        Body: message
                    }),
                    {
                        auth: {
                            username: TWILIO_SID,
                            password: TWILIO_AUTH
                        }
                    }
                );
            } catch (err) {
                console.error("Failed to message:", u.user_id);
            }
        }
    }
});

// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});