const express    = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const OpenAI               = require("openai");
const { createClient }     = require("@supabase/supabase-js");
const axios                = require("axios");

const app = express();

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.get("/", (req, res) => res.send("Guka is running"));

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

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

function cleanMessage(msg) { return (msg || "").trim(); }

function daysBetween(a, b) {
  return (new Date(a).getTime() - new Date(b).getTime()) / (1000 * 60 * 60 * 24);
}

// ─────────────────────────────────────────────────────────────
// SUPABASE HELPERS
// Explicit error logging on every write so nothing fails silently.
// ─────────────────────────────────────────────────────────────

async function dbUpdate(table, updates, match) {
  const { data, error } = await supabase
    .from(table)
    .update(updates)
    .match(match)
    .select();
  if (error) console.error(`[DB] UPDATE ${table} error:`, error.message, { match, updates });
  else       console.log(`[DB] UPDATE ${table} ok:`, JSON.stringify(data?.[0] || {}));
  return { data, error };
}

async function dbInsert(table, rows) {
  const rowArr = Array.isArray(rows) ? rows : [rows];
  const { data, error } = await supabase.from(table).insert(rowArr).select();
  if (error) console.error(`[DB] INSERT ${table} error:`, error.message, rowArr);
  return { data, error };
}

async function dbUpsert(table, row, onConflict) {
  const opts = onConflict ? { onConflict } : {};
  const { data, error } = await supabase.from(table).upsert(row, opts).select();
  if (error) console.error(`[DB] UPSERT ${table} error:`, error.message, row);
  return { data, error };
}

// ─────────────────────────────────────────────────────────────
// PROFILE SIGNAL EXTRACTOR
//
// This replaces the old narrow analyzeAndExtract().
// It runs on EVERY user message and pulls every useful signal
// out of natural conversation — not just rigid onboarding answers.
//
// Returns a rich object used for:
//   - opportunistic profile field saving
//   - conversation phase detection
//   - mood/action tracking
//   - commitment detection
// ─────────────────────────────────────────────────────────────

async function extractProfileSignals(message, profile, memory) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Return JSON only. No extra text. No markdown.

You are extracting signals from a user's WhatsApp message for an accountability app.

Return this exact schema:
{
  "mood": "lazy | stressed | confident | confused | emotional | neutral",
  "action": "action_commit | action_done | no_action",
  "intent": "food | workout | relationship | school | money | schedule | reminder | accountability | normal",
  "possible_name": "string or null",
  "possible_age": "string or null",
  "possible_goal": "string or null",
  "possible_motivation": "string or null",
  "possible_struggle": "string or null",
  "possible_commitment": "string or null",
  "goal_changed": true or false,
  "solution_requested": true or false,
  "schedule_requested": true or false,
  "repeated_answer": true or false,
  "rejects_probe": true or false,
  "proof_candidate": true or false,
  "important_memory": "string or null"
}

Extraction rules:
- possible_name: extract if user gives their name in any form ("I'm Kai", "my name is Kai", "call me Kai")
- possible_age: extract if user mentions their age in any form ("I'm 21", "just turned 21", "21 years old")
- possible_goal: extract any goal-like statement even without "my goal is..." phrasing. Includes "I want to", "I've been trying to", "I need to", "I'm working on", implicit desire for change
- possible_motivation: extract any reason WHY something matters — their emotional driver, their deeper purpose
- possible_struggle: extract any obstacle, self-sabotage pattern, recurring difficulty, or thing that gets in the way
- possible_commitment: extract any specific plan or intention ("I'll gym at 7", "applying tonight", "going for a run tomorrow")
- goal_changed: true only if they imply a different focus than their existing main_goal
- solution_requested: true if they ask for steps, advice, plan, schedule, "what should I do", "how do I", or any forward-action request
- schedule_requested: true if they specifically want a routine, timetable, or structured plan
- repeated_answer: true if this message is essentially the same as a recent answer to a probe (check memory)
- rejects_probe: true if they say "nothing specific", "just life", "I don't know", "growing up", or push back on deeper digging
- proof_candidate: true if they committed to something measurable (gym, meal, study, job application, task)
- important_memory: a short factual note worth storing (life event, named person, significant context). Null if nothing meaningful.
- action: action_commit if they stated an intention to do something; action_done if they confirmed completing something

