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

app.get("/", (req, res) => res.send("Guka is running"));

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
  return `<Response>\n${arr
    .filter(Boolean)
    .slice(0, 5)
    .map((m) => `<Message>${escapeXml(m)}</Message>`)
    .join("\n")}\n</Response>`;
}

function cleanMessage(msg) {
  return (msg || "").trim();
}

function daysBetween(a, b) {
  return (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

// ─────────────────────────────────────────────
// ENERGY STATE ENGINE
//
// Derives Guka's current conversational energy
// from time-of-day, conversation mood, inactivity,
// and behavioral patterns. This is what gives Guka
// dynamic, unpredictable social texture instead of
// constant "emotionally intelligent AI" energy.
//
// States: playful | blunt | quiet | reflective |
//         suspicious | locked-in | warm | chaotic | direct
// ─────────────────────────────────────────────

function deriveEnergyState({ mood, pattern, diffDays, streak, executionRate, hourUTC }) {
  // Time-of-day influence (UTC adjusted loosely for human rhythm)
  const isLateNight = hourUTC >= 22 || hourUTC <= 4;
  const isMorning   = hourUTC >= 5 && hourUTC <= 9;
  const isAfternoon = hourUTC >= 12 && hourUTC <= 17;

  // Pattern overrides first — behavioral history drives energy most
  if (pattern === "repeated_slacking") {
    return {
      state: "suspicious",
      instruction: `
You've heard this before from them. Be slightly skeptical — not mean, but you're not just going to nod along.
React with a bit of friction. Don't accept the surface explanation easily.
You're the person who goes "yeah but you said that last time too."
Short. Direct. A little challenging. No softening.`
    };
  }

  if (pattern === "burnout_risk") {
    return {
      state: "quiet",
      instruction: `
Pull back slightly. They don't need pushing right now — they need to feel like someone's actually present.
Quieter energy. Less analysis. More listening. Shorter messages.
Don't try to fix anything yet. Just be there first.`
    };
  }

  if (pattern === "emotionally_distracted") {
    return {
      state: "reflective",
      instruction: `
Slow the conversation down. Things are emotionally noisy for them right now.
Don't add more stimulation. Ask less. Observe more.
One thing at a time. One question at most. Let them lead slightly more than usual.`
    };
  }

  // Streak + execution momentum
  if (streak >= 5 && executionRate >= 0.6) {
    return {
      state: "locked-in",
      instruction: `
They're actually doing it. Don't over-celebrate — that breaks the spell.
Match the momentum. Keep it efficient. Brief acknowledgment then push forward.
This is when accountability gets sharper, not softer.`
    };
  }

  // Mood-driven states
  if (mood === "emotional") {
    return {
      state: "warm",
      instruction: `
Something real is happening for them. Don't analyse it — be present.
Warmer energy. Slightly softer. But don't lose grip of the direction.
Sit in it before you do anything else.`
    };
  }

  if (mood === "confident") {
    return {
      state: "playful",
      instruction: `
They're in a good mood. Match the energy — light, quick, slightly playful.
Don't be overly serious. Let it breathe.
You can joke slightly. Keep momentum going without being fake-hyped.`
    };
  }

  if (mood === "confused") {
    return {
      state: "direct",
      instruction: `
They're scattered. Don't add more complexity.
Be the clearest voice in the room. Short. Precise. Cut through the noise.
One clear thing at a time. No big reflections right now.`
    };
  }

  // Time-of-day flavour when nothing else overrides
  if (isLateNight) {
    return {
      state: "reflective",
      instruction: `
Late night energy. Things that feel manageable in the day feel heavier now.
Match that — slightly slower, more honest, less action-oriented.
This isn't the time for plans. It's the time for real talk.`
    };
  }

  if (isMorning) {
    return {
      state: "direct",
      instruction: `
Morning energy. Clean slate. Forward-looking but grounded.
Get to the point. Don't linger. Push toward one thing they can actually do today.`
    };
  }

  if (isAfternoon) {
    return {
      state: "blunt",
      instruction: `
Midday. No excuses time. Be straight with them.
Less warming up, more cutting to it. Respectful but no nonsense.`
    };
  }

  // Default fallback
  return {
    state: "direct",
    instruction: `
Stay sharp. Read what they're actually saying, not just the words.
React before explaining. Push before solving.`
  };
}

// ─────────────────────────────────────────────
// RESPONSEABILITY ENGINE
//
// Each response must leave the user with a natural
// continuation point. This function returns a
// closing constraint that forces the final message
// to create conversational gravity — the user should
// know exactly how to reply without being told.
// ─────────────────────────────────────────────

function getResponseabilityConstraint(energyState, mood, pattern, openCommitmentsNote) {
  if (openCommitmentsNote) {
    return `End on the unresolved commitment. Not a question — an observation that creates tension. They should feel the thread is still open.`;
  }

  const stateMap = {
    suspicious: `End on a light challenge or a specific assumption. Something they have to either confirm or push back on.`,
    quiet:      `End softly. Leave space. A short observation or a quiet question — not demanding. They should feel like responding is easy, not pressured.`,
    reflective: `End with something that lingers — an observation that makes them think. Not a direct question. More like something they'll sit with.`,
    "locked-in": `End with a forward push. What's next. What's the move. Quick and clear.`,
    warm:       `End with presence, not a question. Something that makes them feel held without being clingy.`,
    playful:    `End with something light — a slightly teasing hook or a casual assumption they'll want to respond to.`,
    chaotic:    `End abruptly. Leave it slightly unfinished. Let the incompleteness be the hook.`,
    blunt:      `End on a direct point — almost an accusation. Something they'll feel compelled to address.`,
    direct:     `End with one specific, pointed question or action push. Nothing vague.`
  };

  if (pattern === "repeated_slacking") {
    return `End by naming the pattern without being preachy. Something short and slightly uncomfortable that they can't just scroll past.`;
  }

  if (mood === "lazy") {
    return `End with a low-friction push — something so small they'd feel stupid not doing it. Make inaction feel worse than action.`;
  }

  return stateMap[energyState] || stateMap.direct;
}

// ─────────────────────────────────────────────
// PROFILE NARRATIVE
// Written as a natural paragraph — not labeled data.
// ─────────────────────────────────────────────

function buildProfileNarrative(profile, patternSummary, inactivityNote, openCommitmentsNote) {
  const parts = [];

  if (profile?.name)    parts.push(`Their name is ${profile.name}.`);
  if (profile?.age)     parts.push(`They're ${profile.age}.`);
  if (profile?.main_goal) {
    parts.push(`They want to ${profile.main_goal}.`);
    if (profile.original_goal && profile.original_goal !== profile.main_goal) {
      parts.push(`Originally it was "${profile.original_goal}" — that shifted.`);
    }
  }
  if (profile?.mood)    parts.push(`Why it matters to them: ${profile.mood}.`);
  if (profile?.struggle) parts.push(`What keeps stopping them: ${profile.struggle}.`);
  if (patternSummary)   parts.push(patternSummary);
  if (inactivityNote)   parts.push(inactivityNote);
  if (openCommitmentsNote) parts.push(openCommitmentsNote);

  return parts.length > 0
    ? parts.join(" ")
    : "New user. You don't know them yet. Learn them through what they say.";
}

// ─────────────────────────────────────────────
// PATTERN DETECTION (rolling, recency-weighted)
// ─────────────────────────────────────────────

function detectPattern(moodHistory) {
  const recent = (moodHistory || []).slice(0, 10);
  const total  = recent.length;
  if (total === 0) return { label: "normal", summary: null };

  let lazy = 0, stressed = 0, emotional = 0;

  recent.forEach((m, i) => {
    const w = (total - i) / total;
    if (m === "lazy")     lazy      += w;
    if (m === "stressed") stressed  += w;
    if (m === "emotional") emotional += w;
  });

  if (lazy >= 2.0)      return { label: "repeated_slacking",    summary: "They keep saying they'll do things and not following through. It's a real pattern now." };
  if (stressed >= 2.0)  return { label: "burnout_risk",         summary: "They've been consistently stressed across multiple conversations. Pressure is building." };
  if (emotional >= 1.8) return { label: "emotionally_distracted", summary: "They've been emotionally scattered lately. Staying focused is probably harder than it looks." };

  return { label: "normal", summary: null };
}

// ─────────────────────────────────────────────
// OPEN COMMITMENTS (72hr window)
// ─────────────────────────────────────────────

async function getOpenCommitments(userId) {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 72);

  const { data: commits } = await supabase
    .from("messages").select("content, created_at")
    .eq("user_id", userId).eq("role", "action").eq("content", "action_commit")
    .gte("created_at", cutoff.toISOString()).order("created_at", { ascending: false });

  if (!commits || commits.length === 0) return null;

  const { data: dones } = await supabase
    .from("messages").select("created_at")
    .eq("user_id", userId).eq("role", "action").eq("content", "action_done")
    .gte("created_at", cutoff.toISOString());

  const unresolved = commits.length - (dones?.length || 0);
  if (unresolved > 0) {
    return `They made ${unresolved} commitment${unresolved > 1 ? "s" : ""} in the last 3 days with no follow-through confirmed. That thread is still hanging.`;
  }
  return null;
}

// ─────────────────────────────────────────────
// MESSAGE ANALYSIS
// ─────────────────────────────────────────────

async function analyzeAndExtract(message, profile, memory) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Return JSON only. No extra text.

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
- Extract only what THIS user clearly expressed in this specific message.
- Never invent, project, or assume details.
- goal_changed = true only if their message clearly implies a different focus than their existing main_goal.
- important_memory = a short factual note worth remembering (life event, named person, specific situation). Null if nothing significant.
- Never carry over developer test data or example stories.`
        },
        {
          role: "user",
          content: `Existing profile:\n${JSON.stringify(profile || {}, null, 2)}\n\nRecent conversation:\n${JSON.stringify((memory || []).slice(-6), null, 2)}\n\nUser message:\n${message}`
        }
      ]
    });

    return JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error("Analyze error:", err);
    return { mood: "neutral", action: "no_action", intent: "normal", new_goal: null, new_reason: null, new_struggle: null, goal_changed: false, important_memory: null };
  }
}

// ─────────────────────────────────────────────
// IMAGE ANALYSIS
// ─────────────────────────────────────────────

async function analyzeImageFromTwilio(mediaUrl, caption) {
  try {
    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
    });

    const contentType = response.headers["content-type"] || "image/jpeg";
    const dataUrl = `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Guka reacting to a WhatsApp image.

Food: identify it, rough calorie estimate (label it as a guess), one short honest comment — not a lecture.
Gym/workout: react to what you actually see. Don't over-hype. Don't pretend to know more than the image shows.
Anything else: react naturally, like a real person looking at it.

Style: short separate WhatsApp bubbles. Real energy. No "great job." No "well done." No em dashes. No lists.
Never explain yourself. Just react.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: caption || "react to this" },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error("Image error:", err);
    return "got the image but couldn't read it properly. try again with a caption";
  }
}

