import { createClient } from "@supabase/supabase-js";
import type { Company } from "./types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secretKey = process.env.SUPABASE_SECRET_KEY;

if (!url || !secretKey) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
}

// Uses the secret key (full read/write, bypasses RLS) — import this only from
// server-side code (Server Components, Route Handlers), never a 'use client' file.
const supabase = createClient(url, secretKey);

interface CompanyRow {
  name: string;
  city: string;
  lat: number | null;
  lng: number | null;
  industry: string;
  employees: number | null;
  marketing_fit: number;
  growth: number;
  reach: number;
  z_score: number;
  welcomes_hs: number;
  website: string | null;
  kicker: string;
  description: string;
}

function toCompany(row: CompanyRow): Company {
  return {
    n: row.name,
    c: row.city,
    lat: row.lat,
    lng: row.lng,
    i: row.industry,
    e: row.employees === null ? null : String(row.employees),
    m: row.marketing_fit,
    g: row.growth,
    x: row.reach,
    z: row.z_score,
    hs: row.welcomes_hs,
    w: row.website,
    k: row.kicker,
    desc: row.description,
  };
}

export async function getCompanies(): Promise<Company[]> {
  const { data, error } = await supabase
    .from("companies")
    .select("name, city, lat, lng, industry, employees, marketing_fit, growth, reach, z_score, welcomes_hs, website, kicker, description")
    .order("id", { ascending: true });

  if (error) throw error;
  return (data as CompanyRow[]).map(toCompany);
}
