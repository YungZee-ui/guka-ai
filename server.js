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
        // GET USER PROFILE
        // ===============================
        let { data: profile } = await supabase
            .from("user_profiles")
            .select("*")
            .eq("user_id", user)
            .single();

        if (!profile) {
            await supabase.from("user_profiles").insert([
                { user_id: user, step: "name" }
            ]);
            profile = { step: "name" };
        }

        // ===============================
        // SAVE LAST ACTIVE
        // ===============================
        await supabase
            .from("user_profiles")
            .update({ last_active: new Date().toISOString() })
            .eq("user_id", user);

        // ===============================
        // ONBOARDING
        // ===============================
        if (!profile.onboarding_complete) {

            let nextStep = profile.step;
            let updates = {};
            let systemPrompt = "";

            if (profile.step === "name") {
                if (!profile.name) {
                    reply = "hey 🙂 what's your name?";
                } else {
                    updates = { name: message };
                    nextStep = "age";

                    systemPrompt = "React to their name naturally, then ask age casually.";
                }
            }

            else if (profile.step === "age") {
                updates = { age: message };
                nextStep = "goal";

                systemPrompt = "React to age casually, then ask their goal.";
            }

            else if (profile.step === "goal") {
                updates = { main_goal: message };
                nextStep = "struggle";

                systemPrompt = "Be slightly skeptical, then ask what’s holding them back.";
            }

            else if (profile.step === "struggle") {
                updates = {
                    struggle: message,
                    onboarding_complete: true
                };
                nextStep = "done";

                systemPrompt = "Acknowledge struggle, challenge them, end with strong line.";
            }

            if (systemPrompt) {
                const completion = await client.chat.completions.create({
                    model: "gpt-4o-mini",
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: message }
                    ]
                });

                reply = completion.choices[0].message.content;
            }

            await supabase
                .from("user_profiles")
                .update({ ...updates, step: nextStep })
                .eq("user_id", user);

            return res.send(`<Response><Message>${reply}</Message></Response>`);
        }

        // ===============================
        // MOOD DETECTION
        // ===============================
        const moodCheck = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Return one: lazy, stressed, confident, confused, neutral"
                },
                { role: "user", content: message }
            ]
        });

        const mood = moodCheck.choices[0].message.content.trim().toLowerCase();

        await supabase.from("messages").insert([
            { user_id: user, role: "mood", content: mood }
        ]);

        // ===============================
        // ACTION DETECTION
        // ===============================
        const actionCheck = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "Return one: action_commit, action_done, no_action"
                },
                { role: "user", content: message }
            ]
        });

        const actionType = actionCheck.choices[0].message.content.trim().toLowerCase();

        await supabase.from("messages").insert([
            { user_id: user, role: "action", content: actionType }
        ]);

        // ===============================
        // MOOD PATTERN
        // ===============================
        const { data: moodHistory } = await supabase
            .from("messages")
            .select("content")
            .eq("user_id", user)
            .eq("role", "mood")
            .limit(20);

        const moods = (moodHistory || []).map(m => m.content);

        let pattern = "normal";
        if (moods.filter(m => m === "lazy").length >= 5) pattern = "lazy_pattern";
        if (moods.filter(m => m === "stressed").length >= 5) pattern = "burnout";

        // ===============================
        // ACTION PATTERN
        // ===============================
        const { data: actionHistory } = await supabase
            .from("messages")
            .select("content")
            .eq("user_id", user)
            .eq("role", "action")
            .limit(20);

        const actions = (actionHistory || []).map(a => a.content);

        const commits = actions.filter(a => a === "action_commit").length;
        const done = actions.filter(a => a === "action_done").length;

        const executionRate = commits > 0 ? done / commits : 0;

        // ===============================
        // STREAK SYSTEM
        // ===============================
        const { data: streakData } = await supabase
            .from("streaks")
            .select("*")
            .eq("user_id", user)
            .single();

        let streak = streakData?.current_streak || 0;
        let lastDate = streakData?.last_action_date;
        const today = new Date().toISOString().split("T")[0];

        if (actionType === "action_done") {
            if (lastDate !== today) {
                streak = lastDate ? streak + 1 : 1;

                await supabase.from("streaks").upsert({
                    user_id: user,
                    current_streak: streak,
                    last_action_date: today
                });
            }
        }

        // ===============================
        // INACTIVITY
        // ===============================
        const now = new Date();
        const lastActive = new Date(profile.last_active || now);
        const diffDays = (now - lastActive) / (1000 * 60 * 60 * 24);

        let inactivity = "active";
        if (diffDays >= 2) inactivity = "ghosting";
        else if (diffDays >= 1) inactivity = "inactive";

        // ===============================
        // MEMORY
        // ===============================
        const { data: memory } = await supabase
            .from("messages")
            .select("*")
            .eq("user_id", user)
            .order("created_at", { ascending: true })
            .limit(15);

        // ===============================
        // RANDOM BEHAVIOR
        // ===============================
        const rand = Math.random();
        let behaviorHint = rand < 0.5
            ? "Be playful or teasing."
            : "Challenge the user directly.";

        // ===============================
        // FINAL PROMPT
        // ===============================
        const systemPrompt = `
You are Guka. A real person, not a chatbot.

MOOD: ${mood}
PATTERN: ${pattern}
EXECUTION RATE: ${executionRate}
STREAK: ${streak}
INACTIVITY: ${inactivity}

PERSONALITY:
- Sharp
- Observant
- Sometimes sarcastic
- Sometimes supportive
- Always real

RULES:
- Short replies
- Sometimes interrupt
- Sometimes challenge
- Do NOT always ask questions

USER:
Goal: ${profile.main_goal}
Struggle: ${profile.struggle}

EXTRA:
${behaviorHint}
`;

        const completion = await client.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                ...(memory || []).map(m => ({
                    role: m.role,
                    content: m.content
                })),
                { role: "user", content: message }
            ]
        });

        reply = completion.choices[0].message.content;

        // SAVE MEMORY
        await supabase.from("messages").insert([
            { user_id: user, role: "user", content: message },
            { user_id: user, role: "assistant", content: reply }
        ]);

        res.send(`<Response><Message>${reply}</Message></Response>`);

    } catch (err) {
        console.error(err);
        res.send(`<Response><Message>Error</Message></Response>`);
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("Guka running");
});