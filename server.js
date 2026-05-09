const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

const app = express();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("Guka is running");
});

function escapeXml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function twiml(messages) {
  const arr = Array.isArray(messages) ? messages : [messages];

  return `
<Response>
${arr
  .filter(Boolean)
  .slice(0, 5)
  .map((m) => `  <Message>${escapeXml(m)}</Message>`)
  .join("\n")}
</Response>`;
}

function cleanMessage(message) {
  return (message || "").trim();
}

function looksLikeIntro(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("what even is guka") ||
    msg.includes("what is guka") ||
    msg.includes("who is guka") ||
    msg.includes("what even is tomo") ||
    ["hi", "hey", "yo", "hello", "sup"].includes(msg)
  );
}

async function classifyAndExtract(message, profile, memory) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Return JSON only.

Analyze the latest user message and extract only what the user clearly said.

Schema:
{
  "mood": "lazy | stressed | confident | confused | emotional | neutral",
  "action": "action_commit | action_done | no_action",
  "intent": "food | workout | relationship | school | money | schedule | reminder | accountability | normal",
  "new_goal": "string or null",
  "new_reason": "string or null",
  "new_struggle": "string or null",
  "new_routine": "string or null",
  "important_memory": "string or null"
}

Rules:
- Do not invent details.
- Do not use example conversation details.
- Extract only from this user's current message.
`
        },
        {
          role: "user",
          content: `
Current saved profile:
${JSON.stringify(profile || {}, null, 2)}

Recent memory:
${JSON.stringify((memory || []).slice(-6), null, 2)}

Latest message:
${message}
`
        }
      ]
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error("Classification error:", error);
    return {
      mood: "neutral",
      action: "no_action",
      intent: "normal",
      new_goal: null,
      new_reason: null,
      new_struggle: null,
      new_routine: null,
      important_memory: null
    };
  }
}

async function analyzeImageFromTwilio(mediaUrl, caption) {
  try {
    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      }
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    const base64Image = Buffer.from(response.data).toString("base64");
    const dataUrl = `data:${contentType};base64,${base64Image}`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Guka analyzing a WhatsApp image.

If it is food:
- Identify it.
- Estimate calories as a rough range.
- Clearly say it is an estimate.
- Give one practical note.

If it is gym or workout related:
- React like an accountability friend.
- Comment only on what is visible.
- Do not pretend to know exact details.

Style:
- Short WhatsApp messages.
- Real friend energy.
- No em dashes.
- No lecture.
`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: caption || "Analyze this image like Guka."
            },
            {
              type: "image_url",
              image_url: { url: dataUrl }
            }
          ]
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Image analysis error:", error);
    return "I got the image, but I couldn’t read it properly. Send it again with a quick caption.";
  }
}

