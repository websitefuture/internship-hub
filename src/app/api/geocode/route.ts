import { NextResponse } from "next/server";
import { searchPlaces } from "@/lib/geocode";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") || "";
  try {
    const results = await searchPlaces(q);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Geocoding failed" }, { status: 502 });
  }
}
