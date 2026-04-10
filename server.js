const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

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
  enterprise: { queries: 999999 },
};

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/usage", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.json({ used: 0, limit: 10, plan: "free" });
  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.json({ used: 0, limit: 10, plan: "free" });
    const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    const plan = profile?.plan || "free";
    const used = profile?.queries_used || 0;
    const limit = PLANS[plan]?.queries || 10;
    res.json({ used, limit, plan, remaining: Math.max(0, limit - used) });
  } catch (err) {
    res.json({ used: 0, limit: 10, plan: "free" });
  }
});

app.post("/api/generate", async (req, res) => {
  const { prompt, dbType } = req.body;
  const token = req.headers.authorization?.replace("Bearer ", "");

  if (!prompt || !dbType) return res.status(400).json({ error: "prompt and dbType are required" });
  if (!token) return res.status(401).json({ error: "Please sign in to generate SQL.", requireAuth: true });

  let userId, plan = "free", queriesUsed = 0;

  try {
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return res.status(401).json({ error: "Please sign in to generate SQL.", requireAuth: true });
    userId = user.id;

    let { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
    if (!profile) {
      await supabase.from("profiles").insert({ id: user.id, email: user.email, plan: "free", queries_used: 0 });
      profile = { plan: "free", queries_used: 0 };
    }
    plan = profile.plan || "free";
    queriesUsed = profile.queries_used || 0;
  } catch (err) {
    return res.status(401).json({ error: "Authentication failed.", requireAuth: true });
  }

  const limit = PLANS[plan]?.queries || 10;
  if (queriesUsed >= limit) {
    return res.status(429).json({ error: "Query limit reached. Please upgrade your plan.", used: queriesUsed, limit });
  }

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: `You are an expert SQL developer. Convert plain English into production-ready ${dbType} SQL.
Always respond with valid JSON only:
{"sql": "query here", "explanation": "plain English explanation", "tips": ["tip1", "tip2"]}
Return ONLY the JSON, no markdown, no extra text.`,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { parsed = { sql: raw, explanation: "Query generated successfully.", tips: [] }; }

    await supabase.from("profiles").update({ queries_used: queriesUsed + 1 }).eq("id", userId);
    res.json({ ...parsed, usage: { used: queriesUsed + 1, limit, plan } });
  } catch (err) {
    console.error("Anthropic error:", err);
    res.status(500).json({ error: "Failed to generate SQL. Please try again." });
  }
});

app.post("/api/create-checkout", async (req, res) => {
  const { plan, userId, userEmail } = req.body;
  const prices = {
    starter: { amount: 900, name: "InstantSQL Starter", queries: "100 queries/month" },
    pro: { amount: 1900, name: "InstantSQL Pro", queries: "Unlimited queries" },
  };
  const selected = prices[plan];
  if (!selected) return res.status(400).json({ error: "Invalid plan" });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      customer_email: userEmail || undefined,
      line_items: [{ price_data: { currency: "usd", product_data: { name: selected.name, description: selected.queries }, unit_amount: selected.amount, recurring: { interval: "month" } }, quantity: 1 }],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}&uid=${userId || ""}`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
      metadata: { plan, userId: userId || "" },
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

app.post("/api/update-plan", async (req, res) => {
  const { userId, plan } = req.body;
  if (!userId || !plan) return res.status(400).json({ error: "Missing fields" });
  try {
    await supabase.from("profiles").update({ plan, queries_used: 0 }).eq("id", userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update plan" });
  }
});

app.post("/api/create-invite", async (req, res) => {
  const { companyName } = req.body;
  if (!companyName) return res.status(400).json({ error: "Company name required" });
  const code = crypto.randomBytes(8).toString("hex");
  try {
    await supabase.from("invites").insert({ code, company_name: companyName, plan: "enterprise" });
    res.json({ code, url: `${process.env.FRONTEND_URL}?invite=${code}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to create invite" });
  }
});

app.get("/api/invite/:code", async (req, res) => {
  try {
    const { data, error } = await supabase.from("invites").select("*").eq("code", req.params.code).single();
    if (error || !data) return res.status(404).json({ error: "Invalid invite code" });
    res.json({ valid: true, companyName: data.company_name, plan: data.plan });
  } catch (err) {
    res.status(500).json({ error: "Failed to validate invite" });
  }
});

app.post("/api/use-invite", async (req, res) => {
  const { code, userId } = req.body;
  if (!code || !userId) return res.status(400).json({ error: "Missing fields" });
  try {
    const { data: invite } = await supabase.from("invites").select("*").eq("code", code).single();
    if (!invite) return res.status(404).json({ error: "Invalid invite code" });
    await supabase.from("profiles").update({ plan: "enterprise", company: invite.company_name, queries_used: 0 }).eq("id", userId);
    res.json({ success: true, plan: "enterprise", companyName: invite.company_name });
  } catch (err) {
    res.status(500).json({ error: "Failed to apply invite" });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => console.log(`InstantSQL backend running on port ${PORT}`));
