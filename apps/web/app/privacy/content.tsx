import { A, Fact, H3, LI, Mail, P, Table, Term, UL, type LegalSectionDef } from "../components/legal/primitives";

/**
 * The Privacy Policy. Every practice described here was checked against the
 * code that carries it out (apps/web, apps/desktop, apps/research-worker,
 * apps/falcon-engine) and against the desktop app's Settings, Privacy pane,
 * which lists the same recipients from the same code. When one changes, change
 * the other.
 *
 * Section ids are anchors linked from elsewhere (#categories, #retention,
 * #applicants, #cookies); never rename one.
 */

export const PRIVACY_INTRO = (
  <>
    <P>
      This Privacy Policy explains how <Fact k="entityName" /> (&quot;Falcon&quot;, &quot;we&quot;, &quot;us&quot;)
      collects, uses, shares and protects personal data when you use the Falcon desktop application, the website at
      getfalcon.co, our waitlist and early-access programme, and the services that power them (together, the
      &quot;Service&quot;). It also covers people who apply to work with us.
    </P>
    <P>
      In short: we collect what we need to run your account and the features you use; most working data stays on your
      own computer; we do not sell your personal data or use it for advertising; and the AI features send the minimum
      needed to the model provider, without your name or email.
    </P>
  </>
);

