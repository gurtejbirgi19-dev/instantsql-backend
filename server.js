const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// In-memory IP usage tracker (resets on server restart)
// For production, replace with Redis or a database
const ipUsage = {};
const FREE_LIMIT = 10;

function getClientIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// GET /api/usage
app.get("/api/usage", (req, res) => {
  const ip = getClientIP(req);
  const used = ipUsage[ip] || 0;
  res.json({ used, limit: FREE_LIMIT, remaining: Math.max(0, FREE_LIMIT - used) });
});

// POST /api/generate
app.post("/api/generate", async (req, res) => {
  const { prompt, dbType, plan } = req.body;

  if (!prompt || !dbType) {
    return res.status(400).json({ error: "prompt and dbType are required" });
  }

  const ip = getClientIP(req);

  // Free tier IP-based rate limiting
  if (!plan || plan === "free") {
    const used = ipUsage[ip] || 0;
    if (used >= FREE_LIMIT) {
      return res.status(429).json({
        error: "Free tier limit reached. Please upgrade to continue.",
        used,
        limit: FREE_LIMIT,
      });
    }
    ipUsage[ip] = used + 1;
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

    res.json({
      ...parsed,
      usage: {
        used: ipUsage[ip] || 0,
        limit: FREE_LIMIT,
      },
    });
  } catch (err) {
    console.error("Anthropic error:", err);
    res.status(500).json({ error: "Failed to generate SQL. Please try again." });
  }
});

// POST /api/create-checkout
app.post("/api/create-checkout", async (req, res) => {
  const { plan } = req.body;

  const prices = {
    starter: { amount: 900, name: "InstantSQL Starter", queries: "100 queries/month" },
    pro: { amount: 1900, name: "InstantSQL Pro", queries: "Unlimited queries" },
    team: { amount: 4900, name: "InstantSQL Team", queries: "5 seats, unlimited queries" },
  };

  const selected = prices[plan];
  if (!selected) {
    return res.status(400).json({ error: "Invalid plan" });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
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
        },
      ],
      mode: "subscription",
      success_url: `${process.env.FRONTEND_URL}?success=true&plan=${plan}`,
      cancel_url: `${process.env.FRONTEND_URL}?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe error:", err);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`InstantSQL backend running on port ${PORT}`);
});
