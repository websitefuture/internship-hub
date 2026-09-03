import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { join } from "path";
import { COMPANIES } from "../src/lib/companies";

for (const line of readFileSync(join(__dirname, "..", ".env.local"), "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) process.env[match[1]] = match[2];
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !secretKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY in .env.local");
}

const supabase = createClient(url, secretKey);

async function seed() {
  const rows = COMPANIES.map((c) => ({
    name: c.n,
    city: c.c,
    lat: c.lat,
    lng: c.lng,
    industry: c.i,
    employees: c.e === null ? null : Number(c.e),
    marketing_fit: c.m,
    growth: c.g,
    reach: c.x,
    z_score: c.z,
    welcomes_hs: c.hs,
    website: c.w,
    kicker: c.k,
    description: c.desc,
  }));

  console.log(`Seeding ${rows.length} companies...`);

  const { error: deleteError } = await supabase.from("companies").delete().neq("id", 0);
  if (deleteError) throw deleteError;

  const { data, error } = await supabase.from("companies").insert(rows).select("id");
  if (error) throw error;

  console.log(`Inserted ${data?.length ?? 0} rows.`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
