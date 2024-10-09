require("dotenv").config();

const express = require("express");
const cors = require("cors");
const app = express();
const port = 3000;

const GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
const API_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/generate-scenario", async (req, res) => {
  const { gameState } = req.body;
  console.log("Generating scenario for game state:", gameState);
  const { scenario, choices } = await generateScenario(gameState);
  res.json({ scenario, choices });
});

app.post("/evaluate-choice", async (req, res) => {
  const { choice, scenario, gameState } = req.body;
  const {
    summary,
    outcome,
    notableLifeEvent,
    lifeEventSummary,
    newRelationships,
    removedRelationships,
  } = await evaluateChoice(choice, scenario, gameState);
  res.json({
    summary,
    outcome,
    notableLifeEvent,
    lifeEventSummary,
    newRelationships,
    removedRelationships,
  });
});

app.get("/generate-backstory", async (req, res) => {
  const { backstory } = await generateBackstory();
  res.json({ backstory });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
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

async function generateScenario(gameState) {
  const age = gameState.age;
  const name = gameState.backstory?.name || "Unknown";
  let scenarioContext = "";

  if (age >= 0 && age <= 2) {
    scenarioContext = `${name} is  ${age} years old and in the early childhood development stage. Present a choice that is relevant to the early childhood development stage, such as a choice between toys, first words, etc.`;
  } else if (age >= 3 && age <= 5) {
    scenarioContext = `${name} is ${age} years old and in the preschool years. Present choices for the player as a decision that will cover the entire years for age 3-5.`;
  } else if (age >= 6 && age <= 12) {
    scenarioContext = `${name} is ${age} years old and in the elementary school years. Present choices for the player as a decision that will cover the entire years for age 6-12.`;
  } else {
    scenarioContext = `${name} is ${age} years old.`;
  }

  const prompt = `
Generate an age-appropriate scenario and three choices for a life simulation game. Here are the current stats of the character:
Name: ${name}
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

${
  gameState.lifeEvents.length > 0
    ? `Here are their current notable life events:\n${gameState.lifeEvents.join(
        "\n"
      )}`
    : ""
}

Here are their current relationships (relationship status is on a scale of 1-10, with 10 being pure love and 1 being hatred):
${gameState.relationships
  .map(
    (relationship) =>
      ` ${relationship.relationship}: ${relationship.name} - Relationship status: ${relationship.relationshipStatus}`
  )
  .join("\n")}

${scenarioContext}

Always refer to the character as "you" in the scenario.

For each choice, provide the consequences of the choices on each of the character's stats as a json object where each stat is a value between 1 and 5 with the following format:
{
"Health": 1-5,
  "Charisma": 1-5,
  "Happiness": 1-5,
  "Fitness": 1-5,
  "Creativity": 1-5,
  "Intelligence": 1-5,
}
  For each choice, follow this guide when determining the change in stats:
  - A score of 1 indicates the result of a significant decrease in the stat
  - A score of 2 indicates the result of a moderate decrease in the stat
  - A score of 3 indicates the choice had no change on the stat
  - A score of 4 indicates the result of a moderate increase in the stat
  - A score of 5 indicates the result of a significant increase in the stat

You should consider the gravity of the choice they are making and the potential consequences on their stats. The gravity of the situation they are choosing should be determined by the character's age. For example, a choice an 18 year old makes might be more serious than a choice a 13 year old makes, but if your parents are getting divorced or something serious happens when you are 5, then that would be a more serious choice for a 5 year old than for an 18 year old. But generally speaking, match the gravity of the choice to the life situation, age, and circumstances of the character.

Provide your response using the following XML-style tags:
<scenario>Description of the scenario</scenario>
<choice1>Choice 1</choice1>
<choice1Stats>JSON object with the change in stats for choice 1</choice1Stats>
<choice2>Choice 2</choice2>
<choice2Stats>JSON object with the change in stats for choice 2</choice2Stats>
<choice3>Choice 3</choice3>
<choice3Stats>JSON object with the change in stats for choice 3</choice3Stats>

Be sure to always structure the Choice Stats as a JSON object with the keys being the stat name and the values being the change in stats, and to always include all 6 stats, such as:
<choice1Stats>{"Health": 3, "Charisma": 3, "Happiness": 3, "Fitness": 3, "Creativity": 3, "Intelligence": 3}</choice1Stats> (This would be a choice that had no effect on the stats)
or
<choice2Stats>{"Health": 3, "Charisma": 3, "Happiness": 1, "Fitness": 4, "Creativity": 3, "Intelligence": 3}</choice2Stats> (This would be a choice that resulted in a significant decrease in happiness and a moderate increase in fitness, and no effect in the other stats)

Now create the scenario, choices, and choice stats in the appropriate XML format for ${name} who is ${age} years old.
`;

  console.log("Prompt for scenario:", prompt);

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

    // console.log("Generated Text:", generatedText);
    let scenario = "";
    let choices = [];
    try {
      // Parse the XML-style response
      scenario = generatedText
        .match(/<scenario>(.*?)<\/scenario>/s)?.[1]
        .trim();

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
    } catch (error) {
      console.error("Error parsing XML-style response:", error);
      return null;
    }

    return { scenario, choices };
  } catch (error) {
    console.error("Error generating scenario:", error);
    return null;
  }
}

async function evaluateChoice(choice, scenario, gameState) {
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
${gameState.backstory.history}

Here are their current notable life events:
${gameState.lifeEvents}

Here is their current relationships:
${gameState.relationships}

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
    console.error("Error evaluating choice:", error);
    return null;
  }
}

async function generateBackstory() {
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
    console.error("Error generating backstory:", error);
    return null;
  }
}