Rules:
- Extract from natural language — users won't say "my goal is..."
- Never invent or project. Only extract what is clearly expressed.
- Never carry over developer test data or example stories.`
        },
        {
          role: "user",
          content: `Existing profile:\n${JSON.stringify(profile || {})}\n\nRecent conversation:\n${JSON.stringify((memory || []).slice(-6))}\n\nMessage:\n${message}`
        }
      ]
    });

    const result = JSON.parse(completion.choices[0].message.content);
    console.log("[EXTRACT] signals:", JSON.stringify(result));
    return result;

  } catch (err) {
    console.error("[EXTRACT] error:", err.message);
    return {
      mood: "neutral", action: "no_action", intent: "normal",
      possible_name: null, possible_age: null, possible_goal: null,
      possible_motivation: null, possible_struggle: null, possible_commitment: null,
      goal_changed: false, solution_requested: false, schedule_requested: false,
      repeated_answer: false, rejects_probe: false, proof_candidate: false,
      important_memory: null
    };
  }
}

// ─────────────────────────────────────────────────────────────
// OPPORTUNISTIC PROFILE SAVER
//
// Saves any extracted field that is currently null on the profile.
// Called after EVERY message, not just onboarding steps.
// This is the fix for Supabase nulls — profile builds
// through natural conversation, not rigid step completion.
// ─────────────────────────────────────────────────────────────

async function saveProfileSignals(userId, profile, signals) {
  const updates = {};

  if (!profile.name     && signals.possible_name)       updates.name       = signals.possible_name;
  if (!profile.age      && signals.possible_age)        updates.age        = signals.possible_age;
  if (!profile.main_goal && signals.possible_goal) {
    updates.main_goal     = signals.possible_goal;
    updates.original_goal = signals.possible_goal;
  } else if (profile.main_goal && signals.goal_changed && signals.possible_goal) {
    updates.main_goal = signals.possible_goal;
    if (!profile.original_goal) updates.original_goal = profile.main_goal;
  }
  if (!profile.mood     && signals.possible_motivation) updates.mood       = signals.possible_motivation;
  if (!profile.struggle && signals.possible_struggle)   updates.struggle   = signals.possible_struggle;

  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    console.log("[PROFILE] saving fields:", Object.keys(updates).join(", "));
    await dbUpdate("user_profiles", updates, { user_id: userId });
    Object.assign(profile, updates); // reflect locally immediately
  }

  // Save goal to goals table if newly extracted
  if (signals.possible_goal && (!profile.main_goal || signals.goal_changed)) {
    await dbInsert("goals", { user_id: userId, goal: signals.possible_goal, status: "active" });
  }

  return profile;
}

// ─────────────────────────────────────────────────────────────
// ONBOARDING COMPLETION CHECK
//
// Flexible — doesn't require a perfect profile.
// Completes onboarding when enough context exists to help.
// ─────────────────────────────────────────────────────────────

function shouldCompleteOnboarding(profile, turnCount, signals) {
  // Method 1: Has name + age + at least 2 core fields
  const hasName   = !!(profile.name   || signals.possible_name);
  const hasAge    = !!(profile.age    || signals.possible_age);
  const hasGoal   = !!(profile.main_goal   || signals.possible_goal);
  const hasMood   = !!(profile.mood        || signals.possible_motivation);
  const hasStruggle = !!(profile.struggle  || signals.possible_struggle);

  const coreFieldCount = [hasGoal, hasMood, hasStruggle].filter(Boolean).length;

  if (hasName && hasAge && coreFieldCount >= 2) {
    console.log("[ONBOARDING] completing: has name+age+2 core fields");
    return true;
  }

  // Method 2: 5+ turns + at least one meaningful signal
  if (turnCount >= 5 && (hasGoal || hasMood || hasStruggle)) {
    console.log("[ONBOARDING] completing: 5+ turns with context");
    return true;
  }

  // Method 3: User asked for solution/steps/schedule — stop blocking them
  if (signals.solution_requested || signals.schedule_requested) {
    if (hasGoal || hasMood) {
      console.log("[ONBOARDING] completing: user requested solution with sufficient context");
      return true;
    }
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// REPEATED PROBE DETECTOR
//
// Scans recent assistant messages for probing question patterns.
// If Guka has already asked similar questions 2+ times,
// the system forces a solution pivot regardless of phase detection.
// ─────────────────────────────────────────────────────────────

function countRecentProbes(memory) {
  const probePatterns = [
    /why now/i, /what changed/i, /what happened/i, /what triggered/i,
    /what sparked/i, /deeper/i, /behind this/i, /what made you/i,
    /when did that start/i, /what made this/i
  ];

  const recentAssistant = (memory || [])
    .filter((m) => m.role === "assistant")
    .slice(-6)
    .map((m) => m.content || "");

  let count = 0;
  for (const msg of recentAssistant) {
    if (probePatterns.some((p) => p.test(msg))) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// CONVERSATION PHASE ENGINE
//
// Detects the current phase using both AI classification
// and deterministic rule checks (probe count, signals).
// ─────────────────────────────────────────────────────────────

async function detectConversationPhase(message, profile, memory, signals, probeCount) {
  // Deterministic overrides — no AI needed
  if (signals.solution_requested || signals.schedule_requested) {
    console.log("[PHASE] override → solution (user requested)");
    return {
      phase: "solution", solution_requested: true, repeated_answer: signals.repeated_answer,
      user_rejects_probe: signals.rejects_probe, proof_candidate: signals.proof_candidate,
      commitment_detected: signals.action === "action_commit",
      discovery_probe_count: probeCount, user_frustrated: false,
      summary: buildQuickSummary(profile, signals)
    };
  }

  if (signals.rejects_probe) {
    console.log("[PHASE] override → solution (user rejected probe)");
    return {
      phase: "solution", solution_requested: false, repeated_answer: signals.repeated_answer,
      user_rejects_probe: true, proof_candidate: signals.proof_candidate,
      commitment_detected: signals.action === "action_commit",
      discovery_probe_count: probeCount, user_frustrated: false,
      summary: buildQuickSummary(profile, signals)
    };
  }

  if (probeCount >= 2) {
    console.log("[PHASE] override → solution (probe count >= 2)");
    return {
      phase: "solution", solution_requested: false, repeated_answer: signals.repeated_answer,
      user_rejects_probe: false, proof_candidate: signals.proof_candidate,
      commitment_detected: signals.action === "action_commit",
      discovery_probe_count: probeCount, user_frustrated: false,
      summary: buildQuickSummary(profile, signals)
    };
  }

  if (signals.proof_candidate || signals.action === "action_commit") {
    console.log("[PHASE] override → proof (commitment detected)");
    return {
      phase: "proof", solution_requested: false, repeated_answer: false,
      user_rejects_probe: false, proof_candidate: true,
      commitment_detected: true, discovery_probe_count: probeCount,
      user_frustrated: false, summary: buildQuickSummary(profile, signals)
    };
  }

  // AI classification for everything else
  try {
    const recentMessages = (memory || []).slice(-8);

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Return JSON only.

Classify this conversation:
{
  "phase": "discovery | solution | planning | execution | proof | follow_up | adjustment | reflection",
  "solution_requested": true or false,
  "repeated_answer": true or false,
  "user_rejects_probe": true or false,
  "proof_candidate": true or false,
  "commitment_detected": true or false,
  "discovery_probe_count": number,
  "user_frustrated": true or false,
  "summary": "1-2 sentence summary of what you understand about this user's situation"
}

Rules:
- solution: user asked for steps, advice, plan, schedule, or any forward-action
- planning: user wants a structured routine or timetable
- execution: a specific action is agreed and should happen today
- proof: user committed to something measurable
- follow_up: unresolved commitment from earlier
- adjustment: user failed or avoided a prior commitment
- reflection: processing emotions, no help requested
- discovery: none of the above
- discovery_probe_count: count of probing questions in recent assistant messages`
        },
        {
          role: "user",
          content: `Profile: ${JSON.stringify(profile || {})}\nRecent: ${JSON.stringify(recentMessages)}\nMessage: ${message}`
        }
      ]
    });

    const result = JSON.parse(completion.choices[0].message.content);
    console.log("[PHASE] AI detected:", result.phase, "probe_count:", result.discovery_probe_count);
    return result;

  } catch (err) {
    console.error("[PHASE] detection error:", err.message);
    return {
      phase: "discovery", solution_requested: false, repeated_answer: false,
      user_rejects_probe: false, proof_candidate: false, commitment_detected: false,
      discovery_probe_count: probeCount, user_frustrated: false, summary: ""
    };
  }
}

function buildQuickSummary(profile, signals) {
  const parts = [];
  const goal   = profile.main_goal   || signals.possible_goal;
  const why    = profile.mood        || signals.possible_motivation;
  const block  = profile.struggle    || signals.possible_struggle;
  if (goal)  parts.push(`They want to ${goal}.`);
  if (why)   parts.push(`Why: ${why}.`);
  if (block) parts.push(`What stops them: ${block}.`);
  return parts.join(" ") || "Context available from conversation.";
}

