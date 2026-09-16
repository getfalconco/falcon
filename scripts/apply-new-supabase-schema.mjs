import fs from "fs";
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

for (const file of [
  "apps/desktop/supabase/daily_top_signals.sql",
  "apps/desktop/supabase/tracking_agents.sql",
]) {
  const sql = fs.readFileSync(file, "utf8");
  console.log("Applying", file);
  await client.query(sql);
  console.log("OK", file);
}

const tables = await client.query(
  "select tablename from pg_tables where schemaname = 'public' order by 1",
);
console.log("tables:", tables.rows.map((r) => r.tablename).join(", "));
await client.end();