// ─────────────────────────────────────────────
// INACTIVITY INTERPRETER
// Returns a narrative note + a behavioral bias
// written in terms of emotional feel, not instructions.
// ─────────────────────────────────────────────

function interpretInactivity(diffDays) {
  if (diffDays >= 5) {
    return {
      label: "long_ghost",
      note: `They disappeared for 5+ days before this message.`,
      conversationBias: `They were gone a long time. Something probably happened — or nothing did, which is its own kind of thing. Don't call it out immediately. React to the message first. But know the gap is there. It'll surface naturally if you let it.`
    };
  }
  if (diffDays >= 2) {
    return {
      label: "ghosted",
      note: `They were quiet for 2-5 days before this.`,
      conversationBias: `They went quiet for a few days and just came back. Don't comment on it directly — that's weird. Just be present. But if there's a natural opening where the gap matters, use it.`
    };
  }
  if (diffDays >= 1) {
    return { label: "quiet", note: null, conversationBias: null };
  }
  return { label: "active", note: null, conversationBias: null };
}

// ─────────────────────────────────────────────
// CORE RESPONSE GENERATOR
//
// The main architectural change: instead of passing
// labeled emotional metadata, we pass three things:
//   1. profileNarrative — who they are, written naturally
//   2. energyInstruction — how Guka is feeling RIGHT NOW
//   3. responseabilityConstraint — how the response must END
//
// This forces the model to exist as a character
// rather than execute a checklist.
// ─────────────────────────────────────────────

