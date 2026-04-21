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
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ===============================
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

        // CREATE IF NOT EXISTS
        if (!profile) {
            await supabase.from("user_profiles").insert([
                { user_id: user, step: "name" }
            ]);

            profile = { step: "name" };
        }

        // ===============================
        // ONBOARDING (STATE-BASED FIX)
        // ===============================
        if (!profile.onboarding_complete) {

            if (profile.step === "name") {
                await supabase
                    .from("user_profiles")
                    .update({
                        name: message,
                        step: "age"
                    })
                    .eq("user_id", user);

                reply = "How old are you?";
            }

            else if (profile.step === "age") {
                await supabase
                    .from("user_profiles")
                    .update({
                        age: message,
                        step: "goal"
                    })
                    .eq("user_id", user);

                reply = "What’s your main goal right now?";
            }

            else if (profile.step === "goal") {
                await supabase
                    .from("user_profiles")
                    .update({
                        main_goal: message,
                        step: "struggle"
                    })
                    .eq("user_id", user);

                reply = "What’s actually holding you back?";
            }

            else if (profile.step === "struggle") {
                await supabase
                    .from("user_profiles")
                    .update({
                        struggle: message,
                        onboarding_complete: true,
                        step: "done"
                    })
                    .eq("user_id", user);

                reply = "Good. Now we lock in.";
            }

            res.set("Content-Type", "text/xml");
            return res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
            `);
        }

        // ===============================
        // FETCH MEMORY
        // ===============================
        const { data: memory } = await supabase
            .from("messages")
            .select("*")
            .eq("user_id", user)
            .order("created_at", { ascending: true })
            .limit(15);

        // ===============================
        // PERSONALITY SYSTEM (FROM YOUR DOC)
        // ===============================
        const age = parseInt(profile.age || "20");

        let tone = "";

        if (age <= 25) {
            tone = `
Speak like a peer (same age).
Casual, direct, slight slang.
Feels like a friend holding you accountable.
`;
        } else {
            tone = `
Speak like a disciplined coach.
Calm, firm, slightly strict.
No slang. More structured.
`;
        }

        const systemPrompt = `
You are Guka — The Lock-In Coach.

Core behavior:
- Direct and accountability-driven
- You remind users what they said they would do
- You check progress
- You push when they slack

Tone:
- Calm, firm, solution-focused
- Not emotional, not hype
- Slightly strict but supportive

Function:
- Act like a productivity coach + accountability system
- Reinforce habits
- Keep users consistent

User:
Name: ${profile.name}
Age: ${profile.age}
Goal: ${profile.main_goal}
Struggle: ${profile.struggle}

Extra tone rule:
${tone}

Rules:
- Keep replies short
- No long paragraphs
- Ask questions when needed
- Push action
`;

        // ===============================
        // AI RESPONSE
        // ===============================
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
            {
                user_id: user,
                role: "assistant",
                content: reply
            }
        ]);

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