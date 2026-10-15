import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";
import { ownVisitorIds, VISITOR_RE } from "@/lib/visitorId";

// Visit cleanup for /admin/stats. Only signed-in admins (ADMIN_EMAILS) may call it.
//   { action: "remove-mine", device }     -> delete every view this browser made (sent automatically
//                                            whenever the owner opens the stats page)
//   { action: "remove", visitor }         -> delete every view by one visitor picked from the list

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// The tracker went live in October 2026; no row is older than this.
const FIRST_DAY = "2026-10-01";

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email || !ADMINS.includes(email)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });

  let body: { action?: unknown; device?: unknown; visitor?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const device = typeof body.device === "string" ? body.device : null;
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

  if (body.action === "remove-mine") {
    const ids = ownVisitorIds(req.headers, device, FIRST_DAY);
    if (!ids.length) return NextResponse.json({ removed: 0 });
    const { count, error } = await db.from("page_views").delete({ count: "exact" }).in("visitor", ids);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ removed: count ?? 0 });
  }

  if (body.action === "remove") {
    if (typeof body.visitor !== "string" || !VISITOR_RE.test(body.visitor)) {
      return NextResponse.json({ error: "Bad visitor" }, { status: 400 });
    }
    const { count, error } = await db.from("page_views").delete({ count: "exact" }).eq("visitor", body.visitor);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ removed: count ?? 0 });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
