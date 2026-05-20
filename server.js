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

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────

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

function daysBetween(dateA, dateB) {
  return (
    (new Date(dateA).getTime() - new Date(dateB).getTime()) /
    (1000 * 60 * 60 * 24)
  );
}

// ─────────────────────────────────────────────
// BUILD NARRATIVE PROFILE SUMMARY
// Converts profile fields into a paragraph Guka
// can reason from naturally — not labeled metadata.
// ─────────────────────────────────────────────

function buildProfileNarrative(profile, patternSummary, inactivityNote, openCommitmentsNote) {
  const parts = [];

  if (profile?.name) {
    parts.push(`The user's name is ${profile.name}.`);
  }
  if (profile?.age) {
    parts.push(`They are ${profile.age} years old.`);
  }
  if (profile?.main_goal) {
    parts.push(`Their main goal is: ${profile.main_goal}.`);
  }
  if (profile?.original_goal && profile.original_goal !== profile.main_goal) {
    parts.push(`They originally wanted to ${profile.original_goal} but that shifted.`);
  }
  if (profile?.mood) {
    parts.push(`The reason they said this matters to them: ${profile.mood}.`);
  }
  if (profile?.struggle) {
    parts.push(`Their main struggle is: ${profile.struggle}.`);
  }
  if (patternSummary) {
    parts.push(patternSummary);
  }
  if (inactivityNote) {
    parts.push(inactivityNote);
  }
  if (openCommitmentsNote) {
    parts.push(openCommitmentsNote);
  }

  return parts.length > 0
    ? parts.join(" ")
    : "This is a new user. You don't know them yet.";
}

// ─────────────────────────────────────────────
// PATTERN DETECTION (rolling window, recency-weighted)
// ─────────────────────────────────────────────

function detectPattern(moodHistory) {
  // Use last 10 moods with recency weighting
  const recent = (moodHistory || []).slice(0, 10);
  const totalWeight = recent.length;
  if (totalWeight === 0) return { label: "normal", summary: null };

  let lazyScore = 0;
  let stressedScore = 0;
  let emotionalScore = 0;

  recent.forEach((m, i) => {
    // More recent moods count more
    const weight = (totalWeight - i) / totalWeight;
    if (m === "lazy") lazyScore += weight;
    if (m === "stressed") stressedScore += weight;
    if (m === "emotional") emotionalScore += weight;
  });

  // Trigger threshold: 2.0 weighted points (roughly 3 recent or 4-5 older)
  if (lazyScore >= 2.0) {
    return {
      label: "repeated_slacking",
      summary: "They keep saying they'll do things and not following through. It's becoming a pattern."
    };
  }
  if (stressedScore >= 2.0) {
    return {
      label: "burnout_risk",
      summary: "They've been consistently stressed across multiple conversations. Signs of building pressure."
    };
  }
  if (emotionalScore >= 1.8) {
    return {
      label: "emotionally_distracted",
      summary: "They've been emotionally all over the place lately. Hard to stay focused when your head's like that."
    };
  }

  return { label: "normal", summary: null };
}

// ─────────────────────────────────────────────
// OPEN COMMITMENTS CHECK
// Finds action_commit events with no matching
// action_done in the last 72 hours.
// ─────────────────────────────────────────────

async function getOpenCommitments(userId) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 72);

  const { data: commits } = await supabase
    .from("messages")
    .select("content, created_at")
    .eq("user_id", userId)
    .eq("role", "action")
    .eq("content", "action_commit")
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false });

  if (!commits || commits.length === 0) return null;

  const { data: dones } = await supabase
    .from("messages")
    .select("created_at")
    .eq("user_id", userId)
    .eq("role", "action")
    .eq("content", "action_done")
    .gte("created_at", cutoff.toISOString());

  const doneCount = dones?.length || 0;
  const commitCount = commits.length;

  if (commitCount > doneCount) {
    const unresolved = commitCount - doneCount;
    return `They made ${unresolved} commitment${unresolved > 1 ? "s" : ""} recently with no follow-through. That thread is still open.`;
  }

  return null;
}

// ─────────────────────────────────────────────
// MESSAGE ANALYSIS
// Extracts structured signals from the user's message.
// ─────────────────────────────────────────────

