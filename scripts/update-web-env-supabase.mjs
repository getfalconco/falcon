/**
 * Point apps/web/.env.local at the Supabase project.
 *
 * The connection string is read from the environment, not baked in. It used to
 * be a literal in this file — a live Postgres password sitting in a tracked
 * script, readable by anyone with the repo, and carried into every clone and
 * fork of it.
 *
 *   SUPABASE_DB_URL="postgresql://…" node scripts/update-web-env-supabase.mjs
 */
import fs from "fs";

const envPath = "apps/web/.env.local";
const url = process.env.SUPABASE_URL?.trim() || "https://jjixbyafhpyzfvbxapov.supabase.co";
const db = process.env.SUPABASE_DB_URL?.trim();

if (!db) {
  console.error(
    "\n  SUPABASE_DB_URL is required.\n\n" +
      '  SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@<host>:5432/postgres" \\\n' +
      "    node scripts/update-web-env-supabase.mjs\n\n" +
      "  Copy it from the Supabase dashboard → Project Settings → Database.\n",
  );
  process.exit(1);
}

let content = fs.readFileSync(envPath, "utf8");

function setKey(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(text)) return text.replace(re, `${key}=${value}`);
  return `${text.trimEnd()}\n${key}=${value}\n`;
}

content = setKey(content, "NEXT_PUBLIC_SUPABASE_URL", url);
content = setKey(content, "DATABASE_URL", db);
content = setKey(content, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
content = setKey(content, "SUPABASE_SERVICE_ROLE_KEY", "");
content = setKey(content, "RESEND_FROM_EMAIL", "hello@getfalcon.co");
content = setKey(content, "RESEND_FROM_NAME", "Falcon");

fs.writeFileSync(envPath, content.trimEnd() + "\n");
console.log("Updated", envPath);