async function generateGukaMessages({
  message,
  profile,
  memory,
  mood,
  intent,
  actionType,
  pattern,
  executionRate,
  streak,
  inactivity,
  conversationMode
}) {
  const ageNum = parseInt(String(profile?.age || "").replace(/\D/g, ""), 10);

  const peerTone =
    ageNum && ageNum <= 25
      ? "Talk like a peer. Young adult energy. Natural slang is allowed."
      : "Talk like a sharp, grounded friend. Less slang, still direct.";

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You are Guka.

You are not a formal assistant.
You are not a questionnaire.
You are a lock-in friend who helps people understand themselves, build discipline, and stay accountable.

Return JSON only:
{
  "messages": ["message 1", "message 2", "message 3"]
}

Use 1 to 5 short messages.
Each message should feel like a separate WhatsApp text.
Do not use em dashes.
Do not use numbered lists unless the user specifically asks for a plan.
Do not over-help too early.
Do not end with vague lines like "we can map it out together."
Do not say the same intro every time.
Do not use the developer's personal life, routines, or example story.
Only use THIS user's profile and messages.

Core rhythm:
1. React first.
2. Show you understand what they said.
3. Go one layer deeper.
4. Ask one strong natural question OR push one next action.

The most important rule:
If the user shares goals, do not immediately make a plan.
First ask WHY it matters.
Then ask what has been stopping them.
Then use those answers to build accountability.

Good style:
"Okay now we’re talking"

"That combo tells me you already know the problem"

"But what’s making you wanna change this now?"

"Like what’s the real reason behind it"

"Not judging you, just being real"

"That’s the pattern we need to break"

Bad style:
"Here are 3 steps"
"Let’s break this down"
"Got something specific you want to tackle?"
"How can I assist you?"
"Based on your goals..."

Saved user profile:
Name: ${profile?.name || "unknown"}
Age: ${profile?.age || "unknown"}
Main goal: ${profile?.main_goal || "unknown"}
Reason or deeper motivation: ${profile?.mood || "unknown"}
Main struggle: ${profile?.struggle || "unknown"}

Current state:
Conversation mode: ${conversationMode}
Mood: ${mood}
Intent: ${intent}
Action type: ${actionType}
Pattern: ${pattern}
Execution rate: ${executionRate}
Streak: ${streak}
Inactivity: ${inactivity}

Tone:
${peerTone}

Safety:
If the user seems overwhelmed, calm them down before pushing.
If the user mentions alcohol, push moderation and discipline. Do not encourage drinking.
If the user mentions immediate danger or self-harm, tell them to contact local emergency help or a trusted person.
`
      },
      ...(memory || []).map((m) => ({
        role: m.role,
        content: m.content
      })),
      {
        role: "user",
        content: message
      }
    ]
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    return Array.isArray(parsed.messages) && parsed.messages.length
      ? parsed.messages
      : ["I hear you. Say more."];
  } catch {
    return [completion.choices[0].message.content];
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const user = req.body.From || "";
    const message = cleanMessage(req.body.Body);
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 || "" : "";

    if (!user) {
      return res.send(twiml("Something’s off with your number. Try again."));
    }

    let { data: profile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    if (!profile) {
      await supabase.from("user_profiles").insert([
        {
          user_id: user,
          step: "intro",
          onboarding_complete: false,
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]);

      profile = {
        user_id: user,
        step: "intro",
        onboarding_complete: false
      };
    }

    const previousLastActive = profile.last_active;

    await supabase
      .from("user_profiles")
      .update({
        last_active: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("user_id", user);

    const { data: memory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(18);

    // Image handling
    if (mediaUrl && mediaType.startsWith("image/") && profile.onboarding_complete) {
      const imageReply = await analyzeImageFromTwilio(mediaUrl, message);

      await supabase.from("messages").insert([
        { user_id: user, role: "user", content: message || "[image]" },
        { user_id: user, role: "assistant", content: imageReply }
      ]);

      return res.send(twiml(imageReply));
    }

    // Natural intro and discovery flow
    if (!profile.onboarding_complete) {
      let nextStep = profile.step || "intro";
      let updates = {};
      let replyMessages = [];

      if (nextStep === "intro") {
        nextStep = "name";

        replyMessages = [
          "Yo 🤨",
          "Another person tryna lock in huh?",
          "I’ll explain in a sec but first, what’s your name?"
        ];
      }

      else if (nextStep === "name") {
        updates.name = message;
        nextStep = "age";

        const generated = await generateGukaMessages({
          message,
          profile: { ...profile, name: message },
          memory,
          mood: "neutral",
          intent: "onboarding",
          actionType: "no_action",
          pattern: "new_user",
          executionRate: 0,
          streak: 0,
          inactivity: "active",
          conversationMode:
            "User just gave their name. React naturally to the name, then ask age casually. Do not sound like a form."
        });

        replyMessages = generated;
      }

      else if (nextStep === "age") {
        updates.age = message;
        nextStep = "goal";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, age: message },
          memory,
          mood: "neutral",
          intent: "onboarding",
          actionType: "no_action",
          pattern: "new_user",
          executionRate: 0,
          streak: 0,
          inactivity: "active",
          conversationMode:
            "User just gave age. React briefly, then ask what they are trying to fix, build, or improve. Make it broad and natural."
        });
      }

      else if (nextStep === "goal") {
        updates.main_goal = message;
        nextStep = "reason";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, main_goal: message },
          memory,
          mood: "neutral",
          intent: "goal_discovery",
          actionType: "action_commit",
          pattern: "new_user_goal",
          executionRate: 0,
          streak: 0,
          inactivity: "active",
          conversationMode:
            "User shared goals. Do NOT create a plan yet. React to the goals, summarize the pattern, then ask what is making them want to change right now or what the real reason is."
        });
      }

      else if (nextStep === "reason") {
        updates.mood = message;
        nextStep = "struggle";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, mood: message },
          memory,
          mood: "emotional",
          intent: "deeper_reason",
          actionType: "no_action",
          pattern: "motivation_discovery",
          executionRate: 0,
          streak: 0,
          inactivity: "active",
          conversationMode:
            "User explained why their goals matter. Respect their honesty, go one layer deeper, then ask what has actually been stopping them. Do not give a plan yet."
        });
      }

      else if (nextStep === "struggle") {
        updates.struggle = message;
        updates.onboarding_complete = true;
        nextStep = "active";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, struggle: message },
          memory,
          mood: "emotional",
          intent: "struggle_discovery",
          actionType: "no_action",
          pattern: "core_pattern_found",
          executionRate: 0,
          streak: 0,
          inactivity: "active",
          conversationMode:
            "User revealed what has been stopping them. React deeply, identify the pattern, then transition into locking in. Ask what first commitment they want to make today."
        });
      }

      updates.step = nextStep;
      updates.updated_at = new Date().toISOString();

      await supabase
        .from("user_profiles")
        .update(updates)
        .eq("user_id", user);

      await supabase.from("messages").insert([
        { user_id: user, role: "user", content: message || "[start]" },
        { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
      ]);

      return res.send(twiml(replyMessages));
    }

    // Refresh profile
    const { data: refreshedProfile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    profile = refreshedProfile || profile;

    // Commands
    if (message.toLowerCase().startsWith("goal:")) {
      const goalText = message.replace(/goal:/i, "").trim();

      await supabase.from("goals").insert([
        {
          user_id: user,
          goal: goalText,
          status: "active"
        }
      ]);

      return res.send(twiml(["Locked.", `Goal saved: ${goalText}`]));
    }

    if (message.toLowerCase().includes("my goals")) {
      const { data: goals } = await supabase
        .from("goals")
        .select("*")
        .eq("user_id", user)
        .eq("status", "active");

      if (!goals || goals.length === 0) {
        return res.send(
          twiml("You don’t have saved goals yet. Send one like:\n\ngoal: gym 5x a week")
        );
      }

      const list = goals.map((g, i) => `${i + 1}. ${g.goal}`).join("\n");

      return res.send(twiml(`Here’s what we’re tracking:\n\n${list}`));
    }

    const analysis = await classifyAndExtract(message, profile, memory);
    const mood = analysis.mood || "neutral";
    const actionType = analysis.action || "no_action";
    const intent = analysis.intent || "normal";

    await supabase.from("messages").insert([
      { user_id: user, role: "mood", content: mood },
      { user_id: user, role: "action", content: actionType }
    ]);

    // Silently update profile if the user revealed important info
    const profileUpdates = {};
    if (analysis.new_goal && !profile.main_goal) profileUpdates.main_goal = analysis.new_goal;
    if (analysis.new_reason && !profile.mood) profileUpdates.mood = analysis.new_reason;
    if (analysis.new_struggle && !profile.struggle) profileUpdates.struggle = analysis.new_struggle;
    if (Object.keys(profileUpdates).length > 0) {
      profileUpdates.updated_at = new Date().toISOString();

      await supabase
        .from("user_profiles")
        .update(profileUpdates)
        .eq("user_id", user);
    }

    if (analysis.new_goal) {
      await supabase.from("goals").insert([
        {
          user_id: user,
          goal: analysis.new_goal,
          status: "active"
        }
      ]);
    }

    if (analysis.important_memory) {
      await supabase.from("messages").insert([
        {
          user_id: user,
          role: "memory",
          content: analysis.important_memory
        }
      ]);
    }

    // Mood pattern
    const { data: moodHistory } = await supabase
      .from("messages")
      .select("content")
      .eq("user_id", user)
      .eq("role", "mood")
      .order("created_at", { ascending: false })
      .limit(20);

    const moods = (moodHistory || []).map((m) => m.content);
    const lazyCount = moods.filter((m) => m === "lazy").length;
    const stressedCount = moods.filter((m) => m === "stressed").length;
    const emotionalCount = moods.filter((m) => m === "emotional").length;

    let pattern = "normal";
    if (lazyCount >= 5) pattern = "repeated_slacking";
    if (stressedCount >= 5) pattern = "burnout_risk";
    if (emotionalCount >= 4) pattern = "emotionally_distracted";

    // Action pattern
    const { data: actionHistory } = await supabase
      .from("messages")
      .select("content")
      .eq("user_id", user)
      .eq("role", "action")
      .order("created_at", { ascending: false })
      .limit(20);

    const actions = (actionHistory || []).map((a) => a.content);
    const commits = actions.filter((a) => a === "action_commit").length;
    const done = actions.filter((a) => a === "action_done").length;
    const executionRate = commits > 0 ? Number((done / commits).toFixed(2)) : 0;

    // Streak
    const { data: streakData } = await supabase
      .from("streaks")
      .select("*")
      .eq("user_id", user)
      .single();

    let streak = streakData?.current_streak || 0;
    let lastDate = streakData?.last_action_date || null;
    const today = new Date().toISOString().split("T")[0];

    if (actionType === "action_done") {
      if (!lastDate) {
        streak = 1;
      } else if (lastDate !== today) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yDate = yesterday.toISOString().split("T")[0];

        streak = lastDate === yDate ? streak + 1 : 1;
      }

      await supabase.from("streaks").upsert({
        user_id: user,
        current_streak: streak,
        last_action_date: today
      });
    }

    // Inactivity
    const now = new Date();
    const lastActive = new Date(previousLastActive || now);
    const diffDays = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);

    let inactivity = "active";
    if (diffDays >= 2) inactivity = "ghosted";
    else if (diffDays >= 1) inactivity = "quiet";

    const { data: latestMemory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(18);

    const replyMessages = await generateGukaMessages({
      message,
      profile,
      memory: latestMemory || memory,
      mood,
      intent,
      actionType,
      pattern,
      executionRate,
      streak,
      inactivity,
      conversationMode:
        "Active conversation. Respond naturally based on the user's actual message. Do not use lists unless requested. If they shared emotion, probe deeper. If they made a commitment, hold them to it. If they are vague, ask for the real plan."
    });

    await supabase.from("messages").insert([
      { user_id: user, role: "user", content: message },
      { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
    ]);

    return res.send(twiml(replyMessages));
  } catch (error) {
    console.error("Webhook error:", error);
    return res.send(twiml("Guka is bugging right now. Try again in a sec."));
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Guka running on port " + PORT);
});