import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Auto-responder for the "comment NEST" call to action in the reels.
//
// When someone comments the keyword on one of the account's posts, Meta calls this endpoint.
// It posts a public reply under their comment and sends them the link as a private reply,
// which lands in their Instagram inbox if they follow the account and in Requests if not.
//
// Instagram only. TikTok has no equivalent: its Business Messaging API does not allow
// business-initiated conversations, so a comment cannot open a DM thread there. That is why
// the TikTok cut of the reel ends on the URL on screen instead of asking for a comment.
//
// Meta's rules this is built around, from the Private Replies guide:
//   one private reply per comment, and only within 7 days of the comment
//   750 private replies per hour per account for comments on posts and reels
//   Instagram Live comments can only get a private reply during the broadcast
// https://developers.facebook.com/documentation/instagram-platform/private-replies

const GRAPH = "https://graph.instagram.com/v23.0";

const VERIFY_TOKEN = process.env.IG_VERIFY_TOKEN ?? "";
const APP_SECRET = process.env.IG_APP_SECRET ?? "";
const ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN ?? "";
const IG_USER_ID = process.env.IG_USER_ID ?? "";
const KEYWORD = (process.env.IG_KEYWORD ?? "nest").toLowerCase();
const LINK = process.env.IG_LINK ?? "https://internship-nest.vercel.app";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

/**
 * Meta's subscription handshake: it calls GET with a challenge and the verify token that was
 * typed into the App Dashboard, and expects the challenge echoed back as plain text.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

// Anyone can POST to a public URL. Without this check a stranger could make the account reply
// to comments that do not exist, or burn the hourly private-reply quota. Compared in constant
// time so the comparison itself cannot be used to guess the signature byte by byte.
function signatureValid(raw: string, header: string | null): boolean {
  if (!APP_SECRET || !header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface CommentValue {
  id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
}

interface WebhookBody {
  object?: string;
  entry?: { id?: string; time?: number; changes?: { field?: string; value?: CommentValue }[] }[];
}

// Matches the keyword as a word, so "NEST", "nest!" and "nest please" all count while
// "honest" does not. People rarely type the keyword alone, so an exact-string match would
// miss most of the comments the reel is actually asking for.
const keywordRe = new RegExp(`\\b${KEYWORD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");

// Postgres unique_violation. Here it is the ordinary case rather than a fault: it means some
// other delivery of this same comment already claimed it.
const UNIQUE_VIOLATION = "23505";

/**
 * Claim a comment, returning true only if this request is the one that gets to answer it.
 *
 * Meta retries a notification until it gets a 200, so the same comment arrives several times,
 * and two deliveries can be in flight at once. The claim is an insert against a primary key,
 * taken *before* any message is sent, so the database decides the winner and a loser cannot
 * also reply. A read-then-write would leave a gap between the two where both pass.
 */
async function claimComment(commentId: string, username: string): Promise<boolean> {
  const { error } = await supabase.from("ig_handled").insert({ comment_id: commentId, commenter: username });
  if (!error) return true;
  if (error.code === UNIQUE_VIOLATION) return false;

  // Anything else is a real failure, most likely the ig_handled table not existing yet. It is
  // logged rather than swallowed, because the symptom is otherwise invisible: every comment
  // is silently ignored and the account looks like it is simply not responding.
  console.error("[ig-webhook] claim failed, not replying:", error.code, error.message);
  return false;
}

async function replyToComment(commentId: string, message: string) {
  const res = await fetch(`${GRAPH}/${commentId}/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`reply ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function sendPrivateReply(commentId: string, text: string) {
  // The recipient is the comment, not the person: Meta resolves it to the commenter and
  // attaches a link back to the post. This is the only way to message someone who has never
  // messaged the account first.
  const res = await fetch(`${GRAPH}/${IG_USER_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`dm ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function POST(req: Request) {
  const raw = await req.text();

  if (!signatureValid(raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("Bad signature", { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(raw) as WebhookBody;
  } catch {
    return NextResponse.json({ ok: true });
  }

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const v = change.value ?? {};
      const commentId = v.id;
      const text = v.text ?? "";
      const fromId = v.from?.id;
      const username = v.from?.username ?? "";

      if (!commentId || !keywordRe.test(text)) continue;

      // The account's own replies arrive here as comments too. Without this the first reply
      // would trigger another, and the bot would hold a conversation with itself.
      if (fromId && entry.id && fromId === entry.id) continue;

      try {
        if (!(await claimComment(commentId, username))) continue;

        await replyToComment(commentId, `sent it over${username ? ` @${username}` : ""}`);
        await sendPrivateReply(commentId, `sent it over, here you go: ${LINK}`);
      } catch (err) {
        // Logged, not thrown. Meta retries any non-200, and a retry cannot help when the
        // failure is permanent, such as a comment older than the 7 day window, so one bad
        // comment must not stall the whole notification.
        console.error("[ig-webhook]", commentId, err instanceof Error ? err.message : err);
      }
    }
  }

  // Always 200. Meta disables a subscription that keeps erroring.
  return NextResponse.json({ ok: true });
}
