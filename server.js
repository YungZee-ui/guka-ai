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
// SMART QUESTION ENGINE
// ===============================
function getNextQuestion(profile, message) {
    const goal = message.toLowerCase();

    // STEP 1: NAME
    if (!profile.name) {
        return {
            nextStep: "name",
            reply: "Yo. What’s your name?"
        };
    }

    // STEP 2: GOAL (BRANCHING STARTS HERE)
    if (!profile.main_goal) {

        if (goal.includes("money") || goal.includes("make money")) {
            return {
                nextStep: "main_goal",
                reply: "Got it. What's stopping you right now? skills, discipline, or direction?"
            };
        }

        if (goal.includes("fitness") || goal.includes("gym")) {
            return {
                nextStep: "main_goal",
                reply: "Be honest — are you a beginner or just inconsistent right now?"
            };
        }

        return {
            nextStep: "main_goal",
            reply: "What’s your main goal right now?"
        };
    }

    // STEP 3: STRUGGLE (BRANCHING)
    if (!profile.struggle) {
        return {
            nextStep: "struggle",
            reply: "What’s actually holding you back?"
        };
    }

    return {
        nextStep: "done",
        reply: "Perfect. I’ve got you now."
    };
}

// ===============================
// WEBHOOK
// ===============================
app.post("/webhook", async (req, res) => {
    try {
        const user = req.body.From || "";
        const message = req.body.Body || "";

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
        // ONBOARDING FLOW (SMART BRANCHING)
        // ===============================
        if (!profile.onboarding_complete) {

            const result = getNextQuestion(profile, message);

            // Save answer based on step
            if (profile.step === "name") {
                await supabase
                    .from("user_profiles")
                    .update({
                        name: message,
                        step: result.nextStep
                    })
                    .eq("user_id", user);
            }

            else if (profile.step === "main_goal") {
                await supabase
                    .from("user_profiles")
                    .update({
                        main_goal: message,
                        step: result.nextStep
                    })
                    .eq("user_id", user);
            }

            else if (profile.step === "struggle") {
                await supabase
                    .from("user_profiles")
                    .update({
                        struggle: message,
                        step: "done",
                        onboarding_complete: true
                    })
                    .eq("user_id", user);
            }

            res.set("Content-Type", "text/xml");
            return res.send(`
<Response>
    <Message>${result.reply}</Message>
</Response>
            `);
        }

        // ===============================
        // NORMAL AI MODE
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

User:
- Name: ${userData?.name}
- Goal: ${userData?.main_goal}
- Struggle: ${userData?.struggle}

Style:
- 20-year-old Gen Z coach
- brutally honest but friendly
- short replies
- modern slang
- pushes discipline
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

        const reply = completion.choices[0].message.content;

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