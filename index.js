require("dotenv").config();

const express = require("express");
const cors = require("cors");
const argon2 = require("argon2");
const jwt = require("jsonwebtoken");
const db = require("./db"); // Import the database connection
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = 4000;
const cookieParser = require("cookie-parser");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

const apiRouter = express.Router();

const GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
const API_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", true);

app.use(passport.initialize());

const createToken = (user) => {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

const createRefreshToken = (user) => {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });
};

/* Google Login */

// Set up Passport Google Strategy
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // First, try to find an existing user by Google ID
        let result = await db.query(
          "SELECT id, email, google_id, created_at, oauth_provider, last_login FROM users WHERE google_id = $1",
          [profile.id]
        );

        let user;

        if (result.rows.length > 0) {
          // User exists with Google ID, update their information
          user = result.rows[0];
          await db.query(
            "UPDATE users SET email = $1, last_login = NOW() WHERE google_id = $2",
            [profile.emails[0].value, profile.id]
          );
        } else {
          // User doesn't exist with Google ID, check if they exist by email
          result = await db.query(
            "SELECT id, email, google_id, created_at, oauth_provider, last_login FROM users WHERE email = $1",
            [profile.emails[0].value]
          );

          if (result.rows.length > 0) {
            // User exists with email, update their Google ID and oauth_provider
            user = result.rows[0];
            await db.query(
              "UPDATE users SET google_id = $1, oauth_provider = 'google', last_login = NOW() WHERE id = $2",
              [profile.id, user.id]
            );
          } else {
            // User doesn't exist, create a new one
            result = await db.query(
              `INSERT INTO users (google_id, email, oauth_provider, created_at, last_login)
               VALUES ($1, $2, 'google', NOW(), NOW())
               RETURNING id, email, google_id, created_at, oauth_provider, last_login`,
              [profile.id, profile.emails[0].value]
            );
            user = result.rows[0];
          }
        }

        done(null, user);
      } catch (error) {
        console.error("Error in Google Strategy:", error);
        done(error, null);
      }
    }
  )
);

// Routes

apiRouter.get("/test", (req, res) => {
  res.send("Hello World");
});

apiRouter.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] })
);

apiRouter.get(
  "/auth/google/callback",
  passport.authenticate("google", { session: false }),
  async (req, res) => {
    const user = req.user;
    const token = createToken(user);
    const refreshToken = createRefreshToken(user);

    await db.query("UPDATE users SET refresh_token = $1 WHERE id = $2", [
      refreshToken,
      user.id,
    ]);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.redirect("http://localhost:5173/");
  }
);

// Local registration route
apiRouter.post("/auth/register", async (req, res) => {
  const { email, password } = req.body;
  console.log("Registering user", email, password);
  try {
    const hashedPassword = await argon2.hash(password);
    const result = await db.query(
      `INSERT INTO users (email, password, oauth_provider, created_at, last_login)
       VALUES ($1, $2, 'local', NOW(), NOW())
       RETURNING id, email`,
      [email, hashedPassword]
    );
    const user = result.rows[0];
    const token = createToken(user);
    const refreshToken = createRefreshToken(user);

    await db.query("UPDATE users SET refresh_token = $1 WHERE id = $2", [
      refreshToken,
      user.id,
    ]);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.status(201).json({ message: "User registered successfully", user });
  } catch (error) {
    console.log("Error registering user", error);
    res.status(500).json({ error: `Error registering user: ${error}` });
  }
});

