import type { Metadata } from "next";
import Link from "next/link";
import { CONTACT_EMAIL, COVERAGE_COUNTRIES, POLICY_UPDATED, SITE_NAME } from "../legal";

export const metadata: Metadata = {
  title: `Privacy Policy | ${SITE_NAME}`,
  description: `What ${SITE_NAME} collects, where it goes, and how to get it deleted.`,
};

export default function PrivacyPage() {
  return (
    <main className="wrap legal">
      <Link className="legal-back" href="/">
        Back to {SITE_NAME}
      </Link>
      <h1 className="legal-h1">Privacy Policy</h1>
      <p className="legal-meta">Last updated {POLICY_UPDATED}</p>

      <p className="legal-lede">
        {SITE_NAME} is a free tool that helps students find internships and nearby businesses worth contacting. This
        page describes exactly what the site collects, who it is sent to, and how to have it removed. It describes
        what the software actually does, not what a template says it might do.
      </p>

      <h2>The short version</h2>
      <ul>
        <li>If you use the site without an account, your answers stay in your own browser.</li>
        <li>If you sign in with Google, your answers and shortlist are saved so they are there next time.</li>
        <li>We never sell your data, and we do not run advertising trackers.</li>
        <li>
          You can have everything deleted at any time. See <a href="#deletion">Deleting your data</a>.
        </li>
      </ul>

      <h2>What we collect</h2>
      <p>It depends on how you use the site.</p>

      <h3>Without an account</h3>
      <p>
        You give a name, and optionally an email address. These are stored only in your own browser (in{" "}
        <code>localStorage</code>) and are not sent to our database. Your questionnaire answers are stored the same
        way. Clearing your browser data removes them.
      </p>

      <h3>Signed in with Google</h3>
      <p>
        Signing in tells us your Google account name and email address. We do not receive your Google password, and
        we do not have access to your Gmail, contacts, or files. Your questionnaire answers and your generated
        shortlist are saved to our database, keyed to your email address, so they can be restored when you return.
      </p>

      <h3>Location</h3>
      <p>
        The whole point of the site is ranking opportunities by how far away they are, so it needs a location. You
        choose how it gets one:
      </p>
      <ul>
        <li>
          <strong>Search for a city</strong>: we use the coordinates of that city, which is approximate by design.
        </li>
        <li>
          <strong>Use my current location</strong>: your browser asks your permission first, and if you allow it we
          receive precise coordinates. You never have to use this option; searching a city works fine.
        </li>
      </ul>
      <p>
        Your location is used to run the search and to calculate distances and drive times. If you are signed in, it
        is saved with your answers.
      </p>

      <h3>Analytics</h3>
      <p>
        We use Vercel Web Analytics to count page views and visits. It does not use cookies, does not build a profile
        of you, and does not follow you to other websites.
      </p>

      <h2>Cookies and browser storage</h2>
      <p>We keep this deliberately small:</p>
      <ul>
        <li>
          <strong>A sign-in cookie</strong>, set only if you sign in with Google. It keeps you signed in and is
          strictly necessary for that feature. Signing out clears it.
        </li>
        <li>
          <strong>Browser storage</strong> (<code>localStorage</code>), used to remember your profile and answers on
          your own device so the site does not ask you everything twice.
        </li>
      </ul>
      <p>
        We do not use advertising or cross-site tracking cookies, which is why the site does not badger you with a
        cookie consent banner.
      </p>

      <h2>Who else receives data</h2>
      <p>
        Running the search means asking other services questions. Here is every third party involved and what it
        receives:
      </p>
      <ul>
        <li>
          <strong>Google</strong>: handles sign-in, if you choose it. Google sees that you signed in to this site.
        </li>
        <li>
          <strong>Supabase</strong>: the database that stores saved answers and shortlists for signed-in users.
        </li>
        <li>
          <strong>Vercel</strong>: hosts the site and provides the cookieless analytics described above. Standard
          server logs, including IP addresses, are processed as part of hosting.
        </li>
        <li>
          <strong>Adzuna</strong>: the live jobs search. It receives the city name and country you are searching, not
          your identity.
        </li>
        <li>
          <strong>OpenStreetMap (Nominatim and Overpass)</strong>: turns your city search into coordinates, and finds
          nearby businesses. It receives the place text or coordinates being searched.
        </li>
        <li>
          <strong>OSRM</strong>: calculates driving distances. It receives the start and end coordinates of a route.
        </li>
      </ul>
      <p>We do not sell personal data, and we do not share it for advertising.</p>

      <h2>Age, and students under 18</h2>
      <p>
        {SITE_NAME} is built for students, including high schoolers, so this section matters more here than on most
        sites.
      </p>
      <ul>
        <li>
          <strong>The site is not intended for children under 13</strong>, and we do not knowingly collect personal
          information from them. If you believe a child under 13 has given us information, email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we will delete it.
        </li>
        <li>
          <strong>If you are under 18</strong>, please ask a parent or guardian before signing in or sharing your
          location, and before emailing any business you find here.
        </li>
        <li>
          You can use the entire site without an account and without precise location. That path keeps your
          information on your own device.
        </li>
      </ul>

      <h2 id="deletion">Deleting your data</h2>
      <p>You have two routes, depending on how you used the site:</p>
      <ul>
        <li>
          <strong>No account</strong>: your data is only in your browser. Use “Start over” in the app, or clear your
          browser data for this site.
        </li>
        <li>
          <strong>Signed in</strong>: use the <strong>Delete my saved data</strong> button on the results screen to
          erase your saved answers and shortlist from our database immediately. You can also email{" "}
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> to request deletion, and we will action it.
        </li>
      </ul>
      <p>
        Depending on where you live you may also have rights to access or correct your data. Email us and we will
        help.
      </p>

      <h2>What we deliberately do not collect</h2>
      <p>
        We do not ask for your address, phone number, school name, date of birth, or any document. The email field
        without an account is optional, and the site works if you leave it blank.
      </p>

      <h2>Where results come from</h2>
      <p>
        Job listings come from a live jobs API covering {COVERAGE_COUNTRIES.length} countries, and are not screened by
        us. Business suggestions for high schoolers come from OpenStreetMap’s open data. Those businesses have not
        advertised a role, have no relationship with us, and have not agreed to be contacted. Treat them as leads to
        research, not as confirmed openings.
      </p>

      <h2>Changes</h2>
      <p>
        If this policy changes in a way that affects you, the date at the top will change. Continuing to use the site
        after that means the updated policy applies.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, deletion requests, or anything else: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>

      <p className="legal-foot">
        See also our <Link href="/terms">Terms of Service</Link>.
      </p>
    </main>
  );
}
