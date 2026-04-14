const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ===============================
// CLIENTS
// ===============================
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// ===============================
// MIDDLEWARE
// ===============================
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===============================
// HEALTH CHECK
// ===============================
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

        // ===============================
        // PERSONALITY SYSTEM
        // ===============================
        let mode = "balanced";

        if (message.toLowerCase().startsWith("personality:")) {
            mode = message.replace("personality:", "").trim();

            res.set("Content-Type", "text/xml");
            return res.send(`
<Response>
    <Message>Personality set to: ${mode}</Message>
</Response>
            `);
        }

        // ===============================
        // SYSTEM PROMPT (PERSONALITY)
        // ===============================
        let systemPrompt = "";

        if (mode === "strict") {
            systemPrompt =
                "You are Guka. Extremely direct, no excuses, push discipline hard. Use slight modern slang.";
        } 
        else if (mode === "chill") {
            systemPrompt =
                "You are Guka. Friendly, relaxed, supportive Gen Z tone.";
        } 
        else {
            systemPrompt =
                "You are Guka. A 20-year-old brutally honest but friendly productivity coach. Use light modern slang, be direct, no fluff.";
        }

        // ===============================
        // GOAL CREATION
        // ===============================
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

        // ===============================
        // MARK DONE (STREAK SYSTEM)
        // ===============================
        else if (message.toLowerCase().startsWith("done:")) {
            const goalText = message.replace("done:", "").trim();

            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user)
                .eq("goal", goalText)
                .single();

            if (!data) {
                reply = "Goal not found. Create it first.";
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

        // ===============================
        // VIEW GOALS
        // ===============================
        else if (message.toLowerCase().includes("my goals")) {
            const { data } = await supabase
                .from("streaks")
                .select("*")
                .eq("user_id", user);

            const list = (data || [])
                .map(g => `- ${g.goal} | 🔥 ${g.streak_count} days`)
                .join("\n");

            reply = list ? `Your goals:\n${list}` : "No goals yet.";
        }

        // ===============================
        // AI MEMORY CHAT (FALLBACK)
        // ===============================
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
                        content: systemPrompt
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

        // ===============================
        // RESPONSE
        // ===============================
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
    <Message>Guka error. Try again.</Message>
</Response>
        `);
    }
});

// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Guka running on port ${PORT}`);
});