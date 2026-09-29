import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

export async function GET() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { data, error } = await supabase.from("user_data").select("answers, results").eq("user_email", email).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ answers: data?.answers ?? null, results: data?.results ?? null });
}

// Right-to-delete, exposed in the app as "Delete my saved data" and promised in the privacy
// policy. It removes the row outright rather than flagging it, so nothing survives the call.
export async function DELETE() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { error } = await supabase.from("user_data").delete().eq("user_email", email);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json();
  // Only overwrite what this request actually carries. Answers are now saved as they are
  // given, mid-questionnaire, and a full-row upsert would null the saved shortlist every
  // time one of those went through.
  const row: Record<string, unknown> = {
    user_email: email,
    name: session.user?.name ?? "",
    updated_at: new Date().toISOString(),
  };
  if ("answers" in body) row.answers = body.answers ?? null;
  if ("results" in body) row.results = body.results ?? null;

  const { error } = await supabase.from("user_data").upsert(row, { onConflict: "user_email" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