// Local login route
apiRouter.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  console.log("Logging in with email", email);
  try {
    const result = await db.query("SELECT * FROM users WHERE email = $1", [
      email,
    ]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.oauth_provider === "google") {
      return res.status(400).json({
        error:
          "This account uses Google Sign-In. Please use the Google Sign-In option.",
      });
    }

    if (!user.password || !(await argon2.verify(user.password, password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = createToken(user);
    const refreshToken = createRefreshToken(user);

    await db.query(
      "UPDATE users SET refresh_token = $1, last_login = NOW() WHERE id = $2",
      [refreshToken, user.id]
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.json({
      message: "Logged in successfully",
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Error logging in:", error);
    res.status(500).json({ error: "Error logging in" });
  }
});

// Middleware to verify JWT
const verifyToken = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Access denied" });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return res
        .status(401)
        .json({ error: "Token expired", shouldRefresh: true });
    }
    res.status(400).json({ error: "Invalid token" });
  }
};

// Token refresh route
apiRouter.post("/auth/refresh-token", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken)
    return res.status(401).json({ error: "Refresh token not found" });

  try {
    const verified = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const result = await db.query(
      "SELECT * FROM users WHERE id = $1 AND refresh_token = $2",
      [verified.userId, refreshToken]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }

    const user = result.rows[0];
    const newToken = createToken(user);
    const newRefreshToken = createRefreshToken(user);

    await db.query("UPDATE users SET refresh_token = $1 WHERE id = $2", [
      newRefreshToken,
      user.id,
    ]);

    res.cookie("token", newToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    });
    res.json({ message: "Token refreshed successfully" });
  } catch (err) {
    res.status(400).json({ error: "Invalid refresh token" });
  }
});

// Logout route
apiRouter.get("/auth/logout", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;
  if (refreshToken) {
    await db.query(
      "UPDATE users SET refresh_token = NULL WHERE refresh_token = $1",
      [refreshToken]
    );
  }
  res.clearCookie("token");
  res.clearCookie("refreshToken");
  res.json({ message: "Logged out successfully" });
});

