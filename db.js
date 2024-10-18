// db.js
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: "db",
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
};
