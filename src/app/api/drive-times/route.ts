import { NextResponse } from "next/server";
import { getDriveTimes } from "@/lib/routing";

export async function POST(req: Request) {
  const body = await req.json();
  const { origin, destinations } = body as {
    origin: { lat: number; lng: number };
    destinations: ({ lat: number; lng: number } | null)[];
  };

  if (!origin || !Array.isArray(destinations)) {
    return NextResponse.json({ error: "Missing origin or destinations" }, { status: 400 });
  }

  try {
    const times = await getDriveTimes(origin, destinations);
    return NextResponse.json({ times });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Routing failed" }, { status: 502 });
  }
}
