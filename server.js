const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");

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
  .map((m) => `<Message>${escapeXml(m)}</Message>`)
  .join("\n")}
</Response>`;
}

function cleanMessage(message) {
  return (message || "").trim();
}

async function analyzeAndExtract(message, profile, memory) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Return JSON only.

Schema:
{
  "mood": "lazy | stressed | confident | confused | emotional | neutral",
  "action": "action_commit | action_done | no_action",
  "intent": "food | workout | relationship | school | money | schedule | reminder | accountability | normal",
  "new_goal": "string or null",
  "new_reason": "string or null",
  "new_struggle": "string or null",
  "important_memory": "string or null"
}

Rules:
- Only extract what THIS user clearly said.
- Never invent details.
- Never use example stories.
`
        },
        {
          role: "user",
          content: `
Profile:
${JSON.stringify(profile || {}, null, 2)}

Recent memory:
${JSON.stringify((memory || []).slice(-6), null, 2)}

Latest user message:
${message}
`
        }
      ]
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (error) {
    console.error("Analyze error:", error);

    return {
      mood: "neutral",
      action: "no_action",
      intent: "normal",
      new_goal: null,
      new_reason: null,
      new_struggle: null,
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

If food:
- identify the food
- estimate calories roughly
- clearly say it is an estimate
- give one short practical note

If gym/workout:
- react like an accountability friend
- comment only on visible things
- do not pretend to know details

Style:
- short WhatsApp style
- real human energy
- no em dashes
- no lecture
`
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: caption || "Analyze this image."
            },
            {
              type: "image_url",
              image_url: {
                url: dataUrl
              }
            }
          ]
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Image analysis error:", error);

    return "I got the image but I couldn’t read it properly. Send it again with a quick caption.";
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
  const ageNum = parseInt(
    String(profile?.age || "").replace(/\D/g, ""),
    10
  );

  const peerTone =
    ageNum && ageNum <= 25
      ? "Talk like a peer. Young adult energy. Natural slang allowed."
      : "Talk like a grounded sharp friend. Less slang but still casual.";

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You are Guka.

You are NOT an assistant.
You are NOT a therapist.
You are NOT a productivity app.

You are a real-feeling accountability friend.

Return JSON only:
{
  "messages": ["message 1", "message 2", "message 3"]
}

CRITICAL RULES:
- Use 1 to 5 short WhatsApp-style messages.
- Every message should feel like a separate text bubble.
- NEVER use em dashes.
- NEVER use numbered lists unless user specifically asks for a plan.
- NEVER sound like customer support.
- NEVER sound like a motivational coach.
- NEVER say:
  - "what's up"
  - "how can I help"
  - "what would you like to talk about"
  - "anything specific"
  - "let's break this down"
  - "we can map it out together"
  - "got something specific"
- NEVER ask broad lazy questions.
- ALWAYS ask emotionally or contextually specific questions.
- ALWAYS guide the conversation.
- NEVER hand the conversation responsibility back to the user completely.
- NEVER over-help too early.
- NEVER instantly create plans when user shares goals.
- First understand WHY they care.
- Then understand what has been stopping them.
- THEN hold them accountable over time.

VERY IMPORTANT:
Do NOT use the developer's personal life or example chats.
Every user has their own story.

GOOD STYLE EXAMPLES:

"yeah okay so your life lowkey feels outta control rn"

"not judging you btw"

"that combo usually means something deeper is going on"

"so why does this actually matter to you tho"

"most people don’t randomly text something like this at 4am 💀"

"okay now we’re talking"

"that’s the pattern right there"

BAD STYLE EXAMPLES:

"How can I assist you today?"

"Let's create a plan."

"What are your goals?"

"Tell me more."

"What's up?"

Conversation rhythm:
1. react
2. interpret
3. emotionally narrow
4. ask ONE strong question or push ONE strong action

Saved user profile:
Name: ${profile?.name || "unknown"}
Age: ${profile?.age || "unknown"}
Main goal: ${profile?.main_goal || "unknown"}
Reason/motivation: ${profile?.mood || "unknown"}
Main struggle: ${profile?.struggle || "unknown"}

Conversation mode:
${conversationMode}

Current state:
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
If overwhelmed, calm them before pushing.
If discussing alcohol, push moderation and discipline.
If immediate danger/self-harm appears, tell them to contact emergency help or a trusted person.
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
    const parsed = JSON.parse(
      completion.choices[0].message.content
    );

    if (
      parsed.messages &&
      Array.isArray(parsed.messages) &&
      parsed.messages.length
    ) {
      return parsed.messages;
    }

    return ["yeah say that again"];
  } catch {
    return [completion.choices[0].message.content];
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const user = req.body.From || "";

    const message = cleanMessage(req.body.Body);

    const numMedia = Number(req.body.NumMedia || 0);

    const mediaUrl =
      numMedia > 0 ? req.body.MediaUrl0 : null;

    const mediaType =
      numMedia > 0
        ? req.body.MediaContentType0 || ""
        : "";

    if (!user) {
      return res.send(
        twiml("Something’s off. Try again.")
      );
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
          onboarding_complete: false,
          step: "intro",
          last_active: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ]);

      profile = {
        user_id: user,
        onboarding_complete: false,
        step: "intro"
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
      .order("created_at", {
        ascending: true
      })
      .limit(20);

    // IMAGE HANDLING
    if (
      mediaUrl &&
      mediaType.startsWith("image/") &&
      profile.onboarding_complete
    ) {
      const imageReply =
        await analyzeImageFromTwilio(
          mediaUrl,
          message
        );

      await supabase.from("messages").insert([
        {
          user_id: user,
          role: "user",
          content: message || "[image]"
        },
        {
          user_id: user,
          role: "assistant",
          content: imageReply
        }
      ]);

      return res.send(twiml(imageReply));
    }

    // NATURAL ONBOARDING
    if (!profile.onboarding_complete) {
      let updates = {};

      let nextStep = profile.step || "intro";

      let replyMessages = [];

      if (nextStep === "intro") {
        nextStep = "name";

        replyMessages = [
          "yo 🤨",
          "another person tryna lock in huh?",
          "i’ll explain in a sec but first what’s your name"
        ];
      }

      else if (nextStep === "name") {
        updates.name = message;

        nextStep = "age";

        replyMessages =
          await generateGukaMessages({
            message,
            profile: {
              ...profile,
              name: message
            },
            memory,
            mood: "neutral",
            intent: "intro",
            actionType: "no_action",
            pattern: "new_user",
            executionRate: 0,
            streak: 0,
            inactivity: "active",
            conversationMode:
              "User just gave their name. React naturally to it, then casually ask age."
          });
      }

      else if (nextStep === "age") {
        updates.age = message;

        nextStep = "goal";

        replyMessages =
          await generateGukaMessages({
            message,
            profile: {
              ...profile,
              age: message
            },
            memory,
            mood: "neutral",
            intent: "intro",
            actionType: "no_action",
            pattern: "new_user",
            executionRate: 0,
            streak: 0,
            inactivity: "active",
            conversationMode:
              "User just gave age. React briefly then naturally ask what in their life feels off or what they’re trying to change."
          });
      }

      else if (nextStep === "goal") {
        updates.main_goal = message;

        nextStep = "reason";

        replyMessages =
          await generateGukaMessages({
            message,
            profile: {
              ...profile,
              main_goal: message
            },
            memory,
            mood: "neutral",
            intent: "goal",
            actionType: "action_commit",
            pattern: "goal_discovery",
            executionRate: 0,
            streak: 0,
            inactivity: "active",
            conversationMode:
              "User shared goals. Do NOT make a plan. React emotionally, interpret the pattern, then ask WHY this matters to them right now."
          });
      }

      else if (nextStep === "reason") {
        updates.mood = message;

        nextStep = "struggle";

        replyMessages =
          await generateGukaMessages({
            message,
            profile: {
              ...profile,
              mood: message
            },
            memory,
            mood: "emotional",
            intent: "deeper_reason",
            actionType: "no_action",
            pattern: "motivation_discovery",
            executionRate: 0,
            streak: 0,
            inactivity: "active",
            conversationMode:
              "User explained deeper motivation. Respect the honesty. Go one emotional layer deeper, then ask what has been stopping them."
          });
      }

      else if (nextStep === "struggle") {
        updates.struggle = message;

        updates.onboarding_complete = true;

        nextStep = "active";

        replyMessages =
          await generateGukaMessages({
            message,
            profile: {
              ...profile,
              struggle: message
            },
            memory,
            mood: "emotional",
            intent: "struggle",
            actionType: "no_action",
            pattern: "core_pattern_found",
            executionRate: 0,
            streak: 0,
            inactivity: "active",
            conversationMode:
              "User revealed their main struggle. Identify the pattern. Make them feel understood. Transition naturally into accountability and ask for one real commitment today."
          });
      }

      updates.step = nextStep;

      updates.updated_at =
        new Date().toISOString();

      await supabase
        .from("user_profiles")
        .update(updates)
        .eq("user_id", user);

      await supabase.from("messages").insert([
        {
          user_id: user,
          role: "user",
          content: message || "[start]"
        },
        {
          user_id: user,
          role: "assistant",
          content: replyMessages.join("\n\n")
        }
      ]);

      return res.send(twiml(replyMessages));
    }

    // REFRESH PROFILE
    const { data: refreshedProfile } =
      await supabase
        .from("user_profiles")
        .select("*")
        .eq("user_id", user)
        .single();

    profile = refreshedProfile || profile;

    // GOAL COMMAND
    if (
      message.toLowerCase().startsWith("goal:")
    ) {
      const goalText = message
        .replace(/goal:/i, "")
        .trim();

      await supabase.from("goals").insert([
        {
          user_id: user,
          goal: goalText,
          status: "active"
        }
      ]);

      return res.send(
        twiml([
          "locked",
          `goal saved: ${goalText}`
        ])
      );
    }

    // SHOW GOALS
    if (
      message.toLowerCase().includes("my goals")
    ) {
      const { data: goals } = await supabase
        .from("goals")
        .select("*")
        .eq("user_id", user)
        .eq("status", "active");

      if (!goals || goals.length === 0) {
        return res.send(
          twiml(
            "you don’t have saved goals yet"
          )
        );
      }

      const list = goals
        .map((g, i) => `${i + 1}. ${g.goal}`)
        .join("\n");

      return res.send(
        twiml([
          "here’s what we’re tracking",
          list
        ])
      );
    }

    // ANALYSIS
    const analysis =
      await analyzeAndExtract(
        message,
        profile,
        memory
      );

    const mood =
      analysis.mood || "neutral";

    const actionType =
      analysis.action || "no_action";

    const intent =
      analysis.intent || "normal";

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

    // SILENT MEMORY UPDATES
    const profileUpdates = {};

    if (
      analysis.new_goal &&
      !profile.main_goal
    ) {
      profileUpdates.main_goal =
        analysis.new_goal;
    }

    if (
      analysis.new_reason &&
      !profile.mood
    ) {
      profileUpdates.mood =
        analysis.new_reason;
    }

    if (
      analysis.new_struggle &&
      !profile.struggle
    ) {
      profileUpdates.struggle =
        analysis.new_struggle;
    }

    if (
      Object.keys(profileUpdates).length > 0
    ) {
      profileUpdates.updated_at =
        new Date().toISOString();

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
          content:
            analysis.important_memory
        }
      ]);
    }

    // PATTERN DETECTION
    const { data: moodHistory } =
      await supabase
        .from("messages")
        .select("content")
        .eq("user_id", user)
        .eq("role", "mood")
        .order("created_at", {
          ascending: false
        })
        .limit(20);

    const moods = (moodHistory || []).map(
      (m) => m.content
    );

    const lazyCount = moods.filter(
      (m) => m === "lazy"
    ).length;

    const stressedCount = moods.filter(
      (m) => m === "stressed"
    ).length;

    const emotionalCount = moods.filter(
      (m) => m === "emotional"
    ).length;

    let pattern = "normal";

    if (lazyCount >= 5) {
      pattern = "repeated_slacking";
    }

    if (stressedCount >= 5) {
      pattern = "burnout_risk";
    }

    if (emotionalCount >= 4) {
      pattern = "emotionally_distracted";
    }

    // ACTION HISTORY
    const { data: actionHistory } =
      await supabase
        .from("messages")
        .select("content")
        .eq("user_id", user)
        .eq("role", "action")
        .order("created_at", {
          ascending: false
        })
        .limit(20);

    const actions = (
      actionHistory || []
    ).map((a) => a.content);

    const commits = actions.filter(
      (a) => a === "action_commit"
    ).length;

    const done = actions.filter(
      (a) => a === "action_done"
    ).length;

    const executionRate =
      commits > 0
        ? Number((done / commits).toFixed(2))
        : 0;

    // STREAK
    const { data: streakData } =
      await supabase
        .from("streaks")
        .select("*")
        .eq("user_id", user)
        .single();

    let streak =
      streakData?.current_streak || 0;

    let lastDate =
      streakData?.last_action_date ||
      null;

    const today = new Date()
      .toISOString()
      .split("T")[0];

    if (actionType === "action_done") {
      if (!lastDate) {
        streak = 1;
      }

      else if (lastDate !== today) {
        const yesterday = new Date();

        yesterday.setDate(
          yesterday.getDate() - 1
        );

        const yDate = yesterday
          .toISOString()
          .split("T")[0];

        streak =
          lastDate === yDate
            ? streak + 1
            : 1;
      }

      await supabase.from("streaks").upsert({
        user_id: user,
        current_streak: streak,
        last_action_date: today
      });
    }

    // INACTIVITY
    const now = new Date();

    const lastActive = new Date(
      previousLastActive || now
    );

    const diffDays =
      (now.getTime() -
        lastActive.getTime()) /
      (1000 * 60 * 60 * 24);

    let inactivity = "active";

    if (diffDays >= 2) {
      inactivity = "ghosted";
    }

    else if (diffDays >= 1) {
      inactivity = "quiet";
    }

    // REFRESH MEMORY
    const { data: latestMemory } =
      await supabase
        .from("messages")
        .select("*")
        .eq("user_id", user)
        .in("role", ["user", "assistant"])
        .order("created_at", {
          ascending: true
        })
        .limit(20);

    // MAIN RESPONSE
    const replyMessages =
      await generateGukaMessages({
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
          "Active conversation. Respond naturally to THIS user's actual message. Avoid vague questions. Lead the emotional direction of the conversation confidently."
      });

    await supabase.from("messages").insert([
      {
        user_id: user,
        role: "user",
        content: message
      },
      {
        user_id: user,
        role: "assistant",
        content:
          replyMessages.join("\n\n")
      }
    ]);

    return res.send(
      twiml(replyMessages)
    );
  }

  catch (error) {
    console.error(
      "Webhook error:",
      error
    );

    return res.send(
      twiml(
        "guka bugging rn 💀 try again in a sec"
      )
    );
  }
});

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Guka running on port " + PORT
  );
});