async function analyzeAndExtract(message, profile, memory) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `
Return JSON only. No extra text.

Schema:
{
  "mood": "lazy | stressed | confident | confused | emotional | neutral",
  "action": "action_commit | action_done | no_action",
  "intent": "food | workout | relationship | school | money | schedule | reminder | accountability | normal",
  "new_goal": "string or null",
  "new_reason": "string or null",
  "new_struggle": "string or null",
  "goal_changed": true or false,
  "important_memory": "string or null"
}

Rules:
- Only extract what THIS user clearly said in this message.
- Never invent details or assume intent.
- Set goal_changed to true ONLY if the user's message suggests a different focus than their existing main_goal.
- Never reuse example stories or developer test data.
`
        },
        {
          role: "user",
          content: `
Existing profile:
${JSON.stringify(profile || {}, null, 2)}

Recent conversation (last 6 turns):
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
      goal_changed: false,
      important_memory: null
    };
  }
}

// ─────────────────────────────────────────────
// IMAGE ANALYSIS
// ─────────────────────────────────────────────

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
You are Guka reacting to a WhatsApp image a user just sent.

If food:
- identify it
- rough calorie estimate (clearly label it an estimate)
- one short real note, not a lecture

If gym/workout:
- react like you actually see what they're doing
- don't pretend to know more than the image shows
- keep the energy real, not over-hyped

Style:
- short WhatsApp bubbles
- genuine energy, not performative hype
- no em dashes
- no numbered lists
- never say "great job" or "well done"
`
        },
        {
          role: "user",
          content: [
            { type: "text", text: caption || "What do you see?" },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error("Image analysis error:", error);
    return "got the image but couldn't read it properly. send it again with a quick caption";
  }
}

// ─────────────────────────────────────────────
// CORE RESPONSE GENERATOR
// The heart of Guka's personality.
// ─────────────────────────────────────────────