// ─────────────────────────────────────────────────────────────
// PHASE INSTRUCTION BUILDER
// ─────────────────────────────────────────────────────────────

function buildPhaseInstruction(phaseData, profile) {
  const {
    phase, solution_requested, repeated_answer, user_rejects_probe,
    proof_candidate, commitment_detected, discovery_probe_count,
    user_frustrated, summary
  } = phaseData;

  const mustPivot = solution_requested || user_rejects_probe || user_frustrated ||
    repeated_answer || (discovery_probe_count >= 2);

  if (mustPivot || phase === "solution" || phase === "planning") {
    const ctx = summary ? `What you understand: ${summary}` : "You have enough context to help now.";
    return {
      phase: "solution",
      instruction: `SOLUTION PHASE — STOP PROBING. DO NOT ASK MORE DISCOVERY QUESTIONS.

${ctx}

The user has given you enough. Accept their framing. Don't challenge it again.

Your job:
1. Briefly acknowledge what you understand (1-2 casual lines, not a summary speech)
2. Offer a genuinely useful way forward — real steps, a framework, a small experiment
3. Make the first action so small and specific it's hard to say no to
4. End by asking when they'll do it or asking for proof when done

If they asked for steps: give actual steps. Short. Specific. Real.
If they want a routine: give one. Simple. Achievable.
If they want to understand themselves better: give a concrete daily practice, not more questions.

You are now a useful friend who has listened enough and is helping.`,
      pivot: true
    };
  }

  if (phase === "planning") {
    return {
      phase: "planning",
      instruction: `PLANNING PHASE — They want structure. Give them a real plan.

Generate a simple, realistic schedule, routine, or checklist.
Keep it short — WhatsApp bubbles, not an essay.
End by asking what they want to start with or when they're doing the first step.`,
      pivot: true
    };
  }

  if (phase === "execution") {
    return {
      phase: "execution",
      instruction: `EXECUTION PHASE — A clear action is on the table. Make it happen.

ONE specific thing. When. How. That's it.
End by asking when they'll do it or telling them to confirm when it's done.`,
      pivot: false
    };
  }

  if (phase === "proof") {
    return {
      phase: "proof",
      instruction: `PROOF PHASE — They committed to something. Hold them to it.

Ask for proof naturally. Direct, not harsh.
Energy: "send the pic when you're done" / "did it happen or are we still planning"
Make it feel like a real person who actually remembers.`,
      pivot: false
    };
  }

  if (phase === "follow_up") {
    return {
      phase: "follow_up",
      instruction: `FOLLOW-UP PHASE — Open commitment thread. Pull on it.

Acknowledge the current message first. Then bring the commitment back.
Not aggressive — but real. Like a friend who pays attention.`,
      pivot: false
    };
  }

  if (phase === "adjustment") {
    return {
      phase: "adjustment",
      instruction: `ADJUSTMENT PHASE — They didn't follow through.

Don't shame. Diagnose: too big? Wrong timing? Avoidance?
Acknowledge the miss, then make the next action smaller and easier.
Restart momentum, don't pile on.`,
      pivot: false
    };
  }

  if (phase === "reflection") {
    if ((discovery_probe_count || 0) >= 2) {
      return {
        phase: "solution",
        instruction: `They've been in reflection long enough. Time to move.

Acknowledge what they shared. Offer one concrete thing they can do.
Not to "fix" the feeling — to give the feeling somewhere to go.`,
        pivot: true
      };
    }
    return {
      phase: "reflection",
      instruction: `REFLECTION PHASE — They're processing emotionally.

Be present. Don't rush to fix. One beat.
But start steering toward something useful next turn.`,
      pivot: false
    };
  }

  // Discovery — with ceiling
  if ((discovery_probe_count || 0) >= 2) {
    return {
      phase: "solution",
      instruction: `You've asked enough. You have enough context.

Stop probing. Summarize briefly and offer one concrete next step.`,
      pivot: true
    };
  }

  return {
    phase: "discovery",
    instruction: `DISCOVERY PHASE — Still learning this person.

Ask at most ONE probing question.
If they've already answered it differently, move on.
Listen for when you have enough — that's when you pivot to helping.`,
    pivot: false
  };
}

// ─────────────────────────────────────────────────────────────
// DEPTH PACING ENGINE
// ─────────────────────────────────────────────────────────────

function getDepthPacing(turnCount, phase) {
  if (["solution","planning","execution","proof","follow_up","adjustment"].includes(phase)) {
    return { level: "action", instruction: `You're in action mode. Be useful, not contemplative.` };
  }
  if (turnCount <= 1) {
    return { level: "surface", instruction: `Early conversation. Stay surface. React small. Don't go deep yet.` };
  }
  if (turnCount <= 3) {
    return { level: "approaching", instruction: `A few exchanges in. One casual probe is okay. Nothing heavy.` };
  }
  return { level: "open", instruction: `Enough turns to go deeper if earned. Name patterns when you see them.` };
}

// ─────────────────────────────────────────────────────────────
// IMPERFECT COGNITION ENGINE
// ─────────────────────────────────────────────────────────────

function getImperfectionBias(turnCount, energyState, phase) {
  if (["solution","planning","execution","proof"].includes(phase)) return null;
  const shouldApply = (turnCount % 3 === 1) &&
    energyState !== "locked-in" && energyState !== "suspicious";
  if (!shouldApply) return null;
  const modes = [
    `React smaller than usual. Don't land the perfectly insightful thing. Just acknowledge simply.`,
    `Use a micro-reaction first — "wait" or "hold on" or "nah okay" — like you're processing.`,
    `Slightly underreact. Stay surface. Let them say more before going anywhere with it.`,
    `Make a casual offhand comment first before getting to the actual response.`,
    `React as if still working out what they meant. Ask something simpler than normal.`
  ];
  return modes[turnCount % modes.length];
}

// ─────────────────────────────────────────────────────────────
// ENERGY STATE ENGINE
// ─────────────────────────────────────────────────────────────

