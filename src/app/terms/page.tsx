import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, COVERAGE_COUNTRIES, POLICY_UPDATED, SITE_NAME } from "../legal";

export const metadata: Metadata = {
  title: `Terms of Service — ${SITE_NAME}`,
  description: `The rules for using ${SITE_NAME}, and the limits of what it promises.`,
};

export default function TermsPage() {
  return (
    <main className="wrap legal">
      <Link className="legal-back" href="/">
        ← Back to {SITE_NAME}
      </Link>
      <h1 className="legal-h1">Terms of Service</h1>
      <p className="legal-meta">Last updated {POLICY_UPDATED}</p>

      <p className="legal-lede">
        These are the rules for using {SITE_NAME}. It is a free tool with no accounts to pay for and nothing to buy,
        so these terms are mostly about what the site does and does not promise.
      </p>

      <h2>What this service is</h2>
      <p>
        {SITE_NAME} asks you nine questions and returns a ranked list. Depending on your answers that list is either
        live internship listings from a third-party jobs API, or real nearby businesses drawn from OpenStreetMap that
        have <strong>not</strong> advertised a role. For the second kind it also drafts a cold email you can
        personalise and send yourself.
      </p>

      <h2>It is free</h2>
      <p>
        There is no charge, no subscription, no trial, and no payment details are ever collected. Because nothing is
        sold, there is nothing to refund.
      </p>

      <h2>Who can use it</h2>
      <p>
        You must be at least 13 years old. If you are under 18, get permission from a parent or guardian before
        signing in, sharing your location, or contacting any business you find here. See our{" "}
        <Link href="/privacy">Privacy Policy</Link> for what is collected.
      </p>

      <h2>What we do not promise</h2>
      <p>This is the important part, so it is in plain language:</p>
      <ul>
        <li>
          <strong>We do not promise you an internship.</strong> The site helps you find and contact places. It does
          not place you, represent you, or speak to anyone on your behalf.
        </li>
        <li>
          <strong>Listings are not ours and are not vetted.</strong> They come from a third-party jobs API covering{" "}
          {COVERAGE_COUNTRIES.length} countries. Details such as pay, location and whether a role is remote are read
          automatically from listing text and can be wrong. Check the original posting before applying.
        </li>
        <li>
          <strong>Suggested businesses have not offered anything.</strong> A business appearing in your results has
          not posted a job, has no relationship with us, and has not agreed to be contacted. Its details come from
          public OpenStreetMap data and may be out of date.
        </li>
        <li>
          <strong>Scores and distances are estimates.</strong> Ranking is our own calculation. Drive times use a
          routing service where available and a straight-line estimate otherwise.
        </li>
        <li>
          <strong>The site may be unavailable or wrong.</strong> It depends on free third-party services that can
          fail, rate-limit, or change. It is provided “as is”, without warranties.
        </li>
      </ul>

      <h2>Using it responsibly</h2>
      <p>When you contact a business you found here, you are acting as yourself, not on our behalf. Please:</p>
      <ul>
        <li>Personalise the drafted email rather than sending it unchanged, and be honest in it about who you are.</li>
        <li>Contact a business once, and respect it if they say no or do not reply.</li>
        <li>Do not use the site or its drafted emails to send bulk or automated messages.</li>
        <li>Do not scrape, overload, or attempt to break the site or the services behind it.</li>
      </ul>

      <h2>Your content and your data</h2>
      <p>
        Your answers belong to you. If you are signed in we store them so you can come back to your shortlist, and
        you can delete them at any time from the results screen or by emailing us. See the{" "}
        <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Data and attribution</h2>
      <p>
        Business and geocoding data comes from{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
          OpenStreetMap
        </a>
        , © OpenStreetMap contributors, available under the Open Database License (ODbL). Job listings are provided by
        Adzuna. Typefaces are used under the SIL Open Font License.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, we are not liable for losses arising from your use of the site — including
        missed opportunities, inaccurate listings, or how a business responds to you. Nothing here limits rights you
        have that cannot legally be limited.
      </p>

      <h2>Changes and ending access</h2>
      <p>
        These terms may change; the date above will change with them. The site is a personal project and may be
        altered or discontinued at any time. You can stop using it whenever you like and delete your data as
        described above.
      </p>

      <h2>Contact</h2>
      <p>
        Anything at all: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <p className="legal-foot">
        See also our <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </main>
  );
}
