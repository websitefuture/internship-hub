import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";
import { DEVICE_ID_RE, visitorFromDevice } from "@/lib/visitorId";

// Removes the calling device's own past page views, for the owner's "don't count my visits"
// switch on /admin/stats. Only signed-in admins (ADMIN_EMAILS) may call it, and it can only
// delete rows made by the device id it is sent, which only that browser knows.

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !ADMINS.includes(email)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  let device: unknown;
  try {
    device = ((await req.json()) as { device?: unknown }).device;
  } catch {
    device = null;
  }
  if (typeof device !== "string" || !DEVICE_ID_RE.test(device)) {
    return NextResponse.json({ error: "No device id" }, { status: 400 });
  }

  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const { count, error } = await db
    .from("page_views")
    .delete({ count: "exact" })
    .eq("visitor", visitorFromDevice(device));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ removed: count ?? 0 });
}