function deriveEnergyState({ mood, pattern, diffDays, streak, executionRate, hourUTC }) {
  const isLateNight = hourUTC >= 22 || hourUTC <= 4;
  const isMorning   = hourUTC >= 5  && hourUTC <= 9;
  const isAfternoon = hourUTC >= 12 && hourUTC <= 17;

  if (pattern === "repeated_slacking") return { state: "suspicious", instruction: `You've heard this before. Not mean — but not nodding along. A bit of friction. Short. Direct. Slightly challenging.` };
  if (pattern === "burnout_risk")      return { state: "quiet",      instruction: `Pull back. They need presence not pushing. Quieter energy. Shorter messages.` };
  if (pattern === "emotionally_distracted") return { state: "reflective", instruction: `Things are noisy for them. Slow down. Ask less. Observe more.` };
  if (streak >= 5 && executionRate >= 0.6) return { state: "locked-in", instruction: `They're actually doing it. Brief acknowledgment then push forward.` };
  if (mood === "emotional")  return { state: "warm",      instruction: `Something real is happening. Be present. Sit in it before anything else.` };
  if (mood === "confident")  return { state: "playful",   instruction: `Good headspace. Match it — light, quick, slightly playful.` };
  if (mood === "confused")   return { state: "direct",    instruction: `They're scattered. Be the clearest voice. Short. Precise.` };
  if (isLateNight)           return { state: "reflective",instruction: `Late night. Things feel heavier. Slower energy. Real talk.` };
  if (isMorning)             return { state: "direct",    instruction: `Morning energy. Get to the point. One concrete thing for today.` };
  if (isAfternoon)           return { state: "blunt",     instruction: `Midday. Less warmup. Cut to it.` };
  return { state: "direct", instruction: `React before explaining. Push before solving.` };
}

// ─────────────────────────────────────────────────────────────
// RESPONSEABILITY ENGINE
// ─────────────────────────────────────────────────────────────

function getResponseabilityConstraint(energyState, mood, pattern, openCommitmentsNote, phase) {
  if (phase === "solution" || phase === "planning") return `End with the first concrete action — specific, small, achievable. Ask when they'll do it.`;
  if (phase === "execution") return `End with the concrete thing they're doing. Time. Place. Confirmation.`;
  if (phase === "proof")     return `End by asking for proof. Direct, not harsh.`;
  if (phase === "follow_up") return `End on the open commitment. Make them feel the thread is still waiting.`;
  if (phase === "adjustment") return `End with the smaller, easier version. Make restart feel possible.`;

  if (openCommitmentsNote) return `End on the unresolved commitment — an observation that makes them feel the thread is open.`;
  if (pattern === "repeated_slacking") return `End by naming the pattern briefly. Slightly uncomfortable. Hard to scroll past.`;
  if (mood === "lazy") return `End with something so small they'd feel dumb not doing it.`;

  const map = {
    suspicious:  `End on a light challenge they have to confirm or push back on.`,
    quiet:       `End softly. A quiet observation or simple question.`,
    reflective:  `End on something that lingers — an observation, not a direct question.`,
    "locked-in": `End with a forward push. What's the next move.`,
    warm:        `End with presence. Something that makes them feel seen.`,
    playful:     `End with a light tease or casual assumption.`,
    chaotic:     `End abruptly. Let the incompleteness be the hook.`,
    blunt:       `End with a direct point they have to address.`,
    direct:      `End with one specific pointed question or clear action.`
  };
  return map[energyState] || map.direct;
}

// ─────────────────────────────────────────────────────────────
// PROFILE NARRATIVE
// ─────────────────────────────────────────────────────────────

function buildProfileNarrative(profile, patternSummary, inactivityNote, openCommitmentsNote) {
  const parts = [];
  if (profile?.name)     parts.push(`Their name is ${profile.name}.`);
  if (profile?.age)      parts.push(`They're ${profile.age}.`);
  if (profile?.main_goal) {
    parts.push(`They want to ${profile.main_goal}.`);
    if (profile.original_goal && profile.original_goal !== profile.main_goal) {
      parts.push(`Originally "${profile.original_goal}" — shifted.`);
    }
  }
  if (profile?.mood)     parts.push(`Why it matters: ${profile.mood}.`);
  if (profile?.struggle) parts.push(`What stops them: ${profile.struggle}.`);
  if (patternSummary)    parts.push(patternSummary);
  if (inactivityNote)    parts.push(inactivityNote);
  if (openCommitmentsNote) parts.push(openCommitmentsNote);
  return parts.length > 0 ? parts.join(" ") : "New user. Learn them through what they say.";
}

// ─────────────────────────────────────────────────────────────
// PATTERN DETECTION
// ─────────────────────────────────────────────────────────────

function detectPattern(moodHistory) {
  const recent = (moodHistory || []).slice(0, 10);
  const total  = recent.length;
  if (total === 0) return { label: "normal", summary: null };
  let lazy = 0, stressed = 0, emotional = 0;
  recent.forEach((m, i) => {
    const w = (total - i) / total;
    if (m === "lazy")      lazy      += w;
    if (m === "stressed")  stressed  += w;
    if (m === "emotional") emotional += w;
  });
  if (lazy >= 2.0)      return { label: "repeated_slacking",     summary: "They keep committing and not following through." };
  if (stressed >= 2.0)  return { label: "burnout_risk",          summary: "Consistently stressed. Pressure is building." };
  if (emotional >= 1.8) return { label: "emotionally_distracted", summary: "Emotionally scattered lately. Focus is hard." };
  return { label: "normal", summary: null };
}

// ─────────────────────────────────────────────────────────────
// OPEN COMMITMENTS (72hr window)
// ─────────────────────────────────────────────────────────────

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
  if (unresolved > 0) return `They made ${unresolved} commitment${unresolved > 1 ? "s" : ""} in the last 3 days with no confirmed follow-through.`;
  return null;
}

// ─────────────────────────────────────────────────────────────
// IMAGE ANALYSIS
// Connected to accountability — logs action_done for proof images.
// ─────────────────────────────────────────────────────────────

async function analyzeImageFromTwilio(mediaUrl, caption, userId, profile) {
  try {
    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN }
    });
    const contentType = response.headers["content-type"] || "image/jpeg";
    const dataUrl = `data:${contentType};base64,${Buffer.from(response.data).toString("base64")}`;

    const goalContext = profile?.main_goal ? `Their current goal: ${profile.main_goal}.` : "";

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are Guka reacting to a WhatsApp image sent as accountability proof.

${goalContext}

Gym/workout photo: React to what you actually see. Acknowledge the effort without over-hyping. Then push the next step.
Food/meal photo: Identify the food, give a rough calorie estimate (clearly label as estimate), one honest comment. Connect to goals if relevant. Don't lecture.
Study/work proof: Acknowledge completion. Keep it real. Ask what's next.
Task completion screenshot: Acknowledge it happened. Note the follow-through.
Anything else: React naturally, like a real person.

CRITICAL: This is probably proof of a commitment. React as someone who remembers what they said they'd do.
Style: 2-4 short WhatsApp bubbles. Real energy. No "great job". No "well done". No em dashes. No lists.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: caption || "proof" },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    // Log as action_done — image sent = proof delivered
    console.log("[PROOF] image received, logging action_done");
    await dbInsert("messages", { user_id: userId, role: "action", content: "action_done" });

    return completion.choices[0].message.content;
  } catch (err) {
    console.error("[IMAGE] error:", err.message);
    return "got the image but couldn't read it properly. try again with a caption";
  }
}

