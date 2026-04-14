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
// WHATSAPP WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "";
        const message = req.body.Body || "";

        let reply = "";

        // ===========================
        // 1. CREATE GOAL
        // ===========================
        if (message.toLowerCase().startsWith("goal:")) {
            const goalText = message.replace("goal:", "").trim();

            await supabase.from("goals").insert([
                { user_id: user, goal: goalText }
            ]);

            // create streak entry
            await supabase.from("streaks").upsert({
                user_id: user,
                goal: goalText,
                streak_count: 0,
                last_updated: new Date()
            });

            reply = `Goal added: ${goalText}`;
        }

        // ===========================
        // 2. COMPLETE GOAL (STREAK LOGIC)
        // ===========================
        else if (message.toLowerCase().startsWith("done:")) {
            const goalText = message.replace("done:", "").trim();

            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user)
                .eq("goal", goalText)
                .single();

            if (data) {
                const today = new Date().toISOString().split("T")[0];
                const last = data.last_updated;

                let newStreak = data.streak_count;

                if (last !== today) {
                    newStreak += 1;
                }

                await supabase
                    .from("streaks")
                    .update({
                        streak_count: newStreak,
                        last_updated: today
                    })
                    .eq("id", data.id);

                reply = `Good job! 🔥 Streak for "${goalText}" is now ${newStreak} days.`;
            } else {
                reply = "Goal not found. Use goal: to create it first.";
            }
        }

        // ===========================
        // 3. VIEW GOALS + STREAKS
        // ===========================
        else if (message.toLowerCase().includes("my goals")) {
            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user);

            const list = (data || [])
                .map(g => `- ${g.goal} | 🔥 ${g.streak_count} day streak`)
                .join("\n");

            reply = list ? `Your goals:\n${list}` : "No goals yet.";
        }

        // ===========================
        // 4. AI CHAT (FALLBACK)
        // ===========================
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
                        content: "You are Guka, a strict productivity coach. Push users to build consistency and streaks. Keep responses short."
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

        // ===========================
        // RESPONSE
        // ===========================
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
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});