async function generateGukaMessages({
  message,
  profile,
  liveMemory,
  profileNarrative,
  emotionalMoment,
  conversationMode,
  messageLengthBias
}) {
  const ageNum = parseInt(String(profile?.age || "").replace(/\D/g, ""), 10);

  const toneLine =
    ageNum && ageNum <= 25
      ? "Peer energy. Natural slang is fine. Talk like someone their age who actually gives a damn."
      : "Grounded, sharp, direct. Less slang but still human. Not corporate. Not a mentor. A real friend.";

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
You are Guka.

You are NOT an assistant. NOT a therapist. NOT a productivity app. NOT a coach.
You are a psychologically sharp accountability companion. You feel real.

Return JSON only:
{ "messages": ["message 1", "message 2", "message 3"] }

━━━━━━━━━━━━━━━━━━━━━━━━━
CORE BEHAVIOR
━━━━━━━━━━━━━━━━━━━━━━━━━

Conversation rhythm (always follow this order):
1. React to what they said — emotionally, not procedurally
2. Interpret what it means — name the pattern or feeling
3. Narrow the conversation toward something specific
4. Ask ONE precise question OR push ONE clear action

NEVER skip straight to solutions or plans.
NEVER hand full conversational control back to the user.
NEVER ask two questions in the same response.
ALWAYS guide the emotional direction.

━━━━━━━━━━━━━━━━━━━━━━━━━
BANNED PHRASES & PATTERNS
━━━━━━━━━━━━━━━━━━━━━━━━━

Never say:
- "what's up"
- "how can I help"
- "tell me more"
- "let's break this down"
- "we can map it out together"
- "what would you like to talk about"
- "anything specific"
- "got something specific"
- "great job" / "well done" / "amazing"
- "I hear you"
- "that makes sense"
- "absolutely"
- "of course"
- "right?" (as filler)
- "you've got this"
- "let's do this"
- em dashes (—)
- numbered lists (unless explicitly asked for a plan)
- corporate motivational language of any kind

━━━━━━━━━━━━━━━━━━━━━━━━━
FORMAT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━

${messageLengthBias || "Use 2-4 short WhatsApp-style messages. Each one is its own bubble. Short, punchy, real."}

Each message should feel like a separate text sent one after another.
Vary sentence length. Some fragments are fine. Reads like texting, not writing.

━━━━━━━━━━━━━━━━━━━━━━━━━
WHAT GUKA ACTUALLY SOUNDS LIKE
━━━━━━━━━━━━━━━━━━━━━━━━━

Good examples:
"yeah okay so your life lowkey feels outta control rn"
"not judging you btw"
"that combo usually means something deeper is going on"
"so why does this actually matter to you tho"
"most people don't randomly text something like this at 4am 💀"
"okay now we're talking"
"that's the pattern"
"you keep starting things when the pressure gets high and dropping them when it eases. you know that right"
"what changed recently"
"nah we're not moving on yet"

Bad examples (never do this):
"How can I assist you today?"
"Let's create a plan together."
"What are your goals?"
"Tell me more."
"I understand how you feel."
"You've got this!"

━━━━━━━━━━━━━━━━━━━━━━━━━
WHO YOU'RE TALKING TO
━━━━━━━━━━━━━━━━━━━━━━━━━

${profileNarrative}

━━━━━━━━━━━━━━━━━━━━━━━━━
THIS MOMENT
━━━━━━━━━━━━━━━━━━━━━━━━━

${emotionalMoment}

━━━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION DIRECTION
━━━━━━━━━━━━━━━━━━━━━━━━━

${conversationMode}

━━━━━━━━━━━━━━━━━━━━━━━━━
TONE
━━━━━━━━━━━━━━━━━━━━━━━━━

${toneLine}

━━━━━━━━━━━━━━━━━━━━━━━━━
SAFETY
━━━━━━━━━━━━━━━━━━━━━━━━━

If they seem overwhelmed or spiraling: slow down. Calm before push.
If immediate danger or self-harm language appears: stop everything. Tell them to contact emergency services or a trusted person. No accountability talk.
If alcohol or substance use comes up: push discipline and moderation, not judgment.
`
      },

      // Live conversation history (last 8 turns only)
      ...(liveMemory || []).slice(-8).map((m) => ({
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
    if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length) {
      return parsed.messages;
    }
    return ["yeah say that again"];
  } catch {
    return [completion.choices[0].message.content];
  }
}

// ─────────────────────────────────────────────
// INACTIVITY INTERPRETATION
// Returns a human-readable note for the narrative,
// and a bias for how Guka should handle the return.
// ─────────────────────────────────────────────

function interpretInactivity(diffDays) {
  if (diffDays >= 5) {
    return {
      label: "long_ghost",
      note: "They've been gone for 5+ days.",
      conversationBias:
        "They went quiet for a long time and just came back. Don't call it out directly yet. React to their message first. But the silence is present — let it sit in the background. Something usually shifts when people disappear that long."
    };
  }
  if (diffDays >= 2) {
    return {
      label: "ghosted",
      note: "They went quiet for 2-5 days before this message.",
      conversationBias:
        "They went quiet for a few days and just came back. Don't ask where they've been. Respond to the message first. But if there's an opening, acknowledge the gap without being weird about it."
    };
  }
  if (diffDays >= 1) {
    return {
      label: "quiet",
      note: "They were quiet for about a day.",
      conversationBias: null
    };
  }
  return {
    label: "active",
    note: null,
    conversationBias: null
  };
}

// ─────────────────────────────────────────────
// EMOTIONAL MOMENT CLASSIFIER
// Translates mood + pattern + intent into a
// feeling-based description for the system prompt.
// ─────────────────────────────────────────────

function classifyEmotionalMoment(mood, intent, pattern, executionRate, streak) {
  const parts = [];

  const moodMap = {
    lazy: "They're coming in with low energy — not motivated, probably avoiding something.",
    stressed: "They're carrying stress right now. Something is pressing on them.",
    confident: "They're in a good headspace today. Don't over-celebrate it — use the momentum.",
    confused: "They seem unsure or scattered. Help them get clear, not just busy.",
    emotional: "This is an emotionally charged moment. They're not just talking about logistics.",
    neutral: "They seem calm and neutral right now."
  };

  if (moodMap[mood]) parts.push(moodMap[mood]);

  if (pattern === "repeated_slacking") {
    parts.push("They have a pattern of committing and not following through. Don't ignore it.");
  } else if (pattern === "burnout_risk") {
    parts.push("They've been stressed consistently. Careful — don't push too hard right now.");
  } else if (pattern === "emotionally_distracted") {
    parts.push("Emotional noise has been high for them lately. Focus might be the real issue.");
  }

  if (executionRate < 0.3 && executionRate > 0) {
    parts.push("Their follow-through rate is low. They say they'll do things and often don't.");
  } else if (executionRate >= 0.7) {
    parts.push("They've actually been following through recently. That's worth acknowledging quietly.");
  }

  if (streak >= 3) {
    parts.push(`They're on a ${streak}-day streak. That's real momentum.`);
  }

  const intentMap = {
    workout: "They're talking about fitness or physical activity.",
    food: "Food or diet is the topic.",
    relationship: "There's a relationship dynamic in the mix.",
    school: "School or academic pressure is involved.",
    money: "Money or financial stress is part of this.",
    reminder: "They need a reminder or follow-up.",
    accountability: "They're explicitly seeking accountability."
  };

  if (intentMap[intent]) parts.push(intentMap[intent]);

  return parts.length > 0
    ? parts.join(" ")
    : "Standard conversation moment. Stay sharp and specific.";
}

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    const user = req.body.From || "";
    const message = cleanMessage(req.body.Body);
    const numMedia = Number(req.body.NumMedia || 0);
    const mediaUrl = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 || "" : "";

    if (!user) {
      return res.send(twiml("Something went wrong. Try again."));
    }

    // ── LOAD OR CREATE PROFILE ──────────────────

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

    // ── LOAD CONVERSATION MEMORY ────────────────
    // Two layers: full profile fields (narrative) + recent live turns

    const { data: liveMemory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(8); // Live window: last 8 turns only

    // ── IMAGE HANDLING ──────────────────────────

    if (mediaUrl && mediaType.startsWith("image/") && profile.onboarding_complete) {
      const imageReply = await analyzeImageFromTwilio(mediaUrl, message);

      await supabase.from("messages").insert([
        { user_id: user, role: "user", content: message || "[image]" },
        { user_id: user, role: "assistant", content: imageReply }
      ]);

      return res.send(twiml(imageReply));
    }

    // ── ONBOARDING FLOW ─────────────────────────
    // Feels like discovery, not intake.
    // Each step can breathe — profile fields fill
    // through natural conversation, not form submission.

    if (!profile.onboarding_complete) {
      let updates = {};
      let nextStep = profile.step || "intro";
      let replyMessages = [];

      if (nextStep === "intro") {
        nextStep = "name";
        replyMessages = [
          "yo 🤨",
          "another person tryna lock in huh",
          "i'll explain in a sec but first — what's your name"
        ];
      }

      else if (nextStep === "name") {
        updates.name = message;
        nextStep = "age";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, name: message },
          liveMemory,
          profileNarrative: `User just gave their name: ${message}. You know nothing else about them yet.`,
          emotionalMoment: "First real exchange. They just told you their name. The vibe is being set right now.",
          conversationMode:
            "React to the name naturally — not with fake enthusiasm. Then ask their age in the most casual way possible. One question, nothing else.",
          messageLengthBias: "2-3 short messages. Keep it light."
        });
      }

      else if (nextStep === "age") {
        updates.age = message;
        nextStep = "goal";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, age: message },
          liveMemory,
          profileNarrative: `Their name is ${profile.name || "unknown"}. They just said they're ${message}.`,
          emotionalMoment: "Early conversation. Casual but starting to get real. Don't rush.",
          conversationMode:
            "React briefly to the age — something real, not hollow. Then ask what's been feeling off in their life lately, or what they've been wanting to change. Keep it open but emotionally grounded. NOT 'what are your goals' — something more human than that.",
          messageLengthBias: "2-3 messages."
        });
      }

      else if (nextStep === "goal") {
        updates.main_goal = message;
        updates.original_goal = message; // Preserve original for goal-shift tracking
        nextStep = "reason";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, main_goal: message },
          liveMemory,
          profileNarrative: `${profile.name || "They"} is ${profile.age || "unknown"} years old. They just said what they want to change: ${message}.`,
          emotionalMoment:
            "They just shared their goal. This is NOT the moment to celebrate or plan. This is the moment to push deeper. Most people say goals without really knowing why.",
          conversationMode:
            "React to what they said — name what you actually hear, not just the surface. Then ask WHY this matters to them right now. Not 'why is this your goal' — something more specific and emotionally direct. Push past the obvious answer.",
          messageLengthBias:
            "3 messages. React, interpret, then one sharp question."
        });
      }

      else if (nextStep === "reason") {
        updates.mood = message;
        nextStep = "struggle";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, mood: message },
          liveMemory,
          profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "make a change"}. They just told you WHY it matters: ${message}.`,
          emotionalMoment:
            "They just got honest about why this matters. That's a real moment. Don't gloss over it. Sit in it, then go one layer deeper.",
          conversationMode:
            "Acknowledge what they said in a way that makes them feel actually understood — not validated, understood. Then ask what's been stopping them. Not 'what are your obstacles' — something that feels like you already half-know the answer.",
          messageLengthBias:
            "3 messages. One reaction, one interpretation, one question."
        });
      }

      else if (nextStep === "struggle") {
        updates.struggle = message;
        updates.onboarding_complete = true;
        nextStep = "active";

        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, struggle: message },
          liveMemory,
          profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "make a change"}. Their reason: ${profile.mood || "unclear"}. Their struggle: ${message}.`,
          emotionalMoment:
            "They just told you the real thing that's been stopping them. This is the core pattern. Name it. Make them feel like someone finally gets it. Then — not immediately, but naturally — move toward one real commitment today.",
          conversationMode:
            "Name the pattern you see. Make them feel understood before anything else. Then transition into accountability: ask for one specific, real thing they can do or commit to today. Not a plan. One thing.",
          messageLengthBias:
            "3-4 messages. Take your time with this one. This is the moment that decides if they stay."
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

    // ── REFRESH FULL PROFILE ────────────────────

    const { data: refreshedProfile } = await supabase
      .from("user_profiles")
      .select("*")
      .eq("user_id", user)
      .single();

    profile = refreshedProfile || profile;

    // ── GOAL COMMAND ────────────────────────────

    if (message.toLowerCase().startsWith("goal:")) {
      const goalText = message.replace(/goal:/i, "").trim();

      await supabase.from("goals").insert([
        { user_id: user, goal: goalText, status: "active" }
      ]);

      // Don't respond like a productivity app. Push on it.
      const goalReply = await generateGukaMessages({
        message: goalText,
        profile,
        liveMemory,
        profileNarrative: buildProfileNarrative(profile),
        emotionalMoment:
          "They just formally declared a goal. Don't celebrate it. A lot of people declare goals. The question is whether they mean it.",
        conversationMode:
          "Acknowledge the goal was saved. Then ask one question that tests whether they actually mean it — something that probes the commitment level, not the goal itself.",
        messageLengthBias: "2-3 messages."
      });

      await supabase.from("messages").insert([
        { user_id: user, role: "user", content: message },
        { user_id: user, role: "assistant", content: goalReply.join("\n\n") }
      ]);

      return res.send(twiml(goalReply));
    }

    // ── SHOW GOALS ──────────────────────────────

    if (message.toLowerCase().includes("my goals")) {
      const { data: goals } = await supabase
        .from("goals")
        .select("*")
        .eq("user_id", user)
        .eq("status", "active");

      if (!goals || goals.length === 0) {
        return res.send(twiml("you don't have any saved goals yet"));
      }

      const list = goals.map((g, i) => `${i + 1}. ${g.goal}`).join("\n");

      return res.send(twiml(["here's what we're tracking", list]));
    }

    // ── MESSAGE ANALYSIS ────────────────────────

    const analysis = await analyzeAndExtract(message, profile, liveMemory);

    const mood = analysis.mood || "neutral";
    const actionType = analysis.action || "no_action";
    const intent = analysis.intent || "normal";

    // Log mood + action signals for pattern detection
    await supabase.from("messages").insert([
      { user_id: user, role: "mood", content: mood },
      { user_id: user, role: "action", content: actionType }
    ]);

    // ── SILENT PROFILE UPDATES ──────────────────
    // If user's focus shifts, track it — don't silently ignore it.

    const profileUpdates = {};

    if (analysis.new_goal) {
      if (!profile.main_goal) {
        profileUpdates.main_goal = analysis.new_goal;
        profileUpdates.original_goal = analysis.new_goal;
      } else if (analysis.goal_changed) {
        // Goal shift detected — update active goal, preserve original
        profileUpdates.main_goal = analysis.new_goal;
        if (!profile.original_goal) {
          profileUpdates.original_goal = profile.main_goal;
        }
      }
      // Always save extracted goal to goals table
      await supabase.from("goals").insert([
        { user_id: user, goal: analysis.new_goal, status: "active" }
      ]);
    }

    if (analysis.new_reason && !profile.mood) {
      profileUpdates.mood = analysis.new_reason;
    }

    if (analysis.new_struggle && !profile.struggle) {
      profileUpdates.struggle = analysis.new_struggle;
    }

    if (Object.keys(profileUpdates).length > 0) {
      profileUpdates.updated_at = new Date().toISOString();
      await supabase
        .from("user_profiles")
        .update(profileUpdates)
        .eq("user_id", user);

      // Apply to current profile object for this response
      Object.assign(profile, profileUpdates);
    }

    if (analysis.important_memory) {
      await supabase.from("messages").insert([
        { user_id: user, role: "memory", content: analysis.important_memory }
      ]);
    }

    // ── PATTERN DETECTION ───────────────────────

    const { data: moodHistory } = await supabase
      .from("messages")
      .select("content")
      .eq("user_id", user)
      .eq("role", "mood")
      .order("created_at", { ascending: false })
      .limit(10);

    const moods = (moodHistory || []).map((m) => m.content);
    const patternResult = detectPattern(moods);
    const pattern = patternResult.label;

    // ── EXECUTION RATE ──────────────────────────

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

    // ── STREAK ──────────────────────────────────

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

    // ── INACTIVITY ──────────────────────────────

    const now = new Date();
    const lastActive = new Date(previousLastActive || now);
    const diffDays = daysBetween(now, lastActive);
    const inactivityResult = interpretInactivity(diffDays);

    // ── OPEN COMMITMENTS ────────────────────────

    const openCommitmentsNote = await getOpenCommitments(user);

    // ── BUILD PROFILE NARRATIVE ─────────────────

    const profileNarrative = buildProfileNarrative(
      profile,
      patternResult.summary,
      inactivityResult.note,
      openCommitmentsNote
    );

    // ── EMOTIONAL MOMENT CLASSIFICATION ─────────

    const emotionalMoment = classifyEmotionalMoment(
      mood,
      intent,
      pattern,
      executionRate,
      streak
    );

    // ── CONVERSATION DIRECTION ───────────────────
    // Merge base mode with inactivity bias if present

    let conversationMode =
      "Active conversation. Respond to what they actually said. Be specific to this person. Lead the emotional direction. Don't ask vague questions.";

    if (inactivityResult.conversationBias) {
      conversationMode = inactivityResult.conversationBias;
    }

    // Open commitments take priority — Guka pulls the thread
    if (openCommitmentsNote && actionType !== "action_done") {
      conversationMode =
        `${conversationMode} Also: ${openCommitmentsNote} If there's a natural opening, pull on that unresolved thread. Don't ignore it.`;
    }

    // ── MESSAGE LENGTH BIAS ─────────────────────

    let messageLengthBias = "Use 2-4 short WhatsApp-style messages.";

    if (mood === "emotional" || pattern === "emotionally_distracted") {
      messageLengthBias =
        "They're in an emotional moment. Bias toward 3 shorter, more human messages. Don't rush to push. Sit with it slightly.";
    } else if (pattern === "repeated_slacking" || openCommitmentsNote) {
      messageLengthBias =
        "2 messages max. Direct. Call out what needs to be called out. Don't pad it.";
    } else if (mood === "confident" && streak >= 3) {
      messageLengthBias =
        "They're in a good place. 2 messages. Don't overdo it. Use the momentum.";
    }

    // ── REFRESH LIVE MEMORY ─────────────────────

    const { data: refreshedMemory } = await supabase
      .from("messages")
      .select("*")
      .eq("user_id", user)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: true })
      .limit(8);

    // ── GENERATE RESPONSE ───────────────────────

    const replyMessages = await generateGukaMessages({
      message,
      profile,
      liveMemory: refreshedMemory || liveMemory,
      profileNarrative,
      emotionalMoment,
      conversationMode,
      messageLengthBias
    });

    await supabase.from("messages").insert([
      { user_id: user, role: "user", content: message },
      { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
    ]);

    return res.send(twiml(replyMessages));
  } catch (error) {
    console.error("Webhook error:", error);
    return res.send(twiml("guka bugging rn 💀 try again in a sec"));
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Guka running on port " + PORT);
});