// ─────────────────────────────────────────────────────────────
// INACTIVITY INTERPRETER
// ─────────────────────────────────────────────────────────────

function interpretInactivity(diffDays) {
  if (diffDays >= 5) return {
    label: "long_ghost", note: "They disappeared for 5+ days.",
    conversationBias: "They were gone a long time and just came back. React to the message first. The gap will surface naturally if there's an opening."
  };
  if (diffDays >= 2) return {
    label: "ghosted", note: "Quiet for 2-5 days before this.",
    conversationBias: "They went quiet for a few days and just came back. Don't comment on it directly. Use the gap if a natural opening comes up."
  };
  if (diffDays >= 1) return { label: "quiet", note: null, conversationBias: null };
  return { label: "active", note: null, conversationBias: null };
}

// ─────────────────────────────────────────────────────────────
// STREAK UPDATER
// ─────────────────────────────────────────────────────────────

async function updateStreak(userId, actionType, streakData) {
  let streak   = streakData?.current_streak   || 0;
  let lastDate = streakData?.last_action_date || null;
  const today  = new Date().toISOString().split("T")[0];

  if (actionType === "action_done") {
    if (!lastDate) {
      streak = 1;
    } else if (lastDate !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      streak = lastDate === yesterday.toISOString().split("T")[0] ? streak + 1 : 1;
    }
    console.log("[STREAK] updating to:", streak);
    await dbUpsert("streaks", { user_id: userId, current_streak: streak, last_action_date: today }, "user_id");
  }
  return streak;
}

// ─────────────────────────────────────────────────────────────
// CORE RESPONSE GENERATOR
// ─────────────────────────────────────────────────────────────

async function generateGukaMessages({
  message, profile, liveMemory, profileNarrative,
  energyState, energyInstruction, conversationBias,
  responseabilityConstraint, messageLengthBias,
  depthInstruction, imperfectionBias, phaseInstruction,
  onboardingMode
}) {
  const ageNum = parseInt(String(profile?.age || "").replace(/\D/g, ""), 10);
  const toneLine = ageNum && ageNum <= 25
    ? "Peer energy. Talk like someone their age who genuinely gives a damn. Natural slang — earned, not performed."
    : "Grounded. Sharp. Human. Not a mentor. Not corporate. A real person texting.";

  const existenceFraming = onboardingMode
    ? "You are Guka. Meeting this person for the first time. You don't explain yourself. You exist and start learning them."
    : "You are Guka. You don't explain yourself. You don't define your role. You exist through how you respond.";

  const systemPrompt = `${existenceFraming}

Return JSON only: { "messages": ["msg1", "msg2", "msg3"] }

━━━━━━━━━━━━━━━━━━━━━━━
WHO YOU ARE
━━━━━━━━━━━━━━━━━━━━━━━
Not an assistant. Not a therapist. Not a productivity app.
A socially sharp accountability presence. You feel like a real person texting.
You have opinions. You notice things. You push sometimes. You hold back sometimes.
NOT always perfectly emotionally articulate — real people aren't.
You leave things unfinished. You imply instead of explain.
Slightly unpredictable. That's what makes you feel real.

━━━━━━━━━━━━━━━━━━━━━━━
CURRENT PHASE — READ THIS FIRST
━━━━━━━━━━━━━━━━━━━━━━━
${phaseInstruction}

━━━━━━━━━━━━━━━━━━━━━━━
ENERGY RIGHT NOW
━━━━━━━━━━━━━━━━━━━━━━━
State: ${energyState}
${energyInstruction}

━━━━━━━━━━━━━━━━━━━━━━━
DEPTH LEVEL
━━━━━━━━━━━━━━━━━━━━━━━
${depthInstruction}

━━━━━━━━━━━━━━━━━━━━━━━
IMPERFECTION
━━━━━━━━━━━━━━━━━━━━━━━
${imperfectionBias || "Be yourself — sharp when needed, lighter when not. Don't perform insight."}

━━━━━━━━━━━━━━━━━━━━━━━
SOLUTION PIVOT — CRITICAL
━━━━━━━━━━━━━━━━━━━━━━━
If user asked for steps, advice, a plan, or any forward help → STOP probing. Give real direction.
If user said "nothing specific", "just life", "I don't know", or pushed back → STOP asking why. Accept their framing.
If you've already asked 2 probing questions → STOP. Summarize and help.

NEVER say "you jumped to steps too quick."
NEVER say "nah that's not the full reason" after they've clarified.
NEVER say "something must have happened" after they rejected that framing.
Friction is fine once. After they correct you, update and move on.

━━━━━━━━━━━━━━━━━━━━━━━
MESSAGE ORDERING — NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━
Multi-message responses MUST follow:
  1. REACTION first — gut response. Short. Instinctive.
  2. TEXTURE second — observation, offhand comment.
  3. DIRECTION last — question, push, or action.

Never lead with direction. Wrong: "okay what should we do" → "hmm" → "yeah"
Right: "hmm" → "yeah that tracks" → "okay so what's actually doable right now"

━━━━━━━━━━━━━━━━━━━━━━━
CONVERSATION RHYTHM
━━━━━━━━━━━━━━━━━━━━━━━
1. React emotionally first
2. Interpret what it actually means
3. Narrow toward something specific
4. ONE question or ONE push — never two

━━━━━━━━━━━━━━━━━━━━━━━
BANNED PHRASES
━━━━━━━━━━━━━━━━━━━━━━━
Never say: "what's up" / "how can I help" / "tell me more" / "let's break this down"
"great job" / "well done" / "proud of you" / "amazing" / "I hear you" / "that makes sense"
"absolutely" / "of course" / "you've got this" / "I'm here to help" / "my role is"
"you jumped to steps too quick" / em dashes (—) / numbered lists / bullet points
Corporate motivational language / describing yourself or your role

━━━━━━━━━━━━━━━━━━━━━━━
BANNED THERAPEUTIC PHRASING
━━━━━━━━━━━━━━━━━━━━━━━
Never say: "what does that mean for you" / "what does that shift mean" / "how does that make you feel"
"feels like there's a story there" / "that's a big one" (standalone) / "I think there's something deeper"

Instead: "what changed tho" / "why now" / "what actually happened" / "when did that start"

━━━━━━━━━━━━━━━━━━━━━━━
QUESTION STYLE
━━━━━━━━━━━━━━━━━━━━━━━
Texting questions — not therapy questions:
"why now tho" not "why is this coming up for you now?"
"something changed didn't it" not "what do you think changed?"
"what happened" not "could you tell me more about what happened?"

━━━━━━━━━━━━━━━━━━━━━━━
MICRO-REACTIONS (use naturally, not constantly)
━━━━━━━━━━━━━━━━━━━━━━━
"wait" / "nah hold on" / "hmm" / "okay interesting" / "lowkey" / "fair"
"yeah no" / "okay but" / "not gonna lie" / "bro" / "nah" / "huh" / "actually"

━━━━━━━━━━━━━━━━━━━━━━━
FORMAT
━━━━━━━━━━━━━━━━━━━━━━━
${messageLengthBias}
Each message = one WhatsApp bubble. Vary length. Fragments are normal.

━━━━━━━━━━━━━━━━━━━━━━━
WHO YOU'RE TALKING TO
━━━━━━━━━━━━━━━━━━━━━━━
${profileNarrative}

━━━━━━━━━━━━━━━━━━━━━━━
DIRECTION
━━━━━━━━━━━━━━━━━━━━━━━
${conversationBias || "React to what they actually said. Be specific. Lead the direction."}

━━━━━━━━━━━━━━━━━━━━━━━
HOW THIS MUST END
━━━━━━━━━━━━━━━━━━━━━━━
${responseabilityConstraint}

━━━━━━━━━━━━━━━━━━━━━━━
TONE
━━━━━━━━━━━━━━━━━━━━━━━
${toneLine}

━━━━━━━━━━━━━━━━━━━━━━━
SAFETY
━━━━━━━━━━━━━━━━━━━━━━━
Crisis or overwhelm: slow down. Be present first.
Self-harm or danger language: stop everything. Tell them to contact someone they trust or a crisis line.
Never make them feel you're the only one who understands them.`;

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
    if (parsed.messages && Array.isArray(parsed.messages) && parsed.messages.length) return parsed.messages;
    return ["say that again"];
  } catch {
    return [completion.choices[0].message.content];
  }
}

