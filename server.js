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

function twiml(message) {
  return `
<Response>
  <Message>${message}</Message>
</Response>`;
}

async function classifyMood(message) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Classify the user's emotional state. Return ONLY one word: lazy, stressed, confident, confused, neutral"
        },
        { role: "user", content: message }
      ]
    });

    return completion.choices[0].message.content.trim().toLowerCase();
  } catch {
    return "neutral";
  }
}

async function classifyAction(message) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Classify this message. Return ONLY one: action_commit, action_done, no_action"
        },
        { role: "user", content: message }
      ]
    });

    return completion.choices[0].message.content.trim().toLowerCase();
  } catch {
    return "no_action";
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const user = req.body.From || "";
    const message = (req.body.Body || "").trim();

    if (!message) {
      return res.send(twiml("Say something."));
    }

    // =====================
    // LOAD / CREATE PROFILE
    // =====================
    let { data: profile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    if (!profile) {
      await supabase.from("user_profiles").insert([
        {
          user_id: user,
          step: "name"
        }
      ]);

      profile = {
        user_id: user,
        step: "name",
        onboarding_complete: false
      };
    }

    // update activity
    await supabase
      .from("user_profiles")
      .update({
        last_active: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("user_id", user);

    // =====================
    // ONBOARDING
    // =====================
    if (!profile.onboarding_complete) {
      let reply = "";
      let updates = {};
      let nextStep = profile.step;

      if (profile.step === "name") {
        updates.name = message;
        nextStep = "age";

        reply = `good to meet you, ${message}. how old are you?`;
      }

      else if (profile.step === "age") {
        updates.age = message;
        nextStep = "goal";

        reply =
          "nice. so tell me — what are you actually trying to build or improve right now?";
      }

      else if (profile.step === "goal") {
        updates.main_goal = message;
        nextStep = "struggle";

        reply =
          "got it. now be honest — what's actually been stopping you?";
      }

      else if (profile.step === "struggle") {
        updates.struggle = message;
        updates.onboarding_complete = true;
        nextStep = "done";

        reply =
          "alright… now we know the problem. no more hiding from it. let's work.";
      }

      updates.step = nextStep;
      updates.updated_at = new Date().toISOString();

      await supabase
        .from("user_profiles")
        .update(updates)
        .eq("user_id", user);

      return res.send(twiml(reply));
    }

    // refresh profile
    const { data: refreshedProfile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    profile = refreshedProfile;

    // =====================
    // DETECT MOOD / ACTION
    // =====================
    const mood = await classifyMood(message);
    const actionType = await classifyAction(message);

    await supabase.from("messages").insert([
      {
        user_id: user,
        role: "mood",
        content: mood
      },
      {
        user_id: user,
        role: "action",
        content: actionType
      }
    ]);

    // =====================
    // MOOD HISTORY
    // =====================
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

    let pattern = "normal";

    if (lazyCount >= 5) pattern = "consistent_laziness";
    if (stressedCount >= 5) pattern = "burnout";

    // =====================
    // ACTION HISTORY
    // =====================
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

    const executionRate = commits > 0 ? (done / commits).toFixed(2) : 0;

    // =====================
    // STREAKS
    // =====================
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

    // =====================
    // INACTIVITY
    // =====================
    const now = new Date();
    const lastActive = new Date(profile.last_active || now);

    const diffDays =
      (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);

    let inactivity = "active";

    if (diffDays >= 2) inactivity = "ghosting";
    else if (diffDays >= 1) inactivity = "inactive";

    // =====================
    // MEMORY
    // =====================
    const { data: memory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(12);

    // =====================
    // PERSONALITY MODES
    // =====================
    const rand = Math.random();

    let behaviorHint = "Be sharp.";

    if (rand < 0.25) behaviorHint = "Be playful.";
    else if (rand < 0.5) behaviorHint = "Be direct.";
    else if (rand < 0.75) behaviorHint = "Challenge them.";
    else behaviorHint = "Be calm but observant.";

    let emotionalStyle = "Stay balanced.";

    if (mood === "lazy") emotionalStyle = "Call laziness out directly.";
    if (mood === "stressed") emotionalStyle = "Reduce pressure and simplify.";
    if (mood === "confident") emotionalStyle = "Raise standards.";
    if (mood === "confused") emotionalStyle = "Guide clearly.";

    let patternBehavior = "Normal.";

    if (pattern === "consistent_laziness") {
      patternBehavior = "User keeps slipping. Notice it.";
    }

    if (pattern === "burnout") {
      patternBehavior = "User is overloaded. Slow them down.";
    }

    // =====================
    // FINAL AI RESPONSE
    // =====================
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Guka.

You text like a real person.
You are honest, socially aware, sharp, and slightly unpredictable.

Keep replies short.
Never sound robotic.
Sometimes challenge.
Sometimes joke lightly.
Sometimes interrupt.
Sometimes just react.

User profile:
Name: ${profile.name}
Age: ${profile.age}
Goal: ${profile.main_goal}
Struggle: ${profile.struggle}

Mood: ${mood}
Emotional style: ${emotionalStyle}

Pattern: ${pattern}
Pattern response: ${patternBehavior}

Execution rate: ${executionRate}
Streak: ${streak}
Inactivity: ${inactivity}

Behavior style:
${behaviorHint}
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

    const reply = completion.choices[0].message.content;

    // save memory
    await supabase.from("messages").insert([
      {
        user_id: user,
        role: "user",
        content: message
      },
      {
        user_id: user,
        role: "assistant",
        content: reply
      }
    ]);

    return res.send(twiml(reply));
  } catch (error) {
    console.error(error);
    return res.send(
      twiml("Guka is having trouble thinking right now. Try again.")
    );
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Guka running on port " + PORT);
});