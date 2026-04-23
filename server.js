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

        // CREATE USER
        if (!profile) {
            await supabase.from("user_profiles").insert([
                { user_id: user, step: "name" }
            ]);
            profile = { step: "name" };
        }

        // ===============================
        // ONBOARDING (CONVERSATIONAL)
        // ===============================
        if (!profile.onboarding_complete) {

            let nextStep = profile.step;
            let updates = {};
            let systemPrompt = "";

            // ===============================
            // STEP: NAME
            // ===============================
            if (profile.step === "name") {

                if (!profile.name) {
                    reply = "hey 🙂 what's your name?";
                    nextStep = "name";
                } else {
                    updates = { name: message };
                    nextStep = "age";

                    systemPrompt = `
You are Guka.

Reply like a human friend meeting someone new.
React to their name naturally, slightly playful.

Then smoothly ask for their age.
Do NOT sound like a form.
`;

                }
            }

            // ===============================
            // STEP: AGE
            // ===============================
            else if (profile.step === "age") {

                updates = { age: message };
                nextStep = "goal";

                systemPrompt = `
You are Guka.

React to the user's age casually.
Then naturally transition into asking about their goals.

Style:
- relaxed
- slightly teasing
- like a peer
- not robotic

Combine reaction + question naturally.
`;
            }

            // ===============================
            // STEP: GOAL
            // ===============================
            else if (profile.step === "goal") {

                updates = { main_goal: message };
                nextStep = "struggle";

                systemPrompt = `
You are Guka.

User just told you their goal.

Respond like:
- you understand ambition
- slight challenge tone
- not impressed too easily

Then ask:
What's actually stopping them?

Keep it conversational, not interview-like.
`;
            }

            // ===============================
            // STEP: STRUGGLE
            // ===============================
            else if (profile.step === "struggle") {

                updates = {
                    struggle: message,
                    onboarding_complete: true
                };
                nextStep = "done";

                systemPrompt = `
You are Guka.

User just told you what's holding them back.

Respond like:
- you see through them
- calm but sharp
- slightly confrontational (not rude)

Then end onboarding with something like:
"alright... now we fix it"

Keep it short and powerful.
`;
            }

            // ===============================
            // AI RESPONSE (for onboarding steps except first)
            // ===============================
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

            // SAVE DATA + STEP
            await supabase
                .from("user_profiles")
                .update({
                    ...updates,
                    step: nextStep
                })
                .eq("user_id", user);

            res.set("Content-Type", "text/xml");
            return res.send(`
<Response>
    <Message>${reply}</Message>
</Response>
            `);
        }

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
        // AGE-BASED PERSONALITY
        // ===============================
        const age = parseInt(profile.age || "20");

        let tone = "";

        if (age <= 25) {
            tone = `
Talk like a peer.
Casual, modern, slight slang.
Like a friend who keeps it real.
`;
        } else {
            tone = `
Talk like a focused coach.
Calm, sharp, structured.
Less slang.
`;
        }

        const systemPrompt = `
You are Guka — a lock-in coach.

Personality:
- Direct
- Observant
- Slightly challenging
- Not overly nice
- Keeps things real

You:
- push action
- call out excuses
- remind users of their goals

User:
Name: ${profile.name}
Goal: ${profile.main_goal}
Struggle: ${profile.struggle}

Tone:
${tone}

Rules:
- Keep responses short
- No long paragraphs
- Feel like texting, not lecturing
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
            { user_id: user, role: "user", content: message },
            { user_id: user, role: "assistant", content: reply }
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log("Guka running");
});