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

function twiml(message) {
  return `<Response><Message>${escapeXml(message)}</Message></Response>`;
}

function cleanMessage(message) {
  return (message || "").trim();
}

function isIntroQuestion(message) {
  const msg = message.toLowerCase();
  return (
    msg.includes("what even is guka") ||
    msg.includes("what is guka") ||
    msg.includes("who is guka") ||
    msg.includes("what even is tomo") ||
    msg === "hi" ||
    msg === "hey" ||
    msg === "yo" ||
    msg === "hello"
  );
}

async function classifyMessage(message) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Return JSON only:
{
  "mood": "lazy | stressed | confident | confused | emotional | neutral",
  "action": "action_commit | action_done | no_action",
  "intent": "food | workout | relationship | school | money | schedule | reminder | accountability | normal"
}
`
        },
        { role: "user", content: message }
      ]
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch {
    return {
      mood: "neutral",
      action: "no_action",
      intent: "normal"
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
You are Guka analyzing an image sent on WhatsApp.

If it is food:
- Identify the food.
- Estimate calories as a rough range.
- Say it is an estimate, not exact.
- Give one practical comment.

If it is gym/workout:
- React like an accountability coach.
- Mention effort/setup if visible.
- Do not pretend to know details you cannot see.

Tone:
- Real friend energy.
- Short WhatsApp-style lines.
- No em dashes.
- No robotic nutrition lecture.
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

    if (mediaUrl && mediaType.startsWith("image/") && profile.onboarding_complete) {
      const imageReply = await analyzeImageFromTwilio(mediaUrl, message);

      await supabase.from("messages").insert([
        { user_id: user, role: "user", content: message || "[image]" },
        { user_id: user, role: "assistant", content: imageReply }
      ]);

      return res.send(twiml(imageReply));
    }

    // =========================
    // GENERALIZED ONBOARDING
    // =========================
    if (!profile.onboarding_complete) {
      let reply = "";
      let updates = {};
      let nextStep = profile.step || "intro";

      if (nextStep === "intro") {
        nextStep = "name";

        reply = `Yo 🤨

Another person tryna lock in huh?

I’ll explain in a sec, but first what’s your name?`;
      }

      else if (nextStep === "name") {
        updates.name = message;
        nextStep = "age";

        reply = `${message}?? okay, I see you

Wait also, how old are you?

Not being weird, relax`;
      }

      else if (nextStep === "age") {
        updates.age = message;
        nextStep = "goal";

        reply = `Bet

So tell me what you’re actually tryna fix, build, or improve right now

Could be school, money, fitness, discipline, relationships, whatever`;
      }

      else if (nextStep === "goal") {
        updates.main_goal = message;
        nextStep = "reason";

        reply = `Okay now we’re getting somewhere

But why does that actually matter to you?

Like what’s the real reason behind it`;
      }

      else if (nextStep === "reason") {
        updates.mood = message;
        nextStep = "struggle";

        reply = `That makes sense

But be real with me now

What’s been stopping you from already being that version of yourself?`;
      }

      else if (nextStep === "struggle") {
        updates.struggle = message;
        updates.onboarding_complete = true;
        nextStep = "done";

        reply = `Yeah… that’s the part right there

Not judging you, just being real

That’s the pattern we need to break

Now we lock in`;
      }

      updates.step = nextStep;
      updates.updated_at = new Date().toISOString();

      await supabase
        .from("user_profiles")
        .update(updates)
        .eq("user_id", user);

      return res.send(twiml(reply));
    }

    // Refresh profile
    const { data: refreshedProfile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    profile = refreshedProfile || profile;

    // =========================
    // COMMANDS
    // =========================
    if (message.toLowerCase().startsWith("goal:")) {
      const goalText = message.replace(/goal:/i, "").trim();

      await supabase.from("goals").insert([
        {
          user_id: user,
          goal: goalText,
          status: "active"
        }
      ]);

      return res.send(twiml(`Locked.

