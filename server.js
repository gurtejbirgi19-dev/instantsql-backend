const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PLANS = {
  free: { queries: 10 },
  starter: { queries: 100 },
  pro: { queries: 999999 },
  team: { queries: 999999 },
};

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /api/usage — get user usage
app.get("/api/usage", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.json({ used: 0, limit: 10, plan: "free" });

  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.json({ used: 0, limit: 10, plan: "free" });

    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .single();

    const plan = profile?.plan || "free";
    const used = profile?.queries_used || 0;
    const limit = PLANS[plan]?.queries || 10;

    res.json({ used, limit, plan, remaining: Math.max(0, limit - used) });
  } catch (err) {
    res.json({ used: 0, limit: 10, plan: "free" });
  }
});

// POST /api/generate
app.post("/api/generate", async (req, res) => {
  const { prompt, dbType } = req.body;
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!prompt || !dbType) {
    return res.status(400).json({ error: "prompt and dbType are required" });
  }

  let userId = null;
  let plan = "free";
  let queriesUsed = 0;

  if (token) {
    try {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        userId = user.id;
        const { data: profile } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .single();

        plan = profile?.plan || "free";
        queriesUsed = profile?.queries_used || 0;
      }
    } catch (err) {}
  }

  const limit = PLANS[plan]?.queries || 10;
  if (queriesUsed >= limit) {
    return res.status(429).json({
      error: plan === "free"
        ? "Free limit reached. Sign up or upgrade to continue."
        : "Monthly limit reached. Please upgrade your plan.",
      used: queriesUsed,
      limit,
    });
  }

  try {
    const systemPrompt = `You are an expert SQL developer. Convert plain English descriptions into production-ready ${dbType} SQL queries.

Always respond with valid JSON in this exact format:
{
  "sql": "the SQL query here",
  "explanation": "plain English explanation of what the query does",
  "tips": ["optional tip 1", "optional tip 2"]
}

Rules:
- Write clean, optimized SQL for ${dbType}
- Use proper ${dbType} syntax and conventions
- Add helpful comments inside the SQL for complex parts
- Keep the explanation simple and clear
- Return ONLY the JSON, no markdown, no extra text`;

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { sql: raw, explanation: "Query generated successfully.", tips: [] };
    }

    // Update usage count
    if (userId) {
      await supabase
        .from("profiles")
        .update({ queries_used: queriesUsed + 1 })
        .eq("id", userId);
    }

    res.json({
      ...parsed,
      usage: { used: queriesUsed + 1, limit, plan },
    });
  } catch (err) {
    console.error("Anthropic error:", err);
    res.status(500).json({ error: "Failed to generate SQL. Please try again." });
  }
});

// POST /api/create-checkout
app.post("/api/create-checkout", async (req, res) => {
  const { plan, userId, userEmail } = req.body;

  const prices = {
    starter: { amount: 900, name: "InstantSQL Starter", queries: "100 queries/month" },
    pro: { amount: 1900, name: "InstantSQL Pro", queries: "Unlimited queries" },
    team: { amount: 4900, name: "InstantSQL Team", queries: "5 seats, unlimited queries" },
  };

  const selected = prices[plan];
  if (!selected) return res.status(400).json({ error: "Invalid plan" });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: userEmail || undefined,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: selected.name,
            description: selected.queries,
          },
          unit_amount: selected.amount,
          recurring: { interval: "month" },
        },
        quantity: 1,
      }],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}&uid=${userId || ""}`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
      metadata: { plan, userId: userId || "" },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

// POST /api/webhook — Stripe webhook to update plan after payment
app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: "Webhook error" });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { plan, userId } = session.metadata;

    if (userId) {
      await supabase
        .from("profiles")
        .update({ plan, queries_used: 0 })
        .eq("id", userId);
    }
  }

  res.json({ received: true });
});

// POST /api/update-plan — manual plan update after successful checkout
app.post("/api/update-plan", async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: "Missing fields" });

  try {
    await supabase
      .from("profiles")
      .update({ plan, queries_used: 0 })
      .eq("id", userId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update plan" });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`InstantSQL backend running on port ${PORT}`);
});