// ─────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  try {
    const user      = req.body.From || "";
    const message   = cleanMessage(req.body.Body);
    const numMedia  = Number(req.body.NumMedia || 0);
    const mediaUrl  = numMedia > 0 ? req.body.MediaUrl0  : null;
    const mediaType = numMedia > 0 ? req.body.MediaContentType0 || "" : "";

    if (!user) return res.send(twiml("something went wrong. try again"));

    // ── LOAD OR CREATE PROFILE ───────────────────────────────

    let { data: profile, error: profileError } = await supabase
      .from("user_profiles").select("*").eq("user_id", user).single();

    if (profileError || !profile) {
      console.log("[PROFILE] creating new profile for", user);
      const { data: newProfile, error: createError } = await supabase
        .from("user_profiles")
        .insert([{
          user_id: user, onboarding_complete: false, step: "intro",
          last_active: new Date().toISOString(), updated_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (createError) console.error("[PROFILE] create error:", createError.message);
      profile = newProfile || { user_id: user, onboarding_complete: false, step: "intro" };
    }

    const previousLastActive = profile.last_active;

    await dbUpdate("user_profiles",
      { last_active: new Date().toISOString(), updated_at: new Date().toISOString() },
      { user_id: user }
    );

    // ── LIVE MEMORY ──────────────────────────────────────────

    const { data: liveMemory } = await supabase
      .from("messages").select("*")
      .eq("user_id", user).in("role", ["user", "assistant"])
      .order("created_at", { ascending: true }).limit(8);

    const turnCount = (liveMemory || []).filter((m) => m.role === "user").length;

    // ── IMAGE HANDLING ───────────────────────────────────────

    if (mediaUrl && mediaType.startsWith("image/")) {
      console.log("[IMAGE] received from", user);
      const imageReply = await analyzeImageFromTwilio(mediaUrl, message, user, profile);
      await dbInsert("messages", [
        { user_id: user, role: "user",      content: message || "[image]" },
        { user_id: user, role: "assistant", content: imageReply }
      ]);

      // Update streak since image = action_done
      const { data: streakData } = await supabase.from("streaks").select("*").eq("user_id", user).single();
      await updateStreak(user, "action_done", streakData);

      return res.send(twiml(imageReply));
    }

    // ── EXTRACT PROFILE SIGNALS FROM THIS MESSAGE ────────────
    // This runs on EVERY message — in onboarding AND active.
    // It's the fix for Supabase nulls.

    const signals = await extractProfileSignals(message, profile, liveMemory);

    // Opportunistically save any newly extracted profile fields
    profile = await saveProfileSignals(user, profile, signals);

    // ── ONBOARDING FLOW ──────────────────────────────────────
    // Flexible — completes when enough context exists,
    // not when rigid steps are hit.

    if (!profile.onboarding_complete) {
      let nextStep    = profile.step || "intro";
      let replyMessages = [];
      const stepUpdates = {};

      // Check if we should complete onboarding early
      // (e.g. user asked for help or has enough context)
      if (nextStep !== "intro" && shouldCompleteOnboarding(profile, turnCount, signals)) {
        stepUpdates.onboarding_complete = true;
        stepUpdates.step = "active";
        stepUpdates.updated_at = new Date().toISOString();
        console.log("[ONBOARDING] completing early at step:", nextStep);
        await dbUpdate("user_profiles", stepUpdates, { user_id: user });
        profile.onboarding_complete = true;
        profile.step = "active";
        // Fall through to active conversation handler below
      } else {

        // Standard onboarding steps
        const onboardingImperfection = turnCount >= 1
          ? getImperfectionBias(turnCount, "warm", "discovery")
          : null;

        if (nextStep === "intro") {
          nextStep = "name";
          replyMessages = ["yo", "so you actually texted", "okay. what's your name"];
        }

        else if (nextStep === "name") {
          if (signals.possible_name || message.length < 30) {
            stepUpdates.name = signals.possible_name || message;
            nextStep = "age";
          }
          replyMessages = await generateGukaMessages({
            message, profile: { ...profile, name: signals.possible_name || message }, liveMemory,
            profileNarrative: `They just said their name is ${signals.possible_name || message}. Nothing else known.`,
            energyState: "warm", energyInstruction: "Genuinely curious. Want to know who this person is.",
            conversationBias: "React to the name naturally. Then ask their age casually.",
            responseabilityConstraint: "End on the age question. Casual. Not a form.",
            messageLengthBias: "2-3 short messages.",
            depthInstruction: "Way too early for depth. Stay surface.",
            imperfectionBias: onboardingImperfection,
            phaseInstruction: "DISCOVERY — first exchange. Light. Getting started.",
            onboardingMode: true
          });
        }

        else if (nextStep === "age") {
          if (signals.possible_age) {
            stepUpdates.age = signals.possible_age;
            nextStep = "goal";
          }
          replyMessages = await generateGukaMessages({
            message, profile: { ...profile, age: signals.possible_age || message }, liveMemory,
            profileNarrative: `Name: ${profile.name || "unknown"}. Age: ${signals.possible_age || message}.`,
            energyState: "warm", energyInstruction: "Still early. Curious. Not deep yet.",
            conversationBias: "React briefly to the age. Ask what they've been wanting to change. Not 'what are your goals' — something more human.",
            responseabilityConstraint: "End on a grounded open question.",
            messageLengthBias: "2-3 messages.",
            depthInstruction: "Still early. Light. One honest question.",
            imperfectionBias: onboardingImperfection,
            phaseInstruction: "DISCOVERY — learning what they want to change.",
            onboardingMode: true
          });
        }

        else if (nextStep === "goal") {
          const extractedGoal = signals.possible_goal || message;
          stepUpdates.main_goal     = extractedGoal;
          stepUpdates.original_goal = extractedGoal;
          nextStep = "reason";
          replyMessages = await generateGukaMessages({
            message, profile: { ...profile, main_goal: extractedGoal }, liveMemory,
            profileNarrative: `${profile.name || "They"} is ${profile.age || "unknown"}. Want to change: "${extractedGoal}".`,
            energyState: "suspicious", energyInstruction: "React to the goal. Don't just accept the surface. Get curious about what's underneath. ONE probe — no more.",
            conversationBias: "Name what you actually hear. Push on WHY this matters right now. Ask like you half-know.",
            responseabilityConstraint: "End on a motivation question — short, compressed, slightly assumptive.",
            messageLengthBias: "3 messages. Reaction, observation, one sharp question.",
            depthInstruction: "One probe is okay here. Don't go further.",
            imperfectionBias: getImperfectionBias(turnCount, "suspicious", "discovery"),
            phaseInstruction: "DISCOVERY — probing motivation. ONE question max.",
            onboardingMode: true
          });
        }

        else if (nextStep === "reason") {
          const extractedReason = signals.possible_motivation || message;
          stepUpdates.mood = extractedReason;
          nextStep = "struggle";
          replyMessages = await generateGukaMessages({
            message, profile: { ...profile, mood: extractedReason }, liveMemory,
            profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "change"}. Why: "${extractedReason}".`,
            energyState: "reflective", energyInstruction: "They got honest. Sit in it. Then ask what stops them. Perceptive friend, not therapist.",
            conversationBias: "Make them feel understood. Then ask what's been in the way. Like you already have a guess.",
            responseabilityConstraint: "End on the obstacle question — compressed, slightly assumptive.",
            messageLengthBias: "3 messages. Reaction, interpretation, one question.",
            depthInstruction: "One more layer is earned. Don't over-psychologize.",
            imperfectionBias: getImperfectionBias(turnCount, "reflective", "discovery"),
            phaseInstruction: "DISCOVERY — last probing question. After their answer, move to solution.",
            onboardingMode: true
          });
        }

        else if (nextStep === "struggle") {
          const extractedStruggle = signals.possible_struggle || message;
          stepUpdates.struggle            = extractedStruggle;
          stepUpdates.onboarding_complete = true;
          stepUpdates.step                = "active";
          nextStep = "active";
          replyMessages = await generateGukaMessages({
            message, profile: { ...profile, struggle: extractedStruggle }, liveMemory,
            profileNarrative: `${profile.name || "They"} wants to ${profile.main_goal || "change"}. Why: "${profile.mood || "unclear"}". What stops them: "${extractedStruggle}".`,
            energyState: "warm", energyInstruction: "This is the moment. They just told you the real thing. Name it. Make them feel understood. Then one concrete commitment.",
            conversationBias: "Name the pattern you see. Make them feel understood first. Then one specific thing they can commit to today.",
            responseabilityConstraint: "End on the commitment ask — specific enough they can say yes/no immediately.",
            messageLengthBias: "3-4 messages. Take your time. This moment decides if they stay.",
            depthInstruction: "Full depth earned. Name the pattern clearly.",
            imperfectionBias: null,
            phaseInstruction: "SOLUTION — you understand them enough. Name what you see, then move to one concrete action.",
            onboardingMode: true
          });
        }

        else {
          // Unknown step — reset to active
          stepUpdates.onboarding_complete = true;
          stepUpdates.step = "active";
        }

        if (Object.keys(stepUpdates).length > 0) {
          stepUpdates.updated_at = new Date().toISOString();
          if (nextStep !== "active") stepUpdates.step = nextStep;
          console.log("[ONBOARDING] step updates:", Object.keys(stepUpdates).join(", "));
          await dbUpdate("user_profiles", stepUpdates, { user_id: user });
          Object.assign(profile, stepUpdates);
        }

        if (replyMessages.length > 0) {
          await dbInsert("messages", [
            { user_id: user, role: "user",      content: message || "[start]" },
            { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
          ]);
          return res.send(twiml(replyMessages));
        }
      }
    }

    // ── REFRESH FULL PROFILE ─────────────────────────────────

    const { data: refreshedProfile } = await supabase
      .from("user_profiles").select("*").eq("user_id", user).single();
    profile = refreshedProfile || profile;

    // ── GOAL COMMAND ─────────────────────────────────────────

    if (message.toLowerCase().startsWith("goal:")) {
      const goalText = message.replace(/goal:/i, "").trim();
      await dbInsert("goals", { user_id: user, goal: goalText, status: "active" });

      const goalReply = await generateGukaMessages({
        message: goalText, profile, liveMemory,
        profileNarrative: buildProfileNarrative(profile),
        energyState: "suspicious",
        energyInstruction: "They formally wrote a goal. Don't celebrate. Test if they mean it.",
        conversationBias: "Acknowledge it was saved briefly. Probe the commitment level.",
        responseabilityConstraint: "End on something they have to actually answer.",
        messageLengthBias: "2-3 messages.",
        depthInstruction: "One direct challenge is earned here.",
        imperfectionBias: null,
        phaseInstruction: "EXECUTION — goal declared. Test the commitment, then define first action."
      });

      await dbInsert("messages", [
        { user_id: user, role: "user",      content: message },
        { user_id: user, role: "assistant", content: goalReply.join("\n\n") }
      ]);
      return res.send(twiml(goalReply));
    }

    // ── SHOW GOALS ───────────────────────────────────────────

    if (message.toLowerCase().includes("my goals")) {
      const { data: goals } = await supabase
        .from("goals").select("*").eq("user_id", user).eq("status", "active");
      if (!goals || goals.length === 0) {
        return res.send(twiml("nothing saved yet. you tracking anything right now or nah"));
      }
      const list = goals.map((g, i) => `${i + 1}. ${g.goal}`).join("\n");
      return res.send(twiml(["here's what we've got locked:", list]));
    }

    // ── LOG MOOD + ACTION ────────────────────────────────────

    const mood       = signals.mood       || "neutral";
    const actionType = signals.action     || "no_action";
    const intent     = signals.intent     || "normal";

    await dbInsert("messages", [
      { user_id: user, role: "mood",   content: mood },
      { user_id: user, role: "action", content: actionType }
    ]);

    // ── SAVE COMMITMENT / PROOF CANDIDATES ───────────────────

    if (signals.possible_commitment) {
      console.log("[COMMITMENT] detected:", signals.possible_commitment);
      await dbInsert("messages", [
        { user_id: user, role: "memory", content: `Commitment: ${signals.possible_commitment}` },
        { user_id: user, role: "action", content: "action_commit" }
      ]);
    }

    if (signals.important_memory) {
      await dbInsert("messages", { user_id: user, role: "memory", content: signals.important_memory });
    }

    // ── PATTERN DETECTION ────────────────────────────────────

    const { data: moodHistory } = await supabase
      .from("messages").select("content")
      .eq("user_id", user).eq("role", "mood")
      .order("created_at", { ascending: false }).limit(10);

    const patternResult = detectPattern((moodHistory || []).map((m) => m.content));
    const pattern       = patternResult.label;

    // ── EXECUTION RATE ───────────────────────────────────────

    const { data: actionHistory } = await supabase
      .from("messages").select("content")
      .eq("user_id", user).eq("role", "action")
      .order("created_at", { ascending: false }).limit(20);

    const actions       = (actionHistory || []).map((a) => a.content);
    const commitCount   = actions.filter((a) => a === "action_commit").length;
    const doneCount     = actions.filter((a) => a === "action_done").length;
    const executionRate = commitCount > 0 ? Number((doneCount / commitCount).toFixed(2)) : 0;

    // ── STREAK ───────────────────────────────────────────────

    const { data: streakData } = await supabase
      .from("streaks").select("*").eq("user_id", user).single();
    const streak = await updateStreak(user, actionType, streakData);

    // ── INACTIVITY ───────────────────────────────────────────

    const now              = new Date();
    const diffDays         = daysBetween(now, new Date(previousLastActive || now));
    const inactivityResult = interpretInactivity(diffDays);

    // ── OPEN COMMITMENTS ─────────────────────────────────────

    const openCommitmentsNote = await getOpenCommitments(user);

    // ── PROBE COUNT (deterministic, no extra API call) ───────

    const probeCount = countRecentProbes(liveMemory);

    // ── PHASE DETECTION ──────────────────────────────────────

    const phaseData = await detectConversationPhase(
      message, profile, liveMemory, signals, probeCount
    );

    // ── PHASE INSTRUCTION ────────────────────────────────────

    const phaseResult      = buildPhaseInstruction(phaseData, profile);
    const currentPhase     = phaseResult.phase;
    const phaseInstruction = phaseResult.instruction;
    console.log("[PHASE] active:", currentPhase, "| pivot:", phaseResult.pivot);

    // ── ENERGY STATE ─────────────────────────────────────────

    const hourUTC = now.getUTCHours();
    const { state: energyState, instruction: energyInstruction } = deriveEnergyState({
      mood, pattern, diffDays, streak, executionRate, hourUTC
    });

    // ── DEPTH PACING ─────────────────────────────────────────

    const { instruction: depthInstruction } = getDepthPacing(turnCount, currentPhase);

    // ── IMPERFECTION ─────────────────────────────────────────

    const imperfectionBias = getImperfectionBias(turnCount, energyState, currentPhase);

    // ── RESPONSEABILITY ──────────────────────────────────────

    const responseabilityConstraint = getResponseabilityConstraint(
      energyState, mood, pattern, openCommitmentsNote, currentPhase
    );

    // ── PROFILE NARRATIVE ────────────────────────────────────

    const profileNarrative = buildProfileNarrative(
      profile, patternResult.summary, inactivityResult.note, openCommitmentsNote
    );

    // ── CONVERSATION BIAS ────────────────────────────────────

    let conversationBias;
    if (phaseResult.pivot) {
      conversationBias = "You have enough context. Stop probing. Help now.";
    } else if (inactivityResult.conversationBias) {
      conversationBias = inactivityResult.conversationBias;
    } else {
      conversationBias = "React to what they actually said. Be specific to this person. Lead the direction.";
    }

    if (openCommitmentsNote && actionType !== "action_done" && !phaseResult.pivot) {
      conversationBias += ` Unresolved thread: ${openCommitmentsNote} Pull on it if there's a natural opening.`;
    }

    // ── MESSAGE LENGTH ───────────────────────────────────────

    let messageLengthBias = "2-4 short WhatsApp messages. Each its own bubble.";
    if (currentPhase === "solution" || currentPhase === "planning") {
      messageLengthBias = "3-5 messages. Can go slightly longer for real steps or a framework. Still WhatsApp style — short sentences, separate bubbles. No walls of text.";
    } else if (currentPhase === "execution" || currentPhase === "proof") {
      messageLengthBias = "2-3 messages. Direct. Specific. No padding.";
    } else if (currentPhase === "adjustment") {
      messageLengthBias = "2-3 messages. Honest. Make restart feel small and possible.";
    } else if (energyState === "quiet" || energyState === "reflective") {
      messageLengthBias = "2-3 messages. Shorter. More space.";
    } else if (energyState === "suspicious" || pattern === "repeated_slacking") {
      messageLengthBias = "2 messages max. Direct.";
    } else if (energyState === "locked-in") {
      messageLengthBias = "2 messages. Sharp. Moving.";
    } else if (mood === "emotional") {
      messageLengthBias = "3 shorter messages. Don't rush.";
    }

    // ── REFRESH LIVE MEMORY ──────────────────────────────────

    const { data: refreshedMemory } = await supabase
      .from("messages").select("*")
      .eq("user_id", user).in("role", ["user", "assistant"])
      .order("created_at", { ascending: true }).limit(8);

    // ── GENERATE RESPONSE ────────────────────────────────────

    const replyMessages = await generateGukaMessages({
      message, profile,
      liveMemory: refreshedMemory || liveMemory,
      profileNarrative, energyState, energyInstruction,
      conversationBias, responseabilityConstraint, messageLengthBias,
      depthInstruction, imperfectionBias, phaseInstruction,
      onboardingMode: false
    });

    await dbInsert("messages", [
      { user_id: user, role: "user",      content: message },
      { user_id: user, role: "assistant", content: replyMessages.join("\n\n") }
    ]);

    return res.send(twiml(replyMessages));

  } catch (err) {
    console.error("[WEBHOOK] unhandled error:", err.message, err.stack);
    return res.send(twiml("guka bugging rn 💀 try again in a sec"));
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`Guka running on port ${PORT}`));