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

export async function POST(req: Request) {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json();
  const { error } = await supabase.from("user_data").upsert(
    {
      user_email: email,
      name: session.user?.name ?? "",
      answers: body.answers ?? null,
      results: body.results ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_email" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
