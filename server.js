const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
    res.send("Guka is running");
});

// ===============================
// WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "";
        const message = req.body.Body || "";

        let reply = "";

        // ===============================
        // CHECK USER PROFILE
        // ===============================
        let { data: profile } = await supabase
            .from("user_profiles")
            .select("*")
            .eq("user_id", user)
            .single();

        // ===============================
        // CREATE PROFILE IF NOT EXISTS
        // ===============================
        if (!profile) {
            await supabase.from("user_profiles").insert([
                {
                    user_id: user,
                    onboarding_complete: false
                }
            ]);

            profile = { onboarding_complete: false };
        }

        // ===============================
        // ONBOARDING FLOW
        // ===============================
        if (!profile.onboarding_complete) {

            if (!profile.name) {
                await supabase
                    .from("user_profiles")
                    .update({ name: message })
                    .eq("user_id", user);

                reply = "Nice. What’s your main goal?";
            }

            else if (!profile.main_goal) {
                await supabase
                    .from("user_profiles")
                    .update({ main_goal: message })
                    .eq("user_id", user);

                reply = "Got it. What are you struggling with right now?";
            }

            else if (!profile.struggle) {
                await supabase
                    .from("user_profiles")
                    .update({ struggle: message, onboarding_complete: true })
                    .eq("user_id", user);

                reply = "Perfect. I’ve got you now. Let’s get to work.";
            }

            res.set("Content-Type", "text/xml");
            return res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
            `);
        }

        // ===============================
        // NORMAL AI MODE (AFTER ONBOARDING)
        // ===============================
        const { data: memory } = await supabase
            .from("messages")
            .select("*")
            .eq("user_id", user)
            .order("created_at", { ascending: true })
            .limit(20);

        const { data: userData } = await supabase
            .from("user_profiles")
            .select("*")
            .eq("user_id", user)
            .single();

        const systemPrompt = `
You are Guka.

User info:
- Name: ${userData?.name}
- Main goal: ${userData?.main_goal}
- Struggle: ${userData?.struggle}

Personality:
- 20-year-old Gen Z productivity coach
- brutally honest but friendly
- modern slang
- short messages
- pushes discipline
`;

        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                ...(memory || []).map(m => ({
                    role: m.role,
                    content: m.content
                })),
                { role: "user", content: message }
            ]
        });

        reply = completion.choices[0].message.content;

        await supabase.from("messages").insert([
            {
                user_id: user,
                role: "assistant",
                content: reply
            }
        ]);

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
    <Message>Guka error</Message>
</Response>
        `);
    }
});

// ===============================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log("Guka running");
});