export const PRIVACY_SECTIONS: readonly LegalSectionDef[] = [
  {
    id: "who-we-are",
    title: "Who we are",
    body: (
      <>
        <P>
          The controller responsible for your personal data is <Fact k="entityName" />, a company registered in{" "}
          <Fact k="country" /> under number <Fact k="registrationNumber" />, with its registered office at{" "}
          <Fact k="address" />.
        </P>
        <UL>
          <LI>
            Privacy requests and questions: <Mail k="privacyEmail" />
          </LI>
          <LI>
            Data protection officer: <Fact k="dpo" />
          </LI>
          <LI>
            Representative in the European Union: <Fact k="euRepresentative" />
          </LI>
          <LI>
            Representative in the United Kingdom: <Fact k="ukRepresentative" />
          </LI>
          <LI>
            Turkey (KVKK): <Fact k="kvkkRegistration" />
          </LI>
        </UL>
      </>
    ),
  },
  {
    id: "categories",
    title: "What we collect",
    body: (
      <>
        <P>
          What we hold depends on how you use Falcon. Much of the desktop app&apos;s working data is kept only on your
          computer and never reaches us; where that is the case we say so.
        </P>

        <H3>Account and sign-in</H3>
        <UL>
          <LI>
            <Term>Account details:</Term> your email address, a password (stored by our authentication provider as a
            one-way hash; we never see it in readable form), the name you give us, your account identifier, and
            account status such as whether you have been admitted from the waitlist, your membership tier and the
            dates your account was created and last signed in.
          </LI>
          <LI>
            <Term>One-time codes:</Term> sign-up confirmation and password reset use codes emailed to you.
          </LI>
        </UL>

        <H3>Early-access application</H3>
        <UL>
          <LI>
            Your full name, email address and phone number (with country code), and a password for the account the
            application creates.
          </LI>
          <LI>
            Your answers to the application questions: what best describes you (for example founder, finance
            professional or trader), the approximate band of capital you trade with, how you make trading decisions,
            and your free-text answers about what you find hardest and what you hope Falcon will do for you, and
            whether you accepted the programme&apos;s terms.
          </LI>
        </UL>

        <H3>Profile and onboarding</H3>
        <UL>
          <LI>
            Your name, what Falcon should call you, and any instructions you write in your profile. Profile
            instructions are stored with your account and are not currently used by any feature.
          </LI>
          <LI>
            Your onboarding answers: how long you have been investing, the sectors you follow, your typical holding
            period, how you want positions handled, the panels you want on your desk, your preferred signal format,
            and how you heard about Falcon. We also record a country code taken from your computer&apos;s language and
            region settings.
          </LI>
          <LI>
            Your profile photo, if you add one. It is stored only on your computer.
          </LI>
        </UL>

        <H3>What you do in the app</H3>
        <UL>
          <LI>
            <Term>Stored with your account:</Term> your paper (simulated) portfolio (cash, and for each position the
            ticker, number of shares and cost) and its value history, which our engine records at most once a minute
            while the US market is open and less often outside market hours, and only when the value has changed (or
            once an hour to show it has not); the
            company research you start, with its results; and a summary of any brokerage you link (see below).
          </LI>
          <LI>
            <Term>Stored only on your computer:</Term> your watchlist, layout and preferences, recent searches, a copy
            of your paper account, saved briefings, the list of holdings Falcon has researched or queued, your research
            agents (their briefs, instructions, reports and the messages you exchange with them), calendar events you
            add, notification settings, the state and settings of the app&apos;s market engines (including the tickers
            they follow), and caches of public data such as SEC filings, relationship graphs and news.
          </LI>
          <LI>
            <Term>Sent to our engine service:</Term> when the app uses Falcon&apos;s hosted engine, it sends your paper
            account (cash and positions with their market value) so risk readings can be calculated, and the tickers
            you hold and watch so the engines follow them. Your paper account copy, risk readings and watchlist are
            filed under your account identifier and are only returned to you. Followed tickers are kept in a shared list that is not
            linked to your account.
          </LI>
        </UL>

        <H3>Brokerage connection (optional)</H3>
        <P>
          If you choose to link a brokerage, the connection is made through SnapTrade. You sign in to your brokerage on
          SnapTrade&apos;s and your brokerage&apos;s pages; we never receive your brokerage username or password. We
          request read-only access. We identify you to SnapTrade only by a Falcon account identifier, never by name
          or email. We receive and store a summary of each linked account (its name or number, the institution and
          its balance) so it can be shown in the app; we do not currently retrieve individual positions or
          transactions. To keep the link working, SnapTrade issues a user secret for your connection. It is stored
          encrypted, with a key only our servers hold, in a restricted table in our database that only our servers can
          read. In some configurations of the app it is also kept in a file in the app&apos;s data folder on your
          computer, one per account, encrypted with your operating system&apos;s protection for your user account; where
          the system offers no such protection, it is kept in memory only and never written to disk. It is never
          included in data exports.
        </P>

        <H3>Content you send to AI features</H3>
        <P>
          Some features send content to our AI model provider to produce a result. See Section 4 for exactly what is
          sent.
        </P>

        <H3>Technical data</H3>
        <UL>
          <LI>
            <Term>Network data:</Term> like any internet service, our servers and providers receive your IP address and
            basic request information when the app or website contacts them. Our website uses IP addresses briefly, in
            memory, to limit abusive request rates; it does not store them for that purpose.
          </LI>
          <LI>
            <Term>Error reports:</Term> when a Falcon app reports an error to our website, or a request to
            Falcon&apos;s research worker fails, the report sent to our team includes the ticker involved, a description
            of the error and, so reports from the same account can be told apart, a pseudonymous code derived from your
            account (or, where that is not available, your email address with everything before the @ hidden except the
            first character). It does not include your name, your full email address, sign-in tokens, keys or IP
            addresses. See Section 6.
          </LI>
          <LI>
            <Term>Update checks:</Term> the desktop app asks GitHub, where our releases are published, whether a newer
            version exists.
          </LI>
          <LI>
            <Term>No analytics:</Term> neither the website nor the app uses analytics, advertising, usage tracking or
            crash-reporting tools.
          </LI>
        </UL>

        <H3 id="applicants">If you apply for a job or internship</H3>
        <P>
          We collect your name, email address, LinkedIn profile, the role you apply for, your introduction and other
          answers, how you heard about the role and who referred you, your CV if you upload one, and, as your
          application progresses, our assessment notes, any task you submit and interview scheduling details.
        </P>

        <H3>When you contact us</H3>
        <P>The content of your messages and your contact details, so we can reply.</P>

        <P>
          We do not ask for, and ask you not to provide, special categories of personal data (such as health data or
          political opinions) or government identifiers.
        </P>
      </>
    ),
  },
  {
    id: "sources",
    title: "Where it comes from",
    body: (
      <>
        <UL>
          <LI>From you, when you apply, sign up, set up your profile, or use the app.</LI>
          <LI>
            From your brokerage, through SnapTrade, if you choose to link an account.
          </LI>
          <LI>
            Automatically, from your device, when the app or website communicates with our servers (for example your IP
            address and error reports).
          </LI>
          <LI>From people who refer you, if you apply for a role and name a referrer, or are named as one.</LI>
        </UL>
        <P>
          Market data, filings and news shown in Falcon come from public and licensed sources. They are about companies
          and markets, not about you.
        </P>
      </>
    ),
  },
  {
    id: "ai-processing",
    title: "How the AI features use your data",
    body: (
      <>
        <P>
          Falcon uses large language models provided by Anthropic (the Claude API). In the released desktop app,
          requests are relayed through Falcon&apos;s research worker, which checks your session, removes your sign-in
          token and IP address, and then forwards them. The model provider receives:
        </P>
        <UL>
          <LI>tickers, public SEC filing text and news headlines, to build relationship graphs, signals and reads;</LI>
          <LI>
            for <Term>Falcon&apos;s read on news</Term>, the text of a news story you open that has no ready-made read;
            you can switch this off in Settings, Privacy;
          </LI>
          <LI>
            for <Term>your briefing</Term>, the tickers you hold the most of, sized only as large, medium or small,
            and their percentage moves; never dollar amounts, share counts or cash balances;
          </LI>
          <LI>
            the <Term>questions you type into Insight chat</Term>, with the facts of the event you are asking about;
            we do not store these conversations;
          </LI>
          <LI>
            for <Term>research agents</Term>, each agent&apos;s brief and instructions and the messages you exchange
            with it, together with the public market data it gathers;
          </LI>
          <LI>text you select in the app to have explained, with the surrounding context.</LI>
        </UL>
        <P>
          Model requests may pass through a model gateway service before reaching the model:{" "}
          <Fact k="modelGateway" />.
        </P>
        <P>
          We do not send your name, email address or profile instructions to the model provider. To give Falcon&apos;s
          read on a story, the app itself downloads the article from the publisher&apos;s website. Please do not type
          personal information about yourself or others into chat or agent prompts.
        </P>
        <P>
          Anthropic processes this content to provide the service to us. Under Anthropic&apos;s commercial terms for
          its API, customer content is not used to train its models by default; Anthropic may retain API inputs and
          outputs for a limited period, for example for trust and safety purposes, as described in its own policies.
        </P>
        <P>
          Outputs are generated automatically and are not decisions about you. We do not use AI or other automated
          processing to make decisions that have legal or similarly significant effects on you. Early-access
          applications are reviewed by our team.
        </P>
      </>
    ),
  },
  {
    id: "purposes",
    title: "Why we use it, and our legal bases",
    body: (
      <>
        <P>
          Where the GDPR, the UK GDPR or similar laws apply, we rely on the following legal bases (Article 6 GDPR).
          Where we rely on legitimate interests, we have weighed them against your rights; you can ask us for details
          and you can object (Section 10).
        </P>
        <Table
          head={["Purpose", "Data", "Legal basis"]}
          rows={[
            [
              "Create and run your account, sign you in, keep you signed in, and provide the features you use",
              "Account, profile, onboarding, in-app data, brokerage account summary",
              "Performance of a contract (Art. 6(1)(b))",
            ],
            [
              "Assess early-access applications and decide who to admit, and contact applicants about the programme",
              "Application data",
              "Steps at your request before entering a contract (Art. 6(1)(b)); legitimate interests in selecting early users (Art. 6(1)(f))",
            ],
            [
              "Generate AI outputs you ask for (reads, briefings, chat answers, agent reports)",
              "Content listed in Section 4",
              "Performance of a contract (Art. 6(1)(b))",
            ],
            [
              "Falcon's read on news for stories without a ready-made read",
              "Text of the story you open",
              "Performance of a contract; you can switch it off at any time",
            ],
            [
              "Link and show your brokerage holdings",
              "Brokerage account summary, SnapTrade user secret",
              "Performance of a contract, at your request (Art. 6(1)(b))",
            ],
            [
              "Diagnose and fix errors, keep the Service secure, prevent abuse and enforce our Terms",
              "Error reports, IP addresses, account details",
              "Legitimate interests in a working, secure service (Art. 6(1)(f))",
            ],
            [
              "Send service emails (codes, account and application notices)",
              "Email address, name",
              "Performance of a contract (Art. 6(1)(b))",
            ],
            [
              "Review job and internship applications",
              "Applicant data",
              "Steps at your request before entering a contract (Art. 6(1)(b)); legitimate interests in recruiting (Art. 6(1)(f))",
            ],
            [
              "Comply with law, respond to lawful requests, and establish or defend legal claims",
              "Any relevant data",
              "Legal obligation (Art. 6(1)(c)); legitimate interests (Art. 6(1)(f))",
            ],
          ]}
        />
        <P>
          We do not sell personal data, share it for cross-context behavioural advertising, or use it to profile you
          for marketing. We do not trade on your data. If we ever want to use personal data for a new purpose that is
          not compatible with these, we will tell you first and, where required, ask for your consent.
        </P>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who we share it with",
    body: (
      <>
        <P>
          We share personal data only with the service providers that help us run Falcon, under contracts that limit
          their use of it to providing their services to us, and in the limited cases described below.
        </P>
        <Table
          head={["Recipient", "What they do", "Personal data involved", "Location"]}
          rows={[
            [
              "Supabase",
              "Authentication, database and file storage for accounts, applications and careers CVs",
              "Account, application, profile, onboarding and in-app data stored with your account; brokerage account summary and SnapTrade user secret; job applications and CVs",
              "European Union (AWS eu-west-1, Ireland); Supabase, Inc. is based in the United States",
            ],
            [
              "Anthropic",
              "AI model provider (Claude API)",
              "The content described in Section 4; never your name or email",
              "United States",
            ],
            [
              <Fact key="gw" k="modelGateway" />,
              "Model gateway that forwards AI requests to the model, if one is used",
              "The content described in Section 4",
              <Fact key="gwl" k="modelGatewayLocation" />,
            ],
            [
              "Railway",
              "Hosting for Falcon's engine service and research worker",
              "Requests relayed through them, including your session token, paper account, the tickers you hold and watch, and AI request content; IP address",
              <Fact key="rw" k="railwayRegion" />,
            ],
            ["Netlify", "Website hosting", "IP address and request data; data you submit through website forms passes through it", "United States and global edge network"],
            [
              "Resend",
              "Sending emails about careers and internship applications",
              "Name, email address, application status",
              "United States",
            ],
            [
              "SnapTrade",
              "Brokerage connection, only if you link one",
              "A Falcon account identifier and the connection's user secret; account names, balances and institution flow from your brokerage through SnapTrade",
              <Fact key="st" k="snaptradeLocation" />,
            ],
            [
              "Discord",
              "Delivers error reports to a private channel our team reads",
              "Ticker and error details with a pseudonymous account code or partly hidden email address (website and research worker reports)",
              "United States",
            ],
            ["GitHub", "Hosts desktop app releases and answers update checks", "IP address and app version", "United States"],
            [
              "Market data providers (Finnhub, Yahoo Finance, Nasdaq, SEC EDGAR)",
              "News, quotes, symbols and filings",
              "Ticker symbols and company identifiers; your IP address when the app contacts them directly (Yahoo Finance may also set its own cookies inside the app). Nothing else about you",
              "United States",
            ],
            [
              "News publishers",
              "The app downloads a story you open from the publisher's website to give Falcon's read on it",
              "Your IP address and a standard browser identifier",
              "Varies by publisher",
            ],
            [
              "Image hosts used by the website (flagcdn.com, cdn.jim-nielsen.com)",
              "Country flags in the phone field and app icons on the download page",
              "IP address and browser details, when your browser loads those images",
              "Global",
            ],
          ]}
        />
        <P>We may also disclose personal data:</P>
        <UL>
          <LI>
            to comply with law, a court order or a lawful request from a public authority, or to protect the rights,
            property or safety of Falcon, our users or others;
          </LI>
          <LI>
            to professional advisers (such as lawyers and accountants) under confidentiality obligations;
          </LI>
          <LI>
            as part of a merger, acquisition, financing or sale of assets, in which case the recipient will be bound by
            this policy or one at least as protective, and we will tell you before your data becomes subject to a
            different policy.
          </LI>
        </UL>
      </>
    ),
  },
  {
    id: "international-transfers",
    title: "International transfers",
    body: (
      <>
        <P>
          Several of our providers are in the United States or other countries outside the European Economic Area, the
          United Kingdom and Turkey. Where we transfer personal data from those places to a country without an
          adequacy decision, we rely on appropriate safeguards: the European Commission&apos;s Standard Contractual
          Clauses, the UK International Data Transfer Addendum, certification under the EU-U.S. Data Privacy Framework
          (and its UK and Swiss extensions) where the recipient participates, or, for transfers from Turkey, the
          mechanisms available under Article 9 of the KVKK, including the standard contracts published by the Personal
          Data Protection Authority. You can ask us for a copy of the relevant safeguards at <Mail k="privacyEmail" />.
        </P>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <>
        <Table
          head={["Data", "How long"]}
          rows={[
            [
              "Account, profile, onboarding, paper portfolio and its value history, research you started, and brokerage account summary",
              "Until you delete your account (resetting your paper account also clears its value history). Older value history is kept at reduced detail: one point per minute after a day, one per hour after 7 days, and one per day after 90 days",
            ],
            [
              "SnapTrade user secret, and your user at SnapTrade",
              "Both are deleted with your account: we ask SnapTrade to delete your user there, with every brokerage connection under it, before your account is removed. If SnapTrade cannot be reached at that moment, we keep only your SnapTrade user identifier (not the secret) and retry automatically; if the retries run out, our team removes it by hand",
            ],
            [
              "Early-access applications",
              <>
                Kept with your account. If you are not admitted, for <Fact k="applicantRetention" />, or earlier if you
                ask us to delete it
              </>,
            ],
            [
              "Job and internship applications, including CVs",
              <>
                <Fact k="applicantRetention" /> after the process ends, unless you agree to us keeping it longer for
                future roles; if you join us, under our staff privacy notice
              </>,
            ],
            ["Saved briefings on your computer", "14 days, then deleted automatically"],
            ["Research agents on your computer", "Until you delete them; each agent keeps its latest 100 reports and 200 messages"],
            ["Insight chat conversations", "Not stored; they last only while the panel is open"],
            ["Cached news reads on your computer", "Up to 7 days"],
            [
              "Paper account, watchlist and risk readings on our engine",
              "The engine keeps the most recent paper account and watchlist it received from you, filed under your account identifier (not your name), until you send newer ones, and your risk readings for 180 days. All are deleted when you delete your account; if our engine cannot be reached at that moment, the deletion is retried automatically",
            ],
            [
              "Other data on your computer",
              "Until you delete it, clear it in Settings, Privacy, or uninstall the app and remove its data folder",
            ],
            ["Error reports in our team channel", <Fact key="er" k="errorReportRetention" />],
            ["Rate-limiting data on the website", "In memory only, for at most one hour"],
            [
              "Data we must keep by law, or to establish or defend legal claims",
              "For the period the law requires or the claim lasts",
            ],
          ]}
        />
        <P>
          Copies may remain in our providers&apos; backups for a limited period after deletion, until those backups are
          overwritten.
        </P>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect it",
    body: (
      <>
        <UL>
          <LI>Data is encrypted in transit between the app, the website and our servers (HTTPS).</LI>
          <LI>
            Keys for our AI and data providers are kept on our servers or in the app&apos;s background process, never
            in the part of the app that displays web content.
          </LI>
          <LI>
            Database tables holding personal data are protected by row-level security, so each account can reach only
            its own rows; the most sensitive tables (such as SnapTrade user secrets and job applications) can be read
            only by our servers.
          </LI>
          <LI>Access to the admin tools is limited to authorised team members.</LI>
          <LI>Passwords are stored by our authentication provider as one-way hashes.</LI>
        </UL>
        <P>
          No system is perfectly secure. Data kept on your computer is protected by your computer&apos;s own security, so
          please keep your device and operating system account secure. If we become aware of a breach that affects your
          personal data, we will notify you and the authorities where the law requires.
        </P>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "Your rights and choices",
    body: (
      <>
        <P>Depending on where you live, you may have the right to:</P>
        <UL>
          <LI>access the personal data we hold about you and receive a copy;</LI>
          <LI>correct inaccurate data;</LI>
          <LI>delete your data;</LI>
          <LI>receive your data in a portable, machine-readable format;</LI>
          <LI>object to processing based on legitimate interests;</LI>
          <LI>restrict processing in certain circumstances;</LI>
          <LI>withdraw consent where we rely on it, without affecting earlier processing;</LI>
          <LI>not be subject to decisions based solely on automated processing that significantly affect you.</LI>
        </UL>
        <H3>How to use them</H3>
        <UL>
          <LI>
            <Term>Export:</Term> in the desktop app, Settings, Privacy, Export data saves one JSON file with your
            account record, the data stored with your account, your saved briefings, portfolio files, agents (with
            their reports, activity and chats) and calendar events on that computer, your profile photo and the app&apos;s stored preferences. Only the signed-in account&apos;s files
            are included. Your sign-in session and SnapTrade user secret are left out.
          </LI>
          <LI>
            <Term>Delete:</Term> in the desktop app, Settings, Account, delete your account. This deletes your sign-in
            account and the data stored with it, your user at SnapTrade with its brokerage connections, your paper
            account copy, watchlist and risk readings on our engine, and, on the computer you delete from, that account&apos;s
            agents, calendar events, saved briefings, profile photo, brokerage link key and the app&apos;s stored data
            for it; then it signs you out on every device. If a step cannot be finished at that moment (for example,
            SnapTrade cannot be reached), the app tells you which one, and Falcon retries it automatically. It does not
            remove error reports already sent to our team, shared caches of public data and device settings on your
            computer, or Falcon files on other computers you used (remove the app&apos;s data folder there). Saved
            briefings and recent searches can also be cleared in Settings, Privacy.
          </LI>
          <LI>
            <Term>Correct:</Term> edit your name, profile and instructions in Settings.
          </LI>
          <LI>
            <Term>Anything else</Term>, or if you cannot use the app (for example, you applied but were not admitted):
            email <Mail k="privacyEmail" />.
          </LI>
        </UL>
        <P>
          We will respond within the time the law requires (one month under the GDPR, which can be extended in some
          cases; 30 days under the KVKK; 45 days under the CCPA). We may need to verify your identity, usually by
          confirming control of the email address on your account. You can use an authorised agent where the law
          allows; we may ask for proof of their authority. We will not discriminate against you for using your rights.
        </P>
        <P>
          You also have the right to complain to a data protection authority, in particular where you live or work:
          for example your local EU supervisory authority, the UK Information Commissioner&apos;s Office, or
          Turkey&apos;s Personal Data Protection Authority (KVKK). We would appreciate the chance to address your
          concern first.
        </P>
      </>
    ),
  },
  {
    id: "california",
    title: "Additional information for California residents",
    body: (
      <>
        <P>
          Under the California Consumer Privacy Act, as amended by the California Privacy Rights Act (CCPA), in the past
          12 months we have collected the following categories of personal information, from the sources and for the
          purposes described in Sections 2, 3 and 5, and disclosed them for business purposes to the service providers
          in Section 6:
        </P>
        <UL>
          <LI>Identifiers (name, email address, phone number, account identifier, IP address);</LI>
          <LI>
            Customer records and financial information (trading capital band from applications; brokerage account
            names and balances if you link a brokerage; your paper portfolio);
          </LI>
          <LI>Internet or network activity (requests to our servers, error reports);</LI>
          <LI>Professional or employment information (for job applicants);</LI>
          <LI>Approximate location (a country code from your computer&apos;s settings).</LI>
        </UL>
        <P>We do not draw inferences from your personal information to create a profile about you.</P>
        <P>
          <Term>We do not sell or share personal information</Term>, as those terms are defined in the CCPA, and have not
          done so in the past 12 months. We do not knowingly sell or share the personal information of consumers under
          16. Some information we hold may be sensitive personal information (account log-in details, and the SnapTrade
          user secret that keeps a brokerage link working); we use it only to provide the Service and as otherwise
          permitted by the CCPA, so a right to limit its use does not apply. You have the rights to know, delete,
          correct and not be discriminated against, which you can exercise as described in Section 10.
        </P>
      </>
    ),
  },
  {
    id: "turkey",
    title: "Additional information for people in Turkey (KVKK)",
    body: (
      <>
        <P>
          Under Law No. 6698 on the Protection of Personal Data (KVKK), <Fact k="entityName" /> is the data controller.
          We process personal data for the purposes and on the grounds set out in Section 5, which correspond to the
          conditions in Article 5 of the KVKK (in particular, processing necessary for the establishment or performance
          of a contract, compliance with legal obligations, and our legitimate interests), and transfer it abroad as
          described in Section 7.
        </P>
        <P>
          Under Article 11 of the KVKK you may ask whether your data is processed and request information about it;
          learn the purpose of processing and whether it is used for that purpose; know the third parties in Turkey or
          abroad to whom it is transferred; ask for correction of incomplete or inaccurate data and for deletion or
          destruction, and for these to be notified to recipients; object to a result against you arising solely from
          automated analysis; and claim compensation for damage caused by unlawful processing. Send requests to{" "}
          <Mail k="privacyEmail" />.
        </P>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <P>
        Falcon is meant for adults. You must be 18 or older to use it, and we do not knowingly collect personal data
        from anyone under 18. If you believe a minor has given us personal data, contact <Mail k="privacyEmail" /> and
        we will delete it.
      </P>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and local storage",
    body: (
      <>
        <P>
          Our website does not use advertising or analytics cookies, and so does not show a cookie banner. It uses only
          storage that is strictly necessary for features you ask for:
        </P>
        <UL>
          <LI>
            when you sign in on the website, your browser&apos;s local storage keeps your session so you stay signed in;
          </LI>
          <LI>
            after you join the waitlist, local storage remembers that you did, the email address you used and your
            ticket (your name, member number and join date), so the site can show your status. The ticket is read once
            with your own sign-in; the site never looks up anyone&apos;s status by email address. It is all cleared when
            you sign out;
          </LI>
          <LI>session storage remembers a plan you picked on the membership pages until you close the tab;</LI>
          <LI>members of our team who use the admin tools receive a secure, short-lived session cookie.</LI>
        </UL>
        <P>
          The desktop app stores your preferences, layout, watchlist, paper account and recent searches in its own
          storage on your computer. You can see what it holds, and turn off remembering recent searches, in Settings,
          Privacy.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <P>
        We will update this policy when our practices change. We will post the new version here with a new &quot;Last
        updated&quot; date, and if a change is significant we will tell you in advance, by email or in the app.
      </P>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <P>
        Questions or requests about this policy or your personal data: <Mail k="privacyEmail" />, or write to{" "}
        <Fact k="entityName" />, <Fact k="address" />.
      </P>
    ),
  },
];