Goal saved: ${goalText}`));
    }

    if (message.toLowerCase().includes("my goals")) {
      const { data: goals } = await supabase
        .from("goals")
        .select("*")
        .eq("user_id", user)
        .eq("status", "active");

      if (!goals || goals.length === 0) {
        return res.send(twiml("You don’t have saved goals yet. Send one like:\n\ngoal: gym 5x a week"));
      }

      const list = goals.map((g, i) => `${i + 1}. ${g.goal}`).join("\n");

      return res.send(twiml(`Here’s what we’re tracking:\n\n${list}`));
    }

    // =========================
    // CLASSIFY MESSAGE
    // =========================
    const analysis = await classifyMessage(message);
    const mood = analysis.mood || "neutral";
    const actionType = analysis.action || "no_action";
    const intent = analysis.intent || "normal";

    await supabase.from("messages").insert([
      { user_id: user, role: "mood", content: mood },
      { user_id: user, role: "action", content: actionType }
    ]);

    // =========================
    // HISTORY
    // =========================
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

    // =========================
    // STREAK
    // =========================
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

    // =========================
    // INACTIVITY
    // =========================
    const now = new Date();
    const lastActive = new Date(previousLastActive || now);
    const diffDays = (now.getTime() - lastActive.getTime()) / (1000 * 60 * 60 * 24);

    let inactivity = "active";
    if (diffDays >= 2) inactivity = "ghosted";
    else if (diffDays >= 1) inactivity = "quiet";

    // =========================
    // MEMORY
    // =========================
    const { data: memory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(16);

    const ageNum = parseInt(String(profile.age || "24").replace(/\D/g, ""), 10);

    const peerTone =
      ageNum <= 25
        ? "Talk like a peer. Young adult energy. Natural slang allowed."
        : "Talk like a sharp, grounded friend. Less slang, still direct.";

    const systemPrompt = `
You are Guka.

You are not a formal assistant.
You are a personal lock-in coach texting like a real friend.

IMPORTANT:
Never use Zangi's personal story, schedule, gym routine, relationship, meals, devotion, or any details from example chats unless THIS user personally says them.
Every user has their own story.
Only use the current user's saved profile and conversation history.

Your job:
- Learn the user's goals from their own words.
- Keep them accountable.
- Track patterns.
- Call out excuses.
- Help with productivity, habits, food, gym, school, money, emotions, and planning.
- Respond based only on what this user tells you.

User profile:
Name: ${profile.name}
Age: ${profile.age}
Main goal: ${profile.main_goal}
Main reason / mood note: ${profile.mood}
Main struggle: ${profile.struggle}

Current state:
Mood: ${mood}
Intent: ${intent}
Pattern: ${pattern}
Action type: ${actionType}
Execution rate: ${executionRate}
Streak: ${streak}
Inactivity: ${inactivity}

Personality rules:
- React first before asking anything.
- Do not sound like a questionnaire.
- Do not use em dashes.
- Use capital letters naturally.
- Use short WhatsApp-style chunks.
- Use line breaks.
- Be casual, sharp, warm, funny when appropriate, and real.
- You can tease lightly.
- You can be harsh if needed, but do not be cruel.
- If user is vulnerable, acknowledge it before pushing.
- If user is making excuses, call it out.
- If user did well, hype them up.
- If user is avoiding action, ask for the actual plan.
- Do not always ask a question.
- Do not over-explain.
- Never claim you can send scheduled messages unless the system has templates/proactive messaging enabled.
- Never say you are built on a specific model unless directly asked.

Conversation rhythm:
1. React to what they said.
2. Show you understood.
3. Connect it to their goal.
4. Push the next action.

Tone examples:
"Yeah… that combo will mess you up

Not judging you, just being real

You got comfortable

Question is, are you actually ready to tighten up or just talking right now?"

"Bro stop with the generic 'I can do better' stuff

What are you actually doing different tonight?"

"That’s what I like to see

Not perfect, but you showed up

Now don’t get comfortable"

Food/photo ability:
If user sends food or describes food, identify it and estimate calories roughly.
Always say it is an estimate, not exact.
If user sends workout photo/video, react and give basic accountability feedback.
Do not pretend to know exact details if unclear.

Safety:
If the user mentions alcohol, push moderation and discipline. Do not encourage drinking.
If the user seems overwhelmed, slow them down instead of attacking.
If the user mentions immediate danger or self-harm, tell them to contact local emergency help or a trusted person.

Peer style:
${peerTone}
`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...(memory || []).map((m) => ({
          role: m.role,
          content: m.content
        })),
        { role: "user", content: message }
      ]
    });

    const reply = completion.choices[0].message.content;

    await supabase.from("messages").insert([
      { user_id: user, role: "user", content: message },
      { user_id: user, role: "assistant", content: reply }
    ]);

    return res.send(twiml(reply));
  } catch (error) {
    console.error("Webhook error:", error);
    return res.send(twiml("Guka is bugging right now. Try again in a sec."));
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Guka running on port " + PORT);
});