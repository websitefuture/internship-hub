import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  // Sign-in was failing silently: Google authenticated the student, sent them back, and the
  // app simply carried on as though nothing had happened. Auth.js swallows the reason by
  // default, so there was nothing in the logs to read. These hand the real cause to Vercel's
  // runtime log, where it can be looked up instead of inferred from the outside.
  logger: {
    error(error) {
      console.error("[auth:error]", error.name, error.message, error.cause ?? "");
    },
    warn(code) {
      console.warn("[auth:warn]", code);
    },
  },
});