// User info route
apiRouter.get("/api/user", verifyToken, async (req, res) => {
  console.log("Getting user info");
  try {
    const result = await db.query(
      "SELECT id, email, oauth_provider FROM users WHERE id = $1",
      [req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Error fetching user data" });
  }
});

/* User Routes */

// List all users
apiRouter.get("/users", async (req, res) => {
  console.log("getting users");
  try {
    const result = await db.query("SELECT * FROM users");
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

// Create a new user
apiRouter.post("/users", async (req, res) => {
  console.log("posting to users");
  const { email, password } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const result = await db.query(
      "INSERT INTO users (  email, password) VALUES ($1, $2 ) RETURNING *",
      [email, password]
    );

    // Return the created user (excluding the password)
    const { password: _, ...user } = result.rows[0];

    res.status(201).json({ message: "User created!", user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

// Update a user's details
apiRouter.patch("/users/:id", async (req, res) => {
  console.log("patching to users");
  const { id } = req.params;
  const { email, password } = req.body;

  // Build the dynamic SQL query based on the provided fields
  const updates = [];
  if (email) updates.push(`email = '${email}'`);
  if (password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    updates.push(`password = '${hashedPassword}'`);
  }

  if (updates.length === 0) {
    return res
      .status(400)
      .json({ message: "No valid fields provided for update" });
  }

  try {
    const query = `UPDATE users SET ${updates.join(
      ", "
    )} WHERE id = $1 RETURNING *`;
    const result = await db.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const { password: _, ...user } = result.rows[0]; // Exclude password from response
    res.json({ message: "User updated!", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

// Delete a user
apiRouter.delete("/users/:id", async (req, res) => {
  console.log("deleting user");
  const { id } = req.params;

  try {
    // Run the SQL query to delete the user
    const result = await db.query(
      "DELETE FROM users WHERE id = $1 RETURNING *",
      [id]
    );

    // If no user was found, return 404
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    // Return a success message
    res.json({ message: "User deleted", user: result.rows[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

/* Game Routes */

apiRouter.get("/games", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  console.log("Getting games for user", userId);
  try {
    const result = await db.query("SELECT * FROM games WHERE user_id = $1", [
      userId,
    ]);
    console.log("Got games", result.rows);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error in Get Games", error });
  }
});

apiRouter.post("/save-game", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const {
    age,
    location,
    netWorth,
    name,
    stats,
    lifeEvents,
    history,
    inventory,
  } = req.body;
  const gameId = uuidv4();
  console.log("Creating new game", req.body);
  try {
    const result = await db.query(
      "INSERT INTO games (id, user_id, age, location, net_worth, name, stats, life_events, history, inventory, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW()) RETURNING *",
      [
        gameId,
        userId,
        age,
        location,
        netWorth,
        name,
        JSON.stringify(stats),
        lifeEvents,
        history,
        inventory,
      ]
    );
    res.json({
      message: "Game created",
      game: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ message: "Database error in post to Save Game", error });
  }
});

apiRouter.put("/save-game", verifyToken, async (req, res) => {
  console.log("Putting game state");
  const userId = req.user.userId;
  const {
    gameId,
    age,
    location,
    netWorth,
    name,
    stats,
    lifeEvents,
    history,
    inventory,
  } = req.body;
  console.log("Saving game state");
  console.log("Age", age);
  console.log("Location", location);
  console.log("Net worth", netWorth);
  console.log("Name", name);
  console.log("Stats", stats);
  console.log("Life events", lifeEvents);
  console.log("History", history);
  console.log("Inventory", inventory);

  try {
    const result = await db.query(
      `UPDATE games SET age = $3, location = $4, net_worth = $5, name = $6, stats = $7, life_events = $8, history = $9, inventory = $10, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *`,
      [
        gameId,
        userId,
        age,
        location,
        netWorth,
        name,
        stats,
        lifeEvents,
        history,
        inventory,
      ]
    );
    console.log("Game state saved", result.rows[0]);
    res.json({
      message: "Game state saved",
      gameState: result.rows[0],
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

apiRouter.delete("/save-game", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { gameId } = req.body;
  try {
    const result = await db.query(
      "DELETE FROM games WHERE id = $1 AND user_id = $2",
      [gameId, userId]
    );
    res.json({ message: "Game deleted", gameId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error in Patch Save Game" });
  }
});

apiRouter.get("/relationships", verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { gameId } = req.query;
  try {
    const result = await db.query(
      "SELECT * FROM relationships WHERE game_id = $1 AND user_id = $2",
      [gameId, userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Database error" });
  }
});

apiRouter.post("/relationships", verifyToken, async (req, res) => {
  const { userId } = req.user; // Authenticated user's ID
  const { relationships, gameId } = req.body; // relationships will be an array of relationship objects

  console.log("Saving new relationships", relationships, gameId);

  // Validate that the user owns the game
  const gameResult = await db.query(
    "SELECT * FROM games WHERE id = $1 AND user_id = $2",
    [gameId, userId]
  );
  if (gameResult.rows.length === 0) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  const savedRelationships = [];
  try {
    // Insert each relationship into the database
    for (const relationship of relationships) {
      const {
        name,
        age,
        gender,
        relationship: relationshipType,
        relationshipStatus,
      } = relationship;

      const result = await db.query(
        `INSERT INTO relationships (game_id, name, age, gender, relationship_type, relationship_status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [gameId, name, age, gender, relationshipType, relationshipStatus]
      );
      console.log("Saved relationship", result.rows[0]);
      savedRelationships.push(result.rows[0]);
    }
    console.log("Saved relationships", savedRelationships);
    res.status(201).json({
      message: "Relationships saved successfully",
      relationships: savedRelationships,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error saving relationships", error });
  }
});

apiRouter.patch("/relationships/:id", verifyToken, async (req, res) => {
  console.log("Patching relationship");
  const { userId } = req.user; // Authenticated user's ID
  const { id } = req.params; // Relationship ID
  const { relationship } = req.body; // Fields to update

  console.log("Updating relationship", id, relationship);

  // Validate that the relationship belongs to the authenticated user's game
  const relationshipResult = await db.query(
    `SELECT r.* 
     FROM relationships r 
     JOIN games g ON r.game_id = g.id 
     WHERE r.id = $1 AND g.user_id = $2`,
    [id, userId]
  );

  if (relationshipResult.rows.length === 0) {
    return res
      .status(403)
      .json({ message: "Unauthorized or relationship not found" });
  }

  try {
    const result = await db.query(
      "UPDATE relationships SET age = $1, relationship_type = $2, relationship_status = $3, updated_at = NOW() WHERE id = $4 RETURNING *",
      [
        relationship.age,
        relationship.relationship,
        relationship.relationship_status,
        id,
      ]
    );
    res.json({ message: "Relationship updated", relationship: result.rows[0] });
  } catch (error) {
    console.error("Error updating relationship:", error);
    res.status(500).json({ message: "Error updating relationship" });
  }
});

apiRouter.get("/", (req, res) => {
  res.send("Hello World!");
});

apiRouter.post("/generate-scenario", async (req, res) => {
  const { gameState, relationships } = req.body;
  // console.log("Generating scenario for game state:", gameState);
  // console.log("Scenario Relationships:", relationships);
  try {
    const { scenario, choices } = await generateScenario(
      gameState,
      relationships
    );
    res.json({ scenario, choices });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error generating scenario", error });
  }
});

apiRouter.post("/evaluate-choice", async (req, res) => {
  const { choice, scenario, gameState, relationships } = req.body;
  try {
    const {
      summary,
      outcome,
      notableLifeEvent,
      lifeEventSummary,
      newRelationships,
      removedRelationships,
    } = await evaluateChoice(choice, scenario, gameState, relationships);
    res.json({
      summary,
      outcome,
      notableLifeEvent,
      lifeEventSummary,
      newRelationships,
      removedRelationships,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error evaluating choice", error });
  }
});

apiRouter.get("/generate-backstory", async (req, res) => {
  const {
    name,
    gender,
    location,
    situation,
    mother,
    motherAge,
    motherRelationship,
    father,
    fatherAge,
    fatherRelationship,
    siblings,
  } = await generateBackstory();
  res.json({
    name,
    gender,
    location,
    situation,
    mother,
    motherAge,
    motherRelationship,
    father,
    fatherAge,
    fatherRelationship,
    siblings,
  });
});

const numberOfSiblingsProbabilities = [
  // 10% chance of 0 children (10 occurrences of 0)
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,

  // 20% chance of 1 child (20 occurrences of 1)
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1,

  // 40% chance of 2 children (40 occurrences of 2)
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,

  // 20% chance of 3 children (20 occurrences of 3)
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,

  // 7% chance of 4 children (7 occurrences of 4)
  4, 4, 4, 4, 4,

  // 3% chance of 5 or more children (3 occurrences of 5)
  5, 5, 5, 6, 8, 10,
];

async function generateScenario(gameState, relationships, tryCount = 0) {
  if (tryCount >= 3) {
    console.error("Failed to generate scenario after 3 tries");
    return null;
  }

  // Ensure relationships is an array
  const safeRelationships = Array.isArray(relationships) ? relationships : [];

  const name = gameState?.name || "Unknown";
  const age = gameState?.age || 0;
  const stats = gameState?.stats || {};
  const history = Array.isArray(gameState?.history) ? gameState.history : [];
  const lifeEvents = Array.isArray(gameState?.lifeEvents)
    ? gameState.lifeEvents
    : [];

  const prompt = `
    You are generating a scenario for ${name} who is ${age} years old.
    Their current stats are:
    Health: ${stats.health || 0}
    Intelligence: ${stats.intelligence || 0}
    Charisma: ${stats.charisma || 0}
    Happiness: ${stats.happiness || 0}
    Fitness: ${stats.fitness || 0}
    Creativity: ${stats.creativity || 0}

    Their relationships are:
    ${safeRelationships
      .map(
        (r) =>
          `${r.name} (${r.relationshipType}): Relationship level ${r.relationshipStatus}`
      )
      .join("\n")}

    Recent history:
    ${history.slice(-3).join("\n")}

    Notable life events:
    ${lifeEvents.join("\n")}

    Generate a scenario with three choices. Format your response using XML tags:
    <scenario>Describe the scenario</scenario>
    <choice1>First choice</choice1>
    <choice1Stats>{"Health": 3, "Intelligence": 3, "Charisma": 3, "Happiness": 3, "Fitness": 3, "Creativity": 3}</choice1Stats>
    <choice2>Second choice</choice2>
    <choice2Stats>{"Health": 3, "Intelligence": 3, "Charisma": 3, "Happiness": 3, "Fitness": 3, "Creativity": 3}</choice2Stats>
    <choice3>Third choice</choice3>
    <choice3Stats>{"Health": 3, "Intelligence": 3, "Charisma": 3, "Happiness": 3, "Fitness": 3, "Creativity": 3}</choice3Stats>
  `;

  try {
    const response = await fetch(`${API_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to generate scenario");
    }

    const data = await response.json();
    const generatedText = data.candidates[0].content.parts[0].text;

    console.log("Generated Text:", generatedText);
    let scenario = "";
    let choices = [];

    // Parse the XML-style response
    scenario = generatedText.match(/<scenario>(.*?)<\/scenario>/s)?.[1].trim();

    const choice1Stats = JSON.parse(
      generatedText.match(/<choice1Stats>(.*?)<\/choice1Stats>/s)?.[1].trim()
    );
    const choice2Stats = JSON.parse(
      generatedText.match(/<choice2Stats>(.*?)<\/choice2Stats>/s)?.[1].trim()
    );
    const choice3Stats = JSON.parse(
      generatedText.match(/<choice3Stats>(.*?)<\/choice3Stats>/s)?.[1].trim()
    );

    choices = [
      {
        choiceText: generatedText
          .match(/<choice1>(.*?)<\/choice1>/s)?.[1]
          .trim(),
        healthEffect: choice1Stats.Health,
        charismaEffect: choice1Stats.Charisma,
        happinessEffect: choice1Stats.Happiness,
        fitnessEffect: choice1Stats.Fitness,
        creativityEffect: choice1Stats.Creativity,
        intelligenceEffect: choice1Stats.Intelligence,
      },
      {
        choiceText: generatedText
          .match(/<choice2>(.*?)<\/choice2>/s)?.[1]
          .trim(),
        healthEffect: choice2Stats.Health,
        charismaEffect: choice2Stats.Charisma,
        happinessEffect: choice2Stats.Happiness,
        fitnessEffect: choice2Stats.Fitness,
        creativityEffect: choice2Stats.Creativity,
        intelligenceEffect: choice2Stats.Intelligence,
      },
      {
        choiceText: generatedText
          .match(/<choice3>(.*?)<\/choice3>/s)?.[1]
          .trim(),
        healthEffect: choice3Stats.Health,
        charismaEffect: choice3Stats.Charisma,
        happinessEffect: choice3Stats.Happiness,
        fitnessEffect: choice3Stats.Fitness,
        creativityEffect: choice3Stats.Creativity,
        intelligenceEffect: choice3Stats.Intelligence,
      },
    ];

    return { scenario, choices };
  } catch (error) {
    console.error("Error generating scenario:", error);
    return generateScenario(gameState, relationships, tryCount + 1);
  }
}

async function evaluateChoice(
  choice,
  scenario,
  gameState,
  relationships,
  tryCount = 0
) {
  if (tryCount >= 3) {
    console.error("Failed to evaluate choice after 3 tries");
    return null;
  }
  const prompt = `
You are part of a life simulation game where you are evaluating the choices of a character.

Here are the current stats of the character:
Name: ${gameState.backstoryname}
Age: ${gameState.age}
Health: ${gameState.stats.health} / 100 (100 is perfect health)
Intelligence: ${gameState.stats.intelligence} / 100
Charisma: ${gameState.stats.charisma} / 100
Happiness: ${gameState.stats.happiness} / 100
Fitness: ${gameState.stats.fitness} / 100
Creativity: ${gameState.stats.creativity} / 100
Net Worth: ${gameState.netWorth}

Here is the character's life so far:
${gameState.history}

Here are their current notable life events:
${gameState.lifeEvents}

Here are their current relationships:
${relationships}

Here is the scenario that the character is in:
${scenario}

Here is the choice that was made:
${choice.choiceText}

Here are the effects of the choice on each of the character's stats, and how to interpret the change in each stat:
1 - Significant decrease
2 - Moderate decrease
3 - No change
4 - Moderate increase
5 - Significant increase

${JSON.stringify(choice)}

Write a very concise summary of the scenario and the choice, and then write a short outcome of the choice that was made by the character.
You also need to evaluate whether this was a choice that resulted in or was part of a notable life event for the character.
If it was, you would put <notableLifeEvent>true</notableLifeEvent> in the response, otherwise you would put <notableLifeEvent>false</notableLifeEvent>.
If it was a notable life event, then provide a brief, concise summary of the event and its impact on the character's life in <lifeEventsummary> tags.

Also evaluate whether there were any new notable people that should be added to the character's relationships. Only add a relationship if it's someone that the character interacts with on a regular basis.
Also evaluate whether there are any relationships that should be removed from the character's relationships. Only remove a relationship if it's someone that the character no longer interacts with on a regular basis.

For the summary, refer to the character by their name, and for the outcome, refer to the character as "you".

Provide your response using the following XML-style tags:
<summary>Summary of the scenario and choice</summary> (only include a summary, don't include information from the other tags)
<outcome>Outcome of the choice</outcome>
<notableLifeEvent>true or false</notableLifeEvent>
<lifeEventSummary>Summary of the notable life event</lifeEventSummary> (Only if notableLifeEvent is true)
<newRelationships>New relationships to add to the character</newRelationships> (optional, should only be added if there was a new notable person added to their life that isn't already in their relationships)
<removedRelationships>Relationships to remove from the character</removedRelationships> (optional, should only be added if there was a relationship that should be removed from the character's relationships)

There can be multiple relationships in the <newRelationships> tags, and they should be formatted like this:
<relationship>
  <name>Name of the person</name>
  <age>Age of the person</age>
  <gender>Gender of the person (should be male or female)</gender>
  <relationshipType>Type of relationship (i.e. grandfather, girlfriend, friend, coworker, etc.)</relationshipType>
  <relationshipStatus>Relationship to the character (on a scale of 1-10, 1 being hatred and 10 being pure love)</relationshipStatus>
</relationship>

The <removedRelationships> tags should be formatted like this:
<removedRelationship>
  <name>Name of the person</name>
  <reason>Reason for removal of the relationship</reason>
</removedRelationship>

Do not add any other types of tags or any additional information.
Again, only add a relationship to the <removedRelationships> tags if it is a person who was in the character's relationships I initially provided, and they no longer interact with them on a regular basis. Their name should be exactly as it was in the initial relationships I provided.
`;

  console.log("Prompt for evaluation:", prompt);

  try {
    const response = await fetch(`${API_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to evaluate choice");
    }
    try {
      const data = await response.json();
      const generatedText = data.candidates[0].content.parts[0].text;

      console.log("Generated Text:", generatedText);

      // Parse the XML-style response

      let summary = "";
      let outcome = "";
      let notableLifeEvent = "";
      let lifeEventSummary = "";
      let newRelationships = "";
      let removedRelationships = "";
      summary = generatedText.match(/<summary>(.*?)<\/summary>/s)?.[1].trim();
      outcome = generatedText.match(/<outcome>(.*?)<\/outcome>/s)?.[1].trim();
      notableLifeEvent = generatedText
        .match(/<notableLifeEvent>(.*?)<\/notableLifeEvent>/s)?.[1]
        .trim();
      lifeEventSummary = generatedText
        .match(/<lifeEventSummary>(.*?)<\/lifeEventSummary>/s)?.[1]
        .trim();
      newRelationships = generatedText
        .match(/<newRelationships>(.*?)<\/newRelationships>/s)?.[1]
        .trim();
      removedRelationships = generatedText
        .match(/<removedRelationships>(.*?)<\/removedRelationships>/s)?.[1]
        .trim();

      let newRelationshipsArray = [];

      newRelationshipsArray = newRelationships
        ? newRelationships.split("</relationship>").map((relationship) => {
            console.log("Relationship", relationship);
            const parts = relationship.split("</");
            console.log("Parts", parts);
            const newAge = parts[0].match(/<age>(.*?)<\/age>/s)?.[1].trim();
            console.log("New Age", newAge);
            return {
              name: parts[0].match(/<name>(.*?)<\/name>/s)?.[1].trim(),
              age: Number(newAge),
              gender: parts[0].match(/<gender>(.*?)<\/gender>/s)?.[1].trim(),
              relationshipType: parts[0]
                .match(/<relationshipType>(.*?)<\/relationshipType>/s)?.[1]
                .trim(),
              relationshipStatus: parts[0]
                .match(/<relationshipStatus>(.*?)<\/relationshipStatus>/s)?.[1]
                .trim(),
            };
          })
        : [];

      console.log("New Relationships", newRelationshipsArray);

      let removedRelationshipsArray = [];
      removedRelationshipsArray = removedRelationships
        ? removedRelationships
            .split("</removedRelationship>")
            .map((relationship) => {
              const parts = relationship.split("</");
              return {
                name: parts[0].match(/<name>(.*?)<\/name>/s)?.[1].trim(),
                reason: parts[0].match(/<reason>(.*?)<\/reason>/s)?.[1].trim(),
              };
            })
        : [];

      console.log("Removed Relationships", removedRelationshipsArray);

      return {
        summary,
        outcome,
        notableLifeEvent,
        lifeEventSummary,
        newRelationshipsArray,
        removedRelationshipsArray,
      };
    } catch (error) {
      return evaluateChoice(
        choice,
        scenario,
        gameState,
        relationships,
        tryCount + 1
      );
    }
  } catch (error) {
    console.error("Error evaluating choice:", error);
    return null;
  }
}

async function generateBackstory(tryCount = 0) {
  if (tryCount >= 3) {
    console.error("Failed to generate backstory after 3 tries");
    return { error: "Failed to generate backstory" };
  }
  const numberOfSiblings =
    numberOfSiblingsProbabilities[
      Math.floor(Math.random() * numberOfSiblingsProbabilities.length)
    ];
  const gender = Math.random() < 0.5 ? "male" : "female";
  console.log("Number of siblings:", numberOfSiblings);
  let prompt = "";
  if (numberOfSiblings === 0) {
    prompt = `
Generate a random backstory for a character in a life simulation game. Include:
1. A name
2. A location of birth (city, country (should be an English-speaking country))
3. A brief description of their family situation or early life circumstances (in the present tense)
4. The names and ages of their mother and father (They have no siblings)

Do not include the characters state of mind or motivations, simply describe the situation they are born into in the present tense.
This character should be a ${gender}. They also have no siblings.
Provide the response using the following XML-style tags:
<name>Character's full name (should be a ${gender})</name>
<location>Place of birth</location>
<situation>Brief description of family and life circumstances they are born into, as well as relationships to other characters</situation>
<mother>Name of the mother</mother>
<motherAge>Age of the mother</motherAge>
<motherRelationship>State of relationship with mother (on a scale of 1-10)</motherRelationship>
<father>Name of the father</father>
<fatherAge>Age of the father</fatherAge>
<fatherRelationship>State of relationship with father (on a scale of 1-10)</fatherRelationship>`;
  } else {
    prompt = `
Generate a random backstory for a character in a life simulation game. Include:
1. A name
2. A location of birth (city, country (should be in the USA or Canada))
3. A brief description of their family situation or early life circumstances (in the present tense)
4. The names and ages of their mother, father and siblings. They should have ${numberOfSiblings} older sibling${
      numberOfSiblings === 1 ? "" : "s"
    }.
This character should be a ${gender}.

Do not include the characters state of mind or motivations, simply describe the situation at the time of birth in the present tense.
Provide the response using the following XML-style tags:
<name>Character's full name (should be a ${gender})</name>
<location>Place of birth</location>
<situation>Brief description of family and life circumstances they are born into, as well as relationships to other characters (Remember that the character is the youngest, but you shouldn't describe their internal state of mind since they are just born)</situation>
<mother>Name of the mother</mother>
<motherAge>Age of the mother</motherAge>
<motherRelationship>State of relationship with mother (on a scale of 1-10)</motherRelationship>
<father>Name of the father</father>
<fatherAge>Age of the father</fatherAge>
<fatherRelationship>State of relationship with father (on a scale of 1-10)</fatherRelationship>
<sibling1>Name of sibling</sibling1>
<siblingAge1>Age of sibling</siblingAge1>
<siblingGender1>Gender of sibling (should be male or female)</siblingGender1>
<siblingRelationship1>State of relationship with sibling (on a scale of 1-10)</siblingRelationship1>
${
  numberOfSiblings > 1
    ? `<sibling2>Name of sibling</sibling2>
<siblingAge2>Age of sibling</siblingAge2>
<siblingGender2>Gender of sibling (should be male or female)</siblingGender2>
<siblingRelationship2>State of relationship with sibling (on a scale of 1-10)</siblingRelationship2>`
    : ""
}
etc.
${
  numberOfSiblings > 1
    ? `
Here is some examples of how to structure the response:
<name>Sarah Johnson</name>
<location>Tacoma, Washington</location>
<situation>Sarah was born into a middle-class family in Tacoma. Her parents have been married for 10 years. She has an older brother, John, who is 5 years old, and an older sister, Emily, who is 3 years old, and an older sister, Mary, who is 1 year old. Emily is not excited about having a new baby in the house.</situation>
<mother>Emily Johnson</mother>
<motherAge>32</motherAge>
<motherRelationship>10</motherRelationship>
<father>Michael Johnson</father>
<fatherAge>37</fatherAge>
<fatherRelationship>10</fatherRelationship>
<sibling1>John Johnson</sibling1>
<siblingAge1>5</siblingAge1>
<siblingGender1>Male</siblingGender1>
<siblingRelationship1>10</siblingRelationship1>
<sibling2>Emily Johnson</sibling2>
<siblingAge2>3</siblingAge2>
<siblingGender2>Female</siblingGender2>
<siblingRelationship2>4</siblingRelationship2>
<sibling3>Mary Johnson</sibling3>
<siblingAge3>1</siblingAge3>
<siblingGender3>Female</siblingGender3>
<siblingRelationship3>10</siblingRelationship3>

Example 2:
<name>Madison Dahl</name>
<location>Pittsburgh, Pennsylvania</location>
<situation>Emily's parents are divorced, and they share custody of her. Emily lives with her mother, Jane, during the week and her father, Michael, during the weekends. She has an older brother, Devon, who is 4 years old, and an older sister, Mary, who is 3 years old.</situation>
<mother>Eliza Gomez</mother>
<motherAge>28</motherAge>
<motherRelationship>8</motherRelationship>
<father>Michael Dahl</father>
<fatherAge>30</fatherAge>
<fatherRelationship>8</fatherRelationship>
<sibling1>Devon Dahl</sibling1>
<siblingAge1>4</siblingAge1>
<siblingGender1>Male</siblingGender1>
<siblingRelationship1>10</siblingRelationship1>
<sibling2>Mary Dahl</sibling2>
<siblingAge2>3</siblingAge2>
<siblingGender2>Female</siblingGender2>
<siblingRelationship2>10</siblingRelationship2>
`
    : ""
}
`;
  }
  try {
    const response = await fetch(`${API_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

    if (!response.ok) {
      throw new Error("Failed to generate backstory");
    }

    const data = await response.json();
    const generatedText = data.candidates[0].content.parts[0].text;

    // Parse the XML-style response
    const name = generatedText.match(/<name>(.*?)<\/name>/s)?.[1].trim();
    const location = generatedText
      .match(/<location>(.*?)<\/location>/s)?.[1]
      .trim();
    const situation = generatedText
      .match(/<situation>(.*?)<\/situation>/s)?.[1]
      .trim();
    const mother = generatedText.match(/<mother>(.*?)<\/mother>/s)?.[1].trim();
    const motherAge = Number(
      generatedText.match(/<motherAge>(.*?)<\/motherAge>/s)?.[1].trim()
    );
    const motherRelationship = generatedText
      .match(/<motherRelationship>(.*?)<\/motherRelationship>/s)?.[1]
      .trim();
    const father = generatedText.match(/<father>(.*?)<\/father>/s)?.[1].trim();
    const fatherAge = Number(
      generatedText.match(/<fatherAge>(.*?)<\/fatherAge>/s)?.[1].trim()
    );
    const fatherRelationship = generatedText
      .match(/<fatherRelationship>(.*?)<\/fatherRelationship>/s)?.[1]
      .trim();

    const siblings = [];
    if (numberOfSiblings > 0) {
      console.log("Generating siblings:", generatedText);
      for (let i = 1; i <= numberOfSiblings; i++) {
        console.log("Generating sibling", i);
        const sibling = generatedText
          .match(`<sibling${i}>(.*?)<\/sibling${i}>`)?.[1]
          .trim();
        const siblingAge = Number(
          generatedText
            .match(`<siblingAge${i}>(.*?)<\/siblingAge${i}>`)?.[1]
            .trim()
        );
        const siblingGender = generatedText
          .match(`<siblingGender${i}>(.*?)<\/siblingGender${i}>`)?.[1]
          .trim();
        const siblingRelationship = generatedText
          .match(
            `<siblingRelationship${i}>(.*?)<\/siblingRelationship${i}>`
          )?.[1]
          .trim();
        console.log("Sibling Name", sibling);
        console.log("Sibling Age", siblingAge);
        console.log("Sibling Relationship", siblingRelationship);
        siblings.push({
          name: sibling,
          age: siblingAge,
          relationship: siblingRelationship,
          gender: siblingGender,
        });
      }
    }

    console.log("Siblings", siblings);
    return {
      name,
      gender,
      location,
      situation,
      mother,
      motherAge,
      motherRelationship,
      father,
      fatherAge,
      fatherRelationship,
      siblings,
    };
  } catch (error) {
    return generateBackstory(tryCount + 1);
  }
}

app.use("/api", apiRouter);

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