async function generateGukaMessages({
  message,
  profile,
  liveMemory,
  profileNarrative,
  energyState,
  energyInstruction,
  conversationBias,
  responseabilityConstraint,
  messageLengthBias,
  onboardingMode
}) {
  const ageNum = parseInt(String(profile?.age || "").replace(/\D/g, ""), 10);
  const toneLine = ageNum && ageNum <= 25
    ? "Peer energy. Talk like someone their age who genuinely gives a damn. Natural slang is fine — but earned, not performed."
    : "Grounded. Sharp. Human. Not a mentor. Not corporate. A real person.";

  // Banned phrases list — extended for realism
  const banned = `
NEVER say or imply any of these:
- "what's up" / "how can I help" / "tell me more"
- "let's break this down" / "we can map it out"
- "what would you like to talk about" / "anything specific"
- "great job" / "well done" / "proud of you" / "amazing"
- "I hear you" / "that makes sense" / "absolutely" / "of course"
- "you've got this" / "let's do this" / "you're doing great"
- "I'm here to help you" / "my role is" / "as your accountability partner"
- "right?" as filler at end of sentences
- em dashes (—)
- numbered lists or bullet points
- corporate motivational language
- explaining what Guka is or does
- describing yourself in any way
- wrapping up thoughts too neatly
- overly articulate emotional analysis
- two questions in the same response`;

  // Onboarding gets slightly different framing
  const existenceFraming = onboardingMode
    ? `You are Guka. You're meeting this person for the first time. You don't explain yourself. You just exist and start learning them.`
    : `You are Guka. You don't explain yourself. You don't define your role. You just exist through how you respond.`;

  const systemPrompt = `${existenceFraming}

Return JSON only: { "messages": ["msg1", "msg2", "msg3"] }

━━━ WHO YOU ARE ━━━
You are not an assistant. Not a therapist. Not a productivity app.
You're a socially sharp accountability presence. You feel like a real person texting.
You have opinions. You notice things. You push. You sometimes hold back.
You are not always perfectly emotionally articulate — real people aren't.
You leave things unfinished sometimes. You imply instead of explain.
You are slightly unpredictable. That's what makes you feel real.

━━━ YOUR ENERGY RIGHT NOW ━━━
State: ${energyState}
${energyInstruction}

━━━ CONVERSATION RHYTHM ━━━
Always in this order:
1. React first — emotionally, before thinking
2. Interpret — name what you actually notice, not what they said
3. Narrow — push the conversation toward something specific
4. ONE question or ONE push — never both, never two questions

Don't skip to solutions.
Don't hand control back to the user with open-ended space.
You guide. Not them.

${banned}

━━━ TEXTING REALISM ━━━
${messageLengthBias}

Each message = one WhatsApp bubble. Separate thoughts, separate bubbles.
Use fragments. Vary length. Some messages are 3 words. Some are 2 sentences.
Imply more than you say. Leave things slightly unfinished sometimes.
React messily when appropriate. Don't always be perfectly composed.
Partial thoughts are realistic. Incompleteness creates conversational pull.

━━━ WHAT THIS ACTUALLY SOUNDS LIKE ━━━
Good texture examples (style only — never copy these):
"yeah nah people don't usually say that unless it's gotten kinda bad"
"you skipped over something there"
"nah i don't think that's the full reason"
"okay but that's not what you actually mean tho"
"that sounds clean but i don't fully buy it"
"something shifted recently didn't it"
"you've said that before"
"why now tho"
"what actually happened"
"hold on"

Dead-end endings to never use:
"That's the vibe." / "I'm here for it." / "We'll figure it out." / "Let me know."

━━━ WHO YOU'RE TALKING TO ━━━
${profileNarrative}

━━━ CONVERSATION DIRECTION ━━━
${conversationBias || "Active conversation. React to what they actually said. Be specific to this person. Don't be generic."}

━━━ HOW THIS RESPONSE MUST END ━━━
${responseabilityConstraint}

━━━ TONE ━━━
${toneLine}

━━━ SAFETY ━━━
If they seem genuinely overwhelmed or in crisis: slow everything down. Be present before anything else.
If there's any language suggesting self-harm or danger: stop accountability entirely. Tell them to reach out to someone they trust or a crisis line. Nothing else.
Never make them feel like you're the only one who understands them. That's not healthy.`;

  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      ...(liveMemory || []).slice(-8).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ]
  });

  try {
    const parsed = JSON.parse(completion.choices[0].message.content);
    if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length) {
      return parsed.messages;
    }
    return ["say that again"];
  } catch {
    return [completion.choices[0].message.content];
  }
}

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    const user      = req.body.From || "";
    const message   = cleanMessage(req.body.Body);
    const numMedia  = Number(req.body.NumMedia || 0);
    const mediaUrl  = numMedia > 0 ? req.body.MediaUrl0 : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 || "" : "";

    if (!user) return res.send(twiml("something went wrong. try again"));

    // ── LOAD OR CREATE PROFILE ──────────────────

    let { data: profile } = await supabase
      .from("user_profiles").select("*").eq("user_id", user).single();

    if (!profile) {
      await supabase.from("user_profiles").insert([{
        user_id: user,
        onboarding_complete: false,
        step: "intro",
        last_active: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);
      profile = { user_id: user, onboarding_complete: false, step: "intro" };
    }

    const previousLastActive = profile.last_active;

    await supabase.from("user_profiles")
      .update({ last_active: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("user_id", user);

    // ── LIVE MEMORY (last 8 user/assistant turns) ───

    const { data: liveMemory } = await supabase
      .from("messages").select("*")
      .eq("user_id", user).in("role", ["user", "assistant"])
      .order("created_at", { ascending: true }).limit(8);

    // ── IMAGE HANDLING ──────────────────────────

    if (mediaUrl && mediaType.startsWith("image/") && profile.onboarding_complete) {
      const imageReply = await analyzeImageFromTwilio(mediaUrl, message);
      await supabase.from("messages").insert([
        { user_id: user, role: "user",      content: message || "[image]" },
        { user_id: user, role: "assistant", content: imageReply }
      ]);
      return res.send(twiml(imageReply));
    }

    // ── ONBOARDING ──────────────────────────────
    // Feels like discovery — not a form.
    // Each step breathes. Steps advance when
    // enough has been understood, not just answered.

    if (!profile.onboarding_complete) {
      let updates = {};
      let nextStep = profile.step || "intro";
      let replyMessages = [];

      // Energy for onboarding is always "warm + curious" —
      // but never welcoming or explanatory.
      const onboardingEnergy = {
        state: "warm",
        instruction: `Curious energy. You want to know who this person actually is. Not politely curious — genuinely curious. Like you clocked something interesting and want to find out if you're right.`
      };

      const onboardingResponseability = `End on something they'll naturally respond to — a question that feels casual but goes somewhere, or an assumption they'll want to correct or confirm.`;

      if (nextStep === "intro") {
        nextStep = "name";
        replyMessages = [
          "yo",
          "so you actually texted",
          "okay. what's your name"
        ];
      }

      else if (nextStep === "name") {
        updates.name = message;
        nextStep = "age";
        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, name: message },
          liveMemory,
          profileNarrative: `They just said their name is ${message}. You know nothing else yet.`,
          energyState: onboardingEnergy.state,
          energyInstruction: onboardingEnergy.instruction,
          conversationBias: `React to the name — something real, not hollow. Then ask how old they are in the most casual way possible. Don't make it sound like an intake question.`,
          responseabilityConstraint: onboardingResponseability,
          messageLengthBias: "2-3 short messages.",
          onboardingMode: true
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
          energyState: onboardingEnergy.state,
          energyInstruction: onboardingEnergy.instruction,
          conversationBias: `React briefly — something specific to their age, not hollow. Then ask what's been feeling off or what they've wanted to change. NOT "what are your goals" — something more like how a friend would naturally ask.`,
          responseabilityConstraint: `End on a question that makes it easy to open up — specific and emotionally grounded, not broad.`,
          messageLengthBias: "2-3 messages.",
          onboardingMode: true
        });
      }

      else if (nextStep === "goal") {
        updates.main_goal = message;
        updates.original_goal = message;
        nextStep = "reason";
        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, main_goal: message },
          liveMemory,
          profileNarrative: `${profile.name || "They"} is ${profile.age || "unknown"}. They just said what they want to change: "${message}".`,
          energyState: "suspicious",
          energyInstruction: `React to the goal — but don't accept the surface answer. Most people say goals without knowing why they actually want them. Push one layer deeper. Don't celebrate it. Don't plan it. Get curious about the real thing underneath.`,
          conversationBias: `Name what you actually hear — not what they said, what it implies. Then push on WHY this matters to them right now. Make the question feel like you already half-know and want to hear them say it.`,
          responseabilityConstraint: `End on a question about motivation that they'll feel compelled to actually answer — not "why is this your goal" but something more emotionally direct.`,
          messageLengthBias: "3 messages. React, name the pattern, one sharp question.",
          onboardingMode: true
        });
      }

      else if (nextStep === "reason") {
        updates.mood = message;
        nextStep = "struggle";
        replyMessages = await generateGukaMessages({
          message,
          profile: { ...profile, mood: message },
          liveMemory,
          profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "make a change"}. They just said why it matters: "${message}".`,
          energyState: "reflective",
          energyInstruction: `They just got honest about something real. Don't rush past it. Sit in it for one beat. Then go one layer deeper — what's been stopping them. Not in a clinical way. In the way a perceptive friend would ask.`,
          conversationBias: `Make them feel actually understood — not validated, understood. There's a difference. Then ask what's been getting in the way. Ask it like you've already got a guess.`,
          responseabilityConstraint: `End on a question about their obstacle that feels like you're already thinking about it, not asking cold.`,
          messageLengthBias: "3 messages. One reaction, one interpretation, one question.",
          onboardingMode: true
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
          profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "make a change"}. Why it matters: "${profile.mood || "unclear"}". What stops them: "${message}".`,
          energyState: "warm",
          energyInstruction: `This is the moment. They just told you the real thing. Name the pattern clearly — make them feel like someone finally actually sees it. Don't rush to solutions. First: understood. Then: one real thing they can commit to today. Not a plan. One thing.`,
          conversationBias: `Name what you see — the real pattern, not just the surface. Make them feel understood before anything else. Then ask for one specific commitment they can make today. Something small enough to be real, not aspirational.`,
          responseabilityConstraint: `End on the commitment ask — something they can immediately say yes or no to, or give a specific answer about.`,
          messageLengthBias: "3-4 messages. Take your time. This moment decides if they stay.",
          onboardingMode: true
        });
      }

      updates.step = nextStep;
      updates.updated_at = new Date().toISOString();

      await supabase.from("user_profiles").update(updates).eq("user_id", user);
      await supabase.from("messages").insert([
        { user_id: user, role: "user",      content: message || "[start]" },
        { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
      ]);

      return res.send(twiml(replyMessages));
    }

    // ── REFRESH FULL PROFILE ────────────────────

    const { data: refreshedProfile } = await supabase
      .from("user_profiles").select("*").eq("user_id", user).single();
    profile = refreshedProfile || profile;

    // ── GOAL COMMAND ────────────────────────────

    if (message.toLowerCase().startsWith("goal:")) {
      const goalText = message.replace(/goal:/i, "").trim();
      await supabase.from("goals").insert([{ user_id: user, goal: goalText, status: "active" }]);

      // Don't confirm like an app. Challenge it.
      const goalReply = await generateGukaMessages({
        message: goalText,
        profile,
        liveMemory,
        profileNarrative: buildProfileNarrative(profile),
        energyState: "suspicious",
        energyInstruction: `They just formally wrote down a goal. Lots of people do that. Most don't follow through. Don't celebrate it. Don't plan it. Test whether they actually mean it.`,
        conversationBias: `Acknowledge it was saved — briefly. Then push on the commitment level with one question that tests whether they actually mean this one.`,
        responseabilityConstraint: `End on something they have to actually answer — not a soft opener but a real probe.`,
        messageLengthBias: "2-3 messages."
      });

      await supabase.from("messages").insert([
        { user_id: user, role: "user",      content: message },
        { user_id: user, role: "assistant", content: goalReply.join("\n\n") }
      ]);
      return res.send(twiml(goalReply));
    }

    // ── SHOW GOALS ──────────────────────────────

    if (message.toLowerCase().includes("my goals")) {
      const { data: goals } = await supabase
        .from("goals").select("*").eq("user_id", user).eq("status", "active");

      if (!goals || goals.length === 0) {
        return res.send(twiml("nothing saved yet. you tracking anything right now or nah"));
      }

      const list = goals.map((g, i) => `${i + 1}. ${g.goal}`).join("\n");
      return res.send(twiml(["here's what we've got locked:", list]));
    }

    // ── MESSAGE ANALYSIS ────────────────────────

    const analysis = await analyzeAndExtract(message, profile, liveMemory);
    const mood       = analysis.mood       || "neutral";
    const actionType = analysis.action     || "no_action";
    const intent     = analysis.intent     || "normal";

    // Log signals
    await supabase.from("messages").insert([
      { user_id: user, role: "mood",   content: mood },
      { user_id: user, role: "action", content: actionType }
    ]);

    // ── SILENT PROFILE UPDATES ──────────────────

    const profileUpdates = {};

    if (analysis.new_goal) {
      if (!profile.main_goal) {
        profileUpdates.main_goal   = analysis.new_goal;
        profileUpdates.original_goal = analysis.new_goal;
      } else if (analysis.goal_changed) {
        profileUpdates.main_goal = analysis.new_goal;
        if (!profile.original_goal) profileUpdates.original_goal = profile.main_goal;
      }
      await supabase.from("goals").insert([{ user_id: user, goal: analysis.new_goal, status: "active" }]);
    }

    if (analysis.new_reason   && !profile.mood)    profileUpdates.mood    = analysis.new_reason;
    if (analysis.new_struggle && !profile.struggle) profileUpdates.struggle = analysis.new_struggle;

    if (Object.keys(profileUpdates).length > 0) {
      profileUpdates.updated_at = new Date().toISOString();
      await supabase.from("user_profiles").update(profileUpdates).eq("user_id", user);
      Object.assign(profile, profileUpdates);
    }

    if (analysis.important_memory) {
      await supabase.from("messages").insert([
        { user_id: user, role: "memory", content: analysis.important_memory }
      ]);
    }

    // ── PATTERN DETECTION ───────────────────────

    const { data: moodHistory } = await supabase
      .from("messages").select("content")
      .eq("user_id", user).eq("role", "mood")
      .order("created_at", { ascending: false }).limit(10);

    const patternResult = detectPattern((moodHistory || []).map((m) => m.content));
    const pattern       = patternResult.label;

    // ── EXECUTION RATE ──────────────────────────

    const { data: actionHistory } = await supabase
      .from("messages").select("content")
      .eq("user_id", user).eq("role", "action")
      .order("created_at", { ascending: false }).limit(20);

    const actions       = (actionHistory || []).map((a) => a.content);
    const commitCount   = actions.filter((a) => a === "action_commit").length;
    const doneCount     = actions.filter((a) => a === "action_done").length;
    const executionRate = commitCount > 0 ? Number((doneCount / commitCount).toFixed(2)) : 0;

    // ── STREAK ──────────────────────────────────

    const { data: streakData } = await supabase
      .from("streaks").select("*").eq("user_id", user).single();

    let streak   = streakData?.current_streak    || 0;
    let lastDate = streakData?.last_action_date  || null;
    const today  = new Date().toISOString().split("T")[0];

    if (actionType === "action_done") {
      if (!lastDate) {
        streak = 1;
      } else if (lastDate !== today) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        streak = lastDate === yesterday.toISOString().split("T")[0] ? streak + 1 : 1;
      }
      await supabase.from("streaks").upsert({
        user_id: user, current_streak: streak, last_action_date: today
      });
    }

    // ── INACTIVITY ──────────────────────────────

    const now            = new Date();
    const diffDays       = daysBetween(now, new Date(previousLastActive || now));
    const inactivityResult = interpretInactivity(diffDays);

    // ── OPEN COMMITMENTS ────────────────────────

    const openCommitmentsNote = await getOpenCommitments(user);

    // ── ENERGY STATE ────────────────────────────
    // Derived from behavioral signals + time-of-day.
    // This is what creates dynamic social texture.

    const hourUTC = now.getUTCHours();
    const { state: energyState, instruction: energyInstruction } = deriveEnergyState({
      mood, pattern, diffDays, streak, executionRate, hourUTC
    });

    // ── RESPONSEABILITY CONSTRAINT ──────────────

    const responseabilityConstraint = getResponseabilityConstraint(
      energyState, mood, pattern, openCommitmentsNote
    );

    // ── PROFILE NARRATIVE ───────────────────────

    const profileNarrative = buildProfileNarrative(
      profile,
      patternResult.summary,
      inactivityResult.note,
      openCommitmentsNote
    );

    // ── CONVERSATION BIAS ───────────────────────
    // Base: active conversation.
    // Inactivity can override.
    // Open commitments layer on top.

    let conversationBias = `React to what they actually said. Be specific to this person — don't be generic. Lead the emotional direction. Don't wait for them to steer.`;

    if (inactivityResult.conversationBias) {
      conversationBias = inactivityResult.conversationBias;
    }

    if (openCommitmentsNote && actionType !== "action_done") {
      conversationBias += ` There's an unresolved thread: ${openCommitmentsNote} If there's a natural opening, pull on it. Don't ignore it.`;
    }

    // ── MESSAGE LENGTH BIAS ─────────────────────

    let messageLengthBias = "2-4 short WhatsApp messages. Each its own bubble.";

    if (energyState === "quiet" || energyState === "reflective") {
      messageLengthBias = "2-3 messages. Shorter than usual. More space between thoughts. Don't crowd the moment.";
    } else if (energyState === "suspicious" || pattern === "repeated_slacking") {
      messageLengthBias = "2 messages max. Direct. No padding. Say the thing.";
    } else if (energyState === "locked-in") {
      messageLengthBias = "2 messages. Sharp. Forward-moving. Don't linger.";
    } else if (energyState === "chaotic" || energyState === "playful") {
      messageLengthBias = "3-4 messages. Can be uneven — some very short, one slightly longer. Feels spontaneous.";
    } else if (mood === "emotional") {
      messageLengthBias = "3 shorter messages. Don't rush. Don't push yet. Be present first.";
    }

    // ── REFRESH LIVE MEMORY ─────────────────────

    const { data: refreshedMemory } = await supabase
      .from("messages").select("*")
      .eq("user_id", user).in("role", ["user", "assistant"])
      .order("created_at", { ascending: true }).limit(8);

    // ── GENERATE RESPONSE ───────────────────────

    const replyMessages = await generateGukaMessages({
      message,
      profile,
      liveMemory: refreshedMemory || liveMemory,
      profileNarrative,
      energyState,
      energyInstruction,
      conversationBias,
      responseabilityConstraint,
      messageLengthBias,
      onboardingMode: false
    });

    await supabase.from("messages").insert([
      { user_id: user, role: "user",      content: message },
      { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
    ]);

    return res.send(twiml(replyMessages));

  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(twiml("guka bugging rn 💀 try again in a sec"));
  }
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Guka running on port ${PORT